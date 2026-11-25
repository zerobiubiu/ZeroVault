import { describe, expect, it } from 'vitest';
import { createFallbackCryptoProvider } from '../../src/kdbx';
import {
  evaluatePasswordStrength,
  generatePassphrase,
  generatePassword,
  generatePin,
  shouldAutoLock,
} from '../../src/security';

const crypto = createFallbackCryptoProvider();

describe('密码生成器、强度评估与自动锁库', () => {
  it('生成符合长度、字符集约束与排除易混淆字符的高熵密码、词组与 PIN', () => {
    const pwd = generatePassword(
      { length: 24, uppercase: true, lowercase: true, digits: true, symbols: true, excludeAmbiguous: true },
      crypto,
    );
    expect(pwd).toHaveLength(24);
    expect(/[A-Z]/.test(pwd)).toBe(true);
    expect(/[a-z]/.test(pwd)).toBe(true);
    expect(/\d/.test(pwd)).toBe(true);
    expect(/[^a-zA-Z0-9]/.test(pwd)).toBe(true);
    expect(/[0Oo1lI|]/.test(pwd)).toBe(false);

    const phrase = generatePassphrase({ wordCount: 5, separator: '-', capitalize: true, includeNumber: true }, crypto);
    expect(phrase.split('-')).toHaveLength(5);
    expect(/\d{2}/.test(phrase)).toBe(true);

    const pin = generatePin(8, crypto);
    expect(pin).toMatch(/^\d{8}$/);
  });

  it('准确识别高频弱口令、顺序字符与强随机密码', () => {
    expect(evaluatePasswordStrength('password123').level).toBe('very-weak');
    expect(evaluatePasswordStrength('12345678').level).toBe('very-weak');
    const strong = evaluatePasswordStrength('K9#vM2$pQ8!xR5&zL7@wN4');
    expect(['strong', 'very-strong']).toContain(strong.level);
    expect(strong.score).toBeGreaterThanOrEqual(80);
  });

  it('自动锁库超时判断符合预期', () => {
    expect(shouldAutoLock(1000, 1001, 0)).toBe(true);
    expect(shouldAutoLock(1000, 50_000, 60_000)).toBe(false);
    expect(shouldAutoLock(1000, 61_000, 60_000)).toBe(true);
    expect(shouldAutoLock(1000, 999_999_999, -1)).toBe(false);
    expect(shouldAutoLock(null, 999_999, 0)).toBe(false);
  });
});
