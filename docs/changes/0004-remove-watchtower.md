# 0004 - 0.1.3 移除安全体检（Watchtower）模块

- **状态**：已执行
- **影响范围**：`src/security/`、`src/app/`、`tests/security/`、现状架构与 README 文档、版本号（`0.1.3`）
- **前置文档**：[0003-ui-polish-logo-cutout-autounlock.md](0003-ui-polish-logo-cutout-autounlock.md)
- **替代文档**：无
- **生效版本**：`0.1.3`

---

## 1. 背景

根据用户最新产品裁剪决定，移除安全体检（Watchtower）功能，使导航与内存状态更轻量聚焦。

## 2. 实施清单

- **删除文件**：`src/security/watchtower.ts`、`src/app/screens/WatchtowerScreen.tsx`。
- **源码清理**：
  - [src/security/index.ts](../../src/security/index.ts)：移除 `watchtower` 导出。
  - [src/app/state/VaultCoordinator.tsx](../../src/app/state/VaultCoordinator.tsx)：移除 `watchtower` 状态与解锁/保存时的全库密码扫描逻辑。
  - [src/app/App.tsx](../../src/app/App.tsx)：移除底部「体检」导航项与视图分支，精简为「密码库 / 生成器 / 设置」三栏。
  - [src/app/screens/SettingsScreen.tsx](../../src/app/screens/SettingsScreen.tsx)：版本展示同步至 `0.1.3`。
- **测试与版本同步**：
  - [tests/security/security.test.ts](../../tests/security/security.test.ts)：移除 Watchtower 测试用例。
  - 同步递增 `package.json`（`0.1.3`）、`android/app/build.gradle`（`versionCode 4` / `versionName "0.1.3"`）、`CHANGELOG.md`。
  - 同步更新现状文档：`README.md`、`docs/architecture/README.md`、`docs/architecture/0001-system-architecture.md`。

## 3. 执行验证记录

- **执行环境**：Windows，Bun `1.4.5`，Android Studio JBR `OpenJDK 25.0.4`，Android SDK `android-37.0`。
- **验证命令与实际输出**：
  1. 源码与测试全局检索 `watchtower|Watchtower|安全体检`：`CLEAN: zero residual references in src/ and tests/`。
  2. `bun run verify:all`：版本门禁通过（`0.1.3`）、42 组设计令牌对比度通过（最低 `6.11:1`）、`tsc --noEmit` 0 错误、Vitest **7 文件 24/24 测试通过**（`243ms`）。
  3. `.\gradlew.bat :app:assembleRelease --no-daemon --console=plain`：`BUILD SUCCESSFUL in 29s`（含 `lintVitalRelease`），产出 `android/app/build/outputs/apk/release/app-release.apk`（`59,201,549` 字节）。
- **验证结论**：通过，已完整移除且无残余依赖。
- **已知限制**：未重新拉起模拟器实测底部三栏交互，留待真机安装 `0.1.3` APK 复核。
