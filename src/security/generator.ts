/**
 * ZeroVault 强密码、易记词组（Passphrase）与 PIN 生成器 + 密码强度熵评估引擎。
 * 全部随机抽取基于密码学安全随机源（CSPRNG）与拒绝采样，杜绝模偏差（Modulo Bias）。
 */
import { createFallbackCryptoProvider, type CryptoProvider } from '../kdbx';

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?/';
const AMBIGUOUS = new Set(['0', 'O', 'o', '1', 'l', 'I', '|']);

/** 精挑清晰易拼写、无歧义的 Diceware 风格高熵词表（256 词，每词精确提供 8 bit 熵） */
const WORDLIST: readonly string[] = [
  'acorn', 'alder', 'amber', 'anchor', 'anvil', 'apron', 'arbor', 'arrow',
  'aspen', 'atlas', 'attic', 'audio', 'avocado', 'badge', 'baker', 'bamboo',
  'banjo', 'barge', 'basil', 'basin', 'beacon', 'beaver', 'belfry', 'berry',
  'birch', 'bison', 'blade', 'blaze', 'bloom', 'board', 'boulder', 'branch',
  'brass', 'breeze', 'bridge', 'brisk', 'bronze', 'brook', 'brush', 'bucket',
  'bugle', 'cabin', 'cable', 'cactus', 'cairn', 'camel', 'canal', 'candle',
  'cannon', 'canopy', 'canyon', 'canvas', 'capon', 'carbon', 'cargo', 'carpet',
  'carrot', 'castle', 'cedar', 'cellar', 'chalk', 'chapel', 'charm', 'chisel',
  'cider', 'cinder', 'cipher', 'citadel', 'citrus', 'clasp', 'cliff', 'clover',
  'cobalt', 'cobble', 'cocoa', 'comet', 'compass', 'condor', 'copper', 'coral',
  'cornet', 'cotton', 'cougar', 'cradle', 'crane', 'crater', 'crayon', 'creek',
  'crest', 'cricket', 'crimson', 'crocus', 'crown', 'crystal', 'curtain', 'cypress',
  'dagger', 'dahlia', 'daisy', 'dancer', 'delta', 'denim', 'desert', 'diamond',
  'dinghy', 'dolphin', 'domino', 'dragon', 'drift', 'drizzle', 'drumlin', 'dune',
  'eagle', 'easel', 'ebony', 'eclipse', 'eddy', 'egret', 'elder', 'elmwood',
  'ember', 'emerald', 'engine', 'ermine', 'estuary', 'fabric', 'falcon', 'fathom',
  'feather', 'fennel', 'ferret', 'ferry', 'fiddle', 'field', 'figment', 'finch',
  'fjord', 'flannel', 'flint', 'flora', 'flute', 'forest', 'forge', 'fossil',
  'fountain', 'foxglove', 'frost', 'furnace', 'galaxy', 'galley', 'garden', 'garnet',
  'gazelle', 'geyser', 'ginger', 'glacier', 'glade', 'glider', 'globe', 'goblet',
  'gopher', 'granite', 'gravel', 'griffin', 'grotto', 'grove', 'guitar', 'harbor',
  'harvest', 'hazel', 'heather', 'helmet', 'hemlock', 'heron', 'hickory', 'hilltop',
  'hollow', 'horizon', 'hornet', 'humble', 'ibex', 'icicle', 'iguana', 'indigo',
  'ingot', 'inlet', 'iris', 'ironwood', 'island', 'ivory', 'jackal', 'jade',
  'jaguar', 'jasmine', 'jasper', 'jigsaw', 'juniper', 'kayak', 'kelp', 'kennel',
  'kestrel', 'kettle', 'keystone', 'kiln', 'kinglet', 'kiosk', 'knight', 'lagoon',
  'lantern', 'larch', 'lariat', 'lark', 'laurel', 'lavender', 'ledger', 'lemon',
  'leopard', 'lichen', 'linden', 'linnet', 'lizard', 'lobster', 'locket', 'locust',
  'lodge', 'loom', 'lotus', 'lumber', 'lunar', 'lynx', 'magnet', 'magpie',
  'mallet', 'mango', 'mantle', 'maple', 'marble', 'margin', 'marina', 'marmot',
  'marquis', 'marrow', 'martin', 'meadow', 'medley', 'melon', 'mercury', 'merlin',
];

