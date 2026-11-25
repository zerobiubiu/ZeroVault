/**
 * KDBX 复合密钥派生（Composite Key）：
 * 严格区分 password: null（仅密钥文件）与 password: ''（空密码组件），
 * 完整支持 XML KeyFile v1.0 / v2.0（含校验和）、32B 原始密钥、64B Hex 与任意二进制文件（含 0 字节文件）。
 */
import {
  concatBytes,
  constantTimeEqual,
  decodeUtf8,
  encodeUtf8,
  fromBase64,
  fromHex,
  KDBX_LIMITS,
  wipeBytes,
} from './binary';
import { VaultError, type CryptoProvider, type VaultCredentials } from './types';
import { firstChildElement, getChildText, parseSafeXml } from './xml';

export type CredentialMode =
  | 'password-only'
  | 'empty-password-only'
  | 'keyfile-only'
  | 'password-and-keyfile';

/**
 * 解析密钥文件字节为 32 字节密钥组件。
 */
export function parseKeyFileComponent(bytes: Uint8Array, crypto: CryptoProvider): Uint8Array {
  if (bytes.length > KDBX_LIMITS.maxKeyFileBytes) {
    throw new VaultError('INVALID_KEYFILE', '密钥文件大小超过 16 MiB 上限。');
  }

  let asText = '';
  try {
    asText = decodeUtf8(bytes);
  } catch {
    // 非 UTF-8 任意二进制文件无需文本解析
  }

  if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(asText)) {
    throw new VaultError('INVALID_KEYFILE', '密钥文件包含不安全的 XML 实体声明，已拒绝。');
  }

  if (/^\s*(?:<\?xml[\s\S]*?\?>\s*)?<KeyFile(?:\s|>)/u.test(asText)) {
    let parsed: Uint8Array | undefined;
    try {
      const doc = parseSafeXml(asText, 'KeyFile');
      const root = doc.documentElement!;
      const meta = firstChildElement(root, 'Meta');
      const key = firstChildElement(root, 'Key');
      const data = key ? firstChildElement(key, 'Data') : null;
      if (!meta || !key || !data) {
        throw new VaultError('INVALID_KEYFILE', 'XML 密钥文件缺少 Meta/Key/Data 节点。');
      }
      const version = getChildText(meta, 'Version').trim();
      const rawContent = data.textContent ?? '';
      if (/^1(?:\.\d+)*$/.test(version)) {
        parsed = fromBase64(rawContent);
      } else if (/^2(?:\.\d+)*$/.test(version)) {
        parsed = fromHex(rawContent.replace(/\s+/g, ''));
        const hashAttr = data.getAttribute('Hash')?.trim();
        if (!hashAttr || !/^[0-9a-fA-F]{8}$/.test(hashAttr)) {
          throw new VaultError('INVALID_KEYFILE', 'XML v2 密钥文件缺少有效的 4 字节 Hash 校验属性。');
        }
        const expected = fromHex(hashAttr);
        const actual = crypto.sha256(parsed).subarray(0, 4);
        if (!constantTimeEqual(actual, expected)) {
          throw new VaultError('INVALID_KEYFILE', 'XML v2 密钥文件校验和不匹配，文件可能已损坏。');
        }
      } else {
        throw new VaultError('INVALID_KEYFILE', `不支持的 XML 密钥文件版本：${version || '未知'}`);
      }
      if (parsed.length !== 32) {
        throw new VaultError('INVALID_KEYFILE', `XML 密钥文件解码后应为 32 字节，实际为 ${parsed.length} 字节。`);
      }
      return parsed;
    } catch (err) {
      wipeBytes(parsed);
      if (err instanceof VaultError && err.code === 'INVALID_KEYFILE') throw err;
      throw new VaultError('INVALID_KEYFILE', 'XML 密钥文件解析失败，不会退回为普通二进制哈希。', { cause: err });
    }
  }

  // KeePass 2.x 规则：恰好 32 字节原样使用；恰好 64 字节 Hex 解码为 32 字节；其余取 SHA-256（含 0 字节文件）
  if (bytes.length === 32) {
    return bytes.slice();
  }
  if (bytes.length === 64 && /^[0-9a-fA-F]{64}$/.test(asText)) {
    return fromHex(asText);
  }
  return crypto.sha256(bytes);
}

