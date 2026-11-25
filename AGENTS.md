# ZeroVault 项目协作规则

## Git 与版本

- 已授权初始化 Git；未经用户明确要求，不提交、不打标签、不推送，不改写历史。
- 不运行破坏性 Git 操作（`reset --hard`、`push --force` 等）；尊重未提交改动。
- 严格保护根目录 `.markindex/`，不得修改、清理、删除或提交它。
- 版本号以根 `package.json#version` 为单一事实来源，当前开发版本从 `0.1.0` 起步；同步维护 `android/app/build.gradle`（`versionName` / `versionCode`）与 `CHANGELOG.md`，并由 `bun run verify:version` 校验门禁。
- 仅在应用程序行为变更时递增版本号；纯文档、注释、`AGENTS.md` 变更不递增。

## 包管理与本地工具

- 唯一包管理器为 `bun`（根目录 `bun.lock`）；禁止使用 `npm`、`yarn`、`pnpm` 安装依赖或生成对应锁文件。
- 禁止未经用户确认在本机安装全局软件、系统级 JDK 或 Android SDK 组件；构建 Android 时通过命令级环境变量注入本机既有 Android SDK / JBR 路径，不篡改用户系统环境变量。
- 测试统一使用 Vitest（`bun run test`），类型检查使用 `bun run check`，禁止以 `bun test` 替代项目 Vitest 配置。

## 架构与安全硬约束

- **自主 KDBX 实现**：`src/kdbx/` 自主实现 KDBX 3.1 / 4.0 / 4.1 协议，绝不引入或包装 `kdbxweb` 或其他完整第三方 KDBX 库；不得 fork 或依赖参考项目。
- **凭据语义**：严格区分 `password: null`（无密码组件，仅密钥文件）与 `password: ""`（显式空密码组件）；零字节密钥文件视为合法任意二进制文件。
- **零明文落盘**：主密码、解锁派生复合密钥、远程密钥文件明文、WebDAV 密码不得以明文写入任何本地文件、`AsyncStorage`、`SharedPreferences` 或日志。持久缓存的远程密钥与 WebDAV 凭据必须经 Android Keystore 硬件密钥（优先 StrongBox，回退 TEE）结合 `BiometricPrompt` `CryptoObject` 加密封包。
- **界面状态最小化**：UI 列表状态只保存 `VaultEntrySummary` 摘要；密码、受保护自定义字段、附件字节仅在展示、复制或自动填充时按需读取，禁止批量展开至全局 UI 状态。
- **同步与冲突边界**：本地 SAF 文件与 WebDAV 来源独立管理，不静默覆盖冲突；WebDAV 回写须校验版本（强 ETag `If-Match` 或内容哈希比对），发生冲突时必须由用户显式选择保留本地、采用远程或另存副本。
- **Android 隐私与防护**：默认开启 `FLAG_SECURE` 防止截屏与最近任务缩略图泄漏；复制敏感字段须设置 Android 13+ `EXTRA_IS_SENSITIVE` 标记并支持自动清除；XML 解析必须禁用外部实体（防 XXE）。

## 目录与文档规范

- 按职责组织源码：`src/kdbx/`、`src/storage/`、`src/security/`、`src/native/`、`src/theme/`、`src/app/`，测试集中在 `tests/`；禁止新建通用 `utils/`、`helpers/`、`common/` 大杂烩目录，禁止循环依赖。
- 全部文档与新增注释使用简体中文。
- 源码变更须同步在 `docs/changes/` 编写不可变变更记录并更新 `docs/README.md` 索引；未执行或失败的验证不得写为已通过。
- 禁止将真实 `.kdbx` 数据库、真实密钥文件、口令或 WebDAV 凭据提交入库；测试仅使用明确标注的合成数据。
