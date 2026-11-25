/**
 * KDBX 3.1 / 4.0 / 4.1 二进制外层头、VariantDictionary、内层头及块流编解码实现。
 */
import {
  ByteReader,
  concatBytes,
  constantTimeEqual,
  decodeUtf8,
  encodeUtf8,
  fromHex,
  i32Le,
  i64Le,
  KDBX_LIMITS,
  toHex,
  u16Le,
  u32Le,
  u64Le,
  wipeBytes,
} from './binary';
import {
  VaultError,
  type CryptoProvider,
  type InnerStreamCipher,
  type KdbxCipher,
  type KdbxCompression,
  type KdbxKdfParams,
  type KdbxVersion,
} from './types';

export const KDBX_SIG_1 = 0x9aa2d903;
export const KDBX_SIG_2 = 0xb54bfb67;

export const CIPHER_UUID_AES256 = fromHex('31c1f2e6bf714350be5805216afc5aff');
export const CIPHER_UUID_CHACHA20 = fromHex('d6038a2b8b6f4cb5a524339a31dbb59a');
export const CIPHER_UUID_TWOFISH = fromHex('ad68f29f576f4bb9a36ad47af965346c');

export const KDF_UUID_AES = fromHex('c9d9f39a628a4460bf740d08c18a4fea');
export const KDF_UUID_ARGON2D = fromHex('ef636ddf8c29444b91f7a9a403e30a0c');
export const KDF_UUID_ARGON2ID = fromHex('9e298b1956db4773b23dfc3ec6f0a1e6');

export const OuterHeaderField = {
  END: 0,
  COMMENT: 1,
  CIPHER_ID: 2,
  COMPRESSION_FLAGS: 3,
  MASTER_SEED: 4,
  TRANSFORM_SEED: 5,
  TRANSFORM_ROUNDS: 6,
  ENCRYPTION_IV: 7,
  PROTECTED_STREAM_KEY: 8,
  STREAM_START_BYTES: 9,
  INNER_RANDOM_STREAM_ID: 10,
  KDF_PARAMETERS: 11,
  PUBLIC_CUSTOM_DATA: 12,
} as const;

export const InnerHeaderField = {
  END: 0x00,
  INNER_RANDOM_STREAM_ID: 0x01,
  INNER_RANDOM_STREAM_KEY: 0x02,
  BINARY: 0x03,
} as const;

export type VariantEntry =
  | { type: 0x04; value: number }
  | { type: 0x05; value: bigint }
  | { type: 0x08; value: boolean }
  | { type: 0x0c; value: number }
  | { type: 0x0d; value: bigint }
  | { type: 0x18; value: string }
  | { type: 0x42; value: Uint8Array };

export interface ParsedOuterHeader {
  readonly version: KdbxVersion;
  readonly major: number;
  readonly minor: number;
  readonly cipher: KdbxCipher;
  readonly compression: KdbxCompression;
  readonly masterSeed: Uint8Array;
  readonly encryptionIv: Uint8Array;
  readonly kdf: KdbxKdfParams;
  /** 仅 KDBX 3.1 使用 */
  readonly streamStartBytes?: Uint8Array;
  readonly protectedStreamKey3?: Uint8Array;
  readonly innerStreamCipher3?: InnerStreamCipher;
  /** 保留未知或公共扩展字段以无损写回 */
  readonly comment?: Uint8Array;
  readonly publicCustomDataRaw?: Uint8Array;
  readonly rawHeaderBytes: Uint8Array;
  readonly payloadOffset: number;
}

export interface InnerBinaryAttachment {
  readonly flags: number;
  readonly data: Uint8Array;
}

export interface ParsedInnerHeader {
  readonly cipher: InnerStreamCipher;
  readonly key: Uint8Array;
  readonly binaries: InnerBinaryAttachment[];
  readonly xmlOffset: number;
}

