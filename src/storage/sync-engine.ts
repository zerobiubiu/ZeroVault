/**
 * ZeroVault 同步与冲突状态机：
 * 保证本地加密工作副本与远程 WebDAV/本地 SAF 之间绝不静默覆盖冲突。
 */
import { createFallbackCryptoProvider, toHex, type CryptoProvider } from '../kdbx';
import {
  StorageError,
  type ConflictResolution,
  type VaultSyncMeta,
  type WebDavCredentials,
} from './types';
import { isStrongEtag, WebDavClient } from './webdav';

export type PullOutcome =
  | {
      readonly kind: 'up-to-date';
      readonly syncMeta: VaultSyncMeta;
    }
  | {
      readonly kind: 'fast-forward';
      readonly remoteBytes: Uint8Array;
      readonly syncMeta: VaultSyncMeta;
    }
  | {
      readonly kind: 'local-ahead';
      readonly syncMeta: VaultSyncMeta;
    }
  | {
      readonly kind: 'conflict';
      readonly remoteBytes: Uint8Array;
      readonly remoteHash: string;
      readonly remoteEtag: string | null;
      readonly syncMeta: VaultSyncMeta;
    };

export interface PushOutcome {
  readonly kind: 'pushed' | 'conflict';
  readonly syncMeta: VaultSyncMeta;
  readonly remoteBytes?: Uint8Array;
  readonly remoteHash?: string;
  readonly remoteEtag?: string | null;
}

export function hashBytes(bytes: Uint8Array, crypto: CryptoProvider = createFallbackCryptoProvider()): string {
  return toHex(crypto.sha256(bytes));
}

/**
 * 拉取 WebDAV 最新版本并与本地基准版本/当前本地副本比对，输出精确同步状态。
 */
export async function pullWebDavVault(params: {
  client: WebDavClient;
  url: string;
  syncMeta: VaultSyncMeta;
  localBytes: Uint8Array | null;
  credentials?: WebDavCredentials;
  allowInsecureHttp?: boolean;
  crypto?: CryptoProvider;
}): Promise<PullOutcome> {
  const crypto = params.crypto ?? createFallbackCryptoProvider();
  const localHash = params.localBytes ? hashBytes(params.localBytes, crypto) : params.syncMeta.localHash;
  const localDirty = params.syncMeta.baseHash !== null && localHash !== null && localHash !== params.syncMeta.baseHash;
  const now = new Date().toISOString();

  const download = await params.client.getFile(params.url, params.syncMeta.baseEtag, {
    credentials: params.credentials,
    allowInsecureHttp: params.allowInsecureHttp,
  });

  if (download.kind === 'missing') {
    throw new StorageError('not-found', '远程 WebDAV 上的 KDBX 数据库文件不存在。', 404);
  }

  if (download.kind === 'unchanged') {
    if (localDirty) {
      return {
        kind: 'local-ahead',
        syncMeta: {
          ...params.syncMeta,
          baseEtag: download.etag,
          localHash,
          state: 'dirty',
        },
      };
    }
    return {
      kind: 'up-to-date',
      syncMeta: {
        ...params.syncMeta,
        baseEtag: download.etag,
        localHash,
        lastSyncedAt: now,
        state: 'clean',
      },
    };
  }

  // 下载到远程字节：比较 remoteHash 与 baseHash / localHash
  const remoteChanged = params.syncMeta.baseHash !== null && download.hash !== params.syncMeta.baseHash;

  if (localHash === download.hash) {
    return {
      kind: 'up-to-date',
      syncMeta: {
        baseHash: download.hash,
        baseEtag: download.etag,
        localHash: download.hash,
        lastSyncedAt: now,
        state: 'clean',
      },
    };
  }

  if (!localDirty || params.syncMeta.baseHash === null) {
    // 本地未修改（或首次拉取），安全快进到远程版本
    return {
      kind: 'fast-forward',
      remoteBytes: download.data,
      syncMeta: {
        baseHash: download.hash,
        baseEtag: download.etag,
        localHash: download.hash,
        lastSyncedAt: now,
        state: 'clean',
      },
    };
  }

  if (!remoteChanged) {
    // 远端未变，仅本地有待推送修改
    return {
      kind: 'local-ahead',
      syncMeta: {
        ...params.syncMeta,
        baseEtag: download.etag,
        localHash,
        state: 'dirty',
      },
    };
  }

  // 本地与远端双双发生更改 -> 显式冲突态！
  return {
    kind: 'conflict',
    remoteBytes: download.data,
    remoteHash: download.hash,
    remoteEtag: download.etag,
    syncMeta: {
      ...params.syncMeta,
      localHash,
      state: 'conflict',
    },
  };
}

/**
 * 将本地加密 KDBX 推送至 WebDAV：
 * 1. 若有强 ETag：直接走 If-Match 条件写入，遇 412 拉取远端并进入冲突态；
 * 2. 若无强 ETag：先 GET 核对远端当前哈希是否等于 baseHash，若远端漂移立即中止写入并进入冲突态。
 */