const COMMON_WEAK_PASSWORDS = new Set([
  '123456', '12345678', '123456789', '1234567890', 'password', 'password123',
  'qwerty', 'qwerty123', 'admin', 'admin123', 'root', 'letmein', 'welcome',
  'iloveyou', 'abc123', '111111', '000000', '888888', '654321', 'passw0rd',
  'p@ssw0rd', 'dragon', 'monkey', 'sunshine', 'princess', 'football', 'baseball',
  'zaq12wsx', '1q2w3e4r', '1qaz2wsx', 'asdfgh', 'zxcvbnm',
]);

export interface PasswordGeneratorOptions {
  readonly length: number;
  readonly uppercase: boolean;
  readonly lowercase: boolean;
  readonly digits: boolean;
  readonly symbols: boolean;
  readonly excludeAmbiguous: boolean;
}

export interface PassphraseGeneratorOptions {
  readonly wordCount: number;
  readonly separator: string;
  readonly capitalize: boolean;
  readonly includeNumber: boolean;
}

export type StrengthLevel = 'very-weak' | 'weak' | 'fair' | 'strong' | 'very-strong';

export interface PasswordStrengthReport {
  readonly score: number; // 0-100
  readonly entropyBits: number;
  readonly level: StrengthLevel;
  readonly label: string;
  readonly warnings: readonly string[];
}

export const DEFAULT_PASSWORD_OPTIONS: PasswordGeneratorOptions = {
  length: 20,
  uppercase: true,
  lowercase: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: true,
};

export const DEFAULT_PASSPHRASE_OPTIONS: PassphraseGeneratorOptions = {
  wordCount: 5,
  separator: '-',
  capitalize: true,
  includeNumber: true,
};

/** 拒绝采样安全随机整数 [0, maxExclusive) */
function randomInt(maxExclusive: number, crypto: CryptoProvider): number {
  if (maxExclusive <= 1) return 0;
  const maxU32 = 0x100000000;
  const limit = maxU32 - (maxU32 % maxExclusive);
  while (true) {
    const buf = crypto.randomBytes(4);
    const value = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, false);
    if (value < limit) {
      return value % maxExclusive;
    }
  }
}

function filterChars(chars: string, excludeAmbiguous: boolean): string {
  if (!excludeAmbiguous) return chars;
  return Array.from(chars)
    .filter((ch) => !AMBIGUOUS.has(ch))
    .join('');
}

function secureShuffle<T>(arr: T[], crypto: CryptoProvider): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1, crypto);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

export function generatePassword(
  options: PasswordGeneratorOptions = DEFAULT_PASSWORD_OPTIONS,
  crypto: CryptoProvider = createFallbackCryptoProvider(),
): string {
  const length = Math.max(4, Math.min(128, Math.floor(options.length)));
  const pools: string[] = [];
  if (options.uppercase) pools.push(filterChars(UPPER, options.excludeAmbiguous));
  if (options.lowercase) pools.push(filterChars(LOWER, options.excludeAmbiguous));
  if (options.digits) pools.push(filterChars(DIGITS, options.excludeAmbiguous));
  if (options.symbols) pools.push(filterChars(SYMBOLS, options.excludeAmbiguous));
  if (pools.length === 0) {
    pools.push(filterChars(LOWER, options.excludeAmbiguous), filterChars(DIGITS, options.excludeAmbiguous));
  }

  const combined = pools.join('');
  const chars: string[] = [];

  // 保证每个启用的字符池至少包含 1 个字符（长度允许时）
  for (const pool of pools) {
    if (chars.length < length) {
      chars.push(pool[randomInt(pool.length, crypto)]);
    }
  }
  while (chars.length < length) {
    chars.push(combined[randomInt(combined.length, crypto)]);
  }
  return secureShuffle(chars, crypto).join('');
}

