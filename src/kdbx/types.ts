/**
 * ZeroVault KDBX 3.1 / 4.0 / 4.1 领域模型与密码学提供者契约。
 */

export type KdbxVersion = '3.1' | '4.0' | '4.1';
export type KdbxCipher = 'aes256-cbc' | 'chacha20' | 'twofish-cbc';
export type KdbxKdf = 'aes-kdf' | 'argon2d' | 'argon2id';
export type KdbxCompression = 'none' | 'gzip';
export type InnerStreamCipher = 'none' | 'salsa20' | 'chacha20';

/**
 * 凭据模型：
 * - password === null 表示「无密码组件」（仅密钥文件模式）
 * - password === '' 表示「显式空密码组件」（允许无密钥文件纯空密码，或空密码 + 密钥文件）
 */
export interface VaultCredentials {
  readonly password: string | null;
  readonly keyFile?: Uint8Array;
}

export interface KdbxKdfParams {
  readonly type: KdbxKdf;
  readonly salt: Uint8Array;
  readonly rounds?: bigint;
  readonly iterations?: bigint;
  readonly memoryBytes?: bigint;
  readonly parallelism?: number;
  readonly version?: number;
}

export interface VaultFormat {
  readonly version: KdbxVersion;
  readonly cipher: KdbxCipher;
  readonly kdf: KdbxKdf;
  readonly compression: KdbxCompression;
}

export interface VaultGroup {
  readonly id: string;
  readonly name: string;
  readonly notes: string;
  readonly iconId: number;
  readonly parentId: string | null;
  readonly path: string;
  readonly isRecycleBin: boolean;
  readonly entryCount: number;
}

/**
 * 普通列表与搜索状态仅持有此摘要，禁止包含明文密码或受保护自定义字段。
 */
export interface VaultEntrySummary {
  readonly id: string;
  readonly groupId: string;
  readonly groupPath: string;
  readonly title: string;
  readonly username: string;
  readonly url: string;
  readonly iconId: number;
  readonly tags: readonly string[];
  readonly hasPassword: boolean;
  readonly hasTotp: boolean;
  readonly hasAttachments: boolean;
  readonly expires: boolean;
  readonly expiryTime: string | null;
  readonly isExpired: boolean;
  readonly recycled: boolean;
  readonly createdAt: string | null;
  readonly modifiedAt: string | null;
}

export interface VaultCustomField {
  readonly key: string;
  readonly protected: boolean;
  /** 当 protected === true 时不在此对象返回明文，需通过 readField 按需读取 */
  readonly value?: string;
}

export interface VaultAttachmentMeta {
  readonly id: string;
  readonly name: string;
  readonly size: number;
}

export interface VaultHistorySnapshot {
  readonly index: number;
  readonly title: string;
  readonly username: string;
  readonly url: string;
  readonly modifiedAt: string | null;
}

export interface VaultEntry extends VaultEntrySummary {
  readonly notes: string;
  readonly customFields: readonly VaultCustomField[];
  readonly attachments: readonly VaultAttachmentMeta[];
  readonly history: readonly VaultHistorySnapshot[];
}

export interface VaultFieldPatch {
  readonly key: string;
  /** null 表示删除该字段 */
  readonly value: string | null;
  readonly protected?: boolean;
}

export interface VaultEntryInput {
  /** 省略表示新建；提供时必须指向已存在的条目 ID */
  readonly id?: string;
  readonly groupId?: string;
  readonly title: string;
  readonly username: string;
  readonly url: string;
  readonly notes?: string;
  readonly iconId?: number;
  readonly tags?: readonly string[];
  /** 编辑时省略则原样保留；传 '' 表示清空密码 */
  readonly password?: string;
  /** 编辑时省略则原样保留；传 '' 表示清除 TOTP URI */
  readonly totpUri?: string;
  readonly expires?: boolean;
  readonly expiryTime?: string | null;
  readonly customFields?: readonly VaultFieldPatch[];
}

export interface VaultGroupInput {
  readonly id?: string;
  readonly parentId?: string | null;
  readonly name: string;
  readonly notes?: string;
  readonly iconId?: number;
}

