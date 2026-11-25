import { describe, expect, it } from 'vitest';
import {
  buildCredentialsFromMode,
  createFallbackCryptoProvider,
  deriveCompositeKey,
  generateKeyFileV2,
  parseKeyFileComponent,
  toHex,
  VaultError,
} from '../../src/kdbx';

const crypto = createFallbackCryptoProvider();

describe('KDBX 复合密钥与密钥文件规则', () => {
  it('严格区分「仅密钥文件 (password: null)」与「空密码 "" + 密钥文件」', () => {
    const keyFile = new Uint8Array(32).fill(0x5a);
    const keyOnly = deriveCompositeKey({ password: null, keyFile }, crypto);
    const emptyPwdAndKey = deriveCompositeKey({ password: '', keyFile }, crypto);
    const emptyPwdOnly = deriveCompositeKey({ password: '' }, crypto);

    expect(toHex(keyOnly)).not.toBe(toHex(emptyPwdAndKey));
    expect(toHex(emptyPwdOnly)).not.toBe(toHex(emptyPwdAndKey));
    expect(keyOnly).toHaveLength(32);
    expect(emptyPwdAndKey).toHaveLength(32);
    expect(emptyPwdOnly).toHaveLength(32);
  });

  it('无密码且无密钥文件时抛出 INVALID_CREDENTIALS', () => {
    expect(() => deriveCompositeKey({ password: null }, crypto)).toThrowError(VaultError);
    try {
      deriveCompositeKey({ password: null }, crypto);
    } catch (err) {
      expect((err as VaultError).code).toBe('INVALID_CREDENTIALS');
    }
  });

  it('正确解析 XML KeyFile v2.0 并在校验和损坏时拒绝', () => {
    const keyFileV2 = generateKeyFileV2(crypto);
    const parsed = parseKeyFileComponent(keyFileV2, crypto);
    expect(parsed).toHaveLength(32);

    const corruptedText = new TextDecoder().decode(keyFileV2).replace(/Hash="[0-9A-F]{8}"/, 'Hash="DEADBEEF"');
    expect(() => parseKeyFileComponent(new TextEncoder().encode(corruptedText), crypto)).toThrowError(VaultError);
  });

  it('正确解析 XML KeyFile v1.0、32B 原始密钥、64B Hex 与零字节二进制密钥文件', () => {
    const raw32 = new Uint8Array(32);
    for (let i = 0; i < 32; i++) raw32[i] = i;

    // 32B 原样返回
    expect(toHex(parseKeyFileComponent(raw32, crypto))).toBe(toHex(raw32));

    // 64B Hex 解码为 32B
    const hex64 = new TextEncoder().encode(toHex(raw32));
    expect(toHex(parseKeyFileComponent(hex64, crypto))).toBe(toHex(raw32));

    // XML v1.0 Base64
    const v1Xml = `<?xml version="1.0" encoding="utf-8"?>
<KeyFile><Meta><Version>1.00</Version></Meta><Key><Data>${Buffer.from(raw32).toString('base64')}</Data></Key></KeyFile>`;
    expect(toHex(parseKeyFileComponent(new TextEncoder().encode(v1Xml), crypto))).toBe(toHex(raw32));

    // 0 字节文件属于合法任意二进制文件，按 SHA-256 哈希
    const emptyFileKey = parseKeyFileComponent(new Uint8Array(0), crypto);
    expect(toHex(emptyFileKey)).toBe(toHex(crypto.sha256(new Uint8Array(0))));
  });

  it('拒绝包含 DOCTYPE / ENTITY 的 XXE 恶意密钥文件', () => {
    const xxe = new TextEncoder().encode('<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><KeyFile/>');
    expect(() => parseKeyFileComponent(xxe, crypto)).toThrowError(VaultError);
  });

  it('buildCredentialsFromMode 输出正确凭据语义', () => {
    const kf = new Uint8Array([1, 2, 3]);
    expect(buildCredentialsFromMode('empty-password-only', 'ignored')).toEqual({ password: '' });
    expect(buildCredentialsFromMode('keyfile-only', 'ignored', kf)).toEqual({ password: null, keyFile: kf });
    expect(buildCredentialsFromMode('password-and-keyfile', '', kf)).toEqual({ password: '', keyFile: kf });
  });
});
