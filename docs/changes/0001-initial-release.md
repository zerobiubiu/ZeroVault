# 0001 - ZeroVault 0.1.0 初始完整架构与核心能力交付

- **状态**：已执行
- **影响范围**：全项目初始化（`src/`、`android/`、`tests/`、`tools/`、`docs/`、根目录配置）
- **前置文档**：[0001-system-architecture.md](../architecture/0001-system-architecture.md)、[0001-tech-stack-and-security-boundary.md](../decisions/0001-tech-stack-and-security-boundary.md)
- **替代文档**：无
- **生效版本**：`0.1.0`

---

## 1. 背景

从零构建面向 Android 平台的商业级 KeePass（`.kdbx`）密码管理器 **ZeroVault**。要求基于 React Native + Bun 构建，参考 Keyguard 界面层次、KeePassDX / KeePass2Android 的 Android 原生安全实践以及 kdbx-web 的自主 KDBX 与防静默覆盖原则（不 fork 或依赖任何参考项目），支持 Android 硬件生物识别、WebDAV 远程数据库与远程密钥文件、空密码与仅密钥文件以及系统级自动填充服务。

## 2. 方案

1. **React Native 0.88 裸工程 + Kotlin 原生安全模块**：采用官方 React Native 0.88.1 模板（Android compileSdk 37 / buildTools 37.0.0 / NDK 27.1.12297006 / Gradle 9.4.1），唯一包管理器为 `bun`（`bun.lock`）。
2. **自主 KDBX 3.1 / 4.0 / 4.1 协议引擎（`src/kdbx/`）**：纯 TypeScript 协议实现并通过 `CryptoProvider` 依赖倒置接入 Android 原生密码学加速（BouncyCastle Argon2d/Argon2id/ChaCha20/Twofish-CBC + `javax.crypto` AES-KDF/AES-CBC + `SecureRandom`），Node/Vitest 测试使用 `@noble/*` + `pako` 适配器。
3. **Android 硬件安全与系统自动填充（`android/.../com/zerovault/app/`）**：
   - `BiometricKeystoreModule`：优先 StrongBox 回退 TEE 的不可导出 AES-256-GCM 密钥 + `BiometricPrompt` `CryptoObject` 实时强生物认证。
   - `SafStorageModule`：Android SAF 持久化文档读写、路径穿越防护私有沙盒、`FLAG_SECURE` 防截屏、Android 13+ `EXTRA_IS_SENSITIVE` 剪贴板自动清理。
   - `ZeroVaultAutofillService` + `AutofillSessionStore` + `AutofillAuthActivity`：系统自动填充服务与锁定态引导。
4. **多库存储与 WebDAV 同步（`src/storage/`）**：支持本地 SAF 与 WebDAV 远程库及远程密钥文件（内置 `PROPFIND` 目录浏览），硬件加密离线缓存，强 ETag `If-Match` / 哈希漂移检测及三选一冲突解决。
5. **安全引擎与 Keyguard 风格 UI（`src/security/`、`src/theme/`、`src/app/`）**：CSPRNG 拒绝采样强密码/词组/PIN 生成器、Watchtower 离线安全体检、自动锁库守卫、经 WCAG 对比度门禁校验的双层深浅色设计令牌及 9 大完整业务屏幕。

## 3. 实施清单