export async function pushWebDavVault(params: {
  client: WebDavClient;
  url: string;
  localBytes: Uint8Array;
  syncMeta: VaultSyncMeta;
  credentials?: WebDavCredentials;
  allowInsecureHttp?: boolean;
  forceOverwrite?: boolean;
  crypto?: CryptoProvider;
}): Promise<PushOutcome> {
  const crypto = params.crypto ?? createFallbackCryptoProvider();
  const localHash = hashBytes(params.localBytes, crypto);
  const now = new Date().toISOString();
  const reqOpts = {
    credentials: params.credentials,
    allowInsecureHttp: params.allowInsecureHttp,
  };

  if (params.forceOverwrite) {
    const putRes = await params.client.putFile(params.url, params.localBytes, null, reqOpts);
    return {
      kind: 'pushed',
      syncMeta: {
        baseHash: putRes.hash,
        baseEtag: putRes.etag,
        localHash: putRes.hash,
        lastSyncedAt: now,
        state: 'clean',
      },
    };
  }

  // 场景 A：持有强 ETag -> 原子条件写入
  if (isStrongEtag(params.syncMeta.baseEtag)) {
    try {
      const putRes = await params.client.putFile(params.url, params.localBytes, params.syncMeta.baseEtag, reqOpts);
      return {
        kind: 'pushed',
        syncMeta: {
          baseHash: putRes.hash,
          baseEtag: putRes.etag,
          localHash: putRes.hash,
          lastSyncedAt: now,
          state: 'clean',
        },
      };
    } catch (err) {
      if (err instanceof StorageError && err.code === 'conflict') {
        const latest = await params.client.getFile(params.url, null, reqOpts);
        return {
          kind: 'conflict',
          syncMeta: { ...params.syncMeta, localHash, state: 'conflict' },
          remoteBytes: latest.kind === 'downloaded' ? latest.data : undefined,
          remoteHash: latest.kind === 'downloaded' ? latest.hash : undefined,
          remoteEtag: latest.kind === 'downloaded' ? latest.etag : null,
        };
      }
      throw err;
    }
  }

  // 场景 B：首次创建（baseHash === null）或服务端不提供强 ETag -> 先校验远端现状
  const check = await params.client.getFile(params.url, null, reqOpts);
  if (check.kind === 'missing') {
    const putRes = await params.client.putFile(params.url, params.localBytes, 'create-only', reqOpts);
    return {
      kind: 'pushed',
      syncMeta: {
        baseHash: putRes.hash,
        baseEtag: putRes.etag,
        localHash: putRes.hash,
        lastSyncedAt: now,
        state: 'clean',
      },
    };
  }

  if (check.kind === 'downloaded') {
    if (params.syncMeta.baseHash !== null && check.hash !== params.syncMeta.baseHash) {
      return {
        kind: 'conflict',
        syncMeta: { ...params.syncMeta, localHash, state: 'conflict' },
        remoteBytes: check.data,
        remoteHash: check.hash,
        remoteEtag: check.etag,
      };
    }
    const expected = isStrongEtag(check.etag) ? check.etag : null;
    const putRes = await params.client.putFile(params.url, params.localBytes, expected, reqOpts);
    return {
      kind: 'pushed',
      syncMeta: {
        baseHash: putRes.hash,
        baseEtag: putRes.etag,
        localHash: putRes.hash,
        lastSyncedAt: now,
        state: 'clean',
      },
    };
  }

  throw new StorageError('invalid-state', '无法确认远程版本状态，已取消写入。');
}

/**
 * 执行用户明确选定的冲突解决策略。
 */
export async function resolveWebDavConflict(params: {
  resolution: ConflictResolution;
  client: WebDavClient;
  url: string;
  localBytes: Uint8Array;
  remoteBytes: Uint8Array;
  remoteHash: string;
  remoteEtag: string | null;
  syncMeta: VaultSyncMeta;
  credentials?: WebDavCredentials;
  allowInsecureHttp?: boolean;
  exportRecoveryCopy?: (localBytes: Uint8Array) => Promise<void>;
  crypto?: CryptoProvider;
}): Promise<{ activeBytes: Uint8Array; syncMeta: VaultSyncMeta }> {
  const now = new Date().toISOString();

  if (params.resolution === 'keep-local-overwrite-remote') {
    const pushed = await pushWebDavVault({
      client: params.client,
      url: params.url,
      localBytes: params.localBytes,
      syncMeta: params.syncMeta,
      credentials: params.credentials,
      allowInsecureHttp: params.allowInsecureHttp,
      forceOverwrite: true,
      crypto: params.crypto,
    });
    return { activeBytes: params.localBytes, syncMeta: pushed.syncMeta };
  }

  if (params.resolution === 'save-local-recovery-then-use-remote') {
    if (!params.exportRecoveryCopy) {
      throw new StorageError('invalid-state', '未提供本地恢复副本导出处理器。');
    }
    await params.exportRecoveryCopy(params.localBytes);
  }

  return {
    activeBytes: params.remoteBytes,
    syncMeta: {
      baseHash: params.remoteHash,
      baseEtag: params.remoteEtag,
      localHash: params.remoteHash,
      lastSyncedAt: now,
      state: 'clean',
    },
  };
}