export function parseVariantDictionary(bytes: Uint8Array): Map<string, VariantEntry> {
  const reader = new ByteReader(bytes);
  const version = reader.readU16();
  if ((version & 0xff00) !== 0x0100) {
    throw new VaultError('UNSUPPORTED_FORMAT', `不支持的 VariantDictionary 版本：0x${version.toString(16)}`);
  }
  const map = new Map<string, VariantEntry>();
  while (reader.remaining > 0) {
    const type = reader.readU8();
    if (type === 0x00) break;
    const nameLen = reader.readU32();
    const name = decodeUtf8(reader.readBytes(nameLen));
    const valLen = reader.readU32();
    const valBytes = reader.readBytes(valLen);
    const dv = new DataView(valBytes.buffer, valBytes.byteOffset, valBytes.byteLength);
    switch (type) {
      case 0x04:
        map.set(name, { type: 0x04, value: dv.getUint32(0, true) });
        break;
      case 0x05:
        map.set(name, { type: 0x05, value: dv.getBigUint64(0, true) });
        break;
      case 0x08:
        map.set(name, { type: 0x08, value: valBytes[0] !== 0 });
        break;
      case 0x0c:
        map.set(name, { type: 0x0c, value: dv.getInt32(0, true) });
        break;
      case 0x0d:
        map.set(name, { type: 0x0d, value: dv.getBigInt64(0, true) });
        break;
      case 0x18:
        map.set(name, { type: 0x18, value: decodeUtf8(valBytes) });
        break;
      case 0x42:
        map.set(name, { type: 0x42, value: valBytes });
        break;
      default:
        throw new VaultError('UNSUPPORTED_FORMAT', `VariantDictionary 包含未知值类型：0x${type.toString(16)}`);
    }
  }
  return map;
}

export function serializeVariantDictionary(entries: ReadonlyMap<string, VariantEntry>): Uint8Array {
  const chunks: Uint8Array[] = [u16Le(0x0100)];
  for (const [name, entry] of entries) {
    const nameBytes = encodeUtf8(name);
    let valBytes: Uint8Array;
    switch (entry.type) {
      case 0x04:
        valBytes = u32Le(entry.value);
        break;
      case 0x05:
        valBytes = u64Le(entry.value);
        break;
      case 0x08:
        valBytes = new Uint8Array([entry.value ? 1 : 0]);
        break;
      case 0x0c:
        valBytes = i32Le(entry.value);
        break;
      case 0x0d:
        valBytes = i64Le(entry.value);
        break;
      case 0x18:
        valBytes = encodeUtf8(entry.value);
        break;
      case 0x42:
        valBytes = entry.value;
        break;
    }
    chunks.push(new Uint8Array([entry.type]), u32Le(nameBytes.length), nameBytes, u32Le(valBytes.length), valBytes);
  }
  chunks.push(new Uint8Array([0x00]));
  return concatBytes(...chunks);
}

function cipherFromUuid(uuid: Uint8Array): KdbxCipher {
  if (constantTimeEqual(uuid, CIPHER_UUID_AES256)) return 'aes256-cbc';
  if (constantTimeEqual(uuid, CIPHER_UUID_CHACHA20)) return 'chacha20';
  if (constantTimeEqual(uuid, CIPHER_UUID_TWOFISH)) return 'twofish-cbc';
  throw new VaultError('UNSUPPORTED_ALGORITHM', `不支持的加密算法 UUID：${toHex(uuid)}`);
}

function uuidFromCipher(cipher: KdbxCipher): Uint8Array {
  if (cipher === 'aes256-cbc') return CIPHER_UUID_AES256;
  if (cipher === 'chacha20') return CIPHER_UUID_CHACHA20;
  return CIPHER_UUID_TWOFISH;
}

function innerStreamFromId(id: number): InnerStreamCipher {
  if (id === 0) return 'none';
  if (id === 2) return 'salsa20';
  if (id === 3) return 'chacha20';
  throw new VaultError('UNSUPPORTED_ALGORITHM', `不支持的内层随机流算法 ID：${id}`);
}

