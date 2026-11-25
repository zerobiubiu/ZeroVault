/**
 * ZeroVault 多库配置档案、本地加密工作副本与硬件封包秘密持久化管理。
 * 所有敏感秘密（生物识别解锁包、WebDAV 密码、远程密钥文件离线副本）均通过 Android Keystore 加密存储。
 */
import { decodeUtf8, encodeUtf8, fromBase64, toBase64 } from '../kdbx';
import {
  getNativeBiometric,
  getNativeStorage,
  type NativeBiometricBridge,
  type NativeStorageBridge,
  type SealedPayload,
} from '../native';
import { StorageError, type BiometricUnlockSecret, type VaultProfile } from './types';

export interface ProfileStoreDeps {
  readonly storage: Pick<
    NativeStorageBridge,
    'readPrivateFileBase64' | 'writePrivateFileBase64' | 'deletePrivateFile'
  >;
  readonly biometric: Pick<
    NativeBiometricBridge,
    | 'sealWithBiometric'
    | 'unsealWithBiometric'
    | 'sealDeviceSecret'
    | 'unsealDeviceSecret'
    | 'deleteKey'
    | 'hasKey'
  >;
}

const PROFILES_PATH = 'profiles.json';
const vaultCachePath = (vaultId: string) => `vaults/${vaultId}.kdbx`;
const bioBundlePath = (vaultId: string) => `sealed/${vaultId}.bio.json`;
const webdavSecretPath = (vaultId: string) => `sealed/${vaultId}.webdav.json`;
const remoteKeyCachePath = (vaultId: string) => `sealed/${vaultId}.rkey.json`;

/** 进程内存降级存储（仅当无 Android 原生模块时，例如纯预览模式，不落明文到磁盘） */
export function createMemoryStoreDeps(): ProfileStoreDeps {
  const files = new Map<string, string>();
  const keys = new Set<string>();
  return {
    storage: {
      async readPrivateFileBase64(path) {
        return files.get(path) ?? null;
      },
      async writePrivateFileBase64(path, dataB64) {
        files.set(path, dataB64);
        return true;
      },
      async deletePrivateFile(path) {
        files.delete(path);
        return true;
      },
    },
    biometric: {
      async sealWithBiometric(alias, plaintextB64) {
        keys.add(`bio:${alias}`);
        return { ivB64: 'bW9jay1pdg==', ciphertextB64: plaintextB64, strongBox: false };
      },
      async unsealWithBiometric(alias, _ivB64, ciphertextB64) {
        if (!keys.has(`bio:${alias}`)) throw new Error('KEY_NOT_FOUND');
        return ciphertextB64;
      },
      async sealDeviceSecret(alias, plaintextB64) {
        keys.add(`dev:${alias}`);
        return { ivB64: 'bW9jay1pdg==', ciphertextB64: plaintextB64 };
      },
      async unsealDeviceSecret(alias, _ivB64, ciphertextB64) {
        if (!keys.has(`dev:${alias}`)) throw new Error('KEY_NOT_FOUND');
        return ciphertextB64;
      },
      async deleteKey(alias, biometric) {
        keys.delete(`${biometric ? 'bio' : 'dev'}:${alias}`);
        return true;
      },
      async hasKey(alias, biometric) {
        return keys.has(`${biometric ? 'bio' : 'dev'}:${alias}`);
      },
    },
  };
}

export class VaultProfileStore {
  private readonly deps: ProfileStoreDeps;

  constructor(deps?: ProfileStoreDeps) {
    if (deps) {
      this.deps = deps;
    } else {
      const storage = getNativeStorage();
      const biometric = getNativeBiometric();
      this.deps = storage && biometric ? { storage, biometric } : createMemoryStoreDeps();
    }
  }