export interface VaultCreateOptions {
  readonly name?: string;
  readonly description?: string;
  readonly version?: KdbxVersion;
  readonly cipher?: KdbxCipher;
  readonly kdf?: KdbxKdf;
  /** 测试或自定义性能档位可覆写 KDF 参数 */
  readonly kdfIterations?: number;
  readonly kdfMemoryKiB?: number;
  readonly kdfParallelism?: number;
  readonly aesRounds?: number;
}

export interface TotpConfig {
  readonly secret: Uint8Array;
  readonly algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  readonly digits: number;
  readonly period: number;
  readonly issuer?: string;
  readonly account?: string;
}

export interface TotpCodeResult {
  readonly code: string;
  readonly period: number;
  readonly remainingSeconds: number;
  readonly issuer?: string;
  readonly account?: string;
}

/**
 * 密码学原语提供者：
 * - Android 运行时由 Kotlin 原生安全模块实现（硬件/JVM 加速）
 * - Node / Vitest 与回退环境由 crypto-fallback.ts（@noble/* + pako）实现
 */
export interface CryptoProvider {
  readonly name: string;
  randomBytes(length: number): Uint8Array;
  sha256(data: Uint8Array): Uint8Array;
  sha512(data: Uint8Array): Uint8Array;
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;
  hmacSha1(key: Uint8Array, data: Uint8Array): Uint8Array;
  hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array;
  argon2(params: {
    variant: 'argon2d' | 'argon2id';
    password: Uint8Array;
    salt: Uint8Array;
    iterations: number;
    memoryKiB: number;
    parallelism: number;
    version: number;
    hashLength: number;
  }): Promise<Uint8Array>;
  aesKdf(seed: Uint8Array, key: Uint8Array, rounds: bigint): Promise<Uint8Array>;
  aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>;
  aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array>;
  chacha20(key: Uint8Array, nonce: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
  twofishCbcDecrypt?(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array>;
  twofishCbcEncrypt?(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>;
  salsa20Keystream(key32: Uint8Array, nonce8: Uint8Array, length: number): Uint8Array;
  chacha20Keystream(key32: Uint8Array, nonce12: Uint8Array, length: number): Uint8Array;
  gzipCompress(data: Uint8Array): Uint8Array;
  gzipDecompress(data: Uint8Array, maxBytes: number): Uint8Array;
}

export interface VaultModel {
  readonly format: VaultFormat;
  readonly name: string;
  readonly description: string;
  readonly locked: boolean;
  readonly dirty: boolean;
  readonly recycleBinId: string | null;
  listGroups(): readonly VaultGroup[];
  listEntries(options?: { includeRecycled?: boolean }): readonly VaultEntrySummary[];
  getEntry(id: string): VaultEntry;
  /** 按需读取明文密码或受保护自定义字段，调用方不得持久缓存 */
  readField(id: string, key: string): string;
  readTotpConfig(id: string): TotpConfig | null;
  readAttachment(entryId: string, attachmentId: string): Uint8Array;
  upsertGroup(input: VaultGroupInput): VaultGroup;
  deleteGroup(groupId: string, options?: { permanent?: boolean }): void;
  upsertEntry(input: VaultEntryInput): VaultEntrySummary;
  deleteEntry(id: string, options?: { permanent?: boolean }): void;
  restoreEntry(id: string, targetGroupId?: string): VaultEntrySummary;
  addAttachment(entryId: string, name: string, data: Uint8Array): VaultAttachmentMeta;
  removeAttachment(entryId: string, attachmentId: string): void;
  updateMetadata(patch: { name?: string; description?: string }): void;
  /** 更新主凭据（如修改主密码或更换密钥文件），随下次 serialize 生效 */
  changeCredentials(credentials: VaultCredentials): void;
  /** 导出完整 KDBX 加密二进制字节 */
  serialize(): Promise<Uint8Array>;
  /** 事务副本：用于写入/同步失败时回滚 */
  fork(): VaultModel;
  /** 擦除内存敏感字节并锁定会话 */
  lock(): void;
}

export type VaultErrorCode =
  | 'INVALID_FILE'
  | 'UNSUPPORTED_FORMAT'
  | 'UNSUPPORTED_ALGORITHM'
  | 'INVALID_KEYFILE'
  | 'INVALID_CREDENTIALS'
  | 'INTEGRITY_FAILURE'
  | 'RESOURCE_LIMIT'
  | 'LOCKED'
  | 'NOT_FOUND'
  | 'INVALID_EDIT';

export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'VaultError';
  }
}
