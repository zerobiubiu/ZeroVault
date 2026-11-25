package com.zerovault.app.autofill

import android.app.PendingIntent
import android.app.assist.AssistStructure
import android.content.Intent
import android.os.Build
import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.Dataset
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.FillResponse
import android.service.autofill.SaveCallback
import android.service.autofill.SaveInfo
import android.service.autofill.SaveRequest
import android.text.InputType
import android.view.View
import android.view.autofill.AutofillId
import android.view.autofill.AutofillValue
import android.widget.RemoteViews
import androidx.annotation.RequiresApi
import com.zerovault.app.R

/**
 * ZeroVault Android 系统级自动填充服务（API 26+）。
 * - 已解锁：匹配当前应用包名或浏览器域名，返回可直接点击填充的凭据列表；
 * - 锁定态：提供系统级解锁引导项，点击后唤起 AutofillAuthActivity 完成生物识别/主密码解锁；
 * - 保存请求：记录待审核凭据供用户在 ZeroVault 主界面显式确认保存。
 */
@RequiresApi(Build.VERSION_CODES.O)
class ZeroVaultAutofillService : AutofillService() {

  private data class ParsedForm(
    val packageName: String?,
    val webDomain: String?,
    val usernameIds: MutableList<AutofillId> = mutableListOf(),
    val passwordIds: MutableList<AutofillId> = mutableListOf(),
  ) {
    fun hasFillableFields(): Boolean = usernameIds.isNotEmpty() || passwordIds.isNotEmpty()
  }

  override fun onFillRequest(
    request: FillRequest,
    cancellationSignal: CancellationSignal,
    callback: FillCallback,
  ) {
    val latestContext = request.fillContexts.lastOrNull()
    val structure = latestContext?.structure
    if (structure == null) {
      callback.onSuccess(null)
      return
    }

    val targetPkg = structure.activityComponent?.packageName
    // 禁止对 ZeroVault 自身触发系统自动填充
    if (targetPkg == packageName) {
      callback.onSuccess(null)
      return
    }

    val form = parseStructure(structure, targetPkg)
    if (!form.hasFillableFields()) {
      callback.onSuccess(null)
      return
    }

    val responseBuilder = FillResponse.Builder()
    val allIds = (form.usernameIds + form.passwordIds).toTypedArray()

    if (!AutofillSessionStore.isUnlocked()) {
      val authIntent = Intent(this, AutofillAuthActivity::class.java).apply {
        putExtra(AutofillAuthActivity.EXTRA_TARGET_PACKAGE, form.packageName)
        putExtra(AutofillAuthActivity.EXTRA_TARGET_DOMAIN, form.webDomain)
      }
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
      val sender = PendingIntent.getActivity(this, 1001, authIntent, flags).intentSender
      val presentation = buildRowPresentation("解锁 ZeroVault 以填充密码", form.webDomain ?: form.packageName ?: "点击验证身份")
      responseBuilder.setAuthentication(allIds, sender, presentation)
      callback.onSuccess(responseBuilder.build())
      return
    }

    val matches = AutofillSessionStore.findMatches(form.packageName, form.webDomain)
    for (entry in matches) {
      val subtitle = if (entry.username.isNotBlank()) entry.username else entry.url
      val presentation = buildRowPresentation(entry.title.ifBlank { "ZeroVault 凭据" }, subtitle)
      val datasetBuilder = Dataset.Builder(presentation)
      var attached = false

      for (uid in form.usernameIds) {
        if (entry.username.isNotEmpty()) {
          datasetBuilder.setValue(uid, AutofillValue.forText(entry.username), presentation)
          attached = true
        }
      }
      for (pid in form.passwordIds) {
        if (entry.password.isNotEmpty()) {
          datasetBuilder.setValue(pid, AutofillValue.forText(entry.password), presentation)
          attached = true
        }
      }
      if (attached) {
        responseBuilder.addDataset(datasetBuilder.build())
      }
    }

    // 注册保存凭据监听：用户登录/注册新站点时可提交给 ZeroVault 审核保存
    val saveType = when {
      form.usernameIds.isNotEmpty() && form.passwordIds.isNotEmpty() ->
        SaveInfo.SAVE_DATA_TYPE_USERNAME or SaveInfo.SAVE_DATA_TYPE_PASSWORD
      form.passwordIds.isNotEmpty() -> SaveInfo.SAVE_DATA_TYPE_PASSWORD
      else -> 0
    }
    if (saveType != 0 && allIds.isNotEmpty()) {
      responseBuilder.setSaveInfo(SaveInfo.Builder(saveType, allIds).build())
    }

    if (matches.isEmpty() && saveType == 0) {
      callback.onSuccess(null)
    } else {
      callback.onSuccess(responseBuilder.build())
    }
  }

