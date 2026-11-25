# ZeroVault 文档中心

本文件是 ZeroVault 项目文档体系的唯一入口，包含全库文档索引、文档规范与维护要求。

## 文档索引

### 架构设计 (`docs/architecture/`)

| 文档 | 类型 | 状态 | 概览 |
| --- | --- | --- | --- |
| [架构目录索引](architecture/README.md) | 索引 | 有效 | 架构文档清单、代码入口与依赖地图 |
| [0001-系统架构与十步规划](architecture/0001-system-architecture.md) | 架构说明 | 有效 | 范围、用例、规则归属、职责划分、依赖边界与变更局部性模拟 |

### 架构决策 (`docs/decisions/`)

| 文档 | 类型 | 状态 | 概览 |
| --- | --- | --- | --- |
| [决策目录索引](decisions/README.md) | 索引 | 有效 | 架构决策记录（ADR）清单与演进关系 |
| [0001-技术栈与安全边界决策](decisions/0001-tech-stack-and-security-boundary.md) | 架构决策 | 已执行 | React Native 裸工程、自主 KDBX + 原生加密、Keystore 硬件生物识别与 WebDAV 安全边界 |

### 变更记录 (`docs/changes/`)

| 文档 | 类型 | 状态 | 概览 |
| --- | --- | --- | --- |
| [变更目录索引](changes/README.md) | 索引 | 有效 | 源码变更随行记录清单 |
| [0001-0.1.0 初始完整架构与核心能力交付](changes/0001-initial-release.md) | 变更记录 | 已执行 | KDBX 引擎、Android 硬件安全与 Autofill、WebDAV 同步、Keyguard 风格 UI 与构建验收 |
| [0002-0.1.1 真机 Hermes 运行时兼容与独立 Release APK](changes/0002-android-runtime-fixes.md) | 变更记录 | 已执行 | 纯 TS UTF-8、原生 OkHttp WebDAV、Release APK 内嵌 Bundle 与模拟器冷启动实测 |
| [0003-0.1.2 异形屏适配、App Logo、默认库自动解锁与文案精简](changes/0003-ui-polish-logo-cutout-autounlock.md) | 变更记录 | 已执行 | 原创盾锁图标、DisplayCutout 三层安全区、启动自动解锁默认库与全页 UI 规整精简 |
| [0004-0.1.3 移除安全体检（Watchtower）模块](changes/0004-remove-watchtower.md) | 变更记录 | 已执行 | 移除安全体检引擎、页面与导航，精简为密码库/生成器/设置三栏 |
| [0005-MIT 开源与 GitHub Actions APK 自动发布](changes/0005-open-source-and-release-ci.md) | 变更记录 | 已执行 | 添加 MIT 协议、安全 CI 门禁与 v* 标签自动构建发布 Android Release APK |

### 问题排查 (`docs/troubleshooting/`)

| 文档 | 类型 | 状态 | 概览 |
| --- | --- | --- | --- |
| [排查目录索引](troubleshooting/README.md) | 索引 | 有效 | 长期可复现环境、构建与安全问题的排查记录 |
| [0001-真机安装 Debug APK 报错与 Hermes 运行时排查](troubleshooting/0001-android-release-and-hermes-runtime.md) | 排查记录 | 已执行 | Debug APK 缺 JS Bundle、Hermes 缺 TextEncoder/TextDecoder 及 URL/fetch 兼容根因与修复 |

### 文档视觉资源 (`docs/assets/`)

- [hero-banner.svg](assets/hero-banner.svg)：README 顶部品牌横幅矢量图
- [security-architecture.svg](assets/security-architecture.svg)：分层架构与 Android 硬件安全边界示意图
- [ui-overview.svg](assets/ui-overview.svg)：核心界面布局结构矢量示意图

### 根目录核心文档

- [AGENTS.md](../AGENTS.md)：项目级执行规则（Git、版本、Bun、安全约束）
- [CHANGELOG.md](../CHANGELOG.md)：语义化版本变更日志
- [DESIGN.md](../DESIGN.md)：视觉规范与双层设计令牌手册

## 文档规范

1. **存放与命名**：全部项目文档统一归档于 `docs/` 下对应类型子目录（`architecture/`、`decisions/`、`changes/`、`troubleshooting/`），不混放业务代码。
2. **局部编号**：每个分类子目录内独立从 `0001-` 递增编号；持续维护的现状文档与目录索引使用固定文件名（如 `README.md`）。
3. **元数据**：编号文档头部必须声明 `状态`、`影响范围`、`前置文档`、`替代文档`、`生效版本`。
4. **状态枚举**：`已执行`（定稿，不可修改）/ `有效`（持续维护的现状文档）/ `待执行` / `参考` / `已过期` / `已废弃`。
5. **治理分类**：区分「现状文档」（可随架构演进更新）与「不可变变更文档」（定稿后不重写，后续变更另建文档并标注替代关系）。
6. **语言**：全部文档与代码注释一律使用简体中文。

## 维护要求

- 凡改动源码（功能、修复、优化、模块增删），在交付回复前须同步在 `docs/changes/` 写入变更文档（含背景、方案、实施文件清单、执行验证记录、后续验证建议），并回填本文件及对应子目录 `README.md` 的索引。
- 变更文档中的验证记录必须基于真实执行结果，如实标注环境、命令、实际输出、结论与已知限制。
