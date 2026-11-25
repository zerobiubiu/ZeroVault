/**
 * ZeroVault 自主 KDBX 3.1 / 4.0 / 4.1 密码库核心会话引擎。
 * 职责：完整解密加载、新建库、分组与条目 CRUD、历史快照、回收站、附件读写、TOTP 提取、事务 fork 与安全锁定擦除。
 */
import {
  concatBytes,
  constantTimeEqual,
  decodeUtf8,
  encodeUtf8,
  fromBase64,
  generateUuidBase64,
  isZeroUuid,
  KDBX_LIMITS,
  toBase64,
  wipeBytes,
} from './binary';
import { deriveCompositeKey } from './credentials';
import { createFallbackCryptoProvider } from './crypto-fallback';
import {
  computeBlockHmacKey,
  parseInnerHeader,
  parseOuterHeader,
  readHashedBlockStream,
  readHmacBlockStream,
  serializeInnerHeader,
  serializeOuterHeader,
  writeHashedBlockStream,
  writeHmacBlockStream,
  type InnerBinaryAttachment,
} from './header';
import { extractTotpFromFields } from './totp';
import {
  VaultError,
  type CryptoProvider,
  type InnerStreamCipher,
  type KdbxCipher,
  type KdbxCompression,
  type KdbxKdfParams,
  type KdbxVersion,
  type TotpConfig,
  type VaultAttachmentMeta,
  type VaultCreateOptions,
  type VaultCredentials,
  type VaultCustomField,
  type VaultEntry,
  type VaultEntryInput,
  type VaultEntrySummary,
  type VaultFormat,
  type VaultGroup,
  type VaultGroupInput,
  type VaultHistorySnapshot,
  type VaultModel,
} from './types';
import {
  childElements,
  decodeSecretBytes,
  firstChildElement,
  formatKdbxTime,
  getChildText,
  getOrCreateChild,
  parseKdbxTime,
  parseSafeXml,
  ProtectedStreamProcessor,
  serializeXml,
  setChildText,
  type XmlDocument,
  type XmlElement,
} from './xml';

const STANDARD_KEYS = new Set(['Title', 'UserName', 'Password', 'URL', 'Notes']);
const HEADER_HMAC_INDEX = 0xffffffffffffffffn;

interface InternalState {
  version: KdbxVersion;
  cipher: KdbxCipher;
  compression: KdbxCompression;
  kdf: KdbxKdfParams;
  innerStreamCipher: InnerStreamCipher;
  comment?: Uint8Array;
  publicCustomDataRaw?: Uint8Array;
  compositeKey: Uint8Array;
  doc: XmlDocument;
  /** 受保护字段的独立内存字节槽位，锁定或更新时可显式清零 */
  secrets: Map<string, Uint8Array>;
  secretCounter: number;
  /** KDBX 4.x 内层头附件表；KDBX 3.1 附件同步存放于 XML Meta/Binaries */
  binaries4: InnerBinaryAttachment[];
  dirty: boolean;
  locked: boolean;
}

async function runKdf(compositeKey: Uint8Array, kdf: KdbxKdfParams, crypto: CryptoProvider): Promise<Uint8Array> {
  if (kdf.type === 'aes-kdf') {
    return crypto.aesKdf(kdf.salt, compositeKey, kdf.rounds ?? 60000n);
  }
  const memoryKiB = Number((kdf.memoryBytes ?? 16n * 1024n * 1024n) / 1024n);
  return crypto.argon2({
    variant: kdf.type,
    password: compositeKey,
    salt: kdf.salt,
    iterations: Number(kdf.iterations ?? 2n),
    memoryKiB: Math.max(8, memoryKiB),
    parallelism: kdf.parallelism ?? 2,
    version: kdf.version ?? 0x13,
    hashLength: 32,
  });
}

async function encryptCipherPayload(
  cipher: KdbxCipher,
  masterKey: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  crypto: CryptoProvider,
): Promise<Uint8Array> {
  if (cipher === 'aes256-cbc') return crypto.aesCbcEncrypt(masterKey, iv, plaintext);
  if (cipher === 'chacha20') return crypto.chacha20(masterKey, iv, plaintext);
  if (cipher === 'twofish-cbc' && crypto.twofishCbcEncrypt) {
    return crypto.twofishCbcEncrypt(masterKey, iv, plaintext);
  }
  throw new VaultError('UNSUPPORTED_ALGORITHM', `当前密码学引擎不支持加密算法：${cipher}`);
}

async function decryptCipherPayload(
  cipher: KdbxCipher,
  masterKey: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  crypto: CryptoProvider,
): Promise<Uint8Array> {
  if (cipher === 'aes256-cbc') return crypto.aesCbcDecrypt(masterKey, iv, ciphertext);
  if (cipher === 'chacha20') return crypto.chacha20(masterKey, iv, ciphertext);
  if (cipher === 'twofish-cbc' && crypto.twofishCbcDecrypt) {
    return crypto.twofishCbcDecrypt(masterKey, iv, ciphertext);
  }
  throw new VaultError('UNSUPPORTED_ALGORITHM', `当前密码学引擎不支持解密算法：${cipher}`);
}

function defaultIvLength(cipher: KdbxCipher): number {
  return cipher === 'chacha20' ? 12 : 16;
}

class KdbxVaultSession implements VaultModel {
  constructor(
    private readonly state: InternalState,
    private readonly crypto: CryptoProvider,
  ) {}

  private assertUnlocked(): void {
    if (this.state.locked) {
      throw new VaultError('LOCKED', '密码库已锁定，请重新解锁后再操作。');
    }
  }

  private get isKdbx4(): boolean {
    return this.state.version !== '3.1';
  }

  private get metaElement(): XmlElement {
    const root = this.state.doc.documentElement!;
    return getOrCreateChild(this.state.doc, root, 'Meta');
  }

  private get rootGroupElement(): XmlElement {
    const root = this.state.doc.documentElement!;
    const rootNode = getOrCreateChild(this.state.doc, root, 'Root');
    const group = firstChildElement(rootNode, 'Group');
    if (!group) {
      throw new VaultError('INVALID_FILE', 'KDBX XML 缺少 Root/Group 根分组。');
    }
    return group;
  }

  get format(): VaultFormat {
    return {
      version: this.state.version,
      cipher: this.state.cipher,
      kdf: this.state.kdf.type,
      compression: this.state.compression,
    };
  }

  get name(): string {
    if (this.state.locked) return '';
    return getChildText(this.metaElement, 'DatabaseName').trim() || '未命名密码库';
  }

