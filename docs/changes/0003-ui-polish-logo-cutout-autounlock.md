# 0003 - 0.1.2 异形屏安全区适配、原创 App Logo、默认库自动解锁与全页文案精简

- **状态**：已执行
- **影响范围**：`android/app/src/main/{res,java}`、`src/native/`、`src/storage/types.ts`、`src/app/`、`tools/generate-app-icons.mts`
- **前置文档**：[0002-android-runtime-fixes.md](0002-android-runtime-fixes.md)
- **替代文档**：无
- **生效版本**：`0.1.2`

---

## 1. 背景

针对用户真机体验反馈与《UI 文案密度与信息表达规范》，解决四项关键体验问题：部分机型顶部内容越过系统状态栏与刘海/挖孔区、沿用默认模板图标、打开应用后需手动点选库再点解锁、以及界面布局不够规整与存在冗余说明文案。

## 2. 方案与实施清单

1. **原创几何盾锁 App Logo**
   - Android Adaptive 矢量图标：[ic_launcher_background.xml](../../android/app/src/main/res/drawable/ic_launcher_background.xml)、[ic_launcher_foreground.xml](../../android/app/src/main/res/drawable/ic_launcher_foreground.xml)、[mipmap-anydpi-v26/ic_launcher.xml](../../android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml) 与 `ic_launcher_round.xml`。
   - 5 套密度抗锯齿 PNG 图标：[tools/generate-app-icons.mts](../../tools/generate-app-icons.mts) 生成覆盖 `mipmap-mdpi` 至 `mipmap-xxxhdpi` 共 10 个图标文件。
   - App 内同源品牌组件：[src/app/components/BrandLogo.tsx](../../src/app/components/BrandLogo.tsx)。
2. **异形屏 / 刘海屏 / 挖孔屏 / 状态栏与底部手势栏三层安全区适配**
   - [MainActivity.kt](../../android/app/src/main/java/com/zerovault/app/MainActivity.kt)、[styles.xml](../../android/app/src/main/res/values/styles.xml)、[values-v28/styles.xml](../../android/app/src/main/res/values-v28/styles.xml)：统一 Edge-to-Edge 与 `LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES / ALWAYS` 窗口模式。
   - [SafStorageModule.kt](../../android/app/src/main/java/com/zerovault/app/storage/SafStorageModule.kt)：新增 `getSystemInsetsSync()`（API 30+ 优先 `currentWindowMetrics.windowInsets`，合并 `statusBars | displayCutout | navigationBars`，并兜底读取系统 `status_bar_height`）及 `setSystemBarsStyle(darkIcons)`。
   - [src/app/components/SafeLayout.tsx](../../src/app/components/SafeLayout.tsx)：新增 `useSafeInsets()`、`ScreenHeader` 与 `ContentFrame`（横屏/平板 `maxWidth: 640` 并避让四边安全区），[App.tsx](../../src/app/App.tsx) 与全部弹窗（含 WebDAV 目录浏览 Modal）显式隔离顶部状态栏高度与底部手势栏高度。
3. **启动自动唤起默认密码数据库解锁**
   - [src/storage/types.ts](../../src/storage/types.ts) 增加 `VaultProfile.isDefault`；[VaultCoordinator.tsx](../../src/app/state/VaultCoordinator.tsx) 提供 `defaultProfile`、`setDefaultProfile()` 与 `autoUnlockNonce`。
   - [UnlockScreen.tsx](../../src/app/screens/UnlockScreen.tsx) 在冷启动及超时锁库回前台时自动触发默认库生物识别弹窗（或无密码/空密码直解、或主密码自动聚焦唤起键盘回车解锁）；手动锁库或取消生物识别后不死循环反复弹窗。
4. **全页布局规整与极简文案审计重构**
   - [Primitives.tsx](../../src/app/components/Primitives.tsx) 新增统一 `SwitchRow`，统一表单内距（6dp）< 组距（18dp）、44dp+ 触控目标与 2–4 字动作按钮。
   - 逐页重构全部 9 个页面（`UnlockScreen`、`SourceSetupScreen`、`VaultListScreen`、`EntryDetailScreen`、`EntryEditorScreen`、`WatchtowerScreen`、`GeneratorScreen`、`SettingsScreen`、`ConflictResolveScreen`）与 `TotpCard`，删除标题副文案、功能介绍段落、按钮旁重复说明与操作指引型 Placeholder，保留数量/大小/熵值口径与安全风险提示。
   - 版本递增至 `0.1.2`（`versionCode 3`）：同步 `package.json`、`android/app/build.gradle`、`CHANGELOG.md`。

## 3. 执行验证记录

- **执行环境**：Windows，Bun `1.4.5`，Android Studio JBR `OpenJDK 25.0.4`，Android SDK `android-37.0`，无头模拟器 `Medium_Phone_API_37.0`（1080×2400，状态栏高度 `63px`）。
- **验证命令与实际输出**：
  1. `bun run verify:all`（最终修复后）：
     - 版本门禁通过：`0.1.2`
     - 设计令牌门禁通过：42 组深浅色文本配对，最低对比度 `6.11:1`
     - `tsc --noEmit`：0 错误
     - Vitest：`Test Files 7 passed (7)`，`Tests 25 passed (25)`（`327ms`）
  2. `.\gradlew.bat :app:assembleRelease --no-daemon --console=plain`（最终修复后）：
     - `BUILD SUCCESSFUL in 54s`（含 `lintVitalRelease`）
     - 产出：`android/app/build/outputs/apk/release/app-release.apk`（`59,209,513` 字节）
  3. 模拟器实机布局与坐标审计（`Medium_Phone_API_37.0`）：
     - 冷启动主界面与点击进入 `SourceSetupScreen` 全程 `ZERO_CRASHES_IN_LOGCAT`（`PID: 4415` 存活）
     - `uiautomator dump` 量化实测：系统顶部状态栏占用 `y: 0..63px`，`SourceSetupScreen` 顶栏标题 `添加密码库` 坐标 `[42,102][901,165]`、关闭按钮 `[943,106][1017,160]`，严格处于状态栏下方零侵入；标签与输入框内距 `15px (≈6dp)` 小于字段组间距 `47px (≈18dp)`。
- **验证结论**：全部静态检查、单测、Release 构建及模拟器真实坐标验证均通过。
- **已知限制**：挖孔屏高状态栏真机与物理指纹传感器自动弹出需在用户真机安装 `0.1.2` `app-release.apk` 复核（API 30+ 原生 `currentWindowMetrics.windowInsets` 的补充改动已在最终 APK 编译通过，模拟器仅覆盖标准状态栏形态）。