- **规范与文档**：`AGENTS.md`、`README.md`、`CHANGELOG.md`、`DESIGN.md`、`design-tokens.json`、`docs/README.md`、`docs/architecture/`、`docs/decisions/`、`docs/changes/`、`docs/troubleshooting/`
- **工程配置与门禁工具**：`package.json`、`bun.lock`、`tsconfig.json`、`vitest.config.mts`、`index.js`、`metro.config.js`、`babel.config.js`、`app.json`、`.gitignore`、`tools/generate-and-verify-tokens.mts`、`tools/verify-version.mts`
- **自主 KDBX 引擎**：`src/kdbx/{types,binary,xml,credentials,header,crypto-fallback,crypto-native,totp,vault,index}.ts`
- **多库与 WebDAV 存储**：`src/storage/{types,webdav,sync-engine,profile-store,index}.ts`
- **安全与体检**：`src/security/{generator,watchtower,session-guard,index}.ts`
- **原生桥接与主题**：`src/native/{types,bridge,index}.ts`、`src/theme/{tokens,theme-context,index}.ts`
- **商业级界面与状态协调**：`src/app/App.tsx`、`src/app/state/VaultCoordinator.tsx`、`src/app/components/{Primitives,TotpCard,StrengthMeter}.tsx`、`src/app/screens/{UnlockScreen,SourceSetupScreen,VaultListScreen,EntryDetailScreen,EntryEditorScreen,WatchtowerScreen,GeneratorScreen,SettingsScreen,ConflictResolveScreen}.tsx`
- **Android 原生层**：`android/app/build.gradle`、`android/app/src/main/AndroidManifest.xml`、`android/app/src/main/res/{layout/autofill_suggestion_item.xml,xml/autofill_service_config.xml}`、`android/app/src/main/java/com/zerovault/app/{MainActivity,MainApplication,ZeroVaultPackage}.kt`、`crypto/NativeCryptoModule.kt`、`security/BiometricKeystoreModule.kt`、`storage/SafStorageModule.kt`、`autofill/{AutofillSessionStore,ZeroVaultAutofillService,AutofillAuthActivity}.kt`
- **单元测试**：`tests/kdbx/{credentials,totp,vault}.test.ts`、`tests/storage/{webdav,sync-engine}.test.ts`、`tests/security/security.test.ts`

## 4. 执行验证记录

- **执行环境**：Windows，Bun `1.4.5`，Node `v26.13.1`，Android Studio JBR `OpenJDK 25.0.4`，Android SDK `android-37.0` / `build-tools 37.0.0` / `ndk 27.1.12297006`，Gradle `9.4.1`（命令级局部注入环境变量）。
- **验证命令与实际输出**：
  1. `bun run verify:all`
     - `verify:version`：`版本一致性门禁通过：0.1.0`
     - `tokens`：`设计令牌生成并校验通过：共 42 组深浅色文本配对，最低对比度 6.11:1 (>= 4.5:1)。`
     - `check`（`tsc --noEmit -p tsconfig.json`）：退出码 `0`，零类型错误。
     - `test`（`vitest run --config vitest.config.mts`）：`Test Files 6 passed (6)`，`Tests 23 passed (23)`，耗时 `261ms`。
  2. `.\gradlew.bat :app:assembleDebug --no-daemon --console=plain`
     - 结果：`BUILD SUCCESSFUL in 3m 2s`（82 actionable tasks 全部完成），产出 `android/app/build/outputs/apk/debug/app-debug.apk`（`128,716,662` 字节）。
  3. `bunx react-native bundle --platform android --dev false --entry-file index.js --bundle-output <scratch>/index.android.bundle`
     - 结果：成功输出生产 Android JS Bundle（`1,338,460` 字节）。
  4. 保护项检查：根目录 `.markindex/` 完整存在且已写入 `.gitignore` 忽略保护。
- **验证结论**：全部静态检查、设计对比度门禁、纯逻辑/协议/WebDAV/安全单测、Metro 生产打包及 Android Debug APK 原生编译均已实测通过。
- **已知限制**：
  - 本轮未启动 Android 模拟器或连接真机执行运行时 UI 交互、指纹/面容硬件传感器真机弹窗、StrongBox 芯片降级路径、以及跨 App `AutofillService` 真实表单填充验收。
  - 当前 `android/app/build.gradle` 的 `release` 构建仍指向开发用 `debug.keystore` 且未开启 R8 混淆；正式上架发布前需配置正式签名证书与 ProGuard/R8 规则。

## 5. 后续验证建议

1. 启动本机已有模拟器（`Medium_Phone_API_37.0`）或连接支持指纹/StrongBox 的真机，安装 `app-debug.apk` 验证完整解锁、生物识别 `CryptoObject` 封包/解封与 `FLAG_SECURE` 防截屏效果。
2. 搭配 Nextcloud / 坚果云 / 自建 WebDAV 测试服务实测远程 `.kdbx` + 远程 `.keyx` 密钥文件（含空密码与仅密钥文件场景）拉取、离线编辑与双端冲突解决流程。
3. 在系统「密码和自动填充」中将 ZeroVault 设为默认服务，使用 Chrome 及原生 App 登录页验证 `ZeroVaultAutofillService` 匹配填充与锁定态引导。
4. 正式发布前补充 Android Instrumentation / Kotlin 单元测试与 Release 签名及 ProGuard 规则。
