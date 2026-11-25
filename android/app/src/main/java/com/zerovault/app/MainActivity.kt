package com.zerovault.app

import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.core.view.WindowCompat
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
    // 统一启用 Edge-to-Edge 并精确上报状态栏、刘海屏、挖孔屏及手势导航栏安全区
    WindowCompat.setDecorFitsSystemWindows(window, false)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      window.attributes = window.attributes.apply {
        layoutInDisplayCutoutMode =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
          } else {
            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
          }
      }
    }
    @Suppress("DEPRECATION")
    window.statusBarColor = Color.TRANSPARENT
    @Suppress("DEPRECATION")
    window.navigationBarColor = Color.TRANSPARENT
    // 默认开启防截屏与最近任务缩略图隐藏，防止敏感密码外泄
    window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
  }

  override fun getMainComponentName(): String = "ZeroVault"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
