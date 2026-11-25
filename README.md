# ZeroVault

基于 React Native 0.88 与 Android 原生 Kotlin 安全模块的商业级 **KeePass（`.kdbx`）Android 密码管理器**，使用 **Bun** 作为唯一包管理器。

设计参考 Keyguard 的现代化信息层次、KeePassDX / KeePass2Android 的 Android 硬件安全与自动填充实践以及 kdbx-web 的自主 KDBX 与防静默覆盖模型；所有代码均为独立自主实现，不 fork 或依赖上述参考项目。

## 核心能力

- **自主 KDBX 3.1 / 4.0 / 4.1 协议引擎（`src/kdbx/`）**
  - 原生支持 AES-256-CBC、ChaCha20、Twofish-CBC（Android 原生层），Argon2id / Argon2d / AES-KDF，Gzip 压缩与 Salsa20 / ChaCha20 内层随机流加密。
  - **严格支持空密码与远程密钥**：清晰区分「仅密钥文件（`password: null`）」与「显式空密码（`password: ""`）」，支持 XML v1.0 / v2.0（含 Hash 校验和）/ 32B 原始 / 64B Hex / 任意二进制密钥文件（含 0 字节文件），解锁时提供空密码与仅密钥智能兼容探测。
  - 完整支持分组树、条目历史快照、回收站、自定义普通/受保护字段、附件元数据与字节读写、以及 RFC 6238/4226 **TOTP** 实时两步验证码（兼容 `otpauth://`、KeePass `TimeOtp-*` 与 `TOTP Seed`）。
  - 防 XXE 攻击（禁止 XML `DOCTYPE` / `ENTITY`）、未知 XML 扩展节点无损保留、事务 `fork()` 回滚与锁库内存擦除。
- **Android 硬件安全模块与原生加速（`android/.../com/zerovault/app/`）**
  - **硬件生物识别解锁（`BiometricKeystoreModule`）**：基于 Android Keystore（优先 **StrongBox** 安全芯片，回退 **TEE**）生成不可导出 AES-256-GCM 密钥，强制绑定 `BiometricPrompt` `CryptoObject`（Class 3 `BIOMETRIC_STRONG`），系统生物特征变更时硬件自动吊销旧密钥。
  - **原生密码学加速（`NativeCryptoModule`）**：在后台协程池使用 BouncyCastle + `javax.crypto` 执行 Argon2id/Argon2d、AES-KDF、AES-CBC、ChaCha20、Twofish-CBC 与 `SecureRandom`。
  - **隐私防护（`SafStorageModule`）**：默认启用 `FLAG_SECURE` 禁止截屏与最近任务预览；敏感复制支持 Android 13+ `EXTRA_IS_SENSITIVE` 标记与定时自动清空；应用私有沙盒路径穿越防护。
  - **Android 系统自动填充（`ZeroVaultAutofillService`）**：按域名与 `androidapp://` 包名匹配已解锁凭据，锁定态引导至 `AutofillAuthActivity` 验证解锁，支持登录保存请求待审核入库。
- **多库与 WebDAV 同步（`src/storage/`）**
  - 同时支持 **本地 Android SAF 持久化文件** 与 **WebDAV 远程数据库 + 远程密钥文件**（内置 `PROPFIND` 远程目录浏览器，支持同源或独立 WebDAV 认证）。
  - 远程密钥文件与 WebDAV 认证凭据经 Android Keystore 硬件加密缓存，绝不明文落盘，支持离线查看编辑与生物识别解锁。
  - 默认强制 HTTPS、拦截跨源重定向、强 ETag `If-Match` 条件回写与无 ETag 哈希漂移检测；发生双端冲突时绝不静默覆盖，提供「另存恢复副本再采用远端 / 采用远端 / 保留本地强制覆盖」三选一解决界面。
- **密码生成器与锁库守卫（`src/security/`）**
  - CSPRNG 拒绝采样无偏差生成器：随机强密码、Diceware 易记词组（Passphrase）与 PIN 码，附实时熵值评估与后台超时自动锁库。

