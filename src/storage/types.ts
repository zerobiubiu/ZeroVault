/**
 * ZeroVault 多库存储、WebDAV 远程数据库/远程密钥与冲突同步契约。
 */

export type VaultSourceKind = 'local-saf' | 'webdav';

export type PasswordMode = 'password' | 'empty-password' | 'no-password';

export type SyncState =
  | 'clean'
  | 'dirty'
  | 'offline-dirty'
  | 'remote-ahead'
  | 'conflict'
  | 'unknown';

export interface WebDavEndpointConfig {
  readonly url: string;
  readonly username: string;
  /** 默认强制 HTTPS；仅用户显式确认局域网自建服务时可开启 */
  readonly allowInsecureHttp?: boolean;
}

export type KeyFileSourceConfig =
  | { readonly kind: 'none' }
  | { readonly kind: 'local-saf'; readonly uri: string; readonly displayName: string }
  | {
      readonly kind: 'webdav';
      readonly url: string;
      readonly displayName: string;
      readonly useSameAuthAsVault: boolean;
      readonly username?: string;
      readonly allowInsecureHttp?: boolean;
    };

export interface VaultSyncMeta {
  /** 上次成功与来源对齐时的密文 SHA-256 十六进制摘要 */
  readonly baseHash: string | null;
  readonly baseEtag: string | null;
  /** 本地离线加密工作副本当前的 SHA-256 */
  readonly localHash: string | null;
  readonly lastSyncedAt: string | null;
  readonly state: SyncState;
}

/**
 * 持久化存储的非秘密库配置档案。
 * 严禁包含主密码、WebDAV 密码或密钥文件明文！
 */
export interface VaultProfile {
  readonly id: string;
  readonly name: string;
  readonly sourceKind: VaultSourceKind;
  readonly localSafUri?: string;
  readonly localFileName?: string;
  readonly webdav?: WebDavEndpointConfig;
  readonly keyFileSource: KeyFileSourceConfig;
  /** 记住上次成功解锁的密码组件语义（用于正确处理空密码与仅密钥文件） */
  readonly lastPasswordMode: PasswordMode;
  readonly biometricEnabled: boolean;
  readonly biometricStrongBox?: boolean;
  /** 是否为启动默认密码库（冷启动自动唤起解锁） */
  readonly isDefault?: boolean;
  readonly hasCachedWebDavPassword: boolean;
  readonly hasCachedRemoteKeyFile: boolean;
  readonly syncMeta: VaultSyncMeta;
  readonly createdAt: string;
  readonly lastOpenedAt: string | null;
}

export interface WebDavCredentials {
  readonly username: string;
  readonly password: string;
}

export interface WebDavDirectoryItem {
  readonly href: string;
  readonly url: string;
  readonly name: string;
  readonly isDirectory: boolean;
  readonly size: number | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
}

/**
 * 被 Android Keystore + BiometricPrompt 硬件封包的敏感解锁组合（绝不明文落盘）。
 */
export interface BiometricUnlockSecret {
  readonly password: string | null;
  readonly keyFileB64?: string;
  readonly webdavPassword?: string;
  readonly remoteKeyWebdavPassword?: string;
}

export type ConflictResolution =
  | 'keep-local-overwrite-remote'
  | 'use-remote-discard-local'
  | 'save-local-recovery-then-use-remote';

export type StorageErrorCode =
  | 'unsafe-url'
  | 'auth-failed'
  | 'not-found'
  | 'conflict'
  | 'redirect-blocked'
  | 'network'
  | 'http-error'
  | 'permission-revoked'
  | 'invalid-state';

export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    readonly httpStatus?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'StorageError';
  }
}
