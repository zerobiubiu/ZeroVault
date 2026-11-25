package com.zerovault.app.autofill

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.zerovault.app.MainActivity

/**
 * 自动填充锁定态认证中转页：
 * 当用户在其他应用点击「解锁 ZeroVault 以填充密码」时启动主应用完成身份验证，
 * 解锁后用户返回原应用即可立即触发已解锁自动填充建议。
 */
class AutofillAuthActivity : Activity() {

  companion object {
    const val EXTRA_TARGET_PACKAGE = "zv_autofill_target_pkg"
    const val EXTRA_TARGET_DOMAIN = "zv_autofill_target_domain"
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val mainIntent = Intent(this, MainActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      putExtra(EXTRA_TARGET_PACKAGE, intent.getStringExtra(EXTRA_TARGET_PACKAGE))
      putExtra(EXTRA_TARGET_DOMAIN, intent.getStringExtra(EXTRA_TARGET_DOMAIN))
    }
    startActivity(mainIntent)
    setResult(RESULT_CANCELED)
    finish()
  }
}