  override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
    val structure = request.fillContexts.lastOrNull()?.structure
    if (structure == null) {
      callback.onFailure("未检测到可保存的表单内容")
      return
    }
    val targetPkg = structure.activityComponent?.packageName ?: "unknown"
    val extracted = extractSubmittedCredentials(structure)
    if (extracted.second.isBlank() && extracted.third.isBlank()) {
      callback.onFailure("未发现有效账号或密码字段")
      return
    }
    AutofillSessionStore.recordPendingSave(
      PendingAutofillSave(
        packageName = targetPkg,
        webDomain = extracted.first,
        username = extracted.second,
        password = extracted.third,
        capturedAt = System.currentTimeMillis(),
      ),
    )
    callback.onSuccess()
  }

  private fun buildRowPresentation(title: String, subtitle: String): RemoteViews {
    return RemoteViews(packageName, R.layout.autofill_suggestion_item).apply {
      setTextViewText(R.id.autofill_title, title)
      setTextViewText(R.id.autofill_subtitle, subtitle)
    }
  }

  private fun parseStructure(structure: AssistStructure, packageName: String?): ParsedForm {
    var domain: String? = null
    val usernameIds = mutableListOf<AutofillId>()
    val passwordIds = mutableListOf<AutofillId>()

    fun traverse(node: AssistStructure.ViewNode) {
      if (domain == null && !node.webDomain.isNullOrBlank()) {
        domain = node.webDomain
      }
      val autofillId = node.autofillId
      if (autofillId != null && node.autofillType == View.AUTOFILL_TYPE_TEXT) {
        val hints = node.autofillHints?.map { it.lowercase() }.orEmpty()
        val idEntry = node.idEntry?.lowercase() ?: ""
        val hintText = node.hint?.lowercase() ?: ""
        val inputType = node.inputType
        val isPasswordInput = isPasswordInputType(inputType)

        when {
          hints.any { it.contains("password") } ||
            isPasswordInput ||
            idEntry.contains("password") ||
            idEntry.contains("passwd") ||
            hintText.contains("密码") ||
            hintText.contains("password") -> {
            passwordIds.add(autofillId)
          }

          hints.any { it.contains("username") || it.contains("email") } ||
            idEntry.contains("username") ||
            idEntry.contains("email") ||
            idEntry.contains("account") ||
            idEntry.contains("login") ||
            hintText.contains("账号") ||
            hintText.contains("用户名") ||
            hintText.contains("邮箱") ||
            hintText.contains("email") -> {
            usernameIds.add(autofillId)
          }
        }
      }
      for (i in 0 until node.childCount) {
        traverse(node.getChildAt(i))
      }
    }

    for (i in 0 until structure.windowNodeCount) {
      traverse(structure.getWindowNodeAt(i).rootViewNode)
    }
    return ParsedForm(packageName, domain, usernameIds, passwordIds)
  }

  private fun extractSubmittedCredentials(structure: AssistStructure): Triple<String?, String, String> {
    var domain: String? = null
    var username = ""
    var password = ""

    fun traverse(node: AssistStructure.ViewNode) {
      if (domain == null && !node.webDomain.isNullOrBlank()) {
        domain = node.webDomain
      }
      val value = node.autofillValue?.takeIf { it.isText }?.textValue?.toString()?.trim()
      if (!value.isNullOrEmpty()) {
        val hints = node.autofillHints?.map { it.lowercase() }.orEmpty()
        val idEntry = node.idEntry?.lowercase() ?: ""
        if (isPasswordInputType(node.inputType) || hints.any { it.contains("password") } || idEntry.contains("password")) {
          if (password.isEmpty()) password = value
        } else if (
          hints.any { it.contains("username") || it.contains("email") } ||
          idEntry.contains("user") ||
          idEntry.contains("email") ||
          idEntry.contains("login")
        ) {
          if (username.isEmpty()) username = value
        }
      }
      for (i in 0 until node.childCount) {
        traverse(node.getChildAt(i))
      }
    }

    for (i in 0 until structure.windowNodeCount) {
      traverse(structure.getWindowNodeAt(i).rootViewNode)
    }
    return Triple(domain, username, password)
  }

  private fun isPasswordInputType(inputType: Int): Boolean {
    val variation = inputType and InputType.TYPE_MASK_VARIATION
    val cls = inputType and InputType.TYPE_MASK_CLASS
    return (cls == InputType.TYPE_CLASS_TEXT && (
      variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
        variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD ||
        variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
      )) || (cls == InputType.TYPE_CLASS_NUMBER && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD)
  }
}