function idFromInnerStream(cipher: InnerStreamCipher): number {
  if (cipher === 'none') return 0;
  if (cipher === 'salsa20') return 2;
  return 3;
}

export function parseOuterHeader(fileBytes: Uint8Array): ParsedOuterHeader {
  if (fileBytes.byteLength > KDBX_LIMITS.maxFileBytes) {
    throw new VaultError('RESOURCE_LIMIT', 'KDBX 文件大小超过 64 MiB 安全限制。');
  }
  if (fileBytes.byteLength < 12) {
    throw new VaultError('INVALID_FILE', '文件过小，不是有效的 KDBX 文件。');
  }

  const reader = new ByteReader(fileBytes);
  const sig1 = reader.readU32();
  const sig2 = reader.readU32();
  if (sig1 !== KDBX_SIG_1 || sig2 !== KDBX_SIG_2) {
    throw new VaultError('INVALID_FILE', '文件签名不匹配，不是标准的 KDBX 3.x / 4.x 数据库。');
  }

  const versionWord = reader.readU32();
  const minor = versionWord & 0xffff;
  const major = (versionWord >>> 16) & 0xffff;

  let version: KdbxVersion;
  if (major === 3 && minor === 1) {
    version = '3.1';
  } else if (major === 4 && minor === 0) {
    version = '4.0';
  } else if (major === 4 && minor === 1) {
    version = '4.1';
  } else {
    throw new VaultError('UNSUPPORTED_FORMAT', `不支持的 KDBX 版本：${major}.${minor}`);
  }

  const isKdbx4 = major === 4;
  let cipher: KdbxCipher | undefined;
  let compression: KdbxCompression = 'gzip';
  let masterSeed: Uint8Array | undefined;
  let transformSeed: Uint8Array | undefined;
  let transformRounds: bigint | undefined;
  let encryptionIv: Uint8Array | undefined;
  let protectedStreamKey3: Uint8Array | undefined;
  let streamStartBytes: Uint8Array | undefined;
  let innerStreamCipher3: InnerStreamCipher | undefined;
  let kdfParamsRaw: Uint8Array | undefined;
  let comment: Uint8Array | undefined;
  let publicCustomDataRaw: Uint8Array | undefined;

  while (true) {
    const fieldId = reader.readU8();
    const fieldLen = isKdbx4 ? reader.readU32() : reader.readU16();
    const fieldData = reader.readBytes(fieldLen);

    if (fieldId === OuterHeaderField.END) {
      break;
    }

    const dv = new DataView(fieldData.buffer, fieldData.byteOffset, fieldData.byteLength);
    switch (fieldId) {
      case OuterHeaderField.COMMENT:
        comment = fieldData;
        break;
      case OuterHeaderField.CIPHER_ID:
        if (fieldData.length !== 16) throw new VaultError('INVALID_FILE', 'CIPHER_ID 长度必须为 16 字节。');
        cipher = cipherFromUuid(fieldData);
        break;
      case OuterHeaderField.COMPRESSION_FLAGS: {
        const flag = dv.getUint32(0, true);
        if (flag === 0) compression = 'none';
        else if (flag === 1) compression = 'gzip';
        else throw new VaultError('UNSUPPORTED_ALGORITHM', `不支持的压缩算法标记：${flag}`);
        break;
      }
      case OuterHeaderField.MASTER_SEED:
        masterSeed = fieldData;
        break;
      case OuterHeaderField.TRANSFORM_SEED:
        transformSeed = fieldData;
        break;
      case OuterHeaderField.TRANSFORM_ROUNDS:
        transformRounds = dv.getBigUint64(0, true);
        break;
      case OuterHeaderField.ENCRYPTION_IV:
        encryptionIv = fieldData;
        break;
      case OuterHeaderField.PROTECTED_STREAM_KEY:
        protectedStreamKey3 = fieldData;
        break;
      case OuterHeaderField.STREAM_START_BYTES:
        streamStartBytes = fieldData;
        break;
      case OuterHeaderField.INNER_RANDOM_STREAM_ID:
        innerStreamCipher3 = innerStreamFromId(dv.getUint32(0, true));
        break;
      case OuterHeaderField.KDF_PARAMETERS:
        kdfParamsRaw = fieldData;
        break;
      case OuterHeaderField.PUBLIC_CUSTOM_DATA:
        publicCustomDataRaw = fieldData;
        break;
      default:
        // 忽略向前兼容的未知外层头字段
        break;
    }
  }

  if (!cipher || !masterSeed || !encryptionIv) {
    throw new VaultError('INVALID_FILE', 'KDBX 外层头缺少必要加密字段（CIPHER / MASTER_SEED / IV）。');
  }

  let kdf: KdbxKdfParams;
  if (isKdbx4) {
    if (!kdfParamsRaw) {
      throw new VaultError('INVALID_FILE', 'KDBX 4.x 缺少 KDF_PARAMETERS 字段。');
    }
    const vd = parseVariantDictionary(kdfParamsRaw);
    const uuidEntry = vd.get('$UUID');
    if (!uuidEntry || uuidEntry.type !== 0x42) {
      throw new VaultError('INVALID_FILE', 'KDF_PARAMETERS 缺少 $UUID 字段。');
    }
    if (constantTimeEqual(uuidEntry.value, KDF_UUID_ARGON2D) || constantTimeEqual(uuidEntry.value, KDF_UUID_ARGON2ID)) {
      const saltEntry = vd.get('S');
      const memEntry = vd.get('M');
      const iterEntry = vd.get('I');
      const parEntry = vd.get('P');
      const verEntry = vd.get('V');
      if (saltEntry?.type !== 0x42 || memEntry?.type !== 0x05 || iterEntry?.type !== 0x05 || parEntry?.type !== 0x04) {
        throw new VaultError('INVALID_FILE', 'Argon2 KDF 参数不完整。');
      }
      if (memEntry.value > BigInt(KDBX_LIMITS.maxArgon2MemoryBytes) || iterEntry.value > KDBX_LIMITS.maxArgon2Iterations) {
        throw new VaultError('RESOURCE_LIMIT', 'Argon2 参数超出设备安全上限。');
      }
      kdf = {
        type: constantTimeEqual(uuidEntry.value, KDF_UUID_ARGON2D) ? 'argon2d' : 'argon2id',
        salt: saltEntry.value,
        memoryBytes: memEntry.value,
        iterations: iterEntry.value,
        parallelism: parEntry.value,
        version: verEntry?.type === 0x04 ? verEntry.value : 0x13,
      };
    } else if (constantTimeEqual(uuidEntry.value, KDF_UUID_AES)) {
      const saltEntry = vd.get('S');
      const roundsEntry = vd.get('R');
      if (saltEntry?.type !== 0x42 || roundsEntry?.type !== 0x05) {
        throw new VaultError('INVALID_FILE', 'AES-KDF 参数不完整。');
      }
      if (roundsEntry.value > KDBX_LIMITS.maxAesRounds) {
        throw new VaultError('RESOURCE_LIMIT', 'AES-KDF 轮数超出设备安全上限。');
      }
      kdf = {
        type: 'aes-kdf',
        salt: saltEntry.value,
        rounds: roundsEntry.value,
      };
    } else {
      throw new VaultError('UNSUPPORTED_ALGORITHM', `不支持的 KDF UUID：${toHex(uuidEntry.value)}`);
    }
  } else {
    if (!transformSeed || transformRounds === undefined || !streamStartBytes || !protectedStreamKey3) {
      throw new VaultError('INVALID_FILE', 'KDBX 3.1 外层头缺少必需参数。');
    }
    if (transformRounds > KDBX_LIMITS.maxAesRounds) {
      throw new VaultError('RESOURCE_LIMIT', 'KDBX 3.1 AES-KDF 轮数超出安全上限。');
    }
    kdf = {
      type: 'aes-kdf',
      salt: transformSeed,
      rounds: transformRounds,
    };
  }

  const payloadOffset = reader.offset;
  return {
    version,
    major,
    minor,
    cipher,
    compression,
    masterSeed,
    encryptionIv,
    kdf,
    streamStartBytes,
    protectedStreamKey3,
    innerStreamCipher3,
    comment,
    publicCustomDataRaw,
    rawHeaderBytes: fileBytes.slice(0, payloadOffset),
    payloadOffset,
  };
}

