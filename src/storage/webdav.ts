/**
 * ZeroVault 安全 WebDAV 客户端：
 * - 支持读取/写入远程 KDBX 数据库与远程密钥文件（KeyFile）
 * - 支持 PROPFIND (Depth: 1) 目录浏览（防 XXE）
 * - 默认强制 HTTPS、禁止 URL 内嵌凭据、拒绝重定向防凭据泄漏
 * - Android 真机自动优先通过 Kotlin 原生 OkHttp（ZeroVaultWebDav）传输，绕开 RN whatwg-fetch 限制
 * - 独立 RFC 3986 HTTP(S) URL 解析，避免 React Native URL.js 跨端行为差异
 */
import {
  createFallbackCryptoProvider,
  decodeUtf8,
  encodeUtf8,
  fromBase64,
  toBase64,
  toHex,
  wipeBytes,
  type CryptoProvider,
} from '../kdbx';
import { parseSafeXml } from '../kdbx/xml';
import { getNativeWebDav } from '../native';
import {
  StorageError,
  type WebDavCredentials,
  type WebDavDirectoryItem,
} from './types';

export type WebDavDownloadResult =
  | { readonly kind: 'unchanged'; readonly etag: string | null }
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'downloaded';
      readonly data: Uint8Array;
      readonly hash: string;
      readonly etag: string | null;
    };

export interface WebDavRequestOptions {
  readonly credentials?: WebDavCredentials;
  readonly allowInsecureHttp?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface ParsedHttpUrl {
  readonly protocol: 'http:' | 'https:';
  readonly origin: string;
  readonly pathname: string;
  readonly href: string;
}

interface RawHttpResponse {
  readonly status: number;
  readonly url: string;
  readonly isOpaqueRedirect: boolean;
  readonly getHeader: (name: string) => string | null;
  readonly bytes: () => Promise<Uint8Array>;
  readonly text: () => Promise<string>;
}

export function isStrongEtag(etag: string | null | undefined): etag is string {
  return typeof etag === 'string' && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag.trim());
}

