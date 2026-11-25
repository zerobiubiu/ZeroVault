# 0002 - 0.1.1 真机 Hermes 运行时兼容修复、原生 OkHttp WebDAV 与独立 Release APK

- **状态**：已执行
- **影响范围**：`index.js`、`src/kdbx/`、`src/storage/`、`src/security/`、`src/native/`、`src/app/`、`android/`、`tests/`
- **前置文档**：[0001-initial-release.md](0001-initial-release.md)、[0001-android-release-and-hermes-runtime.md](../troubleshooting/0001-android-release-and-hermes-runtime.md)
- **替代文档**：无
- **生效版本**：`0.1.1`

---

## 1. 背景

用户反馈直接安装 `app-debug.apk` 至真机后启动报错。经排查确认存在四大真机运行问题：Debug APK 缺内嵌 JS Bundle、Hermes 缺失 `TextEncoder`/`TextDecoder`、RN 简陋版 `URL.js` 导致 `otpauth://` 与 HTTP URL 兼容问题、以及 RN `whatwg-fetch` 对 WebDAV `PROPFIND`/二进制/防重定向支持不稳定。

## 2. 方案与实施清单

- **UTF-8 与 Hermes 入口修复**：
  - [src/kdbx/binary.ts](../../src/kdbx/binary.ts)：用纯 TypeScript 实现严格 RFC 3629 `encodeUtf8` / `decodeUtf8`（含 UTF-8 BOM 跳过、4 字节代理对支持与非法字节严格抛错）。
  - [index.js](../../index.js)：应用最顶层按需挂载 `globalThis.TextEncoder` / `globalThis.TextDecoder` polyfill。
  - [tests/kdbx/binary.test.ts](../../tests/kdbx/binary.test.ts)：新增 UTF-8 往返、Emoji 代理对、BOM 及 4 类非法编码单测。
- **消除 RN `URL.js` 缺陷依赖**：
  - [src/kdbx/totp.ts](../../src/kdbx/totp.ts)、[src/storage/webdav.ts](../../src/storage/webdav.ts)、[src/security/watchtower.ts](../../src/security/watchtower.ts)、[src/app/state/VaultCoordinator.tsx](../../src/app/state/VaultCoordinator.tsx)。
- **Android 原生 OkHttp WebDAV 通道**：
  - [WebDavNativeModule.kt](../../android/app/src/main/java/com/zerovault/app/network/WebDavNativeModule.kt)、[ZeroVaultPackage.kt](../../android/app/src/main/java/com/zerovault/app/ZeroVaultPackage.kt)、[src/native/types.ts](../../src/native/types.ts)、[src/native/bridge.ts](../../src/native/bridge.ts)、[src/native/index.ts](../../src/native/index.ts)。
- **根级错误边界与版本同步（`0.1.1` / `versionCode 2`）**：
  - [src/app/App.tsx](../../src/app/App.tsx)、[src/app/screens/SettingsScreen.tsx](../../src/app/screens/SettingsScreen.tsx)、[package.json](../../package.json)、[android/app/build.gradle](../../android/app/build.gradle)、[CHANGELOG.md](../../CHANGELOG.md)。

## 3. 执行验证记录

- **执行环境**：Windows，Bun `1.4.5`，Android Studio JBR `OpenJDK 25.0.4`，Android SDK `android-37.0` / `Medium_Phone_API_37.0` 无头模拟器。
- **验证命令与实际输出**：
  1. `bun run verify:all`
     - 版本门禁通过：`0.1.1`
     - 设计令牌门禁通过：42 组配对，最低对比度 `6.11:1`
     - `tsc --noEmit`：0 错误
     - Vitest：`Test Files 7 passed (7)`，`Tests 25 passed (25)`（`271ms`）
  2. `.\gradlew.bat :app:assembleRelease --no-daemon --console=plain`
     - 结果：`BUILD SUCCESSFUL in 1m 31s`（115 tasks，含 `lintVitalRelease`）
     - 产出：`android/app/build/outputs/apk/release/app-release.apk`（`59,192,873` 字节），验证内含 `assets/index.android.bundle`（`1,584,196` 字节）。
  3. Android 无头模拟器 `Medium_Phone_API_37.0` 实机安装与启动验证：
     - `adb install -r app-release.apk`：`Performing Streamed Install` → `Success`
     - `adb shell am start -W -n com.zerovault.app/.MainActivity`：`Status: ok`，`LaunchState: COLD`，`TotalTime: 1266ms`
     - `adb logcat`：`I ReactNativeJS: Running "ZeroVault"`，检测到原生 `BiometricService/PreAuthInfo` 查询成功，全程零 Java/JS/Hermes 异常崩溃，8 秒后进程存活（`PID: 2910`）
     - `uiautomator dump`：`UI_RENDER_OK`，确认屏幕已真实渲染 ZeroVault 中文首屏 UI。
- **验证结论**：通过，已解决真机启动即报错问题并产出可直接安装运行的独立 Release APK。
- **已知限制**：模拟器未录入硬件指纹或连接外部真实 WebDAV 服务器，后续建议在用户真机实测指纹解锁弹窗、WebDAV 同步与系统 AutofillService。
