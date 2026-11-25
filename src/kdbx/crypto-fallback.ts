/**
 * 纯 JavaScript 密码学原语提供者（基于 @noble/ciphers、@noble/hashes 与 pako）。
 * 用途：
 * 1. Node / Vitest 全量纯逻辑与 KDBX 二进制互操作单元测试；
 * 2. 非 Android 原生模块可用场景下的安全回退实现。
 */
import { cbc, ecb } from '@noble/ciphers/aes.js';
import { chacha20 as nobleChacha20 } from '@noble/ciphers/chacha.js';
import { salsa20 as nobleSalsa20 } from '@noble/ciphers/salsa.js';
import { argon2d, argon2id } from '@noble/hashes/argon2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { gzip, Inflate } from 'pako';
import { concatBytes, wipeBytes } from './binary';
import { VaultError, type CryptoProvider } from './types';

function fillSecureRandom(out: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const gCrypto = globalThis.crypto;
  if (gCrypto && typeof gCrypto.getRandomValues === 'function') {
    // Web Crypto getRandomValues 单次限制 65536 字节
    const step = 65536;
    for (let offset = 0; offset < out.length; offset += step) {
      gCrypto.getRandomValues(out.subarray(offset, Math.min(offset + step, out.length)));
    }
    return out;
  }
  throw new VaultError('UNSUPPORTED_ALGORITHM', '当前运行环境缺少密码学安全随机源（CSPRNG）。');
}

export function createFallbackCryptoProvider(): CryptoProvider {
  return {
    name: 'noble-js-fallback',

    randomBytes(length: number): Uint8Array {
      return fillSecureRandom(new Uint8Array(length));
    },

    sha256(data: Uint8Array): Uint8Array {
      return sha256(data);
    },

    sha512(data: Uint8Array): Uint8Array {
      return sha512(data);
    },

    hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
      return hmac(sha256, key, data);
    },

    hmacSha1(key: Uint8Array, data: Uint8Array): Uint8Array {
      return hmac(sha1, key, data);
    },

    hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
      return hmac(sha512, key, data);
    },

    async argon2(params): Promise<Uint8Array> {
      const fn = params.variant === 'argon2d' ? argon2d : argon2id;
      return fn(params.password, params.salt, {
        t: params.iterations,
        m: params.memoryKiB,
        p: params.parallelism,
        dkLen: params.hashLength,
        version: params.version,
      });
    },

    async aesKdf(seed: Uint8Array, key: Uint8Array, rounds: bigint): Promise<Uint8Array> {
      if (seed.length !== 32 || key.length !== 32) {
        throw new VaultError('INVALID_FILE', 'AES-KDF 种子与输入密钥必须均为 32 字节。');
      }
      let current = key.slice();
      try {
        for (let i = 0n; i < rounds; i++) {
          const next = ecb(seed, { disablePadding: true }).encrypt(current);
          wipeBytes(current);
          current = next;
        }
        return sha256(current);
      } finally {
        wipeBytes(current);
      }
    },

    async aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
      return cbc(key, iv).encrypt(plaintext);
    },

    async aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
      try {
        return cbc(key, iv).decrypt(ciphertext);
      } catch (err) {
        throw new VaultError('INVALID_CREDENTIALS', 'AES-256-CBC 解密失败，主密码、密钥文件或数据可能不正确。', {
          cause: err,
        });
      }
    },

    async chacha20(key: Uint8Array, nonce: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
      return nobleChacha20(key, nonce, data);
    },

    salsa20Keystream(key32: Uint8Array, nonce8: Uint8Array, length: number): Uint8Array {
      const zeros = new Uint8Array(length);
      return nobleSalsa20(key32, nonce8, zeros);
    },

    chacha20Keystream(key32: Uint8Array, nonce12: Uint8Array, length: number): Uint8Array {
      const zeros = new Uint8Array(length);
      return nobleChacha20(key32, nonce12, zeros);
    },

    gzipCompress(data: Uint8Array): Uint8Array {
      return gzip(data);
    },

    gzipDecompress(data: Uint8Array, maxBytes: number): Uint8Array {
      const chunks: Uint8Array[] = [];
      let total = 0;
      const inflator = new Inflate();
      inflator.onData = (chunk: Uint8Array) => {
        total += chunk.length;
        if (total > maxBytes) {
          throw new VaultError('RESOURCE_LIMIT', `Gzip 解压体积超过安全上限（${maxBytes} 字节）。`);
        }
        chunks.push(chunk.slice());
      };
      inflator.push(data, true);
      if (inflator.err) {
        throw new VaultError('INTEGRITY_FAILURE', `Gzip 解压失败：${inflator.msg || String(inflator.err)}`);
      }
      return concatBytes(...chunks);
    },
  };
}