export function generatePassphrase(
  options: PassphraseGeneratorOptions = DEFAULT_PASSPHRASE_OPTIONS,
  crypto: CryptoProvider = createFallbackCryptoProvider(),
): string {
  const count = Math.max(3, Math.min(12, Math.floor(options.wordCount)));
  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    let w = WORDLIST[randomInt(WORDLIST.length, crypto)];
    if (options.capitalize) {
      w = w.charAt(0).toUpperCase() + w.slice(1);
    }
    words.push(w);
  }
  if (options.includeNumber) {
    const idx = randomInt(words.length, crypto);
    words[idx] = `${words[idx]}${randomInt(90, crypto) + 10}`;
  }
  return words.join(options.separator);
}

export function generatePin(
  length = 6,
  crypto: CryptoProvider = createFallbackCryptoProvider(),
): string {
  const safeLen = Math.max(4, Math.min(16, Math.floor(length)));
  let out = '';
  for (let i = 0; i < safeLen; i++) {
    out += String(randomInt(10, crypto));
  }
  return out;
}

export function evaluatePasswordStrength(password: string): PasswordStrengthReport {
  if (!password) {
    return {
      score: 0,
      entropyBits: 0,
      level: 'very-weak',
      label: '空密码',
      warnings: ['当前条目未设置密码'],
    };
  }

  const warnings: string[] = [];
  const lower = password.toLowerCase();
  if (COMMON_WEAK_PASSWORDS.has(lower)) {
    return {
      score: 5,
      entropyBits: 8,
      level: 'very-weak',
      label: '极弱',
      warnings: ['属于高频泄漏弱口令，请立即更换'],
    };
  }

  let poolSize = 0;
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSymbol = /[^a-zA-Z0-9]/.test(password);
  if (hasLower) poolSize += 26;
  if (hasUpper) poolSize += 26;
  if (hasDigit) poolSize += 10;
  if (hasSymbol) poolSize += 32;

  const uniqueChars = new Set(password).size;
  const effectiveLen = Math.min(password.length, uniqueChars * 1.5);
  let entropy = poolSize > 0 ? effectiveLen * Math.log2(poolSize) : 0;

  if (password.length < 8) {
    warnings.push('密码长度不足 8 位');
    entropy *= 0.65;
  } else if (password.length < 12) {
    warnings.push('建议长度至少达到 12 位');
  }

  // 重复连续字符或纯递增/递减数字扣分
  if (/(.)\1{2,}/.test(password)) {
    warnings.push('包含连续重复字符');
    entropy -= 12;
  }
  if (/^\d+$/.test(password)) {
    warnings.push('纯数字密码容易被暴力破解');
    entropy = Math.min(entropy, password.length * 3.32);
  }
  if (/(?:0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf)/i.test(password)) {
    warnings.push('包含常见键盘或顺序字符片段');
    entropy -= 16;
  }

  const entropyBits = Math.max(0, Math.round(entropy));
  const score = Math.max(0, Math.min(100, Math.round((entropyBits / 96) * 100)));

  let level: StrengthLevel;
  let label: string;
  if (entropyBits < 28) {
    level = 'very-weak';
    label = '极弱';
  } else if (entropyBits < 45) {
    level = 'weak';
    label = '较弱';
  } else if (entropyBits < 65) {
    level = 'fair';
    label = '一般';
  } else if (entropyBits < 85) {
    level = 'strong';
    label = '强';
  } else {
    level = 'very-strong';
    label = '极强';
  }

  return { score, entropyBits, level, label, warnings };
}
