# ADR 0001 - 技术栈与安全边界决策

- **状态**：已执行
- **影响范围**：全项目架构、原生安全层、KDBX 引擎与存储同步
- **前置文档**：无
- **替代文档**：无
- **生效版本**：`0.1.0`

## 背景

ZeroVault 需要达到商业成熟标准的 Android KDBX 密码管理器能力，涵盖 KDBX 3.1/4.x 完整读写（含空密码与远程密钥）、WebDAV 同步与冲突处理、Android 硬件级生物识别解锁、系统自动填充服务（AutofillService）以及 Keyguard 风格的现代商业界面。

## 决策内容

### 1. 采用 React Native 0.88 裸工程 + Kotlin 原生安全模块

- **选定方案**：基于 React Native 裸工程，以 Bun 为唯一包管理器；在 `android/app/src/main/java/com/zerovault/` 下编写独立 Kotlin 原生模块承载硬件安全、密码学加速、SAF 持久化文档访问与 `AutofillService`。
- **备选方案**：Expo (SDK 58 + Prebuild + Config Plugins)。
- **否决理由**：密码管理器需要深度定制 `AutofillService`、`AutofillAuthActivity`、Android Keystore `CryptoObject` 硬件密钥生命周期及原生 Argon2id/AES 加速，裸工程在 `AndroidManifest.xml`、原生 Service 生命周期与安全审计上边界最透明可控，无托管层黑盒。
- **重审条件**：未来若规划同步发布 iOS/macOS 且希望复用 Expo Modules 生态时可重新评估。

### 2. 自主实现 KDBX 3.1/4.x 协议层（TypeScript）+ Android 原生密码学加速

- **选定方案**：自主编写 KDBX 协议解析/序列化/文档状态机（`src/kdbx/`），并通过 `CryptoProvider` 依赖倒置在 Android 端接入 Kotlin 原生密码学引擎（Argon2d/Argon2id/AES-256-CBC/AES-KDF/ChaCha20/Salsa20/HMAC-SHA256/Gzip），在 Node/Vitest 测试环境使用 `@noble/*` + `pako` 实现同契约适配器。
- **备选方案**：(a) 纯 JS `@noble/*` 在 Hermes 上直接执行 Argon2；(b) 引入第三方 `kdbxweb`。
- **否决理由**：Hermes 无原生 WASM 且单线程跑高内存 Argon2id 耗时可能达十余秒，达不到商业标准；`kdbxweb` 历史维护停滞且用户明确要求自主设计、不依赖参考项目。
- **重审条件**：若未来引入 Rust/JSI 零拷贝原生绑定替代 JVM 层加密，可直接替换 `CryptoProvider` 实现而不改动协议层。

### 3. Android Keystore + BiometricPrompt 硬件级封包远程密钥与凭据

- **选定方案**：用户为某个密码库启用生物识别或离线缓存远程密钥/WebDAV 凭据时，在 Android Keystore 中为该库生成硬件绑定 AES-256-GCM 密钥（优先 StrongBox，回退 TEE；开启 `setUserAuthenticationRequired(true)` 与 `setInvalidatedByBiometricEnrollment(true)`），通过 `BiometricPrompt` `CryptoObject` 仅在通过强生物识别后临时解封至内存，绝不明文落盘。
- **备选方案**：仅内存会话持有，不持久化任何远程密钥或 WebDAV 凭据。
- **否决理由**：离线场景和系统自动填充需要无需每次重输长口令与重新联网拉取远程密钥的流畅体验；硬件级 `CryptoObject` 封包既满足离线+生物识别便捷性，又防止 root/备份提取明文密钥。
- **重审条件**：若后续推出“高敏无痕模式”，可作为库级开关按需关闭本地硬件封包缓存。

### 4. WebDAV 离线优先加密缓存与强冲突保护

- **选定方案**：本地维护加密 `.kdbx` 工作副本与元数据（上次同步哈希与 ETag）；WebDAV 回写优先使用强 ETag `If-Match`，并在无强 ETag 时先 `GET` 比对远端密文 SHA-256 确认未漂移后再写入；检测到远端版本变化时进入冲突态，由用户显式选择「保留本地强推」「采用远程覆盖」或「另存为副本」，绝不静默覆盖。
- **重审条件**：若后续实现基于条目的 KDBX 语义级三向合并，可在冲突页新增「按条目自动合并」选项。