export function serializeOuterHeader(params: {
  version: KdbxVersion;
  cipher: KdbxCipher;
  compression: KdbxCompression;
  masterSeed: Uint8Array;
  encryptionIv: Uint8Array;
  kdf: KdbxKdfParams;
  streamStartBytes?: Uint8Array;
  protectedStreamKey3?: Uint8Array;
  innerStreamCipher3?: InnerStreamCipher;
  comment?: Uint8Array;
  publicCustomDataRaw?: Uint8Array;
}): Uint8Array {
  const isKdbx4 = params.version !== '3.1';
  const major = isKdbx4 ? 4 : 3;
  const minor = params.version === '4.0' ? 0 : 1;
  const versionWord = ((major << 16) | minor) >>> 0;

  const chunks: Uint8Array[] = [u32Le(KDBX_SIG_1), u32Le(KDBX_SIG_2), u32Le(versionWord)];
  const pushField = (id: number, data: Uint8Array): void => {
    chunks.push(new Uint8Array([id]), isKdbx4 ? u32Le(data.length) : u16Le(data.length), data);
  };

  if (params.comment) pushField(OuterHeaderField.COMMENT, params.comment);
  pushField(OuterHeaderField.CIPHER_ID, uuidFromCipher(params.cipher));
  pushField(OuterHeaderField.COMPRESSION_FLAGS, u32Le(params.compression === 'gzip' ? 1 : 0));
  pushField(OuterHeaderField.MASTER_SEED, params.masterSeed);

  if (!isKdbx4) {
    pushField(OuterHeaderField.TRANSFORM_SEED, params.kdf.salt);
    pushField(OuterHeaderField.TRANSFORM_ROUNDS, u64Le(params.kdf.rounds ?? 60000n));
  }

  pushField(OuterHeaderField.ENCRYPTION_IV, params.encryptionIv);

  if (!isKdbx4) {
    pushField(OuterHeaderField.PROTECTED_STREAM_KEY, params.protectedStreamKey3!);
    pushField(OuterHeaderField.STREAM_START_BYTES, params.streamStartBytes!);
    pushField(OuterHeaderField.INNER_RANDOM_STREAM_ID, u32Le(idFromInnerStream(params.innerStreamCipher3 ?? 'salsa20')));
  } else {
    const vd = new Map<string, VariantEntry>();
    if (params.kdf.type === 'aes-kdf') {
      vd.set('$UUID', { type: 0x42, value: KDF_UUID_AES });
      vd.set('S', { type: 0x42, value: params.kdf.salt });
      vd.set('R', { type: 0x05, value: params.kdf.rounds ?? 60000n });
    } else {
      vd.set('$UUID', { type: 0x42, value: params.kdf.type === 'argon2d' ? KDF_UUID_ARGON2D : KDF_UUID_ARGON2ID });
      vd.set('S', { type: 0x42, value: params.kdf.salt });
      vd.set('P', { type: 0x04, value: params.kdf.parallelism ?? 2 });
      vd.set('M', { type: 0x05, value: params.kdf.memoryBytes ?? 16n * 1024n * 1024n });
      vd.set('I', { type: 0x05, value: params.kdf.iterations ?? 2n });
      vd.set('V', { type: 0x04, value: params.kdf.version ?? 0x13 });
    }
    pushField(OuterHeaderField.KDF_PARAMETERS, serializeVariantDictionary(vd));
    if (params.publicCustomDataRaw) {
      pushField(OuterHeaderField.PUBLIC_CUSTOM_DATA, params.publicCustomDataRaw);
    }
  }

  pushField(OuterHeaderField.END, new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]));
  return concatBytes(...chunks);
}