## 目录结构

| 职责模块 | 路径 | 说明 |
| --- | --- | --- |
| 自主 KDBX 核心 | [src/kdbx/](src/kdbx/) | 协议解析/序列化、复合密钥、TOTP、Node 回退与原生加密适配 |
| 多库与 WebDAV | [src/storage/](src/storage/) | WebDAV 传输与目录浏览、冲突状态机、硬件封包档案存储 |
| 安全与生成 | [src/security/](src/security/) | 强密码/词组生成器、自动锁定与 Autofill 同步 |
| 原生桥接契约 | [src/native/](src/native/) | Android 原生模块 TypeScript 接口与桥接层 |
| 设计令牌与主题 | [src/theme/](src/theme/) | 由 [design-tokens.json](design-tokens.json) 派生的深浅双色语义令牌 |
| 界面与状态协调 | [src/app/](src/app/) | Keyguard 风格 9 大业务页面、语义原语组件与 `VaultCoordinator` |
| Android 原生层 | [android/app/src/main/java/com/zerovault/app/](android/app/src/main/java/com/zerovault/app/) | Kotlin 硬件 Keystore、原生密码学、SAF 与 `AutofillService` |
| 单元测试 | [tests/](tests/) | Vitest 全量纯逻辑与端到端 KDBX / WebDAV / 安全测试 |

## 开发与验证

唯一包管理器为 `bun`（`bun.lock`）。

```powershell
# 1. 安装依赖
bun install

# 2. 全量本地门禁（版本一致性 + 42 组设计令牌 WCAG 对比度 + TypeScript + Vitest）
bun run verify:all

# 3. 单独运行类型检查或测试
bun run check
bun run test

# 4. 构建独立可装真机的 Android Release APK（内置完整 Hermes JS Bundle，不依赖电脑 Metro）
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"
cd android
.\gradlew.bat :app:assembleRelease
# 产物：android\app\build\outputs\apk\release\app-release.apk
# 注意：app-debug.apk 不内嵌 JS Bundle，仅用于连接电脑 Metro 开发服务器调试，不可单独发给真机运行。
```

## 文档导航

- [文档中心索引](docs/README.md)
- [项目协作与安全规则](AGENTS.md)
- [系统架构与十步规划](docs/architecture/0001-system-architecture.md)
- [技术栈与安全边界决策（ADR-0001）](docs/decisions/0001-tech-stack-and-security-boundary.md)
- [设计系统手册](DESIGN.md)
- [变更日志](CHANGELOG.md)

## 自动发布与正式签名（GitHub Actions）

- **持续集成**（[.github/workflows/ci.yml](.github/workflows/ci.yml)）：每次推送 `main` 或发起 PR 自动执行版本门禁、设计令牌对比度校验、TypeScript 类型检查与 Vitest 全量单测。
- **自动构建并发布 APK**（[.github/workflows/release-apk.yml](.github/workflows/release-apk.yml)）：推送 `v*` 标签（例如 `git tag v0.1.3 && git push origin v0.1.3`）或在 Actions 页面手动触发后，自动编译 Android Release APK、生成 `SHA256SUMS.txt` 并发布至 [GitHub Releases](https://github.com/zerobiubiu/ZeroVault/releases)。
- **可选配置正式 Release 签名**：在仓库 `Settings → Secrets and variables → Actions` 添加以下 4 个 Secrets 后，Actions 将自动使用正式证书签名（未配置时默认回退调试签名并在 Release 说明中提示）：
  - `ANDROID_KEYSTORE_BASE64`（`.jks`/`.keystore` 文件的 Base64 编码）
  - `ANDROID_KEYSTORE_PASSWORD`
  - `ANDROID_KEY_ALIAS`
  - `ANDROID_KEY_PASSWORD`

## 开源许可

本项目基于 [MIT License](LICENSE) 开源。

