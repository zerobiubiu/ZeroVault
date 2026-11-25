/**
 * KDBX 二进制辅助工具：字节读写、Base64/Hex/UTF-8 编解码、常量时间比较、安全擦除与资源防膨胀限额。
 */
import { VaultError } from './types';

export const KDBX_LIMITS = {
  maxFileBytes: 64 * 1024 * 1024, // 64 MiB
  maxXmlBytes: 64 * 1024 * 1024, // 解压防压缩炸弹上限 64 MiB
  maxKeyFileBytes: 16 * 1024 * 1024, // 16 MiB
  maxArgon2MemoryBytes: 512 * 1024 * 1024, // 512 MiB
  maxArgon2Iterations: 1_000_000n,
  maxAesRounds: 100_000_000n,
  maxBlocks: 100_000,
} as const;

/**
 * 纯 TypeScript 严格 UTF-8 编码（RFC 3629），兼容 React Native Hermes（不依赖全局 TextEncoder）。
 */
export function encodeUtf8(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let codePoint = str.charCodeAt(i);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && i + 1 < str.length) {
      const low = str.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      }
    }
    if (codePoint <= 0x7f) {
      out.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      out.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      out.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      out.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

/**
 * 纯 TypeScript 严格 UTF-8 解码（RFC 3629，等价于 fatal: true），遇到非法字节序列立即抛错。
 * 彻底消除 React Native Hermes 缺少全局 TextDecoder 导致的启动崩溃。
 */
export function decodeUtf8(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let buf = '';
  let i = 0;
  const len = bytes.length;
  // 跳过 UTF-8 BOM（兼容部分 Windows/KeePass XML 文件）
  if (len >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    i = 3;
  }

  while (i < len) {
    const b0 = bytes[i++];
    let cp: number;
    if (b0 <= 0x7f) {
      cp = b0;
    } else if ((b0 & 0xe0) === 0xc0) {
      if (i >= len) throw new VaultError('INVALID_FILE', 'UTF-8 序列不完整。');
      const b1 = bytes[i++];
      if ((b1 & 0xc0) !== 0x80) throw new VaultError('INVALID_FILE', 'UTF-8 续字节无效。');
      cp = ((b0 & 0x1f) << 6) | (b1 & 0x3f);
      if (cp < 0x80) throw new VaultError('INVALID_FILE', 'UTF-8 存在非规范过长编码。');
    } else if ((b0 & 0xf0) === 0xe0) {
      if (i + 1 >= len) throw new VaultError('INVALID_FILE', 'UTF-8 序列不完整。');
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) {
        throw new VaultError('INVALID_FILE', 'UTF-8 续字节无效。');
      }
      cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
      if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) {
        throw new VaultError('INVALID_FILE', 'UTF-8 码点非法或落入代理区。');
      }
    } else if ((b0 & 0xf8) === 0xf0) {
      if (i + 2 >= len) throw new VaultError('INVALID_FILE', 'UTF-8 序列不完整。');
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) {
        throw new VaultError('INVALID_FILE', 'UTF-8 续字节无效。');
      }
      cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      if (cp < 0x10000 || cp > 0x10ffff) {
        throw new VaultError('INVALID_FILE', 'UTF-8 码点超出 Unicode 范围。');
      }
    } else {
      throw new VaultError('INVALID_FILE', 'UTF-8 起始字节无效。');
    }

    if (cp <= 0xffff) {
      buf += String.fromCharCode(cp);
    } else {
      const v = cp - 0x10000;
      buf += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    }

    if (buf.length >= 4096) {
      chunks.push(buf);
      buf = '';
    }
  }
  if (buf.length > 0) chunks.push(buf);
  return chunks.join('');
}

export function wipeBytes(bytes: Uint8Array | undefined | null): void {
  if (bytes) {
    bytes.fill(0);
  }
}