export function parseInnerHeader(bytes: Uint8Array): ParsedInnerHeader {
  const reader = new ByteReader(bytes);
  let cipher: InnerStreamCipher = 'none';
  let key: Uint8Array = new Uint8Array(0);
  const binaries: InnerBinaryAttachment[] = [];

  while (true) {
    const id = reader.readU8();
    const len = reader.readU32();
    const data = reader.readBytes(len);
    if (id === InnerHeaderField.END) {
      break;
    }
    switch (id) {
      case InnerHeaderField.INNER_RANDOM_STREAM_ID: {
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        cipher = innerStreamFromId(dv.getUint32(0, true));
        break;
      }
      case InnerHeaderField.INNER_RANDOM_STREAM_KEY:
        key = data;
        break;
      case InnerHeaderField.BINARY:
        if (data.length < 1) throw new VaultError('INVALID_FILE', '内层头 BINARY 节点为空。');
        binaries.push({ flags: data[0], data: data.slice(1) });
        break;
      default:
        break;
    }
  }

  return { cipher, key, binaries, xmlOffset: reader.offset };
}

export function serializeInnerHeader(
  cipher: InnerStreamCipher,
  key: Uint8Array,
  binaries: readonly InnerBinaryAttachment[],
): Uint8Array {
  const chunks: Uint8Array[] = [];
  const push = (id: number, data: Uint8Array): void => {
    chunks.push(new Uint8Array([id]), u32Le(data.length), data);
  };
  push(InnerHeaderField.INNER_RANDOM_STREAM_ID, u32Le(idFromInnerStream(cipher)));
  push(InnerHeaderField.INNER_RANDOM_STREAM_KEY, key);
  for (const bin of binaries) {
    const wrapped = new Uint8Array(1 + bin.data.length);
    wrapped[0] = bin.flags;
    wrapped.set(bin.data, 1);
    push(InnerHeaderField.BINARY, wrapped);
  }
  push(InnerHeaderField.END, new Uint8Array(0));
  return concatBytes(...chunks);
}

