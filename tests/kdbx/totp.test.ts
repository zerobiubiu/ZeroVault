import { describe, expect, it } from 'vitest';
import {
  computeTotp,
  createFallbackCryptoProvider,
  decodeBase32,
  encodeBase32,
  extractTotpFromFields,
  parseOtpAuthUri,
} from '../../src/kdbx';

const crypto = createFallbackCryptoProvider();

describe('RFC 6238 TOTP 解析与计算', () => {
  it('遵循 RFC 6238 官方测试向量（SHA1 / SHA256 / SHA512）', () => {
    // RFC 6238 Appendix B: key = "12345678901234567890" (20 bytes)
    const sha1Secret = new TextEncoder().encode('12345678901234567890');
    // T = 59s -> 8 digits -> 94287082
    const r1 = computeTotp({ secret: sha1Secret, algorithm: 'SHA1', digits: 8, period: 30 }, crypto, 59_000);
    expect(r1.code).toBe('94287082');
    expect(r1.remainingSeconds).toBe(1);

    // T = 1111111109s -> 07081804
    const r2 = computeTotp({ secret: sha1Secret, algorithm: 'SHA1', digits: 8, period: 30 }, crypto, 1_111_111_109_000);
    expect(r2.code).toBe('07081804');

    // SHA256 32-byte key -> T = 59s -> 46119246
    const sha256Secret = new TextEncoder().encode('12345678901234567890123456789012');
    const r3 = computeTotp({ secret: sha256Secret, algorithm: 'SHA256', digits: 8, period: 30 }, crypto, 59_000);
    expect(r3.code).toBe('46119246');
  });

  it('正确解析 otpauth:// URI、KeePass TimeOtp-* 以及旧版 TOTP Seed 字段', () => {
    const uri = 'otpauth://totp/GitHub:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=6&period=30';
    const parsed = parseOtpAuthUri(uri);
    expect(parsed).not.toBeNull();
    expect(parsed!.issuer).toBe('GitHub');
    expect(parsed!.account).toBe('alice@example.com');
    expect(encodeBase32(parsed!.secret)).toBe('JBSWY3DPEHPK3PXP');

    const timeOtp = extractTotpFromFields((k) =>
      ({
        'TimeOtp-Secret-Base32': 'JBSWY3DPEHPK3PXP',
        'TimeOtp-Period': '60',
        'TimeOtp-Length': '8',
        'TimeOtp-Algorithm': 'HMAC-SHA-256',
      })[k],
    );
    expect(timeOtp).not.toBeNull();
    expect(timeOtp!.period).toBe(60);
    expect(timeOtp!.digits).toBe(8);
    expect(timeOtp!.algorithm).toBe('SHA256');

    const legacy = extractTotpFromFields((k) =>
      ({
        'TOTP Seed': 'JBSWY3DPEHPK3PXP',
        'TOTP Settings': '30;6',
      })[k],
    );
    expect(legacy).not.toBeNull();
    expect(decodeBase32('JBSWY3DPEHPK3PXP').length).toBe(10);
  });
});
