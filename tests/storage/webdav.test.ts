import { describe, expect, it } from 'vitest';
import {
  isStrongEtag,
  normalizeWebDavUrl,
  StorageError,
  WebDavClient,
} from '../../src/storage';

describe('WebDAV 传输与安全边界', () => {
  it('默认拒绝明文 HTTP、拒绝 URL 内嵌账号密码与查询参数', () => {
    expect(normalizeWebDavUrl('https://dav.example.com/vaults/main.kdbx')).toBe(
      'https://dav.example.com/vaults/main.kdbx',
    );
    expect(() => normalizeWebDavUrl('http://nas.local/main.kdbx')).toThrowError(StorageError);
    expect(normalizeWebDavUrl('http://192.168.1.10:5005/main.kdbx', true)).toBe(
      'http://192.168.1.10:5005/main.kdbx',
    );
    expect(() => normalizeWebDavUrl('https://user:pass@dav.example.com/main.kdbx')).toThrowError(StorageError);
    expect(() => normalizeWebDavUrl('https://dav.example.com/main.kdbx?token=1')).toThrowError(StorageError);
  });

  it('正确识别强/弱 ETag，并在 3xx 重定向时拦截防凭据泄漏', async () => {
    expect(isStrongEtag('"abc-123"')).toBe(true);
    expect(isStrongEtag('W/"weak-1"')).toBe(false);
    expect(isStrongEtag(null)).toBe(false);

    const redirectFetch: typeof fetch = async () =>
      new Response(null, { status: 302, headers: { Location: 'https://evil.example/steal' } });
    const client = new WebDavClient(redirectFetch);
    await expect(
      client.getFile('https://dav.example.com/vault.kdbx', null, {
        credentials: { username: 'alice', password: 'secret' },
      }),
    ).rejects.toMatchObject({ code: 'redirect-blocked' });
  });

  it('支持 GET 304/404/下载与 PUT If-Match 412 冲突检测', async () => {
    let lastAuthHeader: string | null = null;
    let lastIfMatch: string | null = null;
    const mockFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      lastAuthHeader = headers.get('Authorization');
      lastIfMatch = headers.get('If-Match');
      const url = String(input);
      if (init?.method === 'GET' && headers.get('If-None-Match') === '"v1"') {
        return new Response(null, { status: 304, headers: { ETag: '"v1"' } });
      }
      if (url.endsWith('/missing.kdbx')) {
        return new Response(null, { status: 404 });
      }
      if (init?.method === 'PUT' && lastIfMatch === '"stale"') {
        return new Response(null, { status: 412 });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { ETag: '"v2"' } });
    };

    const client = new WebDavClient(mockFetch);
    const creds = { username: 'alice', password: 'pwd' };

    const unchanged = await client.getFile('https://dav.example.com/vault.kdbx', '"v1"', { credentials: creds });
    expect(unchanged).toEqual({ kind: 'unchanged', etag: '"v1"' });
    expect(lastAuthHeader).toBe(`Basic ${Buffer.from('alice:pwd').toString('base64')}`);

    const missing = await client.getFile('https://dav.example.com/missing.kdbx', null, { credentials: creds });
    expect(missing).toEqual({ kind: 'missing' });

    await expect(
      client.putFile('https://dav.example.com/vault.kdbx', new Uint8Array([9]), '"stale"', { credentials: creds }),
    ).rejects.toMatchObject({ code: 'conflict', httpStatus: 412 });
  });

  it('PROPFIND 目录浏览正确列出子目录、KDBX 与远程密钥文件，并拒绝 XXE 负载', async () => {
    const propfindXml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/keepass/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/keepass/backup/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:displayname>backup</d:displayname></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/keepass/personal.kdbx</d:href>
    <d:propstat><d:prop><d:getcontentlength>4096</d:getcontentlength><d:getetag>"e1"</d:getetag></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/keepass/remote.keyx</d:href>
    <d:propstat><d:prop><d:getcontentlength>256</d:getcontentlength><d:getetag>"k1"</d:getetag></d:prop></d:propstat>
  </d:response>
</d:multistatus>`;

    const client = new WebDavClient(async () => new Response(propfindXml, { status: 207 }));
    const list = await client.listDirectory('https://dav.example.com/dav/keepass');
    expect(list.map((i) => ({ name: i.name, isDirectory: i.isDirectory }))).toEqual([
      { name: 'backup', isDirectory: true },
      { name: 'personal.kdbx', isDirectory: false },
      { name: 'remote.keyx', isDirectory: false },
    ]);

    const xxeClient = new WebDavClient(
      async () => new Response('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><d:multistatus/>', { status: 207 }),
    );
    await expect(xxeClient.listDirectory('https://dav.example.com/dav/')).rejects.toThrow();
  });
});
