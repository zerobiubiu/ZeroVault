# 变更日志

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本规范，版本号以根 `package.json#version` 为单一事实来源。

## [0.1.3] - 未发布（开发中）

### 移除

- 移除安全体检（Watchtower）引擎模块、底部导航入口及相关界面与测试，底部主导航精简为「密码库 / 生成器 / 设置」。

## [0.1.2] - 未发布（开发中）

### 变更与优化

- 新增 ZeroVault 原创几何盾锁 App Logo（Android Adaptive 矢量图标、5 套密度 PNG 图标及 App 内 `BrandLogo` 组件）。
- 完整适配异形屏、刘海屏、挖孔屏与底部手势栏：新增原生 `DisplayCutout` 窗口模式、`getSystemInsetsSync()` 同步安全区读取、状态栏/导航栏图标深浅色同步及统一 `ScreenHeader` 安全隔离层，确保全部页面与弹窗内容不越过系统顶部状态栏。
- 新增启动默认密码库（`isDefault`）配置：打开 App 或超时锁库回前台时自动唤起默认库生物识别弹窗（或无密码直解 / 自动聚焦密码框）。
- 按高信息密度极简规范完成全部 9 个界面的布局规整与文案精简。

## [0.1.1] - 未发布（开发中）

### 修复

- 彻底消除 React Native Hermes 缺少全局 `TextEncoder` / `TextDecoder` 导致的真机启动即崩问题（纯 TypeScript 严格 RFC 3629 UTF-8 编解码 + 入口自动 polyfill）。
- 消除 `totp.ts`、`webdav.ts`、`watchtower.ts` 对 React Native 残缺版 `URL.js` 的隐式依赖，改用严格 RFC 3986 解析。
- 新增 Android 原生 OkHttp WebDAV 模块（`WebDavNativeModule.kt`），原生支持 `GET`/`PUT`/`HEAD`/`PROPFIND`、禁用重定向与原始二进制字节传输。
- 新增根级 `AppErrorBoundary`，并通过 `assembleRelease` 构建内置完整 Hermes JS Bundle 的独立真机安装包（`app-release.apk`），解决 `app-debug.apk` 无内嵌 bundle 脱离 Metro 报 `Unable to load script` 的问题。

## [0.1.0] - 未发布（开发中）

### 新增

- 初始化 ZeroVault 项目架构、协作规范（`AGENTS.md`）与文档体系（`docs/`）。
- 规划并构建 React Native 0.88 Android 裸工程与 Kotlin 原生安全基座。
- 自主实现 KDBX 3.1 / 4.0 / 4.1 协议引擎（严格区分空密码与无密码组件、支持密钥文件与 TOTP）。
- 实现本地 SAF 与 WebDAV（含远程数据库与远程密钥文件）多库同步及冲突处理引擎。
- 实现 Android Keystore + BiometricPrompt 硬件级生物识别解锁、原生密码学加速、`FLAG_SECURE`、敏感剪贴板与系统自动填充服务（AutofillService）。
- 构建 Keyguard 风格商业界面、密码/词组生成器与 Watchtower 安全体检。