  get description(): string {
    if (this.state.locked) return '';
    return getChildText(this.metaElement, 'DatabaseDescription').trim();
  }

  get locked(): boolean {
    return this.state.locked;
  }

  get dirty(): boolean {
    return this.state.dirty;
  }

  get recycleBinId(): string | null {
    if (this.state.locked) return null;
    const enabled = getChildText(this.metaElement, 'RecycleBinEnabled').trim().toLowerCase();
    if (enabled === 'false') return null;
    const uuid = getChildText(this.metaElement, 'RecycleBinUUID').trim();
    return isZeroUuid(uuid) ? null : uuid;
  }

  private getStringNode(entryEl: XmlElement, key: string): XmlElement | null {
    for (const strEl of childElements(entryEl, 'String')) {
      if (getChildText(strEl, 'Key') === key) {
        return strEl;
      }
    }
    return null;
  }

  private readStringValue(entryEl: XmlElement, key: string): string {
    const strEl = this.getStringNode(entryEl, key);
    if (!strEl) return '';
    const valEl = firstChildElement(strEl, 'Value');
    if (!valEl) return '';
    if (valEl.getAttribute('Protected')?.toLowerCase() === 'true') {
      const slotId = valEl.getAttribute('ZeroVaultSlot');
      if (slotId && this.state.secrets.has(slotId)) {
        return decodeSecretBytes(this.state.secrets.get(slotId));
      }
    }
    return valEl.textContent ?? '';
  }

  private isStringProtected(entryEl: XmlElement, key: string): boolean {
    const strEl = this.getStringNode(entryEl, key);
    if (!strEl) return false;
    const valEl = firstChildElement(strEl, 'Value');
    return valEl?.getAttribute('Protected')?.toLowerCase() === 'true';
  }

  private setStringValue(entryEl: XmlElement, key: string, value: string, isProtected: boolean): void {
    let strEl = this.getStringNode(entryEl, key);
    if (!strEl) {
      strEl = this.state.doc.createElement('String');
      const keyEl = this.state.doc.createElement('Key');
      keyEl.textContent = key;
      const valEl = this.state.doc.createElement('Value');
      strEl.appendChild(keyEl);
      strEl.appendChild(valEl);
      entryEl.appendChild(strEl);
    }
    const valEl = getOrCreateChild(this.state.doc, strEl, 'Value');
    const prevSlot = valEl.getAttribute('ZeroVaultSlot');
    if (prevSlot) {
      wipeBytes(this.state.secrets.get(prevSlot));
      this.state.secrets.delete(prevSlot);
      valEl.removeAttribute('ZeroVaultSlot');
    }
    if (isProtected) {
      valEl.setAttribute('Protected', 'True');
      const slotId = `zv_sec_${this.state.secretCounter++}`;
      this.state.secrets.set(slotId, encodeUtf8(value));
      valEl.setAttribute('ZeroVaultSlot', slotId);
      valEl.textContent = '';
    } else {
      valEl.removeAttribute('Protected');
      valEl.textContent = value;
    }
  }

  private removeStringKey(entryEl: XmlElement, key: string): void {
    const strEl = this.getStringNode(entryEl, key);
    if (!strEl) return;
    const valEl = firstChildElement(strEl, 'Value');
    const prevSlot = valEl?.getAttribute('ZeroVaultSlot');
    if (prevSlot) {
      wipeBytes(this.state.secrets.get(prevSlot));
      this.state.secrets.delete(prevSlot);
    }
    entryEl.removeChild(strEl);
  }

  private touchTimes(el: XmlElement, isNew: boolean): void {
    const now = formatKdbxTime(new Date().toISOString(), this.isKdbx4);
    const timesEl = getOrCreateChild(this.state.doc, el, 'Times');
    if (isNew) {
      setChildText(this.state.doc, timesEl, 'CreationTime', now);
      setChildText(this.state.doc, timesEl, 'UsageCount', '0');
    }
    setChildText(this.state.doc, timesEl, 'LastModificationTime', now);
    setChildText(this.state.doc, timesEl, 'LastAccessTime', now);
    if (!firstChildElement(timesEl, 'Expires')) {
      setChildText(this.state.doc, timesEl, 'Expires', 'False');
    }
    if (!firstChildElement(timesEl, 'ExpiryTime')) {
      setChildText(this.state.doc, timesEl, 'ExpiryTime', now);
    }
  }

  private findGroupElement(groupId: string, node: XmlElement = this.rootGroupElement): XmlElement | null {
    if (getChildText(node, 'UUID').trim() === groupId) {
      return node;
    }
    for (const child of childElements(node, 'Group')) {
      const found = this.findGroupElement(groupId, child);
      if (found) return found;
    }
    return null;
  }

