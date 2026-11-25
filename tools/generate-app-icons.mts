/**
 * ZeroVault 几何盾锁 App 图标栅格化生成器（零外部图像依赖，4x 超采样抗锯齿）。
 * 从与 Android Adaptive VectorDrawable 完全同源的几何定义生成 5 套密度 PNG 图标，
 * 替换 React Native 模板默认小机器人图标。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { deflate } from 'pako';

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, payload.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  dv.setUint32(8 + payload.length, crc32(out.subarray(4, 8 + payload.length)), false);
  return out;
}

function encodePngRgba(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * (width * 4 + 1);
    raw[rowOff] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), rowOff + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width, false);
  dv.setUint32(4, height, false);
  ihdr[8] = 8; // 8-bit
  ihdr[9] = 6; // RGBA
  const compressed = deflate(raw, { level: 9 });
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function pointInShield(x: number, y: number, scale: number): boolean {
  // 以 (54, 54) 为中心的对称几何盾牌（与 ic_launcher_foreground.xml 同源）
  const dx = Math.abs(x - 54) / scale;
  const dy = (y - 54) / scale;
  if (dy < -30 || dy > 31) return false;
  if (dx > 24) return false;
  // 顶部斜肩：从 (0, -30) 线性到 (24, -20.5)
  const topY = -30 + (dx / 24) * 9.5;
  if (dy < topY) return false;
  // 下半弧收尖：从 dy=0 处宽 24 曲线收束至 (0, 31)
  if (dy > 0) {
    const t = dy / 31;
    const maxDx = 24 * (1 - t * t);
    if (dx > maxDx) return false;
  }
  return true;
}

function pointInZ(x: number, y: number): boolean {
  // 对应 foreground 中的 Z 锁栓区域 [43.5..64.5, 42.5..65.5]
  if (x < 43.5 || x > 64.5 || y < 42.5 || y > 65.5) return false;
  // 顶横条
  if (y <= 47.6) return true;
  // 底横条
  if (y >= 60.4) return true;
  // 对角斜杠：从 (62, 46) 到 (46, 62)
  const diagX = 43.5 + ((65.5 - y) / 23) * 21;
  return Math.abs(x - diagX) <= 3.6;
}

function sampleLogoPixel(vx: number, vy: number, roundMask: boolean): [number, number, number, number] {
  // 图标裁剪遮罩（圆角方形或正圆）
  if (roundMask) {
    const d = Math.hypot(vx - 54, vy - 54);
    if (d > 51) return [0, 0, 0, 0];
  } else {
    const rx = Math.max(0, Math.abs(vx - 54) - 34);
    const ry = Math.max(0, Math.abs(vy - 54) - 34);
    if (Math.hypot(rx, ry) > 17) return [0, 0, 0, 0];
  }

  // 背景径向渐变
  const dist = Math.min(1, Math.hypot(vx - 54, vy - 42) / 76);
  let r = 36 * (1 - dist) + 12 * dist;
  let g = 124 * (1 - dist) + 34 * dist;
  let b = 152 * (1 - dist) + 48 * dist;

  // 同心细刻度环
  const ringD = Math.hypot(vx - 54, vy - 54);
  if (Math.abs(ringD - 39) < 0.7 || Math.abs(ringD - 31) < 0.5) {
    r = r * 0.85 + 168 * 0.15;
    g = g * 0.85 + 216 * 0.15;
    b = b * 0.85 + 234 * 0.15;
  }

  // 外层亮白盾徽
  if (pointInShield(vx, vy, 1.0)) {
    r = 244;
    g = 250;
    b = 252;
    // 内层深海金库凹槽
    if (pointInShield(vx, vy, 0.74)) {
      r = 17;
      g = 58;
      b = 77;
      // 中央 Z 锁栓
      if (pointInZ(vx, vy)) {
        r = 92;
        g = 195;
        b = 223;
      }
      // 锁芯中心白点
      if (Math.hypot(vx - 54, vy - 54) <= 2.9) {
        r = 244;
        g = 250;
        b = 252;
      }
    }
  }

  return [r, g, b, 255];
}

function renderIcon(size: number, roundMask: boolean): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  const ss = 3; // 3x3 超采样抗锯齿
  const inv = 1 / (ss * ss);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const vx = ((x + (sx + 0.5) / ss) / size) * 108;
          const vy = ((y + (sy + 0.5) / ss) / size) * 108;
          const [r, g, b, a] = sampleLogoPixel(vx, vy, roundMask);
          sr += r * (a / 255);
          sg += g * (a / 255);
          sb += b * (a / 255);
          sa += a;
        }
      }
      const alpha = sa * inv;
      const idx = (y * size + x) * 4;
      if (alpha > 0.5) {
        const factor = 255 / alpha;
        rgba[idx] = Math.min(255, Math.round(sr * inv * factor));
        rgba[idx + 1] = Math.min(255, Math.round(sg * inv * factor));
        rgba[idx + 2] = Math.min(255, Math.round(sb * inv * factor));
        rgba[idx + 3] = Math.min(255, Math.round(alpha));
      }
    }
  }
  return encodePngRgba(size, size, rgba);
}

const rootDir = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const resDir = resolve(rootDir, 'android/app/src/main/res');

const densities: ReadonlyArray<[string, number]> = [
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192],
];

for (const [folder, size] of densities) {
  const dir = resolve(resDir, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'ic_launcher.png'), renderIcon(size, false));
  writeFileSync(resolve(dir, 'ic_launcher_round.png'), renderIcon(size, true));
}

console.log(`已生成 ZeroVault 几何盾锁图标（5 套密度 × 方形/圆形，共 ${densities.length * 2} 个 PNG）。`);
