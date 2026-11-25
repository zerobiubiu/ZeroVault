# 架构文档索引

本目录维护 ZeroVault 的现状架构说明、职责边界、接口契约与变更局部性评估。

## 文档清单

| 编号 / 文件 | 类型 | 状态 | 阅读顺序 | 说明 |
| --- | --- | --- | --- | --- |
| [0001-system-architecture.md](0001-system-architecture.md) | 架构说明 | 有效 | 1 | 系统范围、用例清单、规则权威归属、职责与目录边界、依赖图及变更模拟 |

## 核心源码入口导航

| 职责单元 | 入口文件 | 说明 |
| --- | --- | --- |
| KDBX 核心引擎 | `src/kdbx/index.ts` | 自主 KDBX 3.1/4.x 解析、序列化、复合密钥、TOTP |
| 多库与 WebDAV 存储 | `src/storage/index.ts` | 本地 SAF、WebDAV 传输与远程密钥、冲突状态机 |
| 安全与密码生成 | `src/security/index.ts` | 强密码/词组生成器、强度评估与锁库守护 |
| Android 原生桥接 | `src/native/index.ts` | Keystore/BiometricPrompt、原生加密、SAF、Autofill 桥接 |
| 设计令牌与主题 | `src/theme/index.ts` | 双层设计令牌（原始/语义）与深浅色主题切换 |
| 界面与状态协调 | `src/app/App.tsx` | Keyguard 风格商业界面、导航与状态协调者 |
| Android 原生实现 | `android/app/src/main/java/com/zerovault/` | Kotlin 安全模块、原生密码学引擎与 AutofillService |
