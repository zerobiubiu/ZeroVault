/**
 * XXE 免疫 XML 解析/序列化与 KDBX InnerRandomStream 受保护字段流式加解密。
 */
import { DOMParser, XMLSerializer, type Document as XmlDocument, type Element as XmlElement } from '@xmldom/xmldom';
import { decodeUtf8, encodeUtf8, fromBase64, toBase64, wipeBytes } from './binary';
import { VaultError, type CryptoProvider, type InnerStreamCipher } from './types';

export type { XmlDocument, XmlElement };

// KeePass 协议固定的 Salsa20 8 字节 IV
const SALSA20_FIXED_NONCE = new Uint8Array([0xe8, 0x30, 0x09, 0x4b, 0x97, 0x20, 0x5d, 0x2a]);

/**
 * 解析 XML，严格禁用 DOCTYPE / ENTITY 声明防止 XXE / Billion Laughs 攻击。
 */
export function parseSafeXml(xmlText: string, expectedRootTag?: string): XmlDocument {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(xmlText)) {
    throw new VaultError('INVALID_FILE', '检测到不安全的 XML 实体或 DOCTYPE 声明，已拒绝解析。');
  }
  const errors: string[] = [];
  const parser = new DOMParser({
    onError: (level, msg) => {
      if (level === 'error' || level === 'fatalError') {
        errors.push(String(msg));
      }
    },
  });
  const doc = parser.parseFromString(xmlText, 'text/xml');
  if (errors.length > 0 || !doc || !doc.documentElement) {
    throw new VaultError('INVALID_FILE', `XML 格式无效：${errors[0] ?? '缺少根节点'}`);
  }
  if (expectedRootTag && doc.documentElement.tagName !== expectedRootTag) {
    throw new VaultError('INVALID_FILE', `XML 根节点不匹配，期望 <${expectedRootTag}>，实际 <${doc.documentElement.tagName}>。`);
  }
  return doc;
}

