import { describe, expect, it } from 'vitest';
import { decodeUtf8, encodeUtf8, VaultError } from '../../src/kdbx';

describe('纯 TypeScript UTF-8 编解码（Hermes 无 TextEncoder/TextDecoder 兼容）', () => {
  it('精确往返 ASCII、简体中文、特殊符号与 4 字节 Emoji 代理对，并兼容 UTF-8 BOM', () => {
    const sample = 'ZeroVault 密码库🔐🚀 — café & 日本語';
    const bytes = encodeUtf8(sample);
    expect(decodeUtf8(bytes)).toBe(sample);

    // 验证与 Node Buffer UTF-8 字节逐字节一致
    expect(Array.from(bytes)).toEqual(Array.from(Buffer.from(sample, 'utf8')));

    // 验证 UTF-8 BOM 跳过
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]);
    expect(decodeUtf8(withBom)).toBe(sample);
  });

  it('遇到非法字节序列或非规范过长编码时严格抛错（等价 fatal: true）', () => {
    // 非法单独续字节
    expect(() => decodeUtf8(new Uint8Array([0x80]))).toThrowError(VaultError);
    // 过长编码 0xC0 0xAF
    expect(() => decodeUtf8(new Uint8Array([0xc0, 0xaf]))).toThrowError(VaultError);
    // 截断的 3 字节中文
    expect(() => decodeUtf8(new Uint8Array([0xe5, 0xaf]))).toThrowError(VaultError);
    // 落入 UTF-16 代理区 U+D800
    expect(() => decodeUtf8(new Uint8Array([0xed, 0xa0, 0x80]))).toThrowError(VaultError);
  });
});
