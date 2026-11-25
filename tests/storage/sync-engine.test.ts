import { describe, expect, it } from 'vitest';
import {
  createMemoryStoreDeps,
  hashBytes,
  pullWebDavVault,
  pushWebDavVault,
  resolveWebDavConflict,
  VaultProfileStore,
  WebDavClient,
  type VaultSyncMeta,
} from '../../src/storage';

class InMemoryWebDavServer {
  data: Uint8Array;
  etag: string | null;
  constructor(initial: Uint8Array, etag: string | null = '"v1"') {
    this.data = initial.slice();
    this.etag = etag;
  }

  fetcher: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    if (init?.method === 'GET') {
      if (this.etag && headers.get('If-None-Match') === this.etag) {
        return new Response(null, { status: 304, headers: { ETag: this.etag } });
      }
      return new Response(this.data as unknown as BodyInit, {
        status: 200,
        headers: this.etag ? { ETag: this.etag } : {},
      });
    }
    if (init?.method === 'PUT') {
      const ifMatch = headers.get('If-Match');
      if (ifMatch && ifMatch !== this.etag) {
        return new Response(null, { status: 412 });
      }
      const raw = init.body as Uint8Array;
      this.data = raw.slice();
      this.etag = this.etag ? `"v${Date.now()}_${this.data.length}"` : null;
      return new Response(null, { status: 204, headers: this.etag ? { ETag: this.etag } : {} });
    }
    return new Response(null, { status: 405 });
  };
}

describe('WebDAV 同步状态机、冲突防护与硬件封包存储', () => {
  it('准确识别 up-to-date、fast-forward、local-ahead 与双向 conflict，并支持三种冲突解决', async () => {
    const v1 = new Uint8Array([1, 1, 1, 1]);
    const v2Local = new Uint8Array([2, 2, 2, 2]);
    const v2Remote = new Uint8Array([3, 3, 3, 3]);
    const server = new InMemoryWebDavServer(v1, '"etag-1"');
    const client = new WebDavClient(server.fetcher);
    const url = 'https://dav.example.com/vault.kdbx';

    // 首次拉取 -> fast-forward
    const initialMeta: VaultSyncMeta = {
      baseHash: null,
      baseEtag: null,
      localHash: null,
      lastSyncedAt: null,
      state: 'unknown',
    };
    const pull1 = await pullWebDavVault({ client, url, syncMeta: initialMeta, localBytes: null });
    expect(pull1.kind).toBe('fast-forward');
    if (pull1.kind !== 'fast-forward') throw new Error('expected fast-forward');

    // 本地修改但远端未变 -> local-ahead
    const pull2 = await pullWebDavVault({ client, url, syncMeta: pull1.syncMeta, localBytes: v2Local });
    expect(pull2.kind).toBe('local-ahead');

    // 此时远端被其他设备更新 -> 推送触发 412 冲突，绝不静默覆盖！
    server.data = v2Remote.slice();
    server.etag = '"etag-remote-2"';
    const pushAttempt = await pushWebDavVault({
      client,
      url,
      localBytes: v2Local,
      syncMeta: pull1.syncMeta,
    });
    expect(pushAttempt.kind).toBe('conflict');
    expect(pushAttempt.remoteHash).toBe(hashBytes(v2Remote));
    // 验证远端文件未被本地覆盖
    expect(Array.from(server.data)).toEqual([3, 3, 3, 3]);

    // 冲突解决 A：先导出恢复副本再采用远端
    let exportedCopy: Uint8Array | null = null;
    const resolvedA = await resolveWebDavConflict({
      resolution: 'save-local-recovery-then-use-remote',
      client,
      url,
      localBytes: v2Local,
      remoteBytes: v2Remote,
      remoteHash: hashBytes(v2Remote),
      remoteEtag: '"etag-remote-2"',
      syncMeta: pushAttempt.syncMeta,
      exportRecoveryCopy: async (bytes) => {
        exportedCopy = bytes.slice();
      },
    });
    expect(Array.from(exportedCopy!)).toEqual([2, 2, 2, 2]);
    expect(Array.from(resolvedA.activeBytes)).toEqual([3, 3, 3, 3]);
    expect(resolvedA.syncMeta.state).toBe('clean');

    // 冲突解决 B：用户显式选择保留本地覆盖远端
    const resolvedB = await resolveWebDavConflict({
      resolution: 'keep-local-overwrite-remote',
      client,
      url,
      localBytes: v2Local,
      remoteBytes: v2Remote,
      remoteHash: hashBytes(v2Remote),
      remoteEtag: '"etag-remote-2"',
      syncMeta: pushAttempt.syncMeta,
    });
    expect(Array.from(server.data)).toEqual([2, 2, 2, 2]);
    expect(resolvedB.syncMeta.state).toBe('clean');
  });

  it('服务端无 ETag 时通过前置哈希比对拦截远端漂移', async () => {
    const v1 = new Uint8Array([10, 20, 30]);
    const server = new InMemoryWebDavServer(v1, null);
    const client = new WebDavClient(server.fetcher);
    const url = 'https://dav.example.com/noetag.kdbx';

    const baseMeta: VaultSyncMeta = {
      baseHash: hashBytes(v1),
      baseEtag: null,
      localHash: hashBytes(v1),
      lastSyncedAt: new Date().toISOString(),
      state: 'clean',
    };

    // 远端变化
    server.data = new Uint8Array([99, 99, 99]);
    const pushRes = await pushWebDavVault({
      client,
      url,
      localBytes: new Uint8Array([77, 77, 77]),
      syncMeta: baseMeta,
    });
    expect(pushRes.kind).toBe('conflict');
    expect(Array.from(server.data)).toEqual([99, 99, 99]);
  });

  it('VaultProfileStore 完整管理生物识别解锁包、WebDAV 凭据与远程密钥文件加密缓存', async () => {
    const store = new VaultProfileStore(createMemoryStoreDeps());
    await store.enableBiometricUnlock('v1', '公司库', {
      password: null,
      keyFileB64: Buffer.from([1, 2, 3, 4]).toString('base64'),
      webdavPassword: 'dav-app-password',
    });
    const unsealed = await store.unsealBiometricUnlock('v1', '公司库');
    expect(unsealed.password).toBeNull();
    expect(unsealed.webdavPassword).toBe('dav-app-password');

    await store.saveSealedRemoteKeyFile('v1', new Uint8Array([42, 43, 44]));
    const cachedKey = await store.loadSealedRemoteKeyFile('v1');
    expect(Array.from(cachedKey!)).toEqual([42, 43, 44]);

    await store.saveSealedWebDavSecrets('v1', { vaultPassword: 'wp1', remoteKeyPassword: 'kp2' });
    expect(await store.loadSealedWebDavSecrets('v1')).toEqual({ vaultPassword: 'wp1', remoteKeyPassword: 'kp2' });
  });
});