/**
 * 派生 32 字节 KDBX 复合密钥（Composite Key）。
 * 严格区分：
 * - { password: null, keyFile } -> SHA256(keyFileComponent)
 * - { password: '', keyFile } -> SHA256(SHA256('') || keyFileComponent)
 * - { password: '' } -> SHA256(SHA256(''))
 */
export function deriveCompositeKey(credentials: VaultCredentials, crypto: CryptoProvider): Uint8Array {
  if (!credentials || (credentials.password !== null && typeof credentials.password !== 'string')) {
    throw new VaultError('INVALID_CREDENTIALS', '主密码必须为字符串或 null（表示无密码组件）。');
  }
  if (credentials.password === null && !credentials.keyFile) {
    throw new VaultError('INVALID_CREDENTIALS', '至少需要提供主密码（可为空字符串）或密钥文件。');
  }
  if (credentials.keyFile !== undefined && !(credentials.keyFile instanceof Uint8Array)) {
    throw new VaultError('INVALID_KEYFILE', '密钥文件必须是 Uint8Array 字节数组。');
  }

  const components: Uint8Array[] = [];
  let passwordBytes: Uint8Array | undefined;
  try {
    if (credentials.password !== null) {
      passwordBytes = encodeUtf8(credentials.password);
      components.push(crypto.sha256(passwordBytes));
    }
    if (credentials.keyFile) {
      components.push(parseKeyFileComponent(credentials.keyFile, crypto));
    }
    const merged = concatBytes(...components);
    try {
      return crypto.sha256(merged);
    } finally {
      wipeBytes(merged);
    }
  } finally {
    wipeBytes(passwordBytes);
    for (const c of components) wipeBytes(c);
  }
}

/**
 * 根据用户界面输入构造明确语义的 VaultCredentials。
 */
export function buildCredentialsFromMode(
  mode: CredentialMode,
  passwordText: string,
  keyFile?: Uint8Array,
): VaultCredentials {
  switch (mode) {
    case 'password-only':
      return { password: passwordText };
    case 'empty-password-only':
      return { password: '' };
    case 'keyfile-only':
      if (!keyFile) throw new VaultError('INVALID_KEYFILE', '仅密钥文件模式必须提供密钥文件。');
      return { password: null, keyFile };
    case 'password-and-keyfile':
      if (!keyFile) throw new VaultError('INVALID_KEYFILE', '主密码 + 密钥文件模式必须提供密钥文件。');
      return { password: passwordText, keyFile };
  }
}

/**
 * 生成标准 KeePass XML v2.0 密钥文件（带 4 字节 SHA-256 校验和）。
 */
export function generateKeyFileV2(crypto: CryptoProvider): Uint8Array {
  const key = crypto.randomBytes(32);
  try {
    const hash4 = crypto.sha256(key).subarray(0, 4);
    const hexKey = Array.from(key)
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
      .join('');
    const formatted = hexKey.match(/.{1,8}/g)!.join(' ');
    const hashHex = Array.from(hash4)
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
      .join('');
    const xml =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<KeyFile>\n` +
      `\t<Meta>\n` +
      `\t\t<Version>2.0</Version>\n` +
      `\t</Meta>\n` +
      `\t<Key>\n` +
      `\t\t<Data Hash="${hashHex}">\n` +
      `\t\t\t${formatted}\n` +
      `\t\t</Data>\n` +
      `\t</Key>\n` +
      `</KeyFile>\n`;
    return encodeUtf8(xml);
  } finally {
    wipeBytes(key);
  }
}
