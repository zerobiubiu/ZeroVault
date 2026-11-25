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

- （将于本地校验与 GitHub Actions `v0.1.3` 首个 Release 工作流真实跑完后回填最终运行链接与结果。）
