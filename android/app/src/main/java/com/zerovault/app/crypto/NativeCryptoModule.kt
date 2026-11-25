package com.zerovault.app.crypto

import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.bouncycastle.crypto.engines.ChaCha7539Engine
import org.bouncycastle.crypto.engines.TwofishEngine
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.modes.CBCBlockCipher
import org.bouncycastle.crypto.paddings.PKCS7Padding
import org.bouncycastle.crypto.paddings.PaddedBufferedBlockCipher
import org.bouncycastle.crypto.params.Argon2Parameters
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.ParametersWithIV
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * ZeroVault 原生密码学加速模块：
 * 在后台协程池执行 Argon2d/Argon2id、AES-KDF、AES-256-CBC、ChaCha20 与 Twofish-CBC，
 * 避免高成本 KDF 阻塞 JS 线程并确保敏感字节缓冲区用后立即清零。
 */
class NativeCryptoModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private val secureRandom = SecureRandom()

  override fun getName(): String = "ZeroVaultCrypto"

  private fun decodeB64(str: String): ByteArray = Base64.decode(str, Base64.NO_WRAP)
  private fun encodeB64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

  @ReactMethod
  fun randomBytes(length: Int, promise: Promise) {
    if (length < 0 || length > 1024 * 1024) {
      promise.reject("CRYPTO_INVALID_ARG", "随机字节长度超出允许范围")
      return
    }
    try {
      val buf = ByteArray(length)
      secureRandom.nextBytes(buf)
      promise.resolve(encodeB64(buf))
      buf.fill(0)
    } catch (e: Exception) {
      promise.reject("CRYPTO_RANDOM_FAILED", e.message, e)
    }
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun randomBytesSync(length: Int): String {
    require(length in 0..(1024 * 1024)) { "随机字节长度超出允许范围" }
    val buf = ByteArray(length)
    try {
      secureRandom.nextBytes(buf)
      return encodeB64(buf)
    } finally {
      buf.fill(0)
    }
  }

  @ReactMethod
  fun argon2(
    variant: String,
    passwordB64: String,
    saltB64: String,
    iterations: Int,
    memoryKiB: Int,
    parallelism: Int,
    version: Int,
    hashLength: Int,
    promise: Promise,
  ) {
    scope.launch {
      val password = decodeB64(passwordB64)
      val salt = decodeB64(saltB64)
      val output = ByteArray(hashLength)
      try {
        val type = when (variant) {
          "argon2d" -> Argon2Parameters.ARGON2_d
          "argon2id" -> Argon2Parameters.ARGON2_id
          else -> throw IllegalArgumentException("不支持的 Argon2 变体: $variant")
        }
        val bcVersion = if (version == 0x10) Argon2Parameters.ARGON2_VERSION_10 else Argon2Parameters.ARGON2_VERSION_13
        val params = Argon2Parameters.Builder(type)
          .withVersion(bcVersion)
          .withIterations(iterations)
          .withMemoryAsKB(memoryKiB)
          .withParallelism(parallelism)
          .withSalt(salt)
          .build()
        val generator = Argon2BytesGenerator()
        generator.init(params)
        generator.generateBytes(password, output)
        promise.resolve(encodeB64(output))
      } catch (e: Exception) {
        promise.reject("CRYPTO_ARGON2_FAILED", e.message, e)
      } finally {
        password.fill(0)
        salt.fill(0)
        output.fill(0)
      }
    }
  }

  @ReactMethod
  fun aesKdf(seedB64: String, keyB64: String, roundsStr: String, promise: Promise) {
    scope.launch {
      val seed = decodeB64(seedB64)
      val current = decodeB64(keyB64)
      try {
        val rounds = roundsStr.toLong()
        if (seed.size != 32 || current.size != 32 || rounds < 0L || rounds > 100_000_000L) {
          throw IllegalArgumentException("AES-KDF 参数不合法")
        }
        val cipher = Cipher.getInstance("AES/ECB/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(seed, "AES"))
        val scratch = ByteArray(32)
        for (i in 0L until rounds) {
          cipher.update(current, 0, 32, scratch, 0)
          System.arraycopy(scratch, 0, current, 0, 32)
        }
        scratch.fill(0)
        val digest = MessageDigest.getInstance("SHA-256").digest(current)
        promise.resolve(encodeB64(digest))
        digest.fill(0)
      } catch (e: Exception) {
        promise.reject("CRYPTO_AES_KDF_FAILED", e.message, e)
      } finally {
        seed.fill(0)
        current.fill(0)
      }
    }
  }

  @ReactMethod
  fun aesCbcEncrypt(keyB64: String, ivB64: String, plaintextB64: String, promise: Promise) {
    scope.launch {
      val key = decodeB64(keyB64)
      val iv = decodeB64(ivB64)
      val plain = decodeB64(plaintextB64)
      try {
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
        val out = cipher.doFinal(plain)
        promise.resolve(encodeB64(out))
      } catch (e: Exception) {
        promise.reject("CRYPTO_AES_ENCRYPT_FAILED", e.message, e)
      } finally {
        key.fill(0)
        plain.fill(0)
      }
    }
  }

  @ReactMethod
  fun aesCbcDecrypt(keyB64: String, ivB64: String, ciphertextB64: String, promise: Promise) {
    scope.launch {
      val key = decodeB64(keyB64)
      val iv = decodeB64(ivB64)
      val cipherBytes = decodeB64(ciphertextB64)
      try {
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
        val out = cipher.doFinal(cipherBytes)
        promise.resolve(encodeB64(out))
        out.fill(0)
      } catch (e: Exception) {
        promise.reject("CRYPTO_AES_DECRYPT_FAILED", e.message, e)
      } finally {
        key.fill(0)
      }
    }
  }

  @ReactMethod
  fun chacha20(keyB64: String, nonceB64: String, dataB64: String, promise: Promise) {
    scope.launch {
      val key = decodeB64(keyB64)
      val nonce = decodeB64(nonceB64)
      val input = decodeB64(dataB64)
      val out = ByteArray(input.size)
      try {
        val engine = ChaCha7539Engine()
        engine.init(true, ParametersWithIV(KeyParameter(key), nonce))
        engine.processBytes(input, 0, input.size, out, 0)
        promise.resolve(encodeB64(out))
      } catch (e: Exception) {
        promise.reject("CRYPTO_CHACHA20_FAILED", e.message, e)
      } finally {
        key.fill(0)
        input.fill(0)
        out.fill(0)
      }
    }
  }

  @ReactMethod
  fun twofishCbcCrypt(
    encrypt: Boolean,
    keyB64: String,
    ivB64: String,
    dataB64: String,
    promise: Promise,
  ) {
    scope.launch {
      val key = decodeB64(keyB64)
      val iv = decodeB64(ivB64)
      val input = decodeB64(dataB64)
      try {
        val cipher = PaddedBufferedBlockCipher(CBCBlockCipher.newInstance(TwofishEngine()), PKCS7Padding())
        cipher.init(encrypt, ParametersWithIV(KeyParameter(key), iv))
        val buffer = ByteArray(cipher.getOutputSize(input.size))
        var len = cipher.processBytes(input, 0, input.size, buffer, 0)
        len += cipher.doFinal(buffer, len)
        val trimmed = buffer.copyOf(len)
        buffer.fill(0)
        promise.resolve(encodeB64(trimmed))
        trimmed.fill(0)
      } catch (e: Exception) {
        promise.reject("CRYPTO_TWOFISH_FAILED", e.message, e)
      } finally {
        key.fill(0)
        input.fill(0)
      }
    }
  }
}
