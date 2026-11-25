package com.zerovault.app

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager
import com.zerovault.app.crypto.NativeCryptoModule
import com.zerovault.app.network.WebDavNativeModule
import com.zerovault.app.security.BiometricKeystoreModule
import com.zerovault.app.storage.SafStorageModule

/**
 * ZeroVault 自定义 Android 原生能力注册包。
 */
class ZeroVaultPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> = listOf(
    NativeCryptoModule(reactContext),
    BiometricKeystoreModule(reactContext),
    SafStorageModule(reactContext),
    WebDavNativeModule(reactContext),
  )

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
