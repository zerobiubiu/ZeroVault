/**
 * RFC 6238 / RFC 4226 TOTP 解析与实时验证码计算。
 * 兼容标准 otpauth:// URI、KeePass 2.x TimeOtp-* 字段及 KeePass2Android/KeeTrayTOTP 旧字段。
 */
import { fromHex } from './binary';
import type { CryptoProvider, TotpCodeResult, TotpConfig } from './types';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function decodeBase32(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s=-]+/g, '');
  if (clean.length === 0) return new Uint8Array(0);
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx < 0) {
      throw new Error('无效的 Base32 TOTP 密钥字符。');
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

export function encodeBase32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

function normalizeAlgorithm(raw: string | null | undefined): 'SHA1' | 'SHA256' | 'SHA512' {
  const upper = (raw ?? 'SHA1').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (upper === 'SHA256' || upper === 'HMACSHA256') return 'SHA256';
  if (upper === 'SHA512' || upper === 'HMACSHA512') return 'SHA512';
  return 'SHA1';
}

export function parseOtpAuthUri(uri: string): TotpConfig | null {
  const trimmed = uri.trim();
  if (!/^otpauth:\/\/totp\//i.test(trimmed)) {
    return null;
  }
  try {
    // 不依赖 React Native 简陋版 URL.pathname（RN URL 正则仅匹配 http/https），手动按 RFC 规范解析
    const withoutScheme = trimmed.slice('otpauth://totp/'.length);
    const qIdx = withoutScheme.indexOf('?');
    const rawLabel = qIdx >= 0 ? withoutScheme.slice(0, qIdx) : withoutScheme;
    const rawQuery = qIdx >= 0 ? withoutScheme.slice(qIdx + 1).split('#')[0] : '';

    const params = new Map<string, string>();
    if (rawQuery) {
      for (const part of rawQuery.split('&')) {
        if (!part) continue;
        const eqIdx = part.indexOf('=');
        const k = decodeURIComponent(eqIdx >= 0 ? part.slice(0, eqIdx) : part).toLowerCase();
        const v = decodeURIComponent((eqIdx >= 0 ? part.slice(eqIdx + 1) : '').replace(/\+/g, ' '));
        params.set(k, v);
      }
    }

    const secretRaw = params.get('secret');
    if (!secretRaw) return null;
    const secret = decodeBase32(secretRaw);
    if (secret.length === 0) return null;

    const digitsNum = Number.parseInt(params.get('digits') ?? '6', 10);
    const periodNum = Number.parseInt(params.get('period') ?? '30', 10);
    const label = decodeURIComponent(rawLabel.replace(/^\/+/, ''));
    const [labelIssuer, labelAccount] = label.includes(':') ? label.split(':', 2) : [undefined, label || undefined];
    const issuer = params.get('issuer') || labelIssuer || undefined;

    return {
      secret,
      algorithm: normalizeAlgorithm(params.get('algorithm')),
      digits: digitsNum === 7 || digitsNum === 8 ? digitsNum : 6,
      period: Number.isFinite(periodNum) && periodNum >= 10 && periodNum <= 300 ? periodNum : 30,
      issuer,
      account: labelAccount,
    };
  } catch {
    return null;
  }
}

/**
 * 从条目字段集合中按优先级解析 TOTP 配置。
 */
export function extractTotpFromFields(getField: (key: string) => string | undefined): TotpConfig | null {
  // 1. 标准 otp / otpauth 字段
  const otpRaw = getField('otp') || getField('TOTP');
  if (otpRaw) {
    const parsed = parseOtpAuthUri(otpRaw);
    if (parsed) return parsed;
    // 部分用户直接把 Base32 密钥填入 otp 字段
    try {
      const secret = decodeBase32(otpRaw);
      if (secret.length >= 10) {
        return { secret, algorithm: 'SHA1', digits: 6, period: 30 };
      }
    } catch {
      // 忽略无效内容
    }
  }

  // 2. KeePass 2.x 原生 TimeOtp-* 字段
  const secretBase32 = getField('TimeOtp-Secret-Base32');
  const secretHex = getField('TimeOtp-Secret-Hex');
  if (secretBase32 || secretHex) {
    try {
      const secret = secretBase32 ? decodeBase32(secretBase32) : fromHex(secretHex!);
      if (secret.length > 0) {
        const digits = Number.parseInt(getField('TimeOtp-Length') ?? '6', 10);
        const period = Number.parseInt(getField('TimeOtp-Period') ?? '30', 10);
        return {
          secret,
          algorithm: normalizeAlgorithm(getField('TimeOtp-Algorithm')),
          digits: digits === 7 || digits === 8 ? digits : 6,
          period: Number.isFinite(period) && period >= 10 && period <= 300 ? period : 30,
        };
      }
    } catch {
      return null;
    }
  }

  // 3. KeePass2Android / KeeTrayTOTP 旧字段（TOTP Seed + TOTP Settings）
  const legacySeed = getField('TOTP Seed');
  if (legacySeed) {
    try {
      const secret = decodeBase32(legacySeed);
      if (secret.length > 0) {
        const settings = (getField('TOTP Settings') ?? '30;6').split(';');
        const period = Number.parseInt(settings[0] ?? '30', 10);
        const digits = Number.parseInt(settings[1] ?? '6', 10);
        return {
          secret,
          algorithm: 'SHA1',
          digits: digits === 7 || digits === 8 ? digits : 6,
          period: Number.isFinite(period) && period >= 10 && period <= 300 ? period : 30,
        };
      }
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * 计算当前时间戳下的 TOTP 验证码与剩余秒数。
 */
export function computeTotp(
  config: TotpConfig,
  crypto: CryptoProvider,
  timestampMs: number = Date.now(),
): TotpCodeResult {
  const epochSeconds = Math.floor(timestampMs / 1000);
  const counter = BigInt(Math.floor(epochSeconds / config.period));
  const counterBuf = new Uint8Array(8);
  new DataView(counterBuf.buffer).setBigUint64(0, counter, false); // RFC 4226 规定大端序

  const digest =
    config.algorithm === 'SHA256'
      ? crypto.hmacSha256(config.secret, counterBuf)
      : config.algorithm === 'SHA512'
        ? crypto.hmacSha512(config.secret, counterBuf)
        : crypto.hmacSha1(config.secret, counterBuf);

  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  const mod = 10 ** config.digits;
  const code = String(binary % mod).padStart(config.digits, '0');
  const remainingSeconds = config.period - (epochSeconds % config.period);

  return {
    code,
    period: config.period,
    remainingSeconds,
    issuer: config.issuer,
    account: config.account,
  };
}