export function parseEtagHeader(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return /^(W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/.test(trimmed) ? trimmed : null;
}

function parseHttpUrlStrict(input: string, allowInsecureHttp = false): ParsedHttpUrl {
  const trimmed = input.trim();
  const match = trimmed.match(/^(https?):\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i);
  if (!match) {
    throw new StorageError('unsafe-url', '请输入有效的完整 WebDAV 地址（例如 https://dav.example.com/vault.kdbx）。');
  }
  const protocol = `${match[1].toLowerCase()}:` as 'http:' | 'https:';
  const authority = match[2];
  const rawPath = match[3] || '/';
  const search = match[4] || '';
  const hash = match[5] || '';

  if (protocol === 'http:' && !allowInsecureHttp) {
    throw new StorageError(
      'unsafe-url',
      'WebDAV 默认仅允许 HTTPS 连接；如确需连接局域网 HTTP 服务，请显式开启「允许非加密 HTTP」开关。',
    );
  }
  if (authority.includes('@') || search.length > 0 || hash.length > 0) {
    throw new StorageError('unsafe-url', 'WebDAV 地址不得包含内嵌账号密码、查询参数或片段，请通过认证表单输入凭据。');
  }
  if (!/^[a-zA-Z0-9._\[\]:-]+$/.test(authority)) {
    throw new StorageError('unsafe-url', 'WebDAV 服务器主机名格式无效。');
  }
  const normalizedAuthority = authority.toLowerCase();
  const origin = `${protocol}//${normalizedAuthority}`;
  const href = `${origin}${rawPath}`;
  return { protocol, origin, pathname: rawPath, href };
}

export function normalizeWebDavUrl(input: string, allowInsecureHttp = false): string {
  return parseHttpUrlStrict(input, allowInsecureHttp).href;
}

function resolveHrefAgainstBase(href: string, base: ParsedHttpUrl): { url: string; pathname: string } | null {
  const clean = href.trim();
  if (!clean) return null;
  if (/^https?:\/\//i.test(clean)) {
    const match = clean.match(/^(https?):\/\/([^/?#]+)(\/[^?#]*)?/i);
    if (!match) return null;
    const pathname = match[3] || '/';
    return { url: `${match[1].toLowerCase()}://${match[2].toLowerCase()}${pathname}`, pathname };
  }
  if (clean.startsWith('/')) {
    return { url: `${base.origin}${clean}`, pathname: clean };
  }
  const baseDir = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  const pathname = `${baseDir}${clean}`;
  return { url: `${base.origin}${pathname}`, pathname };
}

function buildBasicAuthHeader(credentials: WebDavCredentials): string {
  if (credentials.username.includes(':')) {
    throw new StorageError('invalid-state', 'WebDAV 用户名不能包含冒号 (:)。');
  }
  const raw = encodeUtf8(`${credentials.username}:${credentials.password}`);
  try {
    return `Basic ${toBase64(raw)}`;
  } finally {
    wipeBytes(raw);
  }
}

export class WebDavClient {
  constructor(
    private readonly customFetcher?: typeof globalThis.fetch,
    private readonly crypto: CryptoProvider = createFallbackCryptoProvider(),
  ) {}

  async getFile(
    url: string,
    ifNoneMatchEtag: string | null,
    options: WebDavRequestOptions = {},
  ): Promise<WebDavDownloadResult> {
    const headers: Record<string, string> = {};
    if (ifNoneMatchEtag) {
      headers['If-None-Match'] = ifNoneMatchEtag;
    }
    const response = await this.send(url, 'GET', headers, undefined, undefined, options);
    if (response.status === 304) {
      if (!ifNoneMatchEtag) {
        throw new StorageError('http-error', '服务端在无条件请求时异常返回 304。', 304);
      }
      return { kind: 'unchanged', etag: parseEtagHeader(response.getHeader('etag')) ?? ifNoneMatchEtag };
    }
    if (response.status === 404) {
      return { kind: 'missing' };
    }
    this.assertOk(response);
    const bytes = await response.bytes();
    const hash = toHex(this.crypto.sha256(bytes));
    return {
      kind: 'downloaded',
      data: bytes,
      hash,
      etag: parseEtagHeader(response.getHeader('etag')),
    };
  }

  /**
   * 写入远程文件：
   * - expectedEtag === 'create-only' -> 带 If-None-Match: *（仅新建不覆盖）
   * - expectedEtag 为强 ETag -> 带 If-Match 条件写入，远端变化时返回 412 conflict
   * - expectedEtag === null -> 允许在已核验哈希一致或用户显式覆盖后无条件写入
   */
  async putFile(
    url: string,
    data: Uint8Array,
    expectedEtag: string | 'create-only' | null,
    options: WebDavRequestOptions = {},
  ): Promise<{ etag: string | null; hash: string }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    if (expectedEtag === 'create-only') {
      headers['If-None-Match'] = '*';
    } else if (expectedEtag !== null) {
      if (!isStrongEtag(expectedEtag)) {
        throw new StorageError('invalid-state', '仅允许使用强 ETag 执行 If-Match 条件写入。');
      }
      headers['If-Match'] = expectedEtag;
    }

    const response = await this.send(url, 'PUT', headers, data, 'application/octet-stream', options);
    this.assertOk(response);
    const hash = toHex(this.crypto.sha256(data));
    return { etag: parseEtagHeader(response.getHeader('etag')), hash };
  }

  /**
   * 通过标准 WebDAV PROPFIND (Depth: 1) 浏览远程目录，便于选择 .kdbx 库与远程密钥文件。
   */
  async listDirectory(dirUrl: string, options: WebDavRequestOptions = {}): Promise<WebDavDirectoryItem[]> {
    const parsed = parseHttpUrlStrict(dirUrl, options.allowInsecureHttp);
    const targetUrl = parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`;
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<d:propfind xmlns:d="DAV:"><d:prop>' +
      '<d:resourcetype/><d:getcontentlength/><d:getetag/><d:getlastmodified/><d:displayname/>' +
      '</d:prop></d:propfind>';
    const headers: Record<string, string> = {
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8',
    };
    const response = await this.send(
      targetUrl,
      'PROPFIND',
      headers,
      encodeUtf8(body),
      'application/xml; charset=utf-8',
      options,
    );
    if (response.status !== 207 && (response.status < 200 || response.status >= 300)) {
      this.assertOk(response);
    }
    const xmlText = await response.text();
    return this.parsePropfindResponse(xmlText, parseHttpUrlStrict(targetUrl, options.allowInsecureHttp));
  }

  async testConnection(url: string, options: WebDavRequestOptions = {}): Promise<{ ok: boolean; status: number }> {
    const response = await this.send(url, 'HEAD', {}, undefined, undefined, options);
    if (response.status === 401 || response.status === 403) {
      throw new StorageError('auth-failed', 'WebDAV 认证失败，请检查用户名与应用专用密码。', response.status);
    }
    return { ok: (response.status >= 200 && response.status < 300) || response.status === 405, status: response.status };
  }

  private parsePropfindResponse(xmlText: string, baseParsed: ParsedHttpUrl): WebDavDirectoryItem[] {
    const doc = parseSafeXml(xmlText);
    const basePath = decodeURIComponent(baseParsed.pathname).replace(/\/+$/, '') || '/';
    const items: WebDavDirectoryItem[] = [];

    const allNodes = doc.getElementsByTagName('*');
    for (let i = 0; i < allNodes.length; i++) {
      const node = allNodes[i];
      const localName = node.localName || node.tagName.split(':').pop();
      if (localName !== 'response') continue;

      let href = '';
      let displayName = '';
      let isDirectory = false;
      let size: number | null = null;
      let etag: string | null = null;
      let lastModified: string | null = null;

      const descendants = node.getElementsByTagName('*');
      for (let j = 0; j < descendants.length; j++) {
        const el = descendants[j];
        const tag = el.localName || el.tagName.split(':').pop();
        if (tag === 'href' && !href) href = (el.textContent ?? '').trim();
        else if (tag === 'displayname' && !displayName) displayName = (el.textContent ?? '').trim();
        else if (tag === 'collection') isDirectory = true;
        else if (tag === 'getcontentlength') {
          const parsedSize = Number.parseInt((el.textContent ?? '').trim(), 10);
          if (Number.isFinite(parsedSize)) size = parsedSize;
        } else if (tag === 'getetag') etag = parseEtagHeader(el.textContent);
        else if (tag === 'getlastmodified') lastModified = (el.textContent ?? '').trim() || null;
      }

      if (!href) continue;
      const resolved = resolveHrefAgainstBase(href, baseParsed);
      if (!resolved) continue;

      let itemPath: string;
      try {
        itemPath = decodeURIComponent(resolved.pathname).replace(/\/+$/, '') || '/';
      } catch {
        itemPath = resolved.pathname.replace(/\/+$/, '') || '/';
      }
      if (itemPath === basePath) continue;

      const fallbackName = itemPath.split('/').filter(Boolean).pop() ?? itemPath;
      items.push({
        href,
        url: resolved.url,
        name: displayName || fallbackName,
        isDirectory,
        size,
        etag,
        lastModified,
      });
    }

    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return items;
  }

  private async send(
    inputUrl: string,
    method: 'GET' | 'PUT' | 'HEAD' | 'PROPFIND',
    rawHeaders: Record<string, string>,
    body: Uint8Array | undefined,
    contentType: string | undefined,
    options: WebDavRequestOptions,
  ): Promise<RawHttpResponse> {
    const parsedUrl = parseHttpUrlStrict(inputUrl, options.allowInsecureHttp);
    const reqHeaders: Record<string, string> = { ...rawHeaders };
    const timeoutMs = options.timeoutMs ?? 25_000;

    try {
      if (options.credentials && (options.credentials.username || options.credentials.password)) {
        reqHeaders.Authorization = buildBasicAuthHeader(options.credentials);
      }

      // Android 真机（未显式注入 mock fetcher 时）优先走原生 OkHttp，原生支持 PROPFIND 与原始二进制字节
      const nativeDav = this.customFetcher ? null : getNativeWebDav();
      let wrapped: RawHttpResponse;

      if (nativeDav) {
        const res = await nativeDav.request(
          parsedUrl.href,
          method,
          reqHeaders,
          body !== undefined ? toBase64(body) : null,
          contentType ?? null,
          timeoutMs,
        );
        const bodyBytes = res.bodyB64 ? fromBase64(res.bodyB64) : new Uint8Array(0);
        wrapped = {
          status: res.status,
          url: res.url,
          isOpaqueRedirect: false,
          getHeader: (name) => res.headers[name.toLowerCase()] ?? null,
          bytes: async () => bodyBytes,
          text: async () => decodeUtf8(bodyBytes),
        };
      } else {
        const fetcher = this.customFetcher ?? globalThis.fetch.bind(globalThis);
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted) controller.abort();
        const timer = setTimeout(onAbort, timeoutMs);
        try {
          const response = await fetcher(parsedUrl.href, {
            method,
            headers: reqHeaders,
            ...(body !== undefined ? { body: body as unknown as BodyInit } : {}),
            signal: controller.signal,
            redirect: 'manual',
            credentials: 'omit',
            cache: 'no-store',
          });
          wrapped = {
            status: response.status,
            url: response.url,
            isOpaqueRedirect: response.type === 'opaqueredirect',
            getHeader: (name) => response.headers.get(name),
            bytes: async () => new Uint8Array(await response.arrayBuffer()),
            text: async () => response.text(),
          };
        } finally {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
        }
      }

      if (
        wrapped.isOpaqueRedirect ||
        (wrapped.status >= 300 && wrapped.status < 400 && wrapped.status !== 304)
      ) {
        throw new StorageError(
          'redirect-blocked',
          '检测到 WebDAV 重定向，为防止认证凭据泄漏已阻止，请使用最终直连地址。',
          wrapped.status,
        );
      }
      if (wrapped.url) {
        const actualMatch = wrapped.url.match(/^(https?):\/\/([^/?#]+)/i);
        if (actualMatch) {
          const actualOrigin = `${actualMatch[1].toLowerCase()}://${actualMatch[2].toLowerCase()}`;
          if (actualOrigin !== parsedUrl.origin) {
            throw new StorageError('redirect-blocked', 'WebDAV 响应源地址发生变化，已拒绝。');
          }
        }
      }
      return wrapped;
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw new StorageError(
        'network',
        `WebDAV 网络请求失败：${err instanceof Error ? err.message : String(err)}`,
        undefined,
        { cause: err },
      );
    } finally {
      delete reqHeaders.Authorization;
    }
  }

  private assertOk(response: RawHttpResponse): void {
    if (response.status >= 200 && response.status < 300) return;
    if (response.status === 401 || response.status === 403) {
      throw new StorageError('auth-failed', 'WebDAV 认证失败或权限不足，请检查账号与密码。', response.status);
    }
    if (response.status === 404) {
      throw new StorageError('not-found', '远程 WebDAV 文件不存在。', 404);
    }
    if (response.status === 412) {
      throw new StorageError(
        'conflict',
        '远程数据库已被其他设备修改（HTTP 412），已保护你的本地更改不被静默覆盖。',
        412,
      );
    }
    throw new StorageError('http-error', `WebDAV 服务端返回错误状态码：HTTP ${response.status}`, response.status);
  }
}
