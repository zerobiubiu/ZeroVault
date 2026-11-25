package com.zerovault.app.autofill

import java.net.URI
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

data class AutofillEntryRecord(
  val id: String,
  val title: String,
  val username: String,
  val password: String,
  val url: String,
)

data class PendingAutofillSave(
  val packageName: String,
  val webDomain: String?,
  val username: String,
  val password: String,
  val capturedAt: Long,
)

/**
 * 进程内纯内存自动填充会话缓存。
 * 绝不持久化到磁盘；锁库、应用终止或超时自动清空。
 */
object AutofillSessionStore {
  private val lock = ReentrantReadWriteLock()
  private var activeVaultId: String? = null
  private var entries: List<AutofillEntryRecord> = emptyList()
  private var pendingSave: PendingAutofillSave? = null

  fun isUnlocked(): Boolean = lock.read { activeVaultId != null }

  fun update(vaultId: String, records: List<AutofillEntryRecord>) {
    lock.write {
      activeVaultId = vaultId
      entries = records.toList()
    }
  }

  fun clear() {
    lock.write {
      activeVaultId = null
      entries = emptyList()
    }
  }

  fun recordPendingSave(item: PendingAutofillSave) {
    lock.write {
      pendingSave = item
    }
  }

  fun consumePendingSave(): PendingAutofillSave? = lock.write {
    val current = pendingSave
    pendingSave = null
    current
  }

  /**
   * 按 Web 域名（含 eTLD+1 主域）或 Android 包名（androidapp://pkg）匹配候选凭据。
   * 仅返回高相关度匹配项，防止跨站点误填。
   */
  fun findMatches(packageName: String?, webDomain: String?): List<AutofillEntryRecord> = lock.read {
    if (activeVaultId == null) return emptyList()
    val normDomain = webDomain?.trim()?.lowercase()?.removePrefix("www.")
    val normPkg = packageName?.trim()?.lowercase()

    val exact = mutableListOf<AutofillEntryRecord>()
    val secondary = mutableListOf<AutofillEntryRecord>()

    for (item in entries) {
      val rawUrl = item.url.trim().lowercase()
      if (normDomain != null && normDomain.isNotEmpty() && rawUrl.isNotEmpty()) {
        val host = extractHost(rawUrl)
        if (host != null && (host == normDomain || host.endsWith(".$normDomain") || normDomain.endsWith(".$host"))) {
          exact.add(item)
          continue
        }
      }
      if (normPkg != null && normPkg.isNotEmpty()) {
        if (rawUrl == "androidapp://$normPkg" || rawUrl.contains("androidapp://$normPkg")) {
          exact.add(item)
          continue
        }
        val pkgLeaf = normPkg.substringAfterLast('.')
        if (pkgLeaf.length >= 4 && item.title.lowercase().contains(pkgLeaf)) {
          secondary.add(item)
        }
      }
    }
    return (exact + secondary).take(6)
  }

  private fun extractHost(rawUrl: String): String? {
    return try {
      val normalized = if (rawUrl.contains("://")) rawUrl else "https://$rawUrl"
      URI(normalized).host?.lowercase()?.removePrefix("www.")
    } catch (_: Exception) {
      null
    }
  }
}