/** 派生 KDBX 4.x 块 HMAC 密钥：SHA512(u64Le(index) || hmacKeyBase) */
export function computeBlockHmacKey(hmacKeyBase: Uint8Array, blockIndex: bigint, crypto: CryptoProvider): Uint8Array {
  const input = concatBytes(u64Le(blockIndex), hmacKeyBase);
  try {
    return crypto.sha512(input);
  } finally {
    wipeBytes(input);
  }
}

export function readHmacBlockStream(streamBytes: Uint8Array, hmacKeyBase: Uint8Array, crypto: CryptoProvider): Uint8Array {
  const reader = new ByteReader(streamBytes);
  const blocks: Uint8Array[] = [];
  let blockIndex = 0n;
  let totalBytes = 0;

  while (true) {
    if (blockIndex > BigInt(KDBX_LIMITS.maxBlocks)) {
      throw new VaultError('RESOURCE_LIMIT', 'HMAC 块流块数超过安全上限。');
    }
    const storedHmac = reader.readBytes(32);
    const blockSize = reader.readU32();
    const blockData = reader.readBytes(blockSize);

    const blockKey = computeBlockHmacKey(hmacKeyBase, blockIndex, crypto);
    const message = concatBytes(u64Le(blockIndex), u32Le(blockSize), blockData);
    try {
      const computedHmac = crypto.hmacSha256(blockKey, message);
      if (!constantTimeEqual(storedHmac, computedHmac)) {
        throw new VaultError('INTEGRITY_FAILURE', `第 ${blockIndex} 号 HMAC 密文块完整性校验失败。`);
      }
    } finally {
      wipeBytes(blockKey);
      wipeBytes(message);
    }

    if (blockSize === 0) break;
    totalBytes += blockSize;
    if (totalBytes > KDBX_LIMITS.maxFileBytes) {
      throw new VaultError('RESOURCE_LIMIT', '密文块总长度超出安全上限。');
    }
    blocks.push(blockData);
    blockIndex += 1n;
  }

  return concatBytes(...blocks);
}