export function serializeXml(doc: XmlDocument): string {
  const serializer = new XMLSerializer();
  const raw = serializer.serializeToString(doc);
  if (raw.startsWith('<?xml')) {
    return raw;
  }
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n${raw}`;
}

export function childElements(parent: XmlElement, tagName?: string): XmlElement[] {
  const result: XmlElement[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1) {
      const el = node as XmlElement;
      if (!tagName || el.tagName === tagName) {
        result.push(el);
      }
    }
  }
  return result;
}

export function firstChildElement(parent: XmlElement, tagName: string): XmlElement | null {
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1 && (node as XmlElement).tagName === tagName) {
      return node as XmlElement;
    }
  }
  return null;
}

export function getOrCreateChild(doc: XmlDocument, parent: XmlElement, tagName: string): XmlElement {
  const existing = firstChildElement(parent, tagName);
  if (existing) return existing;
  const created = doc.createElement(tagName);
  parent.appendChild(created);
  return created;
}

export function getChildText(parent: XmlElement, tagName: string): string {
  return firstChildElement(parent, tagName)?.textContent ?? '';
}

export function setChildText(doc: XmlDocument, parent: XmlElement, tagName: string, value: string): XmlElement {
  const el = getOrCreateChild(doc, parent, tagName);
  el.textContent = value;
  return el;
}

/**
 * KDBX 内层随机流（ProtectedStream）按文档顺序加解密所有 `<Value Protected="True">` 节点。
 */
export class ProtectedStreamProcessor {
  private readonly cipher: InnerStreamCipher;
  private readonly key32: Uint8Array;
  private readonly nonce: Uint8Array;
  private streamOffset = 0;

  constructor(
    cipher: InnerStreamCipher,
    rawKey: Uint8Array,
    private readonly crypto: CryptoProvider,
  ) {
    this.cipher = cipher;
    if (cipher === 'salsa20') {
      this.key32 = crypto.sha256(rawKey);
      this.nonce = SALSA20_FIXED_NONCE.slice();
    } else if (cipher === 'chacha20') {
      const digest = crypto.sha512(rawKey);
      this.key32 = digest.slice(0, 32);
      this.nonce = digest.slice(32, 44);
      wipeBytes(digest);
    } else {
      this.key32 = new Uint8Array(0);
      this.nonce = new Uint8Array(0);
    }
  }

  private xorWithStream(input: Uint8Array): Uint8Array {
    if (this.cipher === 'none' || input.length === 0) {
      return input.slice();
    }
    const needed = this.streamOffset + input.length;
    const fullStream =
      this.cipher === 'salsa20'
        ? this.crypto.salsa20Keystream(this.key32, this.nonce, needed)
        : this.crypto.chacha20Keystream(this.key32, this.nonce, needed);
    const out = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) {
      out[i] = input[i] ^ fullStream[this.streamOffset + i];
    }
    this.streamOffset = needed;
    wipeBytes(fullStream);
    return out;
  }

  /**
   * 解密 XML 中所有 Protected="True" 节点，返回按出现顺序生成的保护值槽位表，
   * 并将 XML 节点内文本替换为占位标识，避免明文密码暴露于普通 XML 文本检查中。
   */
  extractProtectedValues(doc: XmlDocument): Map<string, Uint8Array> {
    const secrets = new Map<string, Uint8Array>();
    let seq = 0;
    const walk = (el: XmlElement): void => {
      if (el.tagName === 'Value' && el.getAttribute('Protected')?.toLowerCase() === 'true') {
        const b64 = (el.textContent ?? '').trim();
        const raw = b64.length > 0 ? fromBase64(b64) : new Uint8Array(0);
        const plain = this.xorWithStream(raw);
        wipeBytes(raw);
        const slotId = `zv_sec_${seq++}`;
        secrets.set(slotId, plain);
        el.setAttribute('ZeroVaultSlot', slotId);
        el.textContent = '';
        return;
      }
      for (let node = el.firstChild; node; node = node.nextSibling) {
        if (node.nodeType === 1) {
          walk(node as XmlElement);
        }
      }
    };
    if (doc.documentElement) {
      walk(doc.documentElement);
    }
    return secrets;
  }

  /**
   * 序列化导出前，将受保护槽位按文档顺序重新用新随机流加密写回 `<Value Protected="True">`。
   */
  applyProtectedValues(doc: XmlDocument, secrets: ReadonlyMap<string, Uint8Array>): void {
    const walk = (el: XmlElement): void => {
      if (el.tagName === 'Value' && el.getAttribute('Protected')?.toLowerCase() === 'true') {
        const slotId = el.getAttribute('ZeroVaultSlot');
        let plainBytes: Uint8Array;
        if (slotId && secrets.has(slotId)) {
          plainBytes = secrets.get(slotId)!;
        } else {
          plainBytes = encodeUtf8(el.textContent ?? '');
        }
        el.removeAttribute('ZeroVaultSlot');
        const cipherBytes = this.xorWithStream(plainBytes);
        el.textContent = cipherBytes.length > 0 ? toBase64(cipherBytes) : '';
        wipeBytes(cipherBytes);
        return;
      }
      for (let node = el.firstChild; node; node = node.nextSibling) {
        if (node.nodeType === 1) {
          walk(node as XmlElement);
        }
      }
    };
    if (doc.documentElement) {
      walk(doc.documentElement);
    }
  }

  destroy(): void {
    wipeBytes(this.key32);
    wipeBytes(this.nonce);
  }
}

export function decodeSecretBytes(bytes: Uint8Array | undefined): string {
  if (!bytes || bytes.length === 0) return '';
  return decodeUtf8(bytes);
}

/**
 * 兼容解析 KDBX 3.1（ISO-8601 字符串）与 KDBX 4.x（Base64 编码的 Int64 秒数，自 0001-01-01T00:00:00Z）时间。
 */
const EPOCH_0001_OFFSET_SECONDS = 62135596800n;

export function parseKdbxTime(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  try {
    const bytes = fromBase64(trimmed);
    if (bytes.length === 8) {
      const secsSince0001 = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true);
      const unixSeconds = secsSince0001 - EPOCH_0001_OFFSET_SECONDS;
      const ms = Number(unixSeconds) * 1000;
      if (Number.isFinite(ms)) {
        return new Date(ms).toISOString();
      }
    }
  } catch {
    // 忽略无法识别的时间编码
  }
  return null;
}

export function formatKdbxTime(iso: string, isKdbx4: boolean): string {
  const ms = Date.parse(iso);
  const safeMs = Number.isNaN(ms) ? Date.now() : ms;
  if (!isKdbx4) {
    return new Date(safeMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  const unixSeconds = BigInt(Math.floor(safeMs / 1000));
  const secsSince0001 = unixSeconds + EPOCH_0001_OFFSET_SECONDS;
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigInt64(0, secsSince0001, true);
  return toBase64(buf);
}