  async listProfiles(): Promise<VaultProfile[]> {
    const b64 = await this.deps.storage.readPrivateFileBase64(PROFILES_PATH);
    if (!b64) return [];
    try {
      const parsed = JSON.parse(decodeUtf8(fromBase64(b64))) as VaultProfile[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async saveProfiles(profiles: readonly VaultProfile[]): Promise<void> {
    const jsonBytes = encodeUtf8(JSON.stringify(profiles, null, 2));
    await this.deps.storage.writePrivateFileBase64(PROFILES_PATH, toBase64(jsonBytes));
  }

  async upsertProfile(profile: VaultProfile): Promise<VaultProfile[]> {
    const list = await this.listProfiles();
    const idx = list.findIndex((p) => p.id === profile.id);
    const next = idx >= 0 ? list.map((p, i) => (i === idx ? profile : p)) : [profile, ...list];
    await this.saveProfiles(next);
    return next;
  }

  async deleteProfile(vaultId: string): Promise<VaultProfile[]> {
    const list = await this.listProfiles();
    const next = list.filter((p) => p.id !== vaultId);
    await this.saveProfiles(next);
    await Promise.all([
      this.deps.storage.deletePrivateFile(vaultCachePath(vaultId)),
      this.deps.storage.deletePrivateFile(bioBundlePath(vaultId)),
      this.deps.storage.deletePrivateFile(webdavSecretPath(vaultId)),
      this.deps.storage.deletePrivateFile(remoteKeyCachePath(vaultId)),
      this.deps.biometric.deleteKey(`vault_${vaultId}`, true),
      this.deps.biometric.deleteKey(`webdav_${vaultId}`, false),
      this.deps.biometric.deleteKey(`rkey_${vaultId}`, false),
    ]);
    return next;
  }

  /** 读写加密后的 .kdbx 离线工作副本（文件本身已是 KDBX 强加密密文） */
  async readCachedVaultBytes(vaultId: string): Promise<Uint8Array | null> {
    const b64 = await this.deps.storage.readPrivateFileBase64(vaultCachePath(vaultId));
    return b64 ? fromBase64(b64) : null;
  }

  async writeCachedVaultBytes(vaultId: string, kdbxBytes: Uint8Array): Promise<void> {
    await this.deps.storage.writePrivateFileBase64(vaultCachePath(vaultId), toBase64(kdbxBytes));
  }

  /** 经 Android Keystore + BiometricPrompt 硬件封包生物识别解锁包 */
  async enableBiometricUnlock(
    vaultId: string,
    vaultName: string,
    secret: BiometricUnlockSecret,
  ): Promise<{ strongBox: boolean }> {
    const payloadB64 = toBase64(encodeUtf8(JSON.stringify(secret)));
    const sealed = await this.deps.biometric.sealWithBiometric(
      `vault_${vaultId}`,
      payloadB64,
      `为「${vaultName}」启用生物识别解锁`,
      '验证指纹或面容以安全绑定硬件密钥',
    );
    const envelopeB64 = toBase64(encodeUtf8(JSON.stringify(sealed)));
    await this.deps.storage.writePrivateFileBase64(bioBundlePath(vaultId), envelopeB64);
    return { strongBox: Boolean(sealed.strongBox) };
  }

  async unsealBiometricUnlock(vaultId: string, vaultName: string): Promise<BiometricUnlockSecret> {
    const rawB64 = await this.deps.storage.readPrivateFileBase64(bioBundlePath(vaultId));
    if (!rawB64) {
      throw new StorageError('not-found', '未找到已绑定的生物识别解锁凭据，请使用主密码解锁。');
    }
    const sealed = JSON.parse(decodeUtf8(fromBase64(rawB64))) as SealedPayload;
    const plainB64 = await this.deps.biometric.unsealWithBiometric(
      `vault_${vaultId}`,
      sealed.ivB64,
      sealed.ciphertextB64,
      `解锁「${vaultName}」`,
      '验证生物特征以从硬件安全模块解封密码库凭据',
    );
    return JSON.parse(decodeUtf8(fromBase64(plainB64))) as BiometricUnlockSecret;
  }

  async disableBiometricUnlock(vaultId: string): Promise<void> {
    await this.deps.storage.deletePrivateFile(bioBundlePath(vaultId));
    await this.deps.biometric.deleteKey(`vault_${vaultId}`, true);
  }

  /** 使用设备硬件 Keystore 封包 WebDAV 认证密码（绝不明文存盘） */
  async saveSealedWebDavSecrets(
    vaultId: string,
    secrets: { vaultPassword?: string; remoteKeyPassword?: string },
  ): Promise<void> {
    const payloadB64 = toBase64(encodeUtf8(JSON.stringify(secrets)));
    const sealed = await this.deps.biometric.sealDeviceSecret(`webdav_${vaultId}`, payloadB64);
    await this.deps.storage.writePrivateFileBase64(
      webdavSecretPath(vaultId),
      toBase64(encodeUtf8(JSON.stringify(sealed))),
    );
  }

  async loadSealedWebDavSecrets(
    vaultId: string,
  ): Promise<{ vaultPassword?: string; remoteKeyPassword?: string } | null> {
    const rawB64 = await this.deps.storage.readPrivateFileBase64(webdavSecretPath(vaultId));
    if (!rawB64) return null;
    const sealed = JSON.parse(decodeUtf8(fromBase64(rawB64))) as SealedPayload;
    const plainB64 = await this.deps.biometric.unsealDeviceSecret(
      `webdav_${vaultId}`,
      sealed.ivB64,
      sealed.ciphertextB64,
    );
    return JSON.parse(decodeUtf8(fromBase64(plainB64))) as {
      vaultPassword?: string;
      remoteKeyPassword?: string;
    };
  }

  /** 使用设备硬件 Keystore 加密缓存远程密钥文件字节，支持离线解锁 */
  async saveSealedRemoteKeyFile(vaultId: string, keyFileBytes: Uint8Array): Promise<void> {
    const sealed = await this.deps.biometric.sealDeviceSecret(`rkey_${vaultId}`, toBase64(keyFileBytes));
    await this.deps.storage.writePrivateFileBase64(
      remoteKeyCachePath(vaultId),
      toBase64(encodeUtf8(JSON.stringify(sealed))),
    );
  }

  async loadSealedRemoteKeyFile(vaultId: string): Promise<Uint8Array | null> {
    const rawB64 = await this.deps.storage.readPrivateFileBase64(remoteKeyCachePath(vaultId));
    if (!rawB64) return null;
    const sealed = JSON.parse(decodeUtf8(fromBase64(rawB64))) as SealedPayload;
    const plainB64 = await this.deps.biometric.unsealDeviceSecret(
      `rkey_${vaultId}`,
      sealed.ivB64,
      sealed.ciphertextB64,
    );
    return fromBase64(plainB64);
  }
}
