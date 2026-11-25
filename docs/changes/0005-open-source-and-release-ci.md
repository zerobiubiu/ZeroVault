# 0005 - MIT 开源协议、GitHub Actions CI 与 Release APK 自动发布配置

- **状态**：已执行
- **影响范围**：`LICENSE`、`.github/workflows/`、`android/app/build.gradle`、`package.json`、`README.md`
- **前置文档**：[0004-remove-watchtower.md](0004-remove-watchtower.md)
- **替代文档**：无
- **生效版本**：`0.1.3`（纯开源协议与 CI/发布基础设施配置，未改变应用行为，不递增版本号）

---

## 1. 背景

将 ZeroVault 以 MIT 协议开源发布至 GitHub（`zerobiubiu/ZeroVault`），并配置自动化持续集成检查与基于标签的 Android Release APK 自动构建发布流程。

## 2. 方案与实施清单

- **MIT 开源协议**：新增根目录 [LICENSE](../../LICENSE)（Copyright (c) 2026 zerobiubiu），并在 [package.json](../../package.json) 与 [README.md](../../README.md) 补充 `license: "MIT"` 与仓库地址信息。
- **Android 正式签名环境变量支持**：更新 [android/app/build.gradle](../../android/app/build.gradle) 的 `signingConfigs.release`，支持从环境变量读取正式 Keystore，未配置时平滑回退调试签名。
- **GitHub Actions 安全工作流**（遵循最小权限、全部上下文经 `env:` 传递防 Shell 注入、第三方 Action 固定 40 位 Commit SHA、Release 直接使用官方 `gh` CLI）：
  - [.github/workflows/ci.yml](../../.github/workflows/ci.yml)：`main` 分支推送与 PR 自动运行 `bun run verify:all`。
  - [.github/workflows/release-apk.yml](../../.github/workflows/release-apk.yml)：推送 `v*` 标签或手动触发时，自动校验标签与 `package.json` 版本一致、运行全量门禁、安装 Android SDK 37.0/NDK 27.1、构建 Release APK、生成 `SHA256SUMS.txt`、自动提取 `CHANGELOG.md` 发布日志并创建 GitHub Release。

## 3. 执行验证记录

- **执行环境**：Windows 本地（`gh` CLI 登录 `zerobiubiu`，Bun `1.4.5`）+ GitHub Actions `ubuntu-latest` 云端 Runner（Node 22、Bun `1.4.5`、Temurin Java 21、Android SDK `platforms;android-37.0` / `build-tools;37.0.0` / `ndk;27.1.12297006`）。
- **验证命令与实际输出**：
  1. 本地门禁与暂存区安全审计：`bun run verify:all`（版本 `0.1.3`、42 组设计令牌对比度、TypeScript、Vitest 24/24）全部通过；确认暂存区不含 `.markindex/`、APK、构建产物或真实密钥，`android/gradlew` 权限为 `100755`。
  2. 公开仓库与标签推送：创建 `https://github.com/zerobiubiu/ZeroVault`（Public，MIT License），推送 `main` 与注释标签 `v0.1.3`。
  3. GitHub Actions `CI`（Run `#45629174995`）：`completed / success`，耗时 `16s`。
  4. GitHub Actions `Release Android APK`（Run `#45629177920`）：`completed / success`，耗时 `6m22s`，自动发布 `https://github.com/zerobiubiu/ZeroVault/releases/tag/v0.1.3`，上传附件：
     - `ZeroVault-v0.1.3-android.apk`（`59,201,545` 字节，`sha256:f3841f04b6f1e328695ab500431ab280b534c4dabf4b1a599bef1058d20540c3`）
     - `SHA256SUMS.txt`（`95` 字节）
- **验证结论**：通过，开源发布、CI 门禁与自动构建发布 APK 全链路云端实测通过。
- **已知限制**：仓库尚未配置正式发布签名 Secrets（`ANDROID_KEYSTORE_*`），当前 `v0.1.3` Release APK 使用开发签名回退并在 Release Notes 中已明确标注；配置 4 个 Secrets 后后续发版将自动启用正式证书签名。
