# 0001 - 真机安装 Debug APK 报错与 Hermes 运行时兼容性排查

- **状态**：已执行
- **影响范围**：Android 真机独立安装、Hermes JS 运行时、WebDAV 与 TOTP 解析
- **前置文档**：无
- **替代文档**：无
- **生效版本**：`0.1.1`

---

## 现象

将 `android/app/build/outputs/apk/debug/app-debug.apk` 直接安装到脱离电脑的 Android 真机后，启动即报错；且因默认启用了 `FLAG_SECURE` 防截屏，用户无法直接截屏查看红屏报错。

## 根因分析

通过检查 APK 内部 `assets/` 目录、React Native 0.88 运行时源码（`setUpDefaultReactNativeEnvironment.js`、`Libraries/Blob/URL.js`、`Libraries/Network/fetch.js`）及本源码全量静态审计，定位到四个独立根因：

1. **`app-debug.apk` 不含内嵌 JS Bundle（直接首屏报错 `Unable to load script`）**：
   - React Native Gradle Plugin 默认对 `debug` 变体跳过打包 `index.android.bundle`，安装到真机后强制向 `localhost:8081` 请求 Metro 服务，脱离电脑必报红屏。
2. **Hermes 缺失全局 `TextEncoder` / `TextDecoder`（加载模块即抛出 `ReferenceError`）**：
   - `src/kdbx/binary.ts` 原在模块顶层执行 `new TextEncoder()` / `new TextDecoder('utf-8', { fatal: true })`，`@noble/hashes` 与 `@noble/ciphers` 内部辅助也依赖该全局 API，而 React Native 0.88 Hermes 环境未注入这两者。
3. **React Native 内置 `URL.js` 正则硬编码 `https?://`**：
   - 导致 `otpauth://totp/...` 的 `pathname` 始终返回 `/` 而丢失签发方与账号标签，且部分 HTTP URL 边界与标准 WHATWG URL 存在差异。
4. **React Native `whatwg-fetch` 对 WebDAV 自定义方法（`PROPFIND`）与二进制传输存在平台限制**：
   - 依赖 JS polyfill 难以保证全版本 Android 稳定拦截 3xx 重定向（防 `Authorization` 泄漏）与高效传输原始二进制。

## 解决方案

1. **纯 TS 严格 UTF-8 编解码 + 入口 Polyfill**：在 `src/kdbx/binary.ts` 实现零依赖 RFC 3629 `encodeUtf8`/`decodeUtf8`，并在 `index.js` 首行向 Hermes 补齐 `globalThis.TextEncoder`/`TextDecoder`。
2. **独立 RFC 3986 URL 解析**：在 `src/kdbx/totp.ts`、`src/storage/webdav.ts`、`src/security/watchtower.ts` 移除对 RN `URL.js` 缺陷属性的依赖。
3. **Android 原生 OkHttp WebDAV 通道**：新增 `WebDavNativeModule.kt`（`ZeroVaultWebDav`），使用 RN 内置 OkHttp 禁用自动重定向并原生支持 `GET`/`PUT`/`HEAD`/`PROPFIND` 与 Base64 二进制。
4. **构建独立真机 Release APK**：执行 `.\gradlew.bat :app:assembleRelease` 产出内置 `assets/index.android.bundle` 的 `android/app/build/outputs/apk/release/app-release.apk`，并添加根级 `AppErrorBoundary`。

## 预防措施

- 脱离 Metro 独立装机一律使用 `app-release.apk`；`app-debug.apk` 仅用于连电脑 Metro 实时调试。
- 凡涉及 Web/Node 全局 API（`TextEncoder`、`TextDecoder`、`URL`、`Buffer`、`crypto`），必须按 React Native Hermes 真实能力审查并在 Android 模拟器实机拉起校验 `logcat` 与 UI 渲染。
