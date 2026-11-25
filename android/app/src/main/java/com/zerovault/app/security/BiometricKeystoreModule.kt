package com.zerovault.app.security

import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * ZeroVault 硬件安全与生物识别模块：
 * - 基于 Android Keystore（优先 StrongBox，回退 TEE）生成不可导出 AES-256-GCM 密钥；
 * - 强制绑定 BiometricPrompt CryptoObject（BIOMETRIC_STRONG Class 3）；
 * - 系统新增/变更生物特征时硬件自动吊销旧密钥（KeyPermanentlyInvalidatedException）。
 */
class BiometricKeystoreModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
    private const val AES_GCM_TRANSFORMATION = "AES/GCM/NoPadding"
    private const val GCM_TAG_BITS = 128
    private const val BIOMETRIC_PREFIX = "zv_bio_"
    private const val DEVICE_PREFIX = "zv_dev_"
  }

  override fun getName(): String = "ZeroVaultBiometric"

  private fun sanitizeAlias(prefix: String, alias: String): String {
    val clean = alias.replace(Regex("[^a-zA-Z0-9._-]"), "_")
    require(clean.isNotEmpty() && clean.length <= 96) { "Keystore 别名非法" }
    return "$prefix$clean"
  }

  private fun hasStrongBoxHardware(): Boolean {
    return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
      reactContext.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
  }

  private fun loadKeyStore(): KeyStore {
    return KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
  }

  private fun createHardwareAesKey(fullAlias: String, requireBiometric: Boolean): Pair<SecretKey, Boolean> {
    val keyStore = loadKeyStore()
    if (keyStore.containsAlias(fullAlias)) {
      keyStore.deleteEntry(fullAlias)
    }

    fun buildSpec(useStrongBox: Boolean): KeyGenParameterSpec {
      val builder = KeyGenParameterSpec.Builder(
        fullAlias,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setRandomizedEncryptionRequired(true)

      if (requireBiometric) {
        builder.setUserAuthenticationRequired(true)
        builder.setInvalidatedByBiometricEnrollment(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          // 0 秒有效期：每次加密/解封均须经过当前实时强生物认证（CryptoObject 绑定）
          builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        }
      }

      if (useStrongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        builder.setIsStrongBoxBacked(true)
      }
      return builder.build()
    }

    val keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER)
    if (hasStrongBoxHardware()) {
      try {
        keyGen.init(buildSpec(useStrongBox = true))
        return keyGen.generateKey() to true
      } catch (_: StrongBoxUnavailableException) {
        // 部分设备声明特性但 StrongBox 繁忙或配额受限，安全回退 TEE
      } catch (_: Exception) {
        // 回退至 TEE Keystore
      }
    }
    keyGen.init(buildSpec(useStrongBox = false))
    return keyGen.generateKey() to false
  }

  private fun getOrCreateDeviceKey(fullAlias: String): SecretKey {
    val keyStore = loadKeyStore()
    val existing = keyStore.getKey(fullAlias, null) as? SecretKey
    if (existing != null) return existing
    return createHardwareAesKey(fullAlias, requireBiometric = false).first
  }

  @ReactMethod
  fun getCapability(promise: Promise) {
    try {
      val manager = BiometricManager.from(reactContext)
      val status = manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
      val result = Arguments.createMap().apply {
        putBoolean("available", status == BiometricManager.BIOMETRIC_SUCCESS)
        putBoolean("hardwarePresent", status != BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE)
        putBoolean("enrolled", status == BiometricManager.BIOMETRIC_SUCCESS)
        putBoolean("strongBoxSupported", hasStrongBoxHardware())
        putInt("statusCode", status)
      }
      promise.resolve(result)
    } catch (e: Exception) {
      promise.reject("BIOMETRIC_CAPABILITY_ERROR", e.message, e)
    }
  }

  @ReactMethod
  fun sealWithBiometric(
    alias: String,
    plaintextB64: String,
    title: String,
    subtitle: String,
    promise: Promise,
  ) {
    val activity = reactContext.currentActivity as? FragmentActivity
    if (activity == null) {
      promise.reject("BIOMETRIC_NO_ACTIVITY", "当前没有可见的 Activity 用于展示生物认证弹窗")
      return
    }

    val fullAlias = sanitizeAlias(BIOMETRIC_PREFIX, alias)
    val plaintext = Base64.decode(plaintextB64, Base64.NO_WRAP)

    activity.runOnUiThread {
      try {
        val (secretKey, strongBox) = createHardwareAesKey(fullAlias, requireBiometric = true)
        val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey)

        val executor = ContextCompat.getMainExecutor(activity)
        val prompt = BiometricPrompt(
          activity,
          executor,
          object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
              try {
                val authedCipher = result.cryptoObject?.cipher
                  ?: throw IllegalStateException("系统未返回硬件认证后的 CryptoObject")
                val ciphertext = authedCipher.doFinal(plaintext)
                val iv = authedCipher.iv
                val payload = Arguments.createMap().apply {
                  putString("ivB64", Base64.encodeToString(iv, Base64.NO_WRAP))
                  putString("ciphertextB64", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
                  putBoolean("strongBox", strongBox)
                }
                promise.resolve(payload)
              } catch (e: Exception) {
                promise.reject("BIOMETRIC_SEAL_FAILED", e.message, e)
              } finally {
                plaintext.fill(0)
              }
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
              plaintext.fill(0)
              val code = if (
                errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON
              ) {
                "BIOMETRIC_CANCELED"
              } else {
                "BIOMETRIC_AUTH_ERROR"
              }
              promise.reject(code, errString.toString())
            }
          },
        )

        val info = BiometricPrompt.PromptInfo.Builder()
          .setTitle(title)
          .setSubtitle(subtitle)
          .setNegativeButtonText("取消")
          .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
          .build()

        prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
      } catch (e: Exception) {
        plaintext.fill(0)
        promise.reject("BIOMETRIC_INIT_ERROR", e.message, e)
      }
    }
  }

  @ReactMethod
  fun unsealWithBiometric(
    alias: String,
    ivB64: String,
    ciphertextB64: String,
    title: String,
    subtitle: String,
    promise: Promise,
  ) {
    val activity = reactContext.currentActivity as? FragmentActivity
    if (activity == null) {
      promise.reject("BIOMETRIC_NO_ACTIVITY", "当前没有可见的 Activity 用于展示生物认证弹窗")
      return
    }

    val fullAlias = sanitizeAlias(BIOMETRIC_PREFIX, alias)
    val iv = Base64.decode(ivB64, Base64.NO_WRAP)
    val ciphertext = Base64.decode(ciphertextB64, Base64.NO_WRAP)

    activity.runOnUiThread {
      try {
        val keyStore = loadKeyStore()
        val secretKey = keyStore.getKey(fullAlias, null) as? SecretKey
        if (secretKey == null) {
          promise.reject("KEY_NOT_FOUND", "硬件生物识别密钥不存在，请使用主密码重新解锁")
          return@runOnUiThread
        }

        val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
        try {
          cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(GCM_TAG_BITS, iv))
        } catch (invalidated: KeyPermanentlyInvalidatedException) {
          keyStore.deleteEntry(fullAlias)
          promise.reject("KEY_INVALIDATED", "系统生物特征已变更，硬件密钥已自动吊销，请使用主密码重新绑定", invalidated)
          return@runOnUiThread
        }

        val executor = ContextCompat.getMainExecutor(activity)
        val prompt = BiometricPrompt(
          activity,
          executor,
          object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
              var plain: ByteArray? = null
              try {
                val authedCipher = result.cryptoObject?.cipher
                  ?: throw IllegalStateException("系统未返回硬件认证后的 CryptoObject")
                plain = authedCipher.doFinal(ciphertext)
                promise.resolve(Base64.encodeToString(plain, Base64.NO_WRAP))
              } catch (e: Exception) {
                promise.reject("BIOMETRIC_UNSEAL_FAILED", e.message, e)
              } finally {
                plain?.fill(0)
              }
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
              val code = if (
                errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON
              ) {
                "BIOMETRIC_CANCELED"
              } else {
                "BIOMETRIC_AUTH_ERROR"
              }
              promise.reject(code, errString.toString())
            }
          },
        )

        val info = BiometricPrompt.PromptInfo.Builder()
          .setTitle(title)
          .setSubtitle(subtitle)
          .setNegativeButtonText("改用主密码")
          .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
          .build()

        prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
      } catch (e: Exception) {
        promise.reject("BIOMETRIC_UNSEAL_INIT_ERROR", e.message, e)
      }
    }
  }

  @ReactMethod
  fun sealDeviceSecret(alias: String, plaintextB64: String, promise: Promise) {
    val plain = Base64.decode(plaintextB64, Base64.NO_WRAP)
    try {
      val fullAlias = sanitizeAlias(DEVICE_PREFIX, alias)
      val key = getOrCreateDeviceKey(fullAlias)
      val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
      cipher.init(Cipher.ENCRYPT_MODE, key)
      val encrypted = cipher.doFinal(plain)
      val out = Arguments.createMap().apply {
        putString("ivB64", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
        putString("ciphertextB64", Base64.encodeToString(encrypted, Base64.NO_WRAP))
      }
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject("DEVICE_SEAL_FAILED", e.message, e)
    } finally {
      plain.fill(0)
    }
  }

  @ReactMethod
  fun unsealDeviceSecret(alias: String, ivB64: String, ciphertextB64: String, promise: Promise) {
    var plain: ByteArray? = null
    try {
      val fullAlias = sanitizeAlias(DEVICE_PREFIX, alias)
      val keyStore = loadKeyStore()
      val key = keyStore.getKey(fullAlias, null) as? SecretKey
      if (key == null) {
        promise.reject("KEY_NOT_FOUND", "设备 Keystore 密钥不存在")
        return
      }
      val iv = Base64.decode(ivB64, Base64.NO_WRAP)
      val ciphertext = Base64.decode(ciphertextB64, Base64.NO_WRAP)
      val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
      plain = cipher.doFinal(ciphertext)
      promise.resolve(Base64.encodeToString(plain, Base64.NO_WRAP))
    } catch (e: Exception) {
      promise.reject("DEVICE_UNSEAL_FAILED", e.message, e)
    } finally {
      plain?.fill(0)
    }
  }

  @ReactMethod
  fun deleteKey(alias: String, biometric: Boolean, promise: Promise) {
    try {
      val fullAlias = sanitizeAlias(if (biometric) BIOMETRIC_PREFIX else DEVICE_PREFIX, alias)
      val keyStore = loadKeyStore()
      if (keyStore.containsAlias(fullAlias)) {
        keyStore.deleteEntry(fullAlias)
      }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("KEYSTORE_DELETE_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun hasKey(alias: String, biometric: Boolean, promise: Promise) {
    try {
      val fullAlias = sanitizeAlias(if (biometric) BIOMETRIC_PREFIX else DEVICE_PREFIX, alias)
      val keyStore = loadKeyStore()
      promise.resolve(keyStore.containsAlias(fullAlias))
    } catch (e: Exception) {
      promise.reject("KEYSTORE_CHECK_FAILED", e.message, e)
    }
  }
}
