package com.zerovault.app.network

import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * ZeroVault 原生 OkHttp WebDAV 传输模块：
 * - 完整支持 GET / PUT / HEAD / PROPFIND 全部 WebDAV 方法与原始二进制字节（Base64）传输；
 * - 显式禁用 HTTP/HTTPS 自动重定向，防止 Authorization 凭据跨源泄漏；
 * - 绕开 React Native whatwg-fetch 在部分 Android 版本上的二进制与自定义 HTTP 方法限制。
 */
class WebDavNativeModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  private val baseClient: OkHttpClient = OkHttpClient.Builder()
    .followRedirects(false)
    .followSslRedirects(false)
    .build()

  override fun getName(): String = "ZeroVaultWebDav"

  @ReactMethod
  fun request(
    url: String,
    method: String,
    headersMap: ReadableMap,
    bodyB64: String?,
    contentType: String?,
    timeoutMs: Int,
    promise: Promise,
  ) {
    scope.launch {
      try {
        val safeTimeout = timeoutMs.coerceIn(3000, 120000).toLong()
        val client = baseClient.newBuilder()
          .connectTimeout(safeTimeout, TimeUnit.MILLISECONDS)
          .readTimeout(safeTimeout, TimeUnit.MILLISECONDS)
          .writeTimeout(safeTimeout, TimeUnit.MILLISECONDS)
          .build()

        val reqBuilder = Request.Builder().url(url)
        val iter = headersMap.keySetIterator()
        while (iter.hasNextKey()) {
          val key = iter.nextKey()
          val value = headersMap.getString(key)
          if (value != null) {
            reqBuilder.header(key, value)
          }
        }

        val upperMethod = method.uppercase()
        val requestBody = if (bodyB64 != null) {
          val bytes = Base64.decode(bodyB64, Base64.NO_WRAP)
          val mediaType = (contentType ?: "application/octet-stream").toMediaTypeOrNull()
          bytes.toRequestBody(mediaType)
        } else if (upperMethod == "PUT" || upperMethod == "PROPFIND") {
          ByteArray(0).toRequestBody((contentType ?: "application/octet-stream").toMediaTypeOrNull())
        } else {
          null
        }

        reqBuilder.method(upperMethod, requestBody)

        client.newCall(reqBuilder.build()).execute().use { response ->
          val bodyBytes = response.body?.bytes() ?: ByteArray(0)
          val responseHeaders = Arguments.createMap()
          for (name in response.headers.names()) {
            responseHeaders.putString(name.lowercase(), response.header(name))
          }
          val result = Arguments.createMap().apply {
            putInt("status", response.code)
            putString("url", response.request.url.toString())
            putMap("headers", responseHeaders)
            putString("bodyB64", Base64.encodeToString(bodyBytes, Base64.NO_WRAP))
          }
          promise.resolve(result)
        }
      } catch (e: Exception) {
        promise.reject("WEBDAV_NATIVE_ERROR", e.message ?: "WebDAV 原生网络请求失败", e)
      }
    }
  }
}
