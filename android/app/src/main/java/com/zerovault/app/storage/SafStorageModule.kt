package com.zerovault.app.storage

import android.app.Activity
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.provider.OpenableColumns
import android.provider.Settings
import android.util.Base64
import android.view.WindowManager
import android.view.autofill.AutofillManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableMap
import com.zerovault.app.autofill.AutofillEntryRecord
import com.zerovault.app.autofill.AutofillSessionStore
import java.io.File

/**
 * ZeroVault 存储与系统边界模块：
 * - Android SAF（Storage Access Framework）持久化文档读写
 * - 应用私有沙盒文件读写（含路径穿越防护）
 * - FLAG_SECURE 防截屏控制
 * - 敏感剪贴板标记（Android 13+ EXTRA_IS_SENSITIVE）与定时清理
 * - AutofillService 状态查询、系统设置引导与进程内安全会话同步
 */
class SafStorageModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    private const val REQ_OPEN_DOCUMENT = 49101
    private const val REQ_CREATE_DOCUMENT = 49102
    private const val SANDBOX_ROOT_DIR = "zerovault"
  }

  private var pendingPromise: Promise? = null
  private val mainHandler = Handler(Looper.getMainLooper())
  private var clipboardClearRunnable: Runnable? = null

  private val activityListener: ActivityEventListener = object : BaseActivityEventListener() {
    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
      if (requestCode != REQ_OPEN_DOCUMENT && requestCode != REQ_CREATE_DOCUMENT) return
      val promise = pendingPromise ?: return
      pendingPromise = null

      if (resultCode != Activity.RESULT_OK || data?.data == null) {
        promise.reject("SAF_CANCELED", "用户取消了文件选择")
        return
      }
      val uri = data.data!!
      try {
        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        try {
          reactContext.contentResolver.takePersistableUriPermission(uri, flags)
        } catch (_: SecurityException) {
          // 部分只读 SAF 提供者仅允许持久读权限
          try {
            reactContext.contentResolver.takePersistableUriPermission(
              uri,
              Intent.FLAG_GRANT_READ_URI_PERMISSION,
            )
          } catch (_: SecurityException) {
            // 临时 URI 依然可用于单次读取
          }
        }
        val meta = queryUriMeta(uri)
        promise.resolve(meta)
      } catch (e: Exception) {
        promise.reject("SAF_RESULT_ERROR", e.message, e)
      }
    }
  }

  init {
    reactContext.addActivityEventListener(activityListener)
  }

  override fun getName(): String = "ZeroVaultStorage"

  private fun queryUriMeta(uri: Uri) = Arguments.createMap().apply {
    var displayName = uri.lastPathSegment ?: "database.kdbx"
    var size = -1L
    reactContext.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)
      ?.use { cursor ->
        if (cursor.moveToFirst()) {
          val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
          if (nameIdx >= 0) displayName = cursor.getString(nameIdx) ?: displayName
          if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) size = cursor.getLong(sizeIdx)
        }
      }
    putString("uri", uri.toString())
    putString("displayName", displayName)
    putDouble("size", size.toDouble())
  }

  private fun resolveSafePrivateFile(relativePath: String): File {
    val root = File(reactContext.filesDir, SANDBOX_ROOT_DIR).canonicalFile
    if (!root.exists()) root.mkdirs()
    val sanitized = relativePath.trimStart('/', '\\')
    require(sanitized.isNotEmpty() && !sanitized.contains("..")) { "非法沙盒路径: $relativePath" }
    val target = File(root, sanitized).canonicalFile
    require(target.path.startsWith(root.path + File.separator)) { "检测到路径穿越尝试: $relativePath" }
    return target
  }

  @ReactMethod
  fun pickDocument(promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("NO_ACTIVITY", "当前没有可见的 Activity")
      return
    }
    if (pendingPromise != null) {
      promise.reject("SAF_BUSY", "已有正在进行的文件选择操作")
      return
    }
    pendingPromise = promise
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "*/*"
      addFlags(
        Intent.FLAG_GRANT_READ_URI_PERMISSION or
          Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
          Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
      )
    }
    activity.startActivityForResult(intent, REQ_OPEN_DOCUMENT)
  }

  @ReactMethod
  fun createDocument(suggestedName: String, promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("NO_ACTIVITY", "当前没有可见的 Activity")
      return
    }
    if (pendingPromise != null) {
      promise.reject("SAF_BUSY", "已有正在进行的文件创建操作")
      return
    }
    pendingPromise = promise
    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "application/octet-stream"
      putExtra(Intent.EXTRA_TITLE, suggestedName)
      addFlags(
        Intent.FLAG_GRANT_READ_URI_PERMISSION or
          Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
          Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
      )
    }
    activity.startActivityForResult(intent, REQ_CREATE_DOCUMENT)
  }

  @ReactMethod
  fun readDocumentBase64(uriString: String, promise: Promise) {
    try {
      val uri = Uri.parse(uriString)
      val bytes = reactContext.contentResolver.openInputStream(uri)?.use { it.readBytes() }
        ?: throw IllegalStateException("无法打开 SAF 输入流")
      promise.resolve(Base64.encodeToString(bytes, Base64.NO_WRAP))
    } catch (e: SecurityException) {
      promise.reject("SAF_PERMISSION_REVOKED", "文件访问权限已被系统撤销，请重新选择文件", e)
    } catch (e: Exception) {
      promise.reject("SAF_READ_ERROR", e.message, e)
    }
  }

  @ReactMethod
  fun writeDocumentBase64(uriString: String, dataB64: String, promise: Promise) {
    try {
      val uri = Uri.parse(uriString)
      val bytes = Base64.decode(dataB64, Base64.NO_WRAP)
      reactContext.contentResolver.openOutputStream(uri, "wt")?.use { out ->
        out.write(bytes)
        out.flush()
      } ?: throw IllegalStateException("无法打开 SAF 输出流")
      promise.resolve(true)
    } catch (e: SecurityException) {
      promise.reject("SAF_PERMISSION_REVOKED", "缺少该文件的写入权限，请重新授权", e)
    } catch (e: Exception) {
      promise.reject("SAF_WRITE_ERROR", e.message, e)
    }
  }

  @ReactMethod
  fun readPrivateFileBase64(relativePath: String, promise: Promise) {
    try {
      val file = resolveSafePrivateFile(relativePath)
      if (!file.exists()) {
        promise.resolve(null)
        return
      }
      promise.resolve(Base64.encodeToString(file.readBytes(), Base64.NO_WRAP))
    } catch (e: Exception) {
      promise.reject("PRIVATE_READ_ERROR", e.message, e)
    }
  }

  @ReactMethod
  fun writePrivateFileBase64(relativePath: String, dataB64: String, promise: Promise) {
    try {
      val file = resolveSafePrivateFile(relativePath)
      file.parentFile?.mkdirs()
      val tmp = File(file.parentFile, "${file.name}.tmp")
      tmp.writeBytes(Base64.decode(dataB64, Base64.NO_WRAP))
      if (!tmp.renameTo(file)) {
        tmp.copyTo(file, overwrite = true)
        tmp.delete()
      }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("PRIVATE_WRITE_ERROR", e.message, e)
    }
  }

  @ReactMethod
  fun deletePrivateFile(relativePath: String, promise: Promise) {
    try {
      val file = resolveSafePrivateFile(relativePath)
      if (file.exists()) file.delete()
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("PRIVATE_DELETE_ERROR", e.message, e)
    }
  }

  @ReactMethod
  fun setSecureScreen(enabled: Boolean, promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.resolve(false)
      return
    }
    activity.runOnUiThread {
      if (enabled) {
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      } else {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
      promise.resolve(true)
    }
  }

  /**
   * 同步返回系统状态栏、刘海/挖孔（DisplayCutout）与手势导航栏安全区（单位 dp）。
   * 解决国产定制 ROM 或首帧渲染时安全区为 0 导致顶部内容越过系统状态栏的问题。
   */
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun getSystemInsetsSync(): WritableMap {
    val density = reactContext.resources.displayMetrics.density.coerceAtLeast(1f)
    var topPx = 0
    var bottomPx = 0
    var leftPx = 0
    var rightPx = 0

    val activity = reactContext.currentActivity
    if (activity != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val metricsInsets = activity.windowManager.currentWindowMetrics.windowInsets
      val compat = WindowInsetsCompat.toWindowInsetsCompat(metricsInsets)
      val barsAndCutout = compat.getInsets(
        WindowInsetsCompat.Type.statusBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.navigationBars(),
      )
      topPx = barsAndCutout.top
      bottomPx = barsAndCutout.bottom
      leftPx = barsAndCutout.left
      rightPx = barsAndCutout.right
    } else {
      val rootInsets = activity?.window?.decorView?.rootWindowInsets
      if (rootInsets != null) {
        val compat = WindowInsetsCompat.toWindowInsetsCompat(rootInsets)
        val barsAndCutout = compat.getInsets(
          WindowInsetsCompat.Type.statusBars() or
            WindowInsetsCompat.Type.displayCutout() or
            WindowInsetsCompat.Type.navigationBars(),
        )
        topPx = barsAndCutout.top
        bottomPx = barsAndCutout.bottom
        leftPx = barsAndCutout.left
        rightPx = barsAndCutout.right
      }
    }

    // 兜底：若窗口尚未完成首次布局导致 topPx 为 0，读取系统 status_bar_height 资源
    if (topPx <= 0) {
      val resId = reactContext.resources.getIdentifier("status_bar_height", "dimen", "android")
      if (resId > 0) {
        topPx = reactContext.resources.getDimensionPixelSize(resId)
      }
    }

    return Arguments.createMap().apply {
      putDouble("top", (topPx / density).toDouble())
      putDouble("bottom", (bottomPx / density).toDouble())
      putDouble("left", (leftPx / density).toDouble())
      putDouble("right", (rightPx / density).toDouble())
    }
  }

  @ReactMethod
  fun setSystemBarsStyle(darkIcons: Boolean) {
    val activity = reactContext.currentActivity ?: return
    activity.runOnUiThread {
      val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
      controller.isAppearanceLightStatusBars = darkIcons
      controller.isAppearanceLightNavigationBars = darkIcons
    }
  }

  @ReactMethod
  fun copySensitiveToClipboard(text: String, label: String, clearAfterMs: Int, promise: Promise) {
    try {
      val clipboard = reactContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      val clip = ClipData.newPlainText(label, text)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        clip.description.extras = PersistableBundle().apply {
          putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
        }
      }
      clipboard.setPrimaryClip(clip)

      clipboardClearRunnable?.let { mainHandler.removeCallbacks(it) }
      if (clearAfterMs > 0) {
        val snapshot = text
        val task = Runnable {
          try {
            val current = clipboard.primaryClip?.getItemAt(0)?.text?.toString()
            if (current == snapshot) {
              if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                clipboard.clearPrimaryClip()
              } else {
                clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
              }
            }
          } catch (_: Exception) {
            // 后台清理失败时安全忽略
          }
        }
        clipboardClearRunnable = task
        mainHandler.postDelayed(task, clearAfterMs.toLong())
      }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("CLIPBOARD_ERROR", e.message, e)
    }
  }

  @ReactMethod
  fun isAutofillServiceEnabled(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      promise.resolve(false)
      return
    }
    try {
      val afm = reactContext.getSystemService(AutofillManager::class.java)
      promise.resolve(afm?.hasEnabledAutofillServices() == true)
    } catch (e: Exception) {
      promise.reject("AUTOFILL_CHECK_ERROR", e.message, e)
    }
  }

  @ReactMethod
  fun openAutofillSettings(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      promise.resolve(false)
      return
    }
    try {
      val intent = Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE).apply {
        data = Uri.parse("package:${reactContext.packageName}")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      reactContext.startActivity(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("AUTOFILL_SETTINGS_ERROR", e.message, e)
    }
  }

  @ReactMethod
  fun syncAutofillSession(vaultId: String, entries: ReadableArray, promise: Promise) {
    try {
      val list = ArrayList<AutofillEntryRecord>(entries.size())
      for (i in 0 until entries.size()) {
        val map = entries.getMap(i) ?: continue
        list.add(
          AutofillEntryRecord(
            id = map.getString("id") ?: continue,
            title = map.getString("title") ?: "",
            username = map.getString("username") ?: "",
            password = map.getString("password") ?: "",
            url = map.getString("url") ?: "",
          ),
        )
      }
      AutofillSessionStore.update(vaultId, list)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("AUTOFILL_SYNC_ERROR", e.message, e)
    }
  }

  @ReactMethod
  fun clearAutofillSession(promise: Promise) {
    AutofillSessionStore.clear()
    promise.resolve(true)
  }

  @ReactMethod
  fun consumePendingAutofillSave(promise: Promise) {
    val pending = AutofillSessionStore.consumePendingSave()
    if (pending == null) {
      promise.resolve(null)
      return
    }
    val map = Arguments.createMap().apply {
      putString("packageName", pending.packageName)
      putString("webDomain", pending.webDomain)
      putString("username", pending.username)
      putString("password", pending.password)
      putDouble("capturedAt", pending.capturedAt.toDouble())
    }
    promise.resolve(map)
  }
}