export function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** 常量时间字节数组相等比较，降低时序侧信道风险 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new VaultError('INVALID_FILE', '十六进制编码格式无效。');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < BASE64_CHARS.length; i++) {
  BASE64_LOOKUP[BASE64_CHARS.charCodeAt(i)] = i;
}

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    out += BASE64_CHARS[(b0 >> 2) & 0x3f];
    out += BASE64_CHARS[((b0 & 0x03) << 4) | ((b1 >> 4) & 0x0f)];
    out += i + 1 < len ? BASE64_CHARS[((b1 & 0x0f) << 2) | ((b2 >> 6) & 0x03)] : '=';
    out += i + 2 < len ? BASE64_CHARS[b2 & 0x3f] : '=';
  }
  return out;
}

export function fromBase64(input: string): Uint8Array {
  const clean = input.replace(/\s+/g, '');
  if (clean.length === 0) return new Uint8Array(0);
  if (clean.length % 4 !== 0) {
    throw new VaultError('INVALID_FILE', 'Base64 编码长度无效。');
  }
  let padding = 0;
  if (clean.endsWith('==')) padding = 2;
  else if (clean.endsWith('=')) padding = 1;
  const outLen = (clean.length / 4) * 3 - padding;
  const out = new Uint8Array(outLen);
  let outIdx = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = clean.charCodeAt(i);
    const c1 = clean.charCodeAt(i + 1);
    const c2 = clean.charCodeAt(i + 2);
    const c3 = clean.charCodeAt(i + 3);
    const v0 = c0 < 128 ? BASE64_LOOKUP[c0] : -1;
    const v1 = c1 < 128 ? BASE64_LOOKUP[c1] : -1;
    const v2 = c2 === 61 ? 0 : c2 < 128 ? BASE64_LOOKUP[c2] : -1;
    const v3 = c3 === 61 ? 0 : c3 < 128 ? BASE64_LOOKUP[c3] : -1;
    if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) {
      throw new VaultError('INVALID_FILE', 'Base64 字符非法。');
    }
    const triple = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
    if (outIdx < outLen) out[outIdx++] = (triple >> 16) & 0xff;
    if (outIdx < outLen) out[outIdx++] = (triple >> 8) & 0xff;
    if (outIdx < outLen) out[outIdx++] = triple & 0xff;
  }
  return out;
}

export function u16Le(value: number): Uint8Array {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, value, true);
  return buf;
}

export function u32Le(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value >>> 0, true);
  return buf;
}

export function u64Le(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, value, true);
  return buf;
}

export function i32Le(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setInt32(0, value, true);
  return buf;
}

export function i64Le(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigInt64(0, value, true);
  return buf;
}

export class ByteReader {
  private readonly view: DataView;
  private pos = 0;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.data.byteLength - this.pos;
  }

  private ensure(size: number): void {
    if (size < 0 || this.pos + size > this.data.byteLength) {
      throw new VaultError('INVALID_FILE', 'KDBX 二进制流意外截断。');
    }
  }

  readU8(): number {
    this.ensure(1);
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  readU16(): number {
    this.ensure(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  readU32(): number {
    this.ensure(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readI32(): number {
    this.ensure(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readU64(): bigint {
    this.ensure(8);
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }

  readI64(): bigint {
    this.ensure(8);
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return v;
  }

  readBytes(length: number): Uint8Array {
    this.ensure(length);
    const out = this.data.slice(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  sliceRest(): Uint8Array {
    return this.data.subarray(this.pos);
  }
}

export function generateUuidBase64(randomBytes: (len: number) => Uint8Array): string {
  return toBase64(randomBytes(16));
}

export function isZeroUuid(uuidBase64: string | null | undefined): boolean {
  if (!uuidBase64) return true;
  try {
    const bytes = fromBase64(uuidBase64);
    if (bytes.length !== 16) return false;
    for (let i = 0; i < 16; i++) {
      if (bytes[i] !== 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}