export function writeHmacBlockStream(
  encryptedPayload: Uint8Array,
  hmacKeyBase: Uint8Array,
  crypto: CryptoProvider,
  chunkSize = 1024 * 1024,
): Uint8Array {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let blockIndex = 0n;

  while (offset < encryptedPayload.length) {
    const end = Math.min(offset + chunkSize, encryptedPayload.length);
    const slice = encryptedPayload.subarray(offset, end);
    const blockKey = computeBlockHmacKey(hmacKeyBase, blockIndex, crypto);
    const msg = concatBytes(u64Le(blockIndex), u32Le(slice.length), slice);
    try {
      const mac = crypto.hmacSha256(blockKey, msg);
      parts.push(mac, u32Le(slice.length), slice);
    } finally {
      wipeBytes(blockKey);
      wipeBytes(msg);
    }
    offset = end;
    blockIndex += 1n;
  }

  // 写入结束空块并附带 HMAC
  const endKey = computeBlockHmacKey(hmacKeyBase, blockIndex, crypto);
  const endMsg = concatBytes(u64Le(blockIndex), u32Le(0));
  try {
    const endMac = crypto.hmacSha256(endKey, endMsg);
    parts.push(endMac, u32Le(0));
  } finally {
    wipeBytes(endKey);
    wipeBytes(endMsg);
  }

  return concatBytes(...parts);
}

export function readHashedBlockStream(streamBytes: Uint8Array, crypto: CryptoProvider): Uint8Array {
  const reader = new ByteReader(streamBytes);
  const blocks: Uint8Array[] = [];
  let expectedIndex = 0;

  while (true) {
    if (expectedIndex > KDBX_LIMITS.maxBlocks) {
      throw new VaultError('RESOURCE_LIMIT', 'KDBX 3.1 哈希块数量超过上限。');
    }
    const index = reader.readU32();
    const storedHash = reader.readBytes(32);
    const size = reader.readU32();
    if (index !== expectedIndex) {
      throw new VaultError('INTEGRITY_FAILURE', `KDBX 3.1 块序号错位：期望 ${expectedIndex}，实际 ${index}。`);
    }
    if (size === 0) {
      const allZero = storedHash.every((b) => b === 0);
      if (!allZero) {
        throw new VaultError('INTEGRITY_FAILURE', 'KDBX 3.1 终止块哈希非零。');
      }
      break;
    }
    const data = reader.readBytes(size);
    const actualHash = crypto.sha256(data);
    if (!constantTimeEqual(storedHash, actualHash)) {
      throw new VaultError('INTEGRITY_FAILURE', `KDBX 3.1 第 ${index} 块 SHA-256 校验失败。`);
    }
    blocks.push(data);
    expectedIndex += 1;
  }

  return concatBytes(...blocks);
}

export function writeHashedBlockStream(payload: Uint8Array, crypto: CryptoProvider, chunkSize = 1024 * 1024): Uint8Array {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let index = 0;

  while (offset < payload.length) {
    const end = Math.min(offset + chunkSize, payload.length);
    const slice = payload.subarray(offset, end);
    const hash = crypto.sha256(slice);
    parts.push(u32Le(index), hash, u32Le(slice.length), slice);
    offset = end;
    index += 1;
  }

  parts.push(u32Le(index), new Uint8Array(32), u32Le(0));
  return concatBytes(...parts);
}