  private findEntryWithContext(
    entryId: string,
  ): { entryEl: XmlElement; groupEl: XmlElement; groupId: string; groupPath: string; recycled: boolean } | null {
    const recycleId = this.recycleBinId;
    const walk = (
      groupEl: XmlElement,
      parentPath: string,
      inRecycle: boolean,
    ): { entryEl: XmlElement; groupEl: XmlElement; groupId: string; groupPath: string; recycled: boolean } | null => {
      const gid = getChildText(groupEl, 'UUID').trim();
      const gname = getChildText(groupEl, 'Name').trim() || '根目录';
      const path = parentPath ? `${parentPath} / ${gname}` : gname;
      const recycled = inRecycle || (recycleId !== null && gid === recycleId);
      for (const entryEl of childElements(groupEl, 'Entry')) {
        if (getChildText(entryEl, 'UUID').trim() === entryId) {
          return { entryEl, groupEl, groupId: gid, groupPath: path, recycled };
        }
      }
      for (const sub of childElements(groupEl, 'Group')) {
        const hit = walk(sub, path, recycled);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this.rootGroupElement, '', false);
  }

  private parseTags(entryEl: XmlElement): string[] {
    const raw = getChildText(entryEl, 'Tags').trim();
    if (!raw) return [];
    return raw
      .split(/[;,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  private hasTotpField(entryEl: XmlElement): boolean {
    return extractTotpFromFields((key) => {
      const val = this.readStringValue(entryEl, key);
      return val.length > 0 ? val : undefined;
    }) !== null;
  }

  private buildSummary(
    entryEl: XmlElement,
    groupId: string,
    groupPath: string,
    recycled: boolean,
  ): VaultEntrySummary {
    const id = getChildText(entryEl, 'UUID').trim();
    const timesEl = firstChildElement(entryEl, 'Times');
    const createdAt = timesEl ? parseKdbxTime(getChildText(timesEl, 'CreationTime')) : null;
    const modifiedAt = timesEl ? parseKdbxTime(getChildText(timesEl, 'LastModificationTime')) : null;
    const expires = timesEl ? getChildText(timesEl, 'Expires').trim().toLowerCase() === 'true' : false;
    const expiryTime = timesEl ? parseKdbxTime(getChildText(timesEl, 'ExpiryTime')) : null;
    const isExpired = expires && expiryTime !== null && Date.parse(expiryTime) <= Date.now();
    const iconId = Number.parseInt(getChildText(entryEl, 'IconID') || '0', 10) || 0;
    const passwordValue = this.readStringValue(entryEl, 'Password');

    return {
      id,
      groupId,
      groupPath,
      title: this.readStringValue(entryEl, 'Title') || '未命名条目',
      username: this.readStringValue(entryEl, 'UserName'),
      url: this.readStringValue(entryEl, 'URL'),
      iconId,
      tags: this.parseTags(entryEl),
      hasPassword: passwordValue.length > 0,
      hasTotp: this.hasTotpField(entryEl),
      hasAttachments: childElements(entryEl, 'Binary').length > 0,
      expires,
      expiryTime,
      isExpired,
      recycled,
      createdAt,
      modifiedAt,
    };
  }

  listGroups(): readonly VaultGroup[] {
    this.assertUnlocked();
    const recycleId = this.recycleBinId;
    const groups: VaultGroup[] = [];
    const walk = (groupEl: XmlElement, parentId: string | null, parentPath: string): void => {
      const id = getChildText(groupEl, 'UUID').trim();
      const name = getChildText(groupEl, 'Name').trim() || '根目录';
      const notes = getChildText(groupEl, 'Notes');
      const iconId = Number.parseInt(getChildText(groupEl, 'IconID') || '48', 10) || 48;
      const path = parentPath ? `${parentPath} / ${name}` : name;
      const entryCount = childElements(groupEl, 'Entry').length;
      groups.push({
        id,
        name,
        notes,
        iconId,
        parentId,
        path,
        isRecycleBin: recycleId !== null && id === recycleId,
        entryCount,
      });
      for (const sub of childElements(groupEl, 'Group')) {
        walk(sub, id, path);
      }
    };
    walk(this.rootGroupElement, null, '');
    return groups;
  }

  listEntries(options: { includeRecycled?: boolean } = {}): readonly VaultEntrySummary[] {
    this.assertUnlocked();
    const includeRecycled = options.includeRecycled ?? true;
    const recycleId = this.recycleBinId;
    const items: VaultEntrySummary[] = [];
    const walk = (groupEl: XmlElement, parentPath: string, inRecycle: boolean): void => {
      const gid = getChildText(groupEl, 'UUID').trim();
      const gname = getChildText(groupEl, 'Name').trim() || '根目录';
      const path = parentPath ? `${parentPath} / ${gname}` : gname;
      const recycled = inRecycle || (recycleId !== null && gid === recycleId);
      if (includeRecycled || !recycled) {
        for (const entryEl of childElements(groupEl, 'Entry')) {
          items.push(this.buildSummary(entryEl, gid, path, recycled));
        }
      }
      for (const sub of childElements(groupEl, 'Group')) {
        walk(sub, path, recycled);
      }
    };
    walk(this.rootGroupElement, '', false);
    return items;
  }

  private getAttachmentSizeByRef(refId: string): number {
    if (this.isKdbx4) {
      const idx = Number.parseInt(refId, 10);
      if (Number.isInteger(idx) && idx >= 0 && idx < this.state.binaries4.length) {
        return this.state.binaries4[idx].data.byteLength;
      }
      return 0;
    }
    const binariesEl = firstChildElement(this.metaElement, 'Binaries');
    if (!binariesEl) return 0;
    for (const binEl of childElements(binariesEl, 'Binary')) {
      if (binEl.getAttribute('ID') === refId) {
        const raw = fromBase64(binEl.textContent ?? '');
        if (binEl.getAttribute('Compressed')?.toLowerCase() === 'true') {
          try {
            return this.crypto.gzipDecompress(raw, KDBX_LIMITS.maxFileBytes).byteLength;
          } catch {
            return raw.byteLength;
          }
        }
        return raw.byteLength;
      }
    }
    return 0;
  }

  getEntry(id: string): VaultEntry {
    this.assertUnlocked();
    const ctx = this.findEntryWithContext(id);
    if (!ctx) {
      throw new VaultError('NOT_FOUND', `未找到条目：${id}`);
    }
    const summary = this.buildSummary(ctx.entryEl, ctx.groupId, ctx.groupPath, ctx.recycled);
    const customFields: VaultCustomField[] = [];
    for (const strEl of childElements(ctx.entryEl, 'String')) {
      const key = getChildText(strEl, 'Key');
      if (!key || STANDARD_KEYS.has(key)) continue;
      const isProtected = this.isStringProtected(ctx.entryEl, key);
      customFields.push(
        isProtected
          ? { key, protected: true }
          : { key, protected: false, value: this.readStringValue(ctx.entryEl, key) },
      );
    }

    const attachments: VaultAttachmentMeta[] = [];
    for (const binEl of childElements(ctx.entryEl, 'Binary')) {
      const name = getChildText(binEl, 'Key') || '未命名附件';
      const valEl = firstChildElement(binEl, 'Value');
      const refId = valEl?.getAttribute('Ref') ?? '';
      if (refId) {
        attachments.push({ id: refId, name, size: this.getAttachmentSizeByRef(refId) });
      }
    }

    const history: VaultHistorySnapshot[] = [];
    const historyEl = firstChildElement(ctx.entryEl, 'History');
    if (historyEl) {
      childElements(historyEl, 'Entry').forEach((histEl, index) => {
        const timesEl = firstChildElement(histEl, 'Times');
        history.push({
          index,
          title: this.readStringValue(histEl, 'Title'),
          username: this.readStringValue(histEl, 'UserName'),
          url: this.readStringValue(histEl, 'URL'),
          modifiedAt: timesEl ? parseKdbxTime(getChildText(timesEl, 'LastModificationTime')) : null,
        });
      });
    }

    return {
      ...summary,
      notes: this.readStringValue(ctx.entryEl, 'Notes'),
      customFields,
      attachments,
      history,
    };
  }

  readField(id: string, key: string): string {
    this.assertUnlocked();
    const ctx = this.findEntryWithContext(id);
    if (!ctx) {
      throw new VaultError('NOT_FOUND', `未找到条目：${id}`);
    }
    return this.readStringValue(ctx.entryEl, key);
  }

  readTotpConfig(id: string): TotpConfig | null {
    this.assertUnlocked();
    const ctx = this.findEntryWithContext(id);
    if (!ctx) return null;
    return extractTotpFromFields((key) => {
      const val = this.readStringValue(ctx.entryEl, key);
      return val.length > 0 ? val : undefined;
    });
  }

  readAttachment(entryId: string, attachmentId: string): Uint8Array {
    this.assertUnlocked();
    const ctx = this.findEntryWithContext(entryId);
    if (!ctx) throw new VaultError('NOT_FOUND', `未找到条目：${entryId}`);
    const existsOnEntry = childElements(ctx.entryEl, 'Binary').some(
      (b) => firstChildElement(b, 'Value')?.getAttribute('Ref') === attachmentId,
    );
    if (!existsOnEntry) throw new VaultError('NOT_FOUND', `条目不含附件引用：${attachmentId}`);

    if (this.isKdbx4) {
      const idx = Number.parseInt(attachmentId, 10);
      if (!Number.isInteger(idx) || idx < 0 || idx >= this.state.binaries4.length) {
        throw new VaultError('NOT_FOUND', `附件数据不存在：${attachmentId}`);
      }
      return this.state.binaries4[idx].data.slice();
    }

    const binariesEl = firstChildElement(this.metaElement, 'Binaries');
    if (binariesEl) {
      for (const binEl of childElements(binariesEl, 'Binary')) {
        if (binEl.getAttribute('ID') === attachmentId) {
          const raw = fromBase64(binEl.textContent ?? '');
          if (binEl.getAttribute('Compressed')?.toLowerCase() === 'true') {
            return this.crypto.gzipDecompress(raw, KDBX_LIMITS.maxFileBytes);
          }
          return raw;
        }
      }
    }
    throw new VaultError('NOT_FOUND', `附件数据不存在：${attachmentId}`);
  }

  upsertGroup(input: VaultGroupInput): VaultGroup {
    this.assertUnlocked();
    const name = input.name.trim();
    if (!name) throw new VaultError('INVALID_EDIT', '分组名称不能为空。');

    if (input.id) {
      const existing = this.findGroupElement(input.id);
      if (!existing) throw new VaultError('NOT_FOUND', `未找到分组：${input.id}`);
      setChildText(this.state.doc, existing, 'Name', name);
      if (input.notes !== undefined) setChildText(this.state.doc, existing, 'Notes', input.notes);
      if (input.iconId !== undefined) setChildText(this.state.doc, existing, 'IconID', String(input.iconId));
      this.touchTimes(existing, false);
      this.state.dirty = true;
      return this.listGroups().find((g) => g.id === input.id)!;
    }

    const parent = input.parentId ? this.findGroupElement(input.parentId) : this.rootGroupElement;
    if (!parent) throw new VaultError('NOT_FOUND', `未找到父分组：${input.parentId}`);

    const newId = generateUuidBase64((len) => this.crypto.randomBytes(len));
    const groupEl = this.state.doc.createElement('Group');
    setChildText(this.state.doc, groupEl, 'UUID', newId);
    setChildText(this.state.doc, groupEl, 'Name', name);
    setChildText(this.state.doc, groupEl, 'Notes', input.notes ?? '');
    setChildText(this.state.doc, groupEl, 'IconID', String(input.iconId ?? 48));
    this.touchTimes(groupEl, true);
    parent.appendChild(groupEl);
    this.state.dirty = true;
    return this.listGroups().find((g) => g.id === newId)!;
  }

  private ensureRecycleBinGroup(): XmlElement {
    const existingId = this.recycleBinId;
    if (existingId) {
      const el = this.findGroupElement(existingId);
      if (el) return el;
    }
    const newId = generateUuidBase64((len) => this.crypto.randomBytes(len));
    const binEl = this.state.doc.createElement('Group');
    setChildText(this.state.doc, binEl, 'UUID', newId);
    setChildText(this.state.doc, binEl, 'Name', '回收站');
    setChildText(this.state.doc, binEl, 'IconID', '43');
    this.touchTimes(binEl, true);
    this.rootGroupElement.appendChild(binEl);
    setChildText(this.state.doc, this.metaElement, 'RecycleBinEnabled', 'True');
    setChildText(this.state.doc, this.metaElement, 'RecycleBinUUID', newId);
    return binEl;
  }

  deleteGroup(groupId: string, options: { permanent?: boolean } = {}): void {
    this.assertUnlocked();
    const rootId = getChildText(this.rootGroupElement, 'UUID').trim();
    if (groupId === rootId) {
      throw new VaultError('INVALID_EDIT', '不能删除根分组。');
    }
    const target = this.findGroupElement(groupId);
    if (!target || !target.parentNode) {
      throw new VaultError('NOT_FOUND', `未找到分组：${groupId}`);
    }
    if (options.permanent || groupId === this.recycleBinId) {
      target.parentNode.removeChild(target);
    } else {
      const bin = this.ensureRecycleBinGroup();
      if (bin !== target) {
        bin.appendChild(target);
      }
    }
    this.state.dirty = true;
  }

  private appendHistorySnapshot(entryEl: XmlElement): void {
    const clone = entryEl.cloneNode(true) as XmlElement;
    const nestedHistory = firstChildElement(clone, 'History');
    if (nestedHistory) clone.removeChild(nestedHistory);

    // 为克隆出来的受保护节点分配独立槽位，防止后续编辑覆盖历史密码字节
    const rebindSlots = (node: XmlElement): void => {
      if (node.tagName === 'Value' && node.getAttribute('Protected')?.toLowerCase() === 'true') {
        const oldSlot = node.getAttribute('ZeroVaultSlot');
        const copy = oldSlot && this.state.secrets.has(oldSlot)
          ? this.state.secrets.get(oldSlot)!.slice()
          : encodeUtf8(node.textContent ?? '');
        const newSlot = `zv_sec_${this.state.secretCounter++}`;
        this.state.secrets.set(newSlot, copy);
        node.setAttribute('ZeroVaultSlot', newSlot);
        node.textContent = '';
        return;
      }
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1) rebindSlots(c as XmlElement);
      }
    };
    rebindSlots(clone);

    const historyEl = getOrCreateChild(this.state.doc, entryEl, 'History');
    historyEl.appendChild(clone);

    const maxItems = Number.parseInt(getChildText(this.metaElement, 'HistoryMaxItems') || '10', 10) || 10;
    const snapshots = childElements(historyEl, 'Entry');
    while (snapshots.length > maxItems) {
      const oldest = snapshots.shift()!;
      historyEl.removeChild(oldest);
    }
  }

  upsertEntry(input: VaultEntryInput): VaultEntrySummary {
    this.assertUnlocked();
    let entryEl: XmlElement;
    let isNew = false;

    if (input.id) {
      const ctx = this.findEntryWithContext(input.id);
      if (!ctx) {
        throw new VaultError('NOT_FOUND', `未找到待更新条目：${input.id}`);
      }
      entryEl = ctx.entryEl;
      this.appendHistorySnapshot(entryEl);
      if (input.groupId && input.groupId !== ctx.groupId) {
        const targetGroup = this.findGroupElement(input.groupId);
        if (!targetGroup) throw new VaultError('NOT_FOUND', `未找到目标分组：${input.groupId}`);
        targetGroup.appendChild(entryEl);
      }
    } else {
      isNew = true;
      const targetGroup = input.groupId ? this.findGroupElement(input.groupId) : this.rootGroupElement;
      if (!targetGroup) throw new VaultError('NOT_FOUND', `未找到目标分组：${input.groupId}`);
      entryEl = this.state.doc.createElement('Entry');
      const newId = generateUuidBase64((len) => this.crypto.randomBytes(len));
      setChildText(this.state.doc, entryEl, 'UUID', newId);
      setChildText(this.state.doc, entryEl, 'IconID', String(input.iconId ?? 0));
      targetGroup.appendChild(entryEl);
    }

    this.setStringValue(entryEl, 'Title', input.title, false);
    this.setStringValue(entryEl, 'UserName', input.username, false);
    this.setStringValue(entryEl, 'URL', input.url, false);
    if (input.notes !== undefined || isNew) {
      this.setStringValue(entryEl, 'Notes', input.notes ?? '', false);
    }
    if (input.password !== undefined || isNew) {
      this.setStringValue(entryEl, 'Password', input.password ?? '', true);
    }
    if (input.totpUri !== undefined) {
      const cleanOtp = input.totpUri.trim();
      if (cleanOtp.length === 0) {
        this.removeStringKey(entryEl, 'otp');
      } else {
        this.setStringValue(entryEl, 'otp', cleanOtp, true);
      }
    }
    if (input.iconId !== undefined) {
      setChildText(this.state.doc, entryEl, 'IconID', String(input.iconId));
    }
    if (input.tags !== undefined) {
      setChildText(this.state.doc, entryEl, 'Tags', input.tags.map((t) => t.trim()).filter(Boolean).join(';'));
    }
    if (input.customFields) {
      for (const patch of input.customFields) {
        const key = patch.key.trim();
        if (!key || STANDARD_KEYS.has(key)) continue;
        if (patch.value === null) {
          this.removeStringKey(entryEl, key);
        } else {
          this.setStringValue(entryEl, key, patch.value, patch.protected ?? false);
        }
      }
    }

    this.touchTimes(entryEl, isNew);
    if (input.expires !== undefined || input.expiryTime !== undefined) {
      const timesEl = getOrCreateChild(this.state.doc, entryEl, 'Times');
      if (input.expires !== undefined) {
        setChildText(this.state.doc, timesEl, 'Expires', input.expires ? 'True' : 'False');
      }
      if (input.expiryTime) {
        setChildText(this.state.doc, timesEl, 'ExpiryTime', formatKdbxTime(input.expiryTime, this.isKdbx4));
      }
    }

    this.state.dirty = true;
    const entryId = getChildText(entryEl, 'UUID').trim();
    const updatedCtx = this.findEntryWithContext(entryId)!;
    return this.buildSummary(updatedCtx.entryEl, updatedCtx.groupId, updatedCtx.groupPath, updatedCtx.recycled);
  }

  deleteEntry(id: string, options: { permanent?: boolean } = {}): void {
    this.assertUnlocked();
    const ctx = this.findEntryWithContext(id);
    if (!ctx) throw new VaultError('NOT_FOUND', `未找到条目：${id}`);
    const recycleEnabled = getChildText(this.metaElement, 'RecycleBinEnabled').trim().toLowerCase() !== 'false';
    if (options.permanent || ctx.recycled || !recycleEnabled) {
      ctx.entryEl.parentNode?.removeChild(ctx.entryEl);
    } else {
      const bin = this.ensureRecycleBinGroup();
      bin.appendChild(ctx.entryEl);
      this.touchTimes(ctx.entryEl, false);
    }
    this.state.dirty = true;
  }

  restoreEntry(id: string, targetGroupId?: string): VaultEntrySummary {
    this.assertUnlocked();
    const ctx = this.findEntryWithContext(id);
    if (!ctx) throw new VaultError('NOT_FOUND', `未找到条目：${id}`);
    const targetGroup = targetGroupId ? this.findGroupElement(targetGroupId) : this.rootGroupElement;
    if (!targetGroup) throw new VaultError('NOT_FOUND', `未找到目标分组：${targetGroupId}`);
    targetGroup.appendChild(ctx.entryEl);
    this.touchTimes(ctx.entryEl, false);
    this.state.dirty = true;
    const updated = this.findEntryWithContext(id)!;
    return this.buildSummary(updated.entryEl, updated.groupId, updated.groupPath, updated.recycled);
  }

  addAttachment(entryId: string, name: string, data: Uint8Array): VaultAttachmentMeta {
    this.assertUnlocked();
    const ctx = this.findEntryWithContext(entryId);
    if (!ctx) throw new VaultError('NOT_FOUND', `未找到条目：${entryId}`);
    let refId: string;
    if (this.isKdbx4) {
      refId = String(this.state.binaries4.length);
      this.state.binaries4.push({ flags: 0x01, data: data.slice() });
    } else {
      const binariesEl = getOrCreateChild(this.state.doc, this.metaElement, 'Binaries');
      const existingIds = childElements(binariesEl, 'Binary').map((b) => Number.parseInt(b.getAttribute('ID') || '-1', 10));
      const nextId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 0;
      refId = String(nextId);
      const binMetaEl = this.state.doc.createElement('Binary');
      binMetaEl.setAttribute('ID', refId);
      binMetaEl.setAttribute('Compressed', 'True');
      binMetaEl.textContent = toBase64(this.crypto.gzipCompress(data));
      binariesEl.appendChild(binMetaEl);
    }

    const binEl = this.state.doc.createElement('Binary');
    const keyEl = this.state.doc.createElement('Key');
    keyEl.textContent = name;
    const valEl = this.state.doc.createElement('Value');
    valEl.setAttribute('Ref', refId);
    binEl.appendChild(keyEl);
    binEl.appendChild(valEl);
    ctx.entryEl.appendChild(binEl);
    this.touchTimes(ctx.entryEl, false);
    this.state.dirty = true;

    return { id: refId, name, size: data.byteLength };
  }

  removeAttachment(entryId: string, attachmentId: string): void {
    this.assertUnlocked();
    const ctx = this.findEntryWithContext(entryId);
    if (!ctx) throw new VaultError('NOT_FOUND', `未找到条目：${entryId}`);
    for (const binEl of childElements(ctx.entryEl, 'Binary')) {
      if (firstChildElement(binEl, 'Value')?.getAttribute('Ref') === attachmentId) {
        ctx.entryEl.removeChild(binEl);
        this.touchTimes(ctx.entryEl, false);
        this.state.dirty = true;
        return;
      }
    }
    throw new VaultError('NOT_FOUND', `未找到附件引用：${attachmentId}`);
  }

  updateMetadata(patch: { name?: string; description?: string }): void {
    this.assertUnlocked();
    if (patch.name !== undefined) {
      setChildText(this.state.doc, this.metaElement, 'DatabaseName', patch.name.trim());
    }
    if (patch.description !== undefined) {
      setChildText(this.state.doc, this.metaElement, 'DatabaseDescription', patch.description);
    }
    this.state.dirty = true;
  }

  changeCredentials(credentials: VaultCredentials): void {
    this.assertUnlocked();
    const nextKey = deriveCompositeKey(credentials, this.crypto);
    wipeBytes(this.state.compositeKey);
    this.state.compositeKey = nextKey;
    this.state.dirty = true;
  }

  async serialize(): Promise<Uint8Array> {
    this.assertUnlocked();
    // 每次导出都重新生成随机 MasterSeed、IV、KDF Salt 和内层流密钥，符合密码学最佳实践
    const masterSeed = this.crypto.randomBytes(32);
    const encryptionIv = this.crypto.randomBytes(defaultIvLength(this.state.cipher));
    const freshSalt = this.crypto.randomBytes(32);
    const kdf: KdbxKdfParams = { ...this.state.kdf, salt: freshSalt };

    const innerCipher: InnerStreamCipher = this.isKdbx4 ? 'chacha20' : 'salsa20';
    const innerKey = this.crypto.randomBytes(innerCipher === 'chacha20' ? 64 : 32);

    const exportDoc = this.state.doc.cloneNode(true) as XmlDocument;
    const streamProc = new ProtectedStreamProcessor(innerCipher, innerKey, this.crypto);
    let transformedKey: Uint8Array | undefined;
    let masterKey: Uint8Array | undefined;
    let hmacKeyBase: Uint8Array | undefined;

    try {
      transformedKey = await runKdf(this.state.compositeKey, kdf, this.crypto);
      const masterInput = concatBytes(masterSeed, transformedKey);
      masterKey = this.crypto.sha256(masterInput);
      wipeBytes(masterInput);

      if (this.isKdbx4) {
        const hmacSeed = concatBytes(masterSeed, transformedKey, new Uint8Array([0x01]));
        hmacKeyBase = this.crypto.sha512(hmacSeed);
        wipeBytes(hmacSeed);

        const outerHeader = serializeOuterHeader({
          version: this.state.version,
          cipher: this.state.cipher,
          compression: this.state.compression,
          masterSeed,
          encryptionIv,
          kdf,
          comment: this.state.comment,
          publicCustomDataRaw: this.state.publicCustomDataRaw,
        });

        const headerHash = this.crypto.sha256(outerHeader);
        const headerHmacKey = computeBlockHmacKey(hmacKeyBase, HEADER_HMAC_INDEX, this.crypto);
        const headerHmac = this.crypto.hmacSha256(headerHmacKey, outerHeader);
        wipeBytes(headerHmacKey);

        streamProc.applyProtectedValues(exportDoc, this.state.secrets);
        const xmlBytes = encodeUtf8(serializeXml(exportDoc));
        const innerHeader = serializeInnerHeader(innerCipher, innerKey, this.state.binaries4);
        const rawPayload = concatBytes(innerHeader, xmlBytes);
        const compressedPayload = this.state.compression === 'gzip' ? this.crypto.gzipCompress(rawPayload) : rawPayload;
        const encryptedPayload = await encryptCipherPayload(
          this.state.cipher,
          masterKey,
          encryptionIv,
          compressedPayload,
          this.crypto,
        );
        const hmacBlocks = writeHmacBlockStream(encryptedPayload, hmacKeyBase, this.crypto);
        this.state.dirty = false;
        return concatBytes(outerHeader, headerHash, headerHmac, hmacBlocks);
      } else {
        const streamStartBytes = this.crypto.randomBytes(32);
        const outerHeader = serializeOuterHeader({
          version: '3.1',
          cipher: this.state.cipher,
          compression: this.state.compression,
          masterSeed,
          encryptionIv,
          kdf,
          streamStartBytes,
          protectedStreamKey3: innerKey,
          innerStreamCipher3: innerCipher,
          comment: this.state.comment,
        });
        const headerHash = this.crypto.sha256(outerHeader);
        const exportMeta = getOrCreateChild(exportDoc, exportDoc.documentElement!, 'Meta');
        setChildText(exportDoc, exportMeta, 'HeaderHash', toBase64(headerHash));

        streamProc.applyProtectedValues(exportDoc, this.state.secrets);
        const xmlBytes = encodeUtf8(serializeXml(exportDoc));
        const compressedXml = this.state.compression === 'gzip' ? this.crypto.gzipCompress(xmlBytes) : xmlBytes;
        const hashedStream = writeHashedBlockStream(compressedXml, this.crypto);
        const plainWithStart = concatBytes(streamStartBytes, hashedStream);
        const encryptedPayload = await encryptCipherPayload(
          this.state.cipher,
          masterKey,
          encryptionIv,
          plainWithStart,
          this.crypto,
        );
        this.state.dirty = false;
        return concatBytes(outerHeader, encryptedPayload);
      }
    } finally {
      streamProc.destroy();
      wipeBytes(innerKey);
      wipeBytes(transformedKey);
      wipeBytes(masterKey);
      wipeBytes(hmacKeyBase);
    }
  }

  fork(): VaultModel {
    this.assertUnlocked();
    const clonedSecrets = new Map<string, Uint8Array>();
    for (const [k, v] of this.state.secrets) {
      clonedSecrets.set(k, v.slice());
    }
    const clonedState: InternalState = {
      version: this.state.version,
      cipher: this.state.cipher,
      compression: this.state.compression,
      kdf: { ...this.state.kdf, salt: this.state.kdf.salt.slice() },
      innerStreamCipher: this.state.innerStreamCipher,
      comment: this.state.comment?.slice(),
      publicCustomDataRaw: this.state.publicCustomDataRaw?.slice(),
      compositeKey: this.state.compositeKey.slice(),
      doc: this.state.doc.cloneNode(true) as XmlDocument,
      secrets: clonedSecrets,
      secretCounter: this.state.secretCounter,
      binaries4: this.state.binaries4.map((b) => ({ flags: b.flags, data: b.data.slice() })),
      dirty: this.state.dirty,
      locked: false,
    };
    return new KdbxVaultSession(clonedState, this.crypto);
  }

  lock(): void {
    if (this.state.locked) return;
    wipeBytes(this.state.compositeKey);
    for (const secret of this.state.secrets.values()) {
      wipeBytes(secret);
    }
    this.state.secrets.clear();
    for (const bin of this.state.binaries4) {
      wipeBytes(bin.data);
    }
    this.state.binaries4.length = 0;
    this.state.locked = true;
  }
}

/**
 * 加载并解密一个 KDBX 3.1 / 4.0 / 4.1 二进制数据库。
 */
export async function loadVault(
  fileBytes: Uint8Array,
  credentials: VaultCredentials,
  crypto: CryptoProvider = createFallbackCryptoProvider(),
): Promise<VaultModel> {
  const header = parseOuterHeader(fileBytes);
  const compositeKey = deriveCompositeKey(credentials, crypto);
  let transformedKey: Uint8Array | undefined;
  let masterKey: Uint8Array | undefined;
  let hmacKeyBase: Uint8Array | undefined;

  try {
    transformedKey = await runKdf(compositeKey, header.kdf, crypto);
    const masterInput = concatBytes(header.masterSeed, transformedKey);
    masterKey = crypto.sha256(masterInput);
    wipeBytes(masterInput);

    if (header.major === 4) {
      const offset = header.payloadOffset;
      if (fileBytes.byteLength < offset + 64) {
        throw new VaultError('INVALID_FILE', 'KDBX 4.x 缺少头哈希或头 HMAC 校验段。');
      }
      const storedHeaderHash = fileBytes.subarray(offset, offset + 32);
      const storedHeaderHmac = fileBytes.subarray(offset + 32, offset + 64);

      const actualHeaderHash = crypto.sha256(header.rawHeaderBytes);
      if (!constantTimeEqual(storedHeaderHash, actualHeaderHash)) {
        throw new VaultError('INTEGRITY_FAILURE', 'KDBX 4.x 外层头 SHA-256 校验失败，文件可能已损坏。');
      }

      const hmacSeed = concatBytes(header.masterSeed, transformedKey, new Uint8Array([0x01]));
      hmacKeyBase = crypto.sha512(hmacSeed);
      wipeBytes(hmacSeed);

      const headerHmacKey = computeBlockHmacKey(hmacKeyBase, HEADER_HMAC_INDEX, crypto);
      const actualHeaderHmac = crypto.hmacSha256(headerHmacKey, header.rawHeaderBytes);
      wipeBytes(headerHmacKey);
      if (!constantTimeEqual(storedHeaderHmac, actualHeaderHmac)) {
        throw new VaultError('INVALID_CREDENTIALS', '主密码或密钥文件不正确（头 HMAC 认证失败）。');
      }

      const encryptedPayload = readHmacBlockStream(fileBytes.subarray(offset + 64), hmacKeyBase, crypto);
      const decrypted = await decryptCipherPayload(header.cipher, masterKey, header.encryptionIv, encryptedPayload, crypto);
      const plainBytes =
        header.compression === 'gzip' ? crypto.gzipDecompress(decrypted, KDBX_LIMITS.maxXmlBytes) : decrypted;

      const inner = parseInnerHeader(plainBytes);
      const xmlBytes = plainBytes.subarray(inner.xmlOffset);
      const doc = parseSafeXml(decodeUtf8(xmlBytes), 'KeePassFile');
      const streamProc = new ProtectedStreamProcessor(inner.cipher, inner.key, crypto);
      let secrets: Map<string, Uint8Array>;
      try {
        secrets = streamProc.extractProtectedValues(doc);
      } finally {
        streamProc.destroy();
        wipeBytes(inner.key);
      }

      const state: InternalState = {
        version: header.version,
        cipher: header.cipher,
        compression: header.compression,
        kdf: header.kdf,
        innerStreamCipher: inner.cipher,
        comment: header.comment,
        publicCustomDataRaw: header.publicCustomDataRaw,
        compositeKey,
        doc,
        secrets,
        secretCounter: secrets.size,
        binaries4: inner.binaries,
        dirty: false,
        locked: false,
      };
      return new KdbxVaultSession(state, crypto);
    } else {
      // KDBX 3.1
      const encryptedPayload = fileBytes.subarray(header.payloadOffset);
      const decrypted = await decryptCipherPayload(header.cipher, masterKey, header.encryptionIv, encryptedPayload, crypto);
      if (decrypted.length < 32 || !constantTimeEqual(decrypted.subarray(0, 32), header.streamStartBytes!)) {
        throw new VaultError('INVALID_CREDENTIALS', '主密码或密钥文件不正确（KDBX 3.1 启动校验字节不匹配）。');
      }
      const streamData = readHashedBlockStream(decrypted.subarray(32), crypto);
      const xmlBytes =
        header.compression === 'gzip' ? crypto.gzipDecompress(streamData, KDBX_LIMITS.maxXmlBytes) : streamData;
      const doc = parseSafeXml(decodeUtf8(xmlBytes), 'KeePassFile');

      // 校验 Meta/HeaderHash（如存在）
      const metaEl = firstChildElement(doc.documentElement!, 'Meta');
      const storedHashB64 = metaEl ? getChildText(metaEl, 'HeaderHash').trim() : '';
      if (storedHashB64) {
        const storedHash = fromBase64(storedHashB64);
        const actualHash = crypto.sha256(header.rawHeaderBytes);
        if (!constantTimeEqual(storedHash, actualHash)) {
          throw new VaultError('INTEGRITY_FAILURE', 'KDBX 3.1 HeaderHash 校验不匹配。');
        }
      }

      const innerCipher = header.innerStreamCipher3 ?? 'salsa20';
      const streamProc = new ProtectedStreamProcessor(innerCipher, header.protectedStreamKey3!, crypto);
      let secrets: Map<string, Uint8Array>;
      try {
        secrets = streamProc.extractProtectedValues(doc);
      } finally {
        streamProc.destroy();
      }

      const state: InternalState = {
        version: '3.1',
        cipher: header.cipher,
        compression: header.compression,
        kdf: header.kdf,
        innerStreamCipher: innerCipher,
        comment: header.comment,
        compositeKey,
        doc,
        secrets,
        secretCounter: secrets.size,
        binaries4: [],
        dirty: false,
        locked: false,
      };
      return new KdbxVaultSession(state, crypto);
    }
  } catch (err) {
    wipeBytes(compositeKey);
    throw err;
  } finally {
    wipeBytes(transformedKey);
    wipeBytes(masterKey);
    wipeBytes(hmacKeyBase);
  }
}

/**
 * 创建全新的空白 KDBX 数据库（默认 KDBX 4.1 / AES-256-CBC / Argon2id / Gzip）。
 */
export function createVault(
  credentials: VaultCredentials,
  options: VaultCreateOptions = {},
  crypto: CryptoProvider = createFallbackCryptoProvider(),
): VaultModel {
  const version: KdbxVersion = options.version ?? '4.1';
  const isKdbx4 = version !== '3.1';
  const cipher: KdbxCipher = options.cipher ?? 'aes256-cbc';
  const kdfType = isKdbx4 ? (options.kdf ?? 'argon2id') : 'aes-kdf';
  const compositeKey = deriveCompositeKey(credentials, crypto);

  const kdf: KdbxKdfParams =
    kdfType === 'aes-kdf'
      ? {
          type: 'aes-kdf',
          salt: crypto.randomBytes(32),
          rounds: BigInt(options.aesRounds ?? 60000),
        }
      : {
          type: kdfType,
          salt: crypto.randomBytes(32),
          iterations: BigInt(options.kdfIterations ?? 2),
          memoryBytes: BigInt(options.kdfMemoryKiB ?? 16 * 1024) * 1024n,
          parallelism: options.kdfParallelism ?? 2,
          version: 0x13,
        };

  const now = formatKdbxTime(new Date().toISOString(), isKdbx4);
  const rootUuid = generateUuidBase64((len) => crypto.randomBytes(len));
  const dbName = (options.name?.trim() || 'ZeroVault 密码库').replace(/[<>&]/g, '');
  const dbDesc = (options.description ?? '').replace(/[<>&]/g, '');

  const skeletonXml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<KeePassFile>
  <Meta>
    <Generator>ZeroVault</Generator>
    <DatabaseName>${dbName}</DatabaseName>
    <DatabaseDescription>${dbDesc}</DatabaseDescription>
    <RecycleBinEnabled>True</RecycleBinEnabled>
    <RecycleBinUUID>AAAAAAAAAAAAAAAAAAAAAA==</RecycleBinUUID>
    <HistoryMaxItems>10</HistoryMaxItems>
    <HistoryMaxSize>6291456</HistoryMaxSize>
  </Meta>
  <Root>
    <Group>
      <UUID>${rootUuid}</UUID>
      <Name>${dbName}</Name>
      <Notes></Notes>
      <IconID>48</IconID>
      <Times>
        <CreationTime>${now}</CreationTime>
        <LastModificationTime>${now}</LastModificationTime>
        <LastAccessTime>${now}</LastAccessTime>
        <Expires>False</Expires>
        <ExpiryTime>${now}</ExpiryTime>
        <UsageCount>0</UsageCount>
      </Times>
    </Group>
  </Root>
</KeePassFile>`;

  const doc = parseSafeXml(skeletonXml, 'KeePassFile');
  const state: InternalState = {
    version,
    cipher,
    compression: 'gzip',
    kdf,
    innerStreamCipher: isKdbx4 ? 'chacha20' : 'salsa20',
    compositeKey,
    doc,
    secrets: new Map(),
    secretCounter: 0,
    binaries4: [],
    dirty: true,
    locked: false,
  };
  return new KdbxVaultSession(state, crypto);
}

/**
 * 便捷智能解锁助手：
 * 当密码框为空且附带了密钥文件，并且显式开启兼容探测时，
 * 先尝试「无密码组件（password: null）+ 密钥文件」，若凭据失败再尝试「空密码 "" + 密钥文件」，
 * 并返回实际命中的凭据语义，方便记住正确的解锁组合。
 */
export async function loadVaultWithEmptyPasswordProbe(
  fileBytes: Uint8Array,
  options: {
    password: string | null;
    keyFile?: Uint8Array;
    probeEmptyPasswordWithKeyFile?: boolean;
  },
  crypto: CryptoProvider = createFallbackCryptoProvider(),
): Promise<{ vault: VaultModel; resolvedPasswordMode: 'password' | 'empty-password' | 'no-password' }> {
  const tryLoad = async (pwd: string | null): Promise<VaultModel> =>
    loadVault(fileBytes, { password: pwd, keyFile: options.keyFile }, crypto);

  if (options.password !== null && options.password.length > 0) {
    const vault = await tryLoad(options.password);
    return { vault, resolvedPasswordMode: 'password' };
  }

  // 无密钥文件时，只能使用显式空密码 ''
  if (!options.keyFile) {
    const vault = await tryLoad('');
    return { vault, resolvedPasswordMode: 'empty-password' };
  }

  // 有密钥文件且未输入非空密码
  if (!options.probeEmptyPasswordWithKeyFile) {
    const vault = await tryLoad(options.password);
    return {
      vault,
      resolvedPasswordMode: options.password === null ? 'no-password' : 'empty-password',
    };
  }

  // 智能兼容：先试仅密钥文件 (null)，再试空密码 + 密钥文件 ('')
  try {
    const vault = await tryLoad(null);
    return { vault, resolvedPasswordMode: 'no-password' };
  } catch (err) {
    if (err instanceof VaultError && err.code === 'INVALID_CREDENTIALS') {
      const vault = await tryLoad('');
      return { vault, resolvedPasswordMode: 'empty-password' };
    }
    throw err;
  }
}
