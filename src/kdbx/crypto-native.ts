/**
 * React Native Android 运行时密码学提供者：
 * 将计算密集型 KDF（Argon2d/Argon2id/AES-KDF）与块加密（AES-256-CBC/ChaCha20/Twofish-CBC）
 * 委派给 Kotlin 原生线程执行，轻量散列/流密码/压缩与 Node 回退保持同构契约。
 */
import { getNativeCrypto } from '../native';
import { fromBase64, toBase64, wipeBytes } from './binary';
import { createFallbackCryptoProvider } from './crypto-fallback';
import { VaultError, type CryptoProvider } from './types';

export function createRuntimeCryptoProvider(): CryptoProvider {
  const fallback = createFallbackCryptoProvider();
  const native = getNativeCrypto();

  if (!native) {
    return fallback;
  }

  return {
    ...fallback,
    name: 'android-native-bouncycastle',

    async argon2(params): Promise<Uint8Array> {
      const pwdB64 = toBase64(params.password);
      const saltB64 = toBase64(params.salt);
      const resultB64 = await native.argon2(
        params.variant,
        pwdB64,
        saltB64,
        params.iterations,
        params.memoryKiB,
        params.parallelism,
        params.version,
        params.hashLength,
      );
      return fromBase64(resultB64);
    },

    async aesKdf(seed: Uint8Array, key: Uint8Array, rounds: bigint): Promise<Uint8Array> {
      const resB64 = await native.aesKdf(toBase64(seed), toBase64(key), rounds.toString());
      return fromBase64(resB64);
    },

    async aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
      const resB64 = await native.aesCbcEncrypt(toBase64(key), toBase64(iv), toBase64(plaintext));
      return fromBase64(resB64);
    },

    async aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
      try {
        const resB64 = await native.aesCbcDecrypt(toBase64(key), toBase64(iv), toBase64(ciphertext));
        return fromBase64(resB64);
      } catch (err) {
        throw new VaultError('INVALID_CREDENTIALS', '原生 AES-256-CBC 解密失败，主密码或密钥文件可能不正确。', {
          cause: err,
        });
      }
    },

    async chacha20(key: Uint8Array, nonce: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
      const resB64 = await native.chacha20(toBase64(key), toBase64(nonce), toBase64(data));
      return fromBase64(resB64);
    },

    async twofishCbcEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
      const resB64 = await native.twofishCbcCrypt(true, toBase64(key), toBase64(iv), toBase64(plaintext));
      return fromBase64(resB64);
    },

    async twofishCbcDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
      try {
        const resB64 = await native.twofishCbcCrypt(false, toBase64(key), toBase64(iv), toBase64(ciphertext));
        return fromBase64(resB64);
      } catch (err) {
        throw new VaultError('INVALID_CREDENTIALS', '原生 Twofish-CBC 解密失败。', { cause: err });
      }
    },

    randomBytes(length: number): Uint8Array {
      if (typeof native.randomBytesSync === 'function') {
        return fromBase64(native.randomBytesSync(length));
      }
      const out = fallback.randomBytes(length);
      if (out.length !== length) {
        wipeBytes(out);
        throw new VaultError('UNSUPPORTED_ALGORITHM', 'CSPRNG 输出长度异常。');
      }
      return out;
    },
  };
}
