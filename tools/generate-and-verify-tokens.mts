/**
 * ZeroVault 双层设计令牌生成与 WCAG 对比度校验工具
 * 严格遵循 Refactoring UI 调色算法：
 * 500(base) -> 100/900(edges) -> 300/700(midpoints) -> 200/400/600/800(fill)
 * 附带饱和度补偿与 <=20° 色相旋转，并校验深浅双色全部真实文本-背景对比度。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

interface Hsl {
  h: number;
  s: number;
  l: number;
}

type Ramp = Record<string, string>;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const num = Number.parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToHsl(hex: string): Hsl {
  const [r8, g8, b8] = hexToRgb(hex);
  const r = r8 / 255;
  const g = g8 / 255;
  const b = b8 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s: s * 100, l: l * 100 };
}

function hslToHex(hsl: Hsl): string {
  const h = ((hsl.h % 360) + 360) % 360;
  const s = clamp(hsl.s, 0, 100) / 100;
  const l = clamp(hsl.l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

function nearestTarget(h: number, targets: readonly number[], tieBreak: 'cool' | 'warm'): number {
  let best = targets[0];
  let bestDist = 360;
  for (const t of targets) {
    let diff = ((t - h + 540) % 360) - 180;
    const dist = Math.abs(diff);
    if (dist < bestDist - 0.001) {
      bestDist = dist;
      best = t;
    } else if (Math.abs(dist - bestDist) <= 0.001) {
      // 红/青等距时按冷暖偏好消歧
      if (tieBreak === 'cool' && t > best) best = t;
      if (tieBreak === 'warm' && t < best) best = t;
    }
  }
  return best;
}

function rotateHue(h: number, target: number, factor: number, maxDeg = 20): number {
  const delta = ((target - h + 540) % 360) - 180;
  const shift = clamp(delta * factor, -maxDeg, maxDeg);
  return (h + shift + 360) % 360;
}

function generateColorRamp(
  baseHex: string,
  options: { lightest?: number; darkest?: number; strength?: number; cap?: number; toward?: 'cool' | 'warm' } = {},
): Ramp {
  const base = hexToHsl(baseHex);
  const lightest = options.lightest ?? 96;
  const darkest = options.darkest ?? 20;
  const strength = options.strength ?? 0.55;
  const cap = options.cap ?? 20;
  const toward = options.toward ?? 'cool';

  // 500 -> 100 / 900 -> 300 / 700 -> 200 / 400 / 600 / 800
  const l500 = base.l;
  const l100 = lightest;
  const l900 = darkest;
  const l300 = (l500 + l100) / 2;
  const l700 = (l500 + l900) / 2;
  const l200 = (l300 + l100) / 2;
  const l400 = (l500 + l300) / 2;
  const l600 = (l700 + l500) / 2;
  const l800 = (l900 + l700) / 2;
  const l50 = clamp(l100 + (100 - l100) * 0.45, 96, 98.5);
  const l950 = clamp(l900 * 0.62, 9, 15);

  const lightTarget = nearestTarget(base.h, [60, 180, 300], toward);
  const darkTarget = nearestTarget(base.h, [0, 120, 240], toward);

  const stops: Array<[string, number]> = [
    ['50', l50],
    ['100', l100],
    ['200', l200],
    ['300', l300],
    ['400', l400],
    ['500', l500],
    ['600', l600],
    ['700', l700],
    ['800', l800],
    ['900', l900],
    ['950', l950],
  ];

  const ramp: Ramp = {};
  for (const [key, l] of stops) {
    if (key === '500') {
      ramp[key] = baseHex.toLowerCase();
      continue;
    }
    const distFromMid = Math.abs(l - 50) / 50;
    const baseDist = Math.abs(l500 - 50) / 50;
    const satDelta = (distFromMid - baseDist) * 28 * strength;
    const s = clamp(base.s + satDelta, 14, 92);
    const ratio = l > l500 ? (l - l500) / Math.max(1, l100 - l500) : (l500 - l) / Math.max(1, l500 - l900);
    const h = rotateHue(base.h, l > l500 ? lightTarget : darkTarget, clamp(ratio, 0, 1) * 0.45, cap);
    ramp[key] = hslToHex({ h, s, l });
  }
  return ramp;
}

function generateCoolNeutralRamp(): Ramp {
  // 冷石墨灰，色相锚定 216°，两端补饱和避免冷色漂移
  const stops: Array<[string, number, number]> = [
    ['50', 98, 22],
    ['100', 95.5, 20],
    ['200', 90, 18],
    ['300', 81, 16],
    ['400', 64, 14],
    ['500', 48, 13],
    ['600', 37, 15],
    ['700', 27, 17],
    ['800', 18, 20],
    ['850', 14.5, 22],
    ['900', 11.5, 24],
    ['950', 7.5, 28],
  ];
  const ramp: Ramp = {};
  for (const [key, l, s] of stops) {
    ramp[key] = hslToHex({ h: 216, s, l });
  }
  return ramp;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

const primitives = {
  color: {
    primary: generateColorRamp('#1d6f8a', { lightest: 96, darkest: 18, toward: 'cool' }),
    neutral: generateCoolNeutralRamp(),
    success: generateColorRamp('#16805a', { lightest: 95, darkest: 18, toward: 'cool' }),
    warning: generateColorRamp('#c26a0a', { lightest: 96, darkest: 20, toward: 'warm' }),
    danger: generateColorRamp('#c82834', { lightest: 96, darkest: 20, toward: 'cool' }),
    info: generateColorRamp('#2563a8', { lightest: 96, darkest: 20, toward: 'cool' }),
    white: '#ffffff',
  },
  fontSize: {
    xs: 12,
    sm: 14,
    base: 16,
    lg: 18,
    xl: 20,
    '2xl': 24,
    '3xl': 30,
  },
  fontWeight: {
    regular: '400' as const,
    semibold: '600' as const,
  },
  lineHeight: {
    tight: 1.25,
    normal: 1.5,
    relaxed: 1.75,
  },
  spacing: {
    '1': 4,
    '2': 8,
    '3': 12,
    '4': 16,
    '6': 24,
    '8': 32,
    '12': 48,
    '16': 64,
  },
  radius: {
    sm: 6,
    md: 10,
    lg: 16,
    xl: 20,
    full: 999,
  },
  borderWidth: {
    hairline: 1,
    emphasis: 2,
  },
  opacity: {
    disabled: 0.45,
    pressed: 0.82,
    scrim: 0.56,
  },
  elevation: {
    none: 0,
    xs: 1,
    sm: 3,
    md: 6,
    lg: 12,
    xl: 20,
  },
  zIndex: {
    base: 0,
    dropdown: 10,
    sticky: 20,
    overlay: 30,
    modal: 40,
    popover: 50,
    toast: 60,
  },
};

const semanticLight = {
  background: primitives.color.neutral['50'],
  surface: primitives.color.white,
  surfaceRaised: primitives.color.white,
  surfaceSunken: primitives.color.neutral['100'],
  text: primitives.color.neutral['950'],
  textSecondary: primitives.color.neutral['700'],
  textMuted: primitives.color.neutral['600'],
  border: primitives.color.neutral['200'],
  borderStrong: primitives.color.neutral['300'],
  action: primitives.color.primary['600'],
  actionPressed: primitives.color.primary['700'],
  actionText: primitives.color.white,
  actionSubtle: primitives.color.primary['100'],
  actionSubtleText: primitives.color.primary['900'],
  success: primitives.color.success['700'],
  successSubtle: primitives.color.success['100'],
  successSubtleText: primitives.color.success['900'],
  warning: primitives.color.warning['700'],
  warningSubtle: primitives.color.warning['100'],
  warningSubtleText: primitives.color.warning['900'],
  danger: primitives.color.danger['600'],
  dangerText: primitives.color.white,
  dangerSubtle: primitives.color.danger['100'],
  dangerSubtleText: primitives.color.danger['900'],
  info: primitives.color.info['700'],
  infoSubtle: primitives.color.info['100'],
  infoSubtleText: primitives.color.info['900'],
  focusRing: primitives.color.primary['500'],
  tabBarBg: primitives.color.white,
  tabActive: primitives.color.primary['600'],
  tabInactive: primitives.color.neutral['600'],
};

const semanticDark = {
  // 深色表面严格按 surface-0 < surface-1 < surface-2 提亮，禁用纯黑 #000
  background: primitives.color.neutral['950'],
  surface: primitives.color.neutral['900'],
  surfaceRaised: primitives.color.neutral['850'],
  surfaceSunken: primitives.color.neutral['800'],
  text: primitives.color.neutral['50'],
  textSecondary: primitives.color.neutral['200'],
  textMuted: primitives.color.neutral['300'],
  border: primitives.color.neutral['800'],
  borderStrong: primitives.color.neutral['700'],
  action: primitives.color.primary['400'],
  actionPressed: primitives.color.primary['300'],
  actionText: primitives.color.neutral['950'],
  actionSubtle: primitives.color.primary['950'],
  actionSubtleText: primitives.color.primary['200'],
  success: primitives.color.success['300'],
  successSubtle: primitives.color.success['950'],
  successSubtleText: primitives.color.success['200'],
  warning: primitives.color.warning['300'],
  warningSubtle: primitives.color.warning['950'],
  warningSubtleText: primitives.color.warning['200'],
  danger: primitives.color.danger['300'],
  dangerText: primitives.color.neutral['950'],
  dangerSubtle: primitives.color.danger['950'],
  dangerSubtleText: primitives.color.danger['200'],
  info: primitives.color.info['300'],
  infoSubtle: primitives.color.info['950'],
  infoSubtleText: primitives.color.info['200'],
  focusRing: primitives.color.primary['300'],
  tabBarBg: primitives.color.neutral['900'],
  tabActive: primitives.color.primary['300'],
  tabInactive: primitives.color.neutral['300'],
};

type SemanticPalette = typeof semanticLight;

function checkPairs(mode: 'light' | 'dark', palette: SemanticPalette): Array<{ name: string; ratio: number; pass: boolean }> {
  const pairs: Array<[string, string, string, number]> = [
    ['text / background', palette.text, palette.background, 4.5],
    ['text / surface', palette.text, palette.surface, 4.5],
    ['text / surfaceRaised', palette.text, palette.surfaceRaised, 4.5],
    ['textSecondary / background', palette.textSecondary, palette.background, 4.5],
    ['textSecondary / surface', palette.textSecondary, palette.surface, 4.5],
    ['textMuted / background', palette.textMuted, palette.background, 4.5],
    ['textMuted / surface', palette.textMuted, palette.surface, 4.5],
    ['textMuted / surfaceSunken', palette.textMuted, palette.surfaceSunken, 4.5],
    ['actionText / action', palette.actionText, palette.action, 4.5],
    ['actionSubtleText / actionSubtle', palette.actionSubtleText, palette.actionSubtle, 4.5],
    ['success / surface', palette.success, palette.surface, 4.5],
    ['successSubtleText / successSubtle', palette.successSubtleText, palette.successSubtle, 4.5],
    ['warning / surface', palette.warning, palette.surface, 4.5],
    ['warningSubtleText / warningSubtle', palette.warningSubtleText, palette.warningSubtle, 4.5],
    ['danger / surface', palette.danger, palette.surface, 4.5],
    ['dangerText / danger', palette.dangerText, palette.danger, 4.5],
    ['dangerSubtleText / dangerSubtle', palette.dangerSubtleText, palette.dangerSubtle, 4.5],
    ['info / surface', palette.info, palette.surface, 4.5],
    ['infoSubtleText / infoSubtle', palette.infoSubtleText, palette.infoSubtle, 4.5],
    ['tabActive / tabBarBg', palette.tabActive, palette.tabBarBg, 4.5],
    ['tabInactive / tabBarBg', palette.tabInactive, palette.tabBarBg, 4.5],
  ];
  return pairs.map(([name, fg, bg, minRatio]) => {
    const ratio = Number(contrastRatio(fg, bg).toFixed(2));
    return { name: `[${mode}] ${name}`, ratio, pass: ratio >= minRatio };
  });
}

const lightChecks = checkPairs('light', semanticLight);
const darkChecks = checkPairs('dark', semanticDark);
const allChecks = [...lightChecks, ...darkChecks];
const failed = allChecks.filter((c) => !c.pass);

if (failed.length > 0) {
  console.error('设计令牌对比度校验未通过：');
  for (const item of failed) {
    console.error(`  FAIL ${item.name}: ${item.ratio}:1 (< 4.5:1)`);
  }
  process.exit(1);
}

const minRatio = Math.min(...allChecks.map((c) => c.ratio));
const rootDir = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const designTokensDoc = {
  $schema: 'zerovault-design-tokens/v1',
  name: 'ZeroVault · 静谧金库蓝',
  contrastVerified: {
    pairCount: allChecks.length,
    minRatio,
    threshold: 4.5,
  },
  primitives,
  semantic: {
    light: semanticLight,
    dark: semanticDark,
  },
};

writeFileSync(resolve(rootDir, 'design-tokens.json'), `${JSON.stringify(designTokensDoc, null, 2)}\n`, 'utf8');

const tsOutput = `/**
 * 本文件由 tools/generate-and-verify-tokens.mts 自动生成，事实来源为根 design-tokens.json。
 * 业务组件禁止直接使用 primitives 颜色，仅允许消费 ThemeColors 语义令牌。
 */

export const primitiveTokens = ${JSON.stringify(primitives, null, 2)} as const;

export const lightColors = ${JSON.stringify(semanticLight, null, 2)} as const;

export const darkColors = ${JSON.stringify(semanticDark, null, 2)} as const;

export type ThemeColors = {
  readonly [K in keyof typeof lightColors]: string;
};

export type ThemeMode = 'system' | 'light' | 'dark';
`;

mkdirSync(resolve(rootDir, 'src/theme'), { recursive: true });
writeFileSync(resolve(rootDir, 'src/theme/tokens.ts'), tsOutput, 'utf8');

console.log(`设计令牌生成并校验通过：共 ${allChecks.length} 组深浅色文本配对，最低对比度 ${minRatio}:1 (>= 4.5:1)。`);
