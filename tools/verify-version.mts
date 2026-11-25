/**
 * ZeroVault 版本号单一事实来源门禁脚本
 * 校验 package.json#version、android/app/build.gradle#versionName 与 CHANGELOG.md 保持一致。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const rootDir = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')) as { version: string };
const expected = pkg.version;

const errors: string[] = [];

const gradlePath = resolve(rootDir, 'android/app/build.gradle');
if (existsSync(gradlePath)) {
  const gradleText = readFileSync(gradlePath, 'utf8');
  const match = gradleText.match(/versionName\s+"([^"]+)"/);
  if (!match) {
    errors.push('android/app/build.gradle 未找到 versionName 声明。');
  } else if (match[1] !== expected) {
    errors.push(`android/app/build.gradle versionName="${match[1]}" 与 package.json (${expected}) 不一致。`);
  }
} else {
  errors.push('缺少 android/app/build.gradle。');
}

const changelogPath = resolve(rootDir, 'CHANGELOG.md');
if (existsSync(changelogPath)) {
  const changelogText = readFileSync(changelogPath, 'utf8');
  if (!changelogText.includes(`## [${expected}]`)) {
    errors.push(`CHANGELOG.md 缺少版本节 "## [${expected}]"。`);
  }
} else {
  errors.push('缺少 CHANGELOG.md。');
}

if (errors.length > 0) {
  console.error('版本一致性门禁失败：');
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

console.log(`版本一致性门禁通过：${expected}`);
