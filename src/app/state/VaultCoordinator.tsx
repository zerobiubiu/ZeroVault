/**
 * ZeroVault 全局应用状态协调者（VaultCoordinator）：
 * 严格执行零明文 UI 状态最小化约束：
 * - React State 仅保存多库非秘密档案与 VaultEntrySummary 摘要；
 * - 实际 KDBX VaultModel 实例留在 ref 中，密码/受保护字段/附件按需读取；
 * - 统一协调本地 SAF、WebDAV（含远程密钥）、硬件生物识别解锁、冲突解决与后台自动锁库。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  createRuntimeCryptoProvider,
  createVault,
  fromBase64,
  loadVaultWithEmptyPasswordProbe,
  toBase64,
  wipeBytes,
  type CryptoProvider,
  type TotpConfig,
  type VaultCreateOptions,
  type VaultCredentials,
  type VaultEntry,
  type VaultEntryInput,
  type VaultEntrySummary,
  type VaultFormat,
  type VaultGroup,
  type VaultGroupInput,
  type VaultModel,
} from '../../kdbx';
import {
  getNativeStorage,
  queryBiometricCapability,
  type BiometricCapability,
  type PendingAutofillSave,
} from '../../native';
import {
  clearNativeAutofillSession,
  copySecretSafely,
  DEFAULT_SECURITY_PREFERENCES,
  pushUnlockedVaultToAutofill,
  shouldAutoLock,
  type SecurityPreferences,
} from '../../security';
import {
  hashBytes,
  pullWebDavVault,
  pushWebDavVault,
  resolveWebDavConflict,
  VaultProfileStore,
  WebDavClient,
  type ConflictResolution,
  type KeyFileSourceConfig,
  type PasswordMode,
  type VaultProfile,
  type VaultSyncMeta,
  type WebDavCredentials,
  type WebDavDirectoryItem,
} from '../../storage';

export interface ActiveConflict {
  readonly profileId: string;
  readonly localBytes: Uint8Array;
  readonly remoteBytes: Uint8Array;
  readonly remoteHash: string;
  readonly remoteEtag: string | null;
}

export interface UnlockedVaultMeta {
  readonly name: string;
  readonly description: string;
  readonly format: VaultFormat;
  readonly dirty: boolean;
}

export interface ToastMessage {
  readonly id: number;
  readonly text: string;
  readonly tone: 'info' | 'success' | 'warning' | 'danger';
}

export interface UnlockAttemptInput {
  readonly profileId: string;
  /** null 表示仅密钥文件（无密码组件）；'' 表示显式空密码 */
  readonly password: string | null;
  readonly probeEmptyPasswordWithKeyFile?: boolean;
  readonly webdavPassword?: string;
  readonly remoteKeyWebdavPassword?: string;
  readonly overrideKeyFileBytes?: Uint8Array;
  readonly rememberSecretsInKeystore?: boolean;
}

export interface AddWebDavVaultInput {
  readonly name: string;
  readonly vaultUrl: string;
  readonly username: string;
  readonly password: string;
  readonly allowInsecureHttp?: boolean;
  readonly keyFileSource: KeyFileSourceConfig;
  readonly remoteKeyWebdavPassword?: string;
  readonly cacheWebDavSecrets: boolean;
}

export interface CreateLocalVaultInput {
  readonly name: string;
  readonly safUri: string;
  readonly fileName: string;
  readonly credentials: VaultCredentials;
  readonly keyFileSource: KeyFileSourceConfig;
  readonly options?: VaultCreateOptions;
}

export interface VaultCoordinatorValue {
  readonly ready: boolean;
  readonly busyMessage: string | null;
  readonly profiles: readonly VaultProfile[];
  readonly defaultProfile: VaultProfile | null;
  readonly activeProfile: VaultProfile | null;
  /** 递增序号：驱动 UnlockScreen 在冷启动或超时锁库回前台时自动唤起默认库解锁 */
  readonly autoUnlockNonce: number;
  readonly isUnlocked: boolean;
  readonly vaultMeta: UnlockedVaultMeta | null;
  readonly groups: readonly VaultGroup[];
  readonly entries: readonly VaultEntrySummary[];
  readonly biometricCapability: BiometricCapability;
  readonly autofillEnabled: boolean;
  readonly pendingAutofillSave: PendingAutofillSave | null;
  readonly conflict: ActiveConflict | null;
  readonly securityPrefs: SecurityPreferences;
  readonly toast: ToastMessage | null;
  readonly crypto: CryptoProvider;

  selectProfile: (profileId: string) => void;
  setDefaultProfile: (profileId: string) => Promise<void>;
  addLocalSafVault: (params: {
    name: string;
    safUri: string;
    fileName: string;
    keyFileSource: KeyFileSourceConfig;
  }) => Promise<VaultProfile>;
  createNewLocalVault: (input: CreateLocalVaultInput) => Promise<VaultProfile>;
  addWebDavVault: (input: AddWebDavVaultInput) => Promise<VaultProfile>;
  removeProfile: (profileId: string) => Promise<void>;
  browseWebDavDirectory: (
    dirUrl: string,
    credentials?: WebDavCredentials,
    allowInsecureHttp?: boolean,
  ) => Promise<WebDavDirectoryItem[]>;

  unlockVault: (input: UnlockAttemptInput) => Promise<void>;
  unlockWithBiometric: (profileId: string) => Promise<void>;
  lockVault: (silent?: boolean) => void;

  enableBiometricForActiveVault: () => Promise<void>;
  disableBiometricForActiveVault: () => Promise<void>;

  getEntryDetail: (entryId: string) => VaultEntry;
  readEntryField: (entryId: string, key: string) => string;
  readEntryTotp: (entryId: string) => TotpConfig | null;
  upsertEntry: (input: VaultEntryInput) => Promise<VaultEntrySummary>;
  deleteEntry: (entryId: string, permanent?: boolean) => Promise<void>;
  restoreEntry: (entryId: string, targetGroupId?: string) => Promise<void>;
  upsertGroup: (input: VaultGroupInput) => Promise<VaultGroup>;

  syncActiveVault: (overrideWebDavPassword?: string) => Promise<void>;
  resolveConflict: (resolution: ConflictResolution) => Promise<void>;
  dismissConflict: () => void;

  copySensitive: (value: string, label: string) => Promise<void>;
  updateSecurityPrefs: (patch: Partial<SecurityPreferences>) => Promise<void>;
  openAutofillSettings: () => Promise<void>;
  refreshPlatformStatus: () => Promise<void>;
  dismissPendingAutofillSave: () => void;
  showToast: (text: string, tone?: ToastMessage['tone']) => void;
}

const CoordinatorContext = createContext<VaultCoordinatorValue | null>(null);

function generateProfileId(crypto: CryptoProvider): string {
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function VaultCoordinatorProvider({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const crypto = useMemo(() => createRuntimeCryptoProvider(), []);
  const profileStore = useMemo(() => new VaultProfileStore(), []);
  const webdav = useMemo(() => new WebDavClient(undefined, crypto), [crypto]);

  // 敏感会话对象仅放 ref，不触发全量序列化或进 React DevTools 树
  const vaultRef = useRef<VaultModel | null>(null);
  // 当前解锁会话的凭据副本（仅留内存用于支持开启生物识别与热重载），锁库即清空
  const sessionSecretRef = useRef<{
    password: string | null;
    keyFile?: Uint8Array;
    webdavPassword?: string;
    remoteKeyWebdavPassword?: string;
  } | null>(null);
  const backgroundedAtRef = useRef<number | null>(null);

  const [ready, setReady] = useState(false);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<VaultProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [autoUnlockNonce, setAutoUnlockNonce] = useState(0);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [vaultMeta, setVaultMeta] = useState<UnlockedVaultMeta | null>(null);
  const [groups, setGroups] = useState<VaultGroup[]>([]);
  const [entries, setEntries] = useState<VaultEntrySummary[]>([]);
  const [conflict, setConflict] = useState<ActiveConflict | null>(null);
  const [securityPrefs, setSecurityPrefs] = useState<SecurityPreferences>(DEFAULT_SECURITY_PREFERENCES);
  const [biometricCapability, setBiometricCapability] = useState<BiometricCapability>({
    available: false,
    hardwarePresent: false,
    enrolled: false,
    strongBoxSupported: false,
    statusCode: -1,
  });
  const [autofillEnabled, setAutofillEnabled] = useState(false);
  const [pendingAutofillSave, setPendingAutofillSave] = useState<PendingAutofillSave | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const showToast = useCallback((text: string, tone: ToastMessage['tone'] = 'info') => {
    const id = Date.now();
    setToast({ id, text, tone });
    setTimeout(() => {
      setToast((prev) => (prev?.id === id ? null : prev));
    }, 3200);
  }, []);

  const defaultProfile = useMemo(
    () => profiles.find((p) => p.isDefault) ?? profiles[0] ?? null,
    [profiles],
  );

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId) ?? defaultProfile,
    [profiles, activeProfileId, defaultProfile],
  );

  const refreshVaultProjection = useCallback(
    (profileId: string, model: VaultModel) => {
      setVaultMeta({
        name: model.name,
        description: model.description,
        format: model.format,
        dirty: model.dirty,
      });
      setGroups([...model.listGroups()]);
      setEntries([...model.listEntries({ includeRecycled: true })]);
      if (securityPrefs.autofillSyncEnabled) {
        pushUnlockedVaultToAutofill(profileId, model).catch(() => {});
      }
    },
    [securityPrefs.autofillSyncEnabled],
  );

  const lockVault = useCallback(
    (silent = false) => {
      vaultRef.current?.lock();
      vaultRef.current = null;
      if (sessionSecretRef.current) {
        wipeBytes(sessionSecretRef.current.keyFile);
        sessionSecretRef.current = null;
      }
      setIsUnlocked(false);
      setVaultMeta(null);
      setGroups([]);
      setEntries([]);
      setConflict(null);
      clearNativeAutofillSession().catch(() => {});
      if (!silent) {
        showToast('已锁定', 'info');
      }
    },
    [showToast],
  );

  const refreshPlatformStatus = useCallback(async () => {
    const bio = await queryBiometricCapability().catch(() => biometricCapability);
    setBiometricCapability(bio);
    const nativeStorage = getNativeStorage();
    if (nativeStorage) {
      const enabled = await nativeStorage.isAutofillServiceEnabled().catch(() => false);
      setAutofillEnabled(enabled);
      const pending = await nativeStorage.consumePendingAutofillSave().catch(() => null);
      if (pending) setPendingAutofillSave(pending);
    }
  }, [biometricCapability]);

  // 初始化加载多库配置与硬件能力，默认选中默认密码库并触发启动自动唤起解锁
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const list = await profileStore.listProfiles();
        if (!mounted) return;
        setProfiles(list);
        const def = list.find((p) => p.isDefault) ?? list[0] ?? null;
        if (def) {
          setActiveProfileId(def.id);
        }
        await refreshPlatformStatus();
        if (mounted && def) {
          setAutoUnlockNonce((n) => n + 1);
        }
      } finally {
        if (mounted) setReady(true);
      }
    })();
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 监听 App 前后台切换，执行自动锁定与待保存 Autofill 检查
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (nextState === 'background' || nextState === 'inactive') {
        if (backgroundedAtRef.current === null) {
          backgroundedAtRef.current = Date.now();
        }
        if (isUnlocked && securityPrefs.autoLockTimeoutMs === 0) {
          lockVault(true);
        }
      } else if (nextState === 'active') {
        const timedOut =
          isUnlocked &&
          shouldAutoLock(backgroundedAtRef.current, Date.now(), securityPrefs.autoLockTimeoutMs);
        if (timedOut) {
          lockVault(true);
          setAutoUnlockNonce((n) => n + 1);
        }
        backgroundedAtRef.current = null;
        refreshPlatformStatus().catch(() => {});
      }
    });
    return () => sub.remove();
  }, [isUnlocked, lockVault, refreshPlatformStatus, securityPrefs.autoLockTimeoutMs]);

  const selectProfile = useCallback(
    (profileId: string) => {
      if (profileId === activeProfileId) return;
      lockVault(true);
      setActiveProfileId(profileId);
    },
    [activeProfileId, lockVault],
  );

  const setDefaultProfile = useCallback(
    async (profileId: string) => {
      const next = profiles.map((p) => ({ ...p, isDefault: p.id === profileId }));
      await profileStore.saveProfiles(next);
      setProfiles(next);
      showToast('已设为默认库', 'success');
    },
    [profileStore, profiles, showToast],
  );

  const browseWebDavDirectory = useCallback(
    async (
      dirUrl: string,
      credentials?: WebDavCredentials,
      allowInsecureHttp = false,
    ): Promise<WebDavDirectoryItem[]> => {
      return webdav.listDirectory(dirUrl, { credentials, allowInsecureHttp });
    },
    [webdav],
  );

  const addLocalSafVault = useCallback(
    async (params: {
      name: string;
      safUri: string;
      fileName: string;
      keyFileSource: KeyFileSourceConfig;
    }): Promise<VaultProfile> => {
      const profile: VaultProfile = {
        id: generateProfileId(crypto),
        name: params.name.trim() || params.fileName.replace(/\.kdbx$/i, ''),
        sourceKind: 'local-saf',
        localSafUri: params.safUri,
        localFileName: params.fileName,
        keyFileSource: params.keyFileSource,
        lastPasswordMode: params.keyFileSource.kind === 'none' ? 'password' : 'no-password',
        biometricEnabled: false,
        isDefault: profiles.length === 0,
        hasCachedWebDavPassword: false,
        hasCachedRemoteKeyFile: false,
        syncMeta: { baseHash: null, baseEtag: null, localHash: null, lastSyncedAt: null, state: 'unknown' },
        createdAt: new Date().toISOString(),
        lastOpenedAt: null,
      };
      const next = await profileStore.upsertProfile(profile);
      setProfiles(next);
      setActiveProfileId(profile.id);
      showToast('已添加密码库', 'success');
      return profile;
    },
    [crypto, profileStore, profiles.length, showToast],
  );

  const createNewLocalVault = useCallback(
    async (input: CreateLocalVaultInput): Promise<VaultProfile> => {
      setBusyMessage('正在加密创建 KDBX 密码库…');
      try {
        const model = createVault(
          input.credentials,
          { name: input.name, ...input.options },
          crypto,
        );
        const bytes = await model.serialize();
        const nativeStorage = getNativeStorage();
        if (nativeStorage && input.safUri) {
          await nativeStorage.writeDocumentBase64(input.safUri, toBase64(bytes));
        }
        const id = generateProfileId(crypto);
        await profileStore.writeCachedVaultBytes(id, bytes);
        const fileHash = hashBytes(bytes, crypto);
        const mode: PasswordMode =
          input.credentials.password === null
            ? 'no-password'
            : input.credentials.password === ''
              ? 'empty-password'
              : 'password';
        const now = new Date().toISOString();
        const profile: VaultProfile = {
          id,
          name: input.name.trim() || '新建密码库',
          sourceKind: 'local-saf',
          localSafUri: input.safUri,
          localFileName: input.fileName,
          keyFileSource: input.keyFileSource,
          lastPasswordMode: mode,
          biometricEnabled: false,
          isDefault: profiles.length === 0,
          hasCachedWebDavPassword: false,
          hasCachedRemoteKeyFile: false,
          syncMeta: {
            baseHash: fileHash,
            baseEtag: null,
            localHash: fileHash,
            lastSyncedAt: now,
            state: 'clean',
          },
          createdAt: now,
          lastOpenedAt: now,
        };
        const next = await profileStore.upsertProfile(profile);
        setProfiles(next);
        setActiveProfileId(id);

        vaultRef.current?.lock();
        vaultRef.current = model;
        sessionSecretRef.current = {
          password: input.credentials.password,
          keyFile: input.credentials.keyFile?.slice(),
        };
        setIsUnlocked(true);
        refreshVaultProjection(id, model);
        showToast('已创建并解锁', 'success');
        return profile;
      } finally {
        setBusyMessage(null);
      }
    },
    [crypto, profileStore, profiles.length, refreshVaultProjection, showToast],
  );

  const addWebDavVault = useCallback(
    async (input: AddWebDavVaultInput): Promise<VaultProfile> => {
      setBusyMessage('正在连接 WebDAV 并拉取远程数据库…');
      try {
        const vaultCreds: WebDavCredentials | undefined =
          input.username || input.password
            ? { username: input.username, password: input.password }
            : undefined;
        const download = await webdav.getFile(input.vaultUrl, null, {
          credentials: vaultCreds,
          allowInsecureHttp: input.allowInsecureHttp,
        });
        if (download.kind !== 'downloaded') {
          throw new Error('远程 WebDAV 地址未找到 KDBX 数据库文件（HTTP 404）。');
        }

        let remoteKeyBytes: Uint8Array | undefined;
        if (input.keyFileSource.kind === 'webdav') {
          const keyCreds = input.keyFileSource.useSameAuthAsVault
            ? vaultCreds
            : input.keyFileSource.username || input.remoteKeyWebdavPassword
              ? {
                  username: input.keyFileSource.username ?? '',
                  password: input.remoteKeyWebdavPassword ?? '',
                }
              : undefined;
          const keyRes = await webdav.getFile(input.keyFileSource.url, null, {
            credentials: keyCreds,
            allowInsecureHttp: input.keyFileSource.allowInsecureHttp ?? input.allowInsecureHttp,
          });
          if (keyRes.kind !== 'downloaded') {
            throw new Error('远程 WebDAV 地址未找到指定的远程密钥文件。');
          }
          remoteKeyBytes = keyRes.data;
        }

        const id = generateProfileId(crypto);
        await profileStore.writeCachedVaultBytes(id, download.data);

        let hasCachedWebDavPassword = false;
        let hasCachedRemoteKeyFile = false;
        if (input.cacheWebDavSecrets && (input.password || input.remoteKeyWebdavPassword)) {
          await profileStore.saveSealedWebDavSecrets(id, {
            vaultPassword: input.password || undefined,
            remoteKeyPassword: input.remoteKeyWebdavPassword || undefined,
          });
          hasCachedWebDavPassword = true;
        }
        if (input.cacheWebDavSecrets && remoteKeyBytes) {
          await profileStore.saveSealedRemoteKeyFile(id, remoteKeyBytes);
          hasCachedRemoteKeyFile = true;
        }

        const now = new Date().toISOString();
        const lastSeg = input.vaultUrl.trim().split('/').filter(Boolean).pop() || 'WebDAV 密码库';
        let decodedSeg = lastSeg;
        try {
          decodedSeg = decodeURIComponent(lastSeg);
        } catch {
          // 保留原始文件名
        }
        const defaultName = input.name.trim() || decodedSeg.replace(/\.kdbx$/i, '');
        const profile: VaultProfile = {
          id,
          name: defaultName,
          sourceKind: 'webdav',
          webdav: {
            url: input.vaultUrl.trim(),
            username: input.username.trim(),
            allowInsecureHttp: input.allowInsecureHttp,
          },
          keyFileSource: input.keyFileSource,
          lastPasswordMode: input.keyFileSource.kind === 'none' ? 'password' : 'no-password',
          biometricEnabled: false,
          isDefault: profiles.length === 0,
          hasCachedWebDavPassword,
          hasCachedRemoteKeyFile,
          syncMeta: {
            baseHash: download.hash,
            baseEtag: download.etag,
            localHash: download.hash,
            lastSyncedAt: now,
            state: 'clean',
          },
          createdAt: now,
          lastOpenedAt: null,
        };
        const next = await profileStore.upsertProfile(profile);
        setProfiles(next);
        setActiveProfileId(id);
        showToast('已添加 WebDAV 库', 'success');
        return profile;
      } finally {
        setBusyMessage(null);
      }
    },
    [crypto, profileStore, profiles.length, showToast, webdav],
  );

  const removeProfile = useCallback(
    async (profileId: string) => {
      if (activeProfile?.id === profileId) {
        lockVault(true);
      }
      const next = await profileStore.deleteProfile(profileId);
      setProfiles(next);
      setActiveProfileId(next[0]?.id ?? null);
      showToast('已移除密码库及其本地加密缓存与硬件密钥', 'info');
    },
    [activeProfile?.id, lockVault, profileStore, showToast],
  );

  const resolveKeyFileForProfile = useCallback(
    async (
      profile: VaultProfile,
      options: {
        overrideBytes?: Uint8Array;
        webdavPassword?: string;
        remoteKeyWebdavPassword?: string;
        cacheRemoteKey?: boolean;
      },
    ): Promise<Uint8Array | undefined> => {
      if (options.overrideBytes) return options.overrideBytes.slice();
      const src = profile.keyFileSource;
      if (src.kind === 'none') return undefined;

      if (src.kind === 'local-saf') {
        const nativeStorage = getNativeStorage();
        if (!nativeStorage) throw new Error('当前环境无法读取 Android SAF 本地密钥文件。');
        const b64 = await nativeStorage.readDocumentBase64(src.uri);
        return fromBase64(b64);
      }

      // 远程 WebDAV 密钥文件：优先联网获取最新副本，离线时安全回退至硬件 Keystore 加密缓存
      const keyCreds: WebDavCredentials | undefined = src.useSameAuthAsVault
        ? profile.webdav?.username || options.webdavPassword
          ? { username: profile.webdav?.username ?? '', password: options.webdavPassword ?? '' }
          : undefined
        : src.username || options.remoteKeyWebdavPassword
          ? { username: src.username ?? '', password: options.remoteKeyWebdavPassword ?? '' }
          : undefined;

      try {
        const res = await webdav.getFile(src.url, null, {
          credentials: keyCreds,
          allowInsecureHttp: src.allowInsecureHttp ?? profile.webdav?.allowInsecureHttp,
        });
        if (res.kind === 'downloaded') {
          if (options.cacheRemoteKey) {
            await profileStore.saveSealedRemoteKeyFile(profile.id, res.data).catch(() => {});
          }
          return res.data;
        }
      } catch {
        // 离线或远端暂不可达，尝试硬件加密缓存
      }

      const cached = await profileStore.loadSealedRemoteKeyFile(profile.id).catch(() => null);
      if (cached) return cached;
      throw new Error('无法拉取 WebDAV 远程密钥文件，且本地无硬件加密离线缓存，请检查网络或认证信息。');
    },
    [profileStore, webdav],
  );

  const loadVaultBytesForProfile = useCallback(
    async (
      profile: VaultProfile,
      webdavPassword?: string,
    ): Promise<{ bytes: Uint8Array; updatedProfile: VaultProfile }> => {
      const cachedBytes = await profileStore.readCachedVaultBytes(profile.id);

      if (profile.sourceKind === 'local-saf' && profile.localSafUri) {
        const nativeStorage = getNativeStorage();
        if (nativeStorage) {
          try {
            const b64 = await nativeStorage.readDocumentBase64(profile.localSafUri);
            const diskBytes = fromBase64(b64);
            const diskHash = hashBytes(diskBytes, crypto);
            await profileStore.writeCachedVaultBytes(profile.id, diskBytes);
            const updated: VaultProfile = {
              ...profile,
              syncMeta: {
                ...profile.syncMeta,
                baseHash: diskHash,
                localHash: diskHash,
                lastSyncedAt: new Date().toISOString(),
                state: 'clean',
              },
            };
            return { bytes: diskBytes, updatedProfile: updated };
          } catch (err) {
            if (!cachedBytes) throw err;
          }
        }
      }

      if (profile.sourceKind === 'webdav' && profile.webdav) {
        try {
          const creds =
            profile.webdav.username || webdavPassword
              ? { username: profile.webdav.username, password: webdavPassword ?? '' }
              : undefined;
          const pulled = await pullWebDavVault({
            client: webdav,
            url: profile.webdav.url,
            syncMeta: profile.syncMeta,
            localBytes: cachedBytes,
            credentials: creds,
            allowInsecureHttp: profile.webdav.allowInsecureHttp,
            crypto,
          });
          if (pulled.kind === 'fast-forward') {
            await profileStore.writeCachedVaultBytes(profile.id, pulled.remoteBytes);
            return {
              bytes: pulled.remoteBytes,
              updatedProfile: { ...profile, syncMeta: pulled.syncMeta },
            };
          }
          if (pulled.kind === 'conflict' && cachedBytes) {
            setConflict({
              profileId: profile.id,
              localBytes: cachedBytes,
              remoteBytes: pulled.remoteBytes,
              remoteHash: pulled.remoteHash,
              remoteEtag: pulled.remoteEtag,
            });
            return {
              bytes: cachedBytes,
              updatedProfile: { ...profile, syncMeta: pulled.syncMeta },
            };
          }
          if (cachedBytes) {
            return {
              bytes: cachedBytes,
              updatedProfile: { ...profile, syncMeta: pulled.syncMeta },
            };
          }
        } catch {
          // 离线模式：直接使用本地已加密 KDBX 副本，绝不阻塞用户查看密码
          if (cachedBytes) {
            return {
              bytes: cachedBytes,
              updatedProfile: {
                ...profile,
                syncMeta: {
                  ...profile.syncMeta,
                  state: profile.syncMeta.state === 'dirty' ? 'offline-dirty' : profile.syncMeta.state,
                },
              },
            };
          }
        }
      }

      if (cachedBytes) {
        return { bytes: cachedBytes, updatedProfile: profile };
      }
      throw new Error('找不到可读的 KDBX 数据库文件，请重新拉取或授权本地文件。');
    },
    [crypto, profileStore, webdav],
  );

  const unlockVault = useCallback(
    async (input: UnlockAttemptInput) => {
      const profile = profiles.find((p) => p.id === input.profileId);
      if (!profile) throw new Error('未找到指定的密码库配置。');

      setBusyMessage('正在派生密钥并解密 KDBX 密码库…');
      try {
        const sealedDav = await profileStore.loadSealedWebDavSecrets(profile.id).catch(() => null);
        const effectiveDavPwd = input.webdavPassword ?? sealedDav?.vaultPassword;
        const effectiveKeyDavPwd = input.remoteKeyWebdavPassword ?? sealedDav?.remoteKeyPassword;

        const [{ bytes, updatedProfile }, keyFileBytes] = await Promise.all([
          loadVaultBytesForProfile(profile, effectiveDavPwd),
          resolveKeyFileForProfile(profile, {
            overrideBytes: input.overrideKeyFileBytes,
            webdavPassword: effectiveDavPwd,
            remoteKeyWebdavPassword: effectiveKeyDavPwd,
            cacheRemoteKey: input.rememberSecretsInKeystore ?? true,
          }),
        ]);

        const { vault, resolvedPasswordMode } = await loadVaultWithEmptyPasswordProbe(
          bytes,
          {
            password: input.password,
            keyFile: keyFileBytes,
            probeEmptyPasswordWithKeyFile: input.probeEmptyPasswordWithKeyFile ?? true,
          },
          crypto,
        );

        const resolvedPassword =
          resolvedPasswordMode === 'no-password'
            ? null
            : resolvedPasswordMode === 'empty-password'
              ? ''
              : input.password;

        if (input.rememberSecretsInKeystore && (effectiveDavPwd || effectiveKeyDavPwd)) {
          await profileStore
            .saveSealedWebDavSecrets(profile.id, {
              vaultPassword: effectiveDavPwd,
              remoteKeyPassword: effectiveKeyDavPwd,
            })
            .catch(() => {});
        }

        const finalizedProfile: VaultProfile = {
          ...updatedProfile,
          lastPasswordMode: resolvedPasswordMode,
          lastOpenedAt: new Date().toISOString(),
        };
        const nextProfiles = await profileStore.upsertProfile(finalizedProfile);
        setProfiles(nextProfiles);
        setActiveProfileId(profile.id);

        vaultRef.current?.lock();
        vaultRef.current = vault;
        sessionSecretRef.current = {
          password: resolvedPassword,
          keyFile: keyFileBytes?.slice(),
          webdavPassword: effectiveDavPwd,
          remoteKeyWebdavPassword: effectiveKeyDavPwd,
        };
        wipeBytes(keyFileBytes);

        setIsUnlocked(true);
        refreshVaultProjection(profile.id, vault);
      } finally {
        setBusyMessage(null);
      }
    },
    [crypto, loadVaultBytesForProfile, profileStore, profiles, refreshVaultProjection, resolveKeyFileForProfile],
  );

  const unlockWithBiometric = useCallback(
    async (profileId: string) => {
      const profile = profiles.find((p) => p.id === profileId);
      if (!profile) throw new Error('未找到密码库配置。');
      const secret = await profileStore.unsealBiometricUnlock(profile.id, profile.name);
      const keyBytes = secret.keyFileB64 ? fromBase64(secret.keyFileB64) : undefined;
      try {
        await unlockVault({
          profileId: profile.id,
          password: secret.password,
          probeEmptyPasswordWithKeyFile: false,
          overrideKeyFileBytes: keyBytes,
          webdavPassword: secret.webdavPassword,
          remoteKeyWebdavPassword: secret.remoteKeyWebdavPassword,
        });
      } finally {
        wipeBytes(keyBytes);
      }
    },
    [profileStore, profiles, unlockVault],
  );

  const enableBiometricForActiveVault = useCallback(async () => {
    if (!activeProfile || !sessionSecretRef.current) {
      throw new Error('请先解锁密码库后再启用生物识别。');
    }
    const { strongBox } = await profileStore.enableBiometricUnlock(activeProfile.id, activeProfile.name, {
      password: sessionSecretRef.current.password,
      keyFileB64: sessionSecretRef.current.keyFile
        ? toBase64(sessionSecretRef.current.keyFile)
        : undefined,
      webdavPassword: sessionSecretRef.current.webdavPassword,
      remoteKeyWebdavPassword: sessionSecretRef.current.remoteKeyWebdavPassword,
    });
    const updated: VaultProfile = {
      ...activeProfile,
      biometricEnabled: true,
      biometricStrongBox: strongBox,
    };
    const next = await profileStore.upsertProfile(updated);
    setProfiles(next);
    showToast(strongBox ? '已启用 StrongBox 生物识别' : '已启用生物识别', 'success');
  }, [activeProfile, profileStore, showToast]);

  const disableBiometricForActiveVault = useCallback(async () => {
    if (!activeProfile) return;
    await profileStore.disableBiometricUnlock(activeProfile.id);
    const updated: VaultProfile = { ...activeProfile, biometricEnabled: false, biometricStrongBox: false };
    const next = await profileStore.upsertProfile(updated);
    setProfiles(next);
    showToast('已关闭生物识别', 'info');
  }, [activeProfile, profileStore, showToast]);

  /** 持久化编辑变更：先写入本地加密工作副本，再按来源尝试回写 SAF 或 WebDAV */
  const persistVaultMutation = useCallback(
    async (mutator: (draft: VaultModel) => void) => {
      const currentVault = vaultRef.current;
      if (!currentVault || !activeProfile) {
        throw new Error('密码库已锁定，无法保存更改。');
      }
      const draft = currentVault.fork();
      try {
        mutator(draft);
        const bytes = await draft.serialize();
        await profileStore.writeCachedVaultBytes(activeProfile.id, bytes);
        const localHash = hashBytes(bytes, crypto);

        // 原子切换主会话
        currentVault.lock();
        vaultRef.current = draft;

        let nextSyncMeta: VaultSyncMeta = {
          ...activeProfile.syncMeta,
          localHash,
          state: 'dirty',
        };

        if (activeProfile.sourceKind === 'local-saf' && activeProfile.localSafUri) {
          const nativeStorage = getNativeStorage();
          if (nativeStorage) {
            await nativeStorage.writeDocumentBase64(activeProfile.localSafUri, toBase64(bytes));
            nextSyncMeta = {
              baseHash: localHash,
              baseEtag: null,
              localHash,
              lastSyncedAt: new Date().toISOString(),
              state: 'clean',
            };
          }
        } else if (activeProfile.sourceKind === 'webdav' && activeProfile.webdav) {
          try {
            const davPwd = sessionSecretRef.current?.webdavPassword;
            const creds =
              activeProfile.webdav.username || davPwd
                ? { username: activeProfile.webdav.username, password: davPwd ?? '' }
                : undefined;
            const pushed = await pushWebDavVault({
              client: webdav,
              url: activeProfile.webdav.url,
              localBytes: bytes,
              syncMeta: activeProfile.syncMeta,
              credentials: creds,
              allowInsecureHttp: activeProfile.webdav.allowInsecureHttp,
              crypto,
            });
            nextSyncMeta = pushed.syncMeta;
            if (pushed.kind === 'conflict' && pushed.remoteBytes && pushed.remoteHash) {
              setConflict({
                profileId: activeProfile.id,
                localBytes: bytes,
                remoteBytes: pushed.remoteBytes,
                remoteHash: pushed.remoteHash,
                remoteEtag: pushed.remoteEtag ?? null,
              });
              showToast('检测到 WebDAV 远端冲突，已保护本地修改，请决定合并方式', 'warning');
            }
          } catch {
            // 网络不可用：已安全落盘到本地加密工作副本
            nextSyncMeta = { ...nextSyncMeta, state: 'offline-dirty' };
            showToast('离线已保存在本机加密副本，连网后请同步至 WebDAV', 'warning');
          }
        }

        const updatedProfile: VaultProfile = { ...activeProfile, syncMeta: nextSyncMeta };
        const nextProfiles = await profileStore.upsertProfile(updatedProfile);
        setProfiles(nextProfiles);
        refreshVaultProjection(activeProfile.id, draft);
      } catch (err) {
        draft.lock();
        throw err;
      }
    },
    [activeProfile, crypto, profileStore, refreshVaultProjection, showToast, webdav],
  );

  const getEntryDetail = useCallback((entryId: string): VaultEntry => {
    if (!vaultRef.current) throw new Error('密码库已锁定。');
    return vaultRef.current.getEntry(entryId);
  }, []);

  const readEntryField = useCallback((entryId: string, key: string): string => {
    if (!vaultRef.current) throw new Error('密码库已锁定。');
    return vaultRef.current.readField(entryId, key);
  }, []);

  const readEntryTotp = useCallback((entryId: string): TotpConfig | null => {
    if (!vaultRef.current) return null;
    return vaultRef.current.readTotpConfig(entryId);
  }, []);

  const upsertEntry = useCallback(
    async (input: VaultEntryInput): Promise<VaultEntrySummary> => {
      let saved!: VaultEntrySummary;
      await persistVaultMutation((draft) => {
        saved = draft.upsertEntry(input);
      });
      showToast('已保存', 'success');
      return saved;
    },
    [persistVaultMutation, showToast],
  );

  const deleteEntry = useCallback(
    async (entryId: string, permanent = false) => {
      await persistVaultMutation((draft) => {
        draft.deleteEntry(entryId, { permanent });
      });
      showToast(permanent ? '已永久删除' : '已移入回收站', 'info');
    },
    [persistVaultMutation, showToast],
  );

  const restoreEntry = useCallback(
    async (entryId: string, targetGroupId?: string) => {
      await persistVaultMutation((draft) => {
        draft.restoreEntry(entryId, targetGroupId);
      });
      showToast('已恢复', 'success');
    },
    [persistVaultMutation, showToast],
  );

  const upsertGroup = useCallback(
    async (input: VaultGroupInput): Promise<VaultGroup> => {
      let saved!: VaultGroup;
      await persistVaultMutation((draft) => {
        saved = draft.upsertGroup(input);
      });
      showToast('分组已保存', 'success');
      return saved;
    },
    [persistVaultMutation, showToast],
  );

  const syncActiveVault = useCallback(
    async (overrideWebDavPassword?: string) => {
      if (!activeProfile) return;
      if (activeProfile.sourceKind !== 'webdav' || !activeProfile.webdav) {
        showToast('当前为本地 SAF 密码库，所有修改均已直接回写本地文件', 'info');
        return;
      }
      setBusyMessage('正在与 WebDAV 同步…');
      try {
        const localBytes = await profileStore.readCachedVaultBytes(activeProfile.id);
        const davPwd = overrideWebDavPassword ?? sessionSecretRef.current?.webdavPassword;
        const creds =
          activeProfile.webdav.username || davPwd
            ? { username: activeProfile.webdav.username, password: davPwd ?? '' }
            : undefined;

        const pulled = await pullWebDavVault({
          client: webdav,
          url: activeProfile.webdav.url,
          syncMeta: activeProfile.syncMeta,
          localBytes,
          credentials: creds,
          allowInsecureHttp: activeProfile.webdav.allowInsecureHttp,
          crypto,
        });

        if (pulled.kind === 'conflict' && localBytes) {
          setConflict({
            profileId: activeProfile.id,
            localBytes,
            remoteBytes: pulled.remoteBytes,
            remoteHash: pulled.remoteHash,
            remoteEtag: pulled.remoteEtag,
          });
          const next = await profileStore.upsertProfile({ ...activeProfile, syncMeta: pulled.syncMeta });
          setProfiles(next);
          showToast('远端与本地均发生变更，请选择冲突处理方式', 'warning');
          return;
        }

        if (pulled.kind === 'local-ahead' && localBytes) {
          const pushed = await pushWebDavVault({
            client: webdav,
            url: activeProfile.webdav.url,
            localBytes,
            syncMeta: pulled.syncMeta,
            credentials: creds,
            allowInsecureHttp: activeProfile.webdav.allowInsecureHttp,
            crypto,
          });
          const next = await profileStore.upsertProfile({ ...activeProfile, syncMeta: pushed.syncMeta });
          setProfiles(next);
          if (pushed.kind === 'conflict' && pushed.remoteBytes && pushed.remoteHash) {
            setConflict({
              profileId: activeProfile.id,
              localBytes,
              remoteBytes: pushed.remoteBytes,
              remoteHash: pushed.remoteHash,
              remoteEtag: pushed.remoteEtag ?? null,
            });
          } else {
            showToast('本地更改已成功推送到 WebDAV', 'success');
          }
          return;
        }

        if (pulled.kind === 'fast-forward') {
          await profileStore.writeCachedVaultBytes(activeProfile.id, pulled.remoteBytes);
          const next = await profileStore.upsertProfile({ ...activeProfile, syncMeta: pulled.syncMeta });
          setProfiles(next);
          if (sessionSecretRef.current) {
            const { vault } = await loadVaultWithEmptyPasswordProbe(
              pulled.remoteBytes,
              {
                password: sessionSecretRef.current.password,
                keyFile: sessionSecretRef.current.keyFile,
                probeEmptyPasswordWithKeyFile: false,
              },
              crypto,
            );
            vaultRef.current?.lock();
            vaultRef.current = vault;
            refreshVaultProjection(activeProfile.id, vault);
          }
          showToast('已从 WebDAV 拉取最新版本并刷新密码库', 'success');
          return;
        }

        const next = await profileStore.upsertProfile({ ...activeProfile, syncMeta: pulled.syncMeta });
        setProfiles(next);
        showToast('密码库已是最新状态', 'success');
      } finally {
        setBusyMessage(null);
      }
    },
    [activeProfile, crypto, profileStore, refreshVaultProjection, showToast, webdav],
  );

  const resolveConflict = useCallback(
    async (resolution: ConflictResolution) => {
      if (!conflict || !activeProfile || !activeProfile.webdav) return;
      setBusyMessage('正在执行冲突解决策略…');
      try {
        const davPwd = sessionSecretRef.current?.webdavPassword;
        const creds =
          activeProfile.webdav.username || davPwd
            ? { username: activeProfile.webdav.username, password: davPwd ?? '' }
            : undefined;
        const resolved = await resolveWebDavConflict({
          resolution,
          client: webdav,
          url: activeProfile.webdav.url,
          localBytes: conflict.localBytes,
          remoteBytes: conflict.remoteBytes,
          remoteHash: conflict.remoteHash,
          remoteEtag: conflict.remoteEtag,
          syncMeta: activeProfile.syncMeta,
          credentials: creds,
          allowInsecureHttp: activeProfile.webdav.allowInsecureHttp,
          crypto,
          exportRecoveryCopy: async (localBytes) => {
            const nativeStorage = getNativeStorage();
            if (!nativeStorage) {
              throw new Error('当前环境不支持 SAF 导出恢复副本。');
            }
            const handle = await nativeStorage.createDocument(
              `${activeProfile.name}-recovery-${Date.now()}.kdbx`,
            );
            await nativeStorage.writeDocumentBase64(handle.uri, toBase64(localBytes));
          },
        });

        await profileStore.writeCachedVaultBytes(activeProfile.id, resolved.activeBytes);
        const next = await profileStore.upsertProfile({ ...activeProfile, syncMeta: resolved.syncMeta });
        setProfiles(next);
        setConflict(null);

        if (resolution !== 'keep-local-overwrite-remote' && sessionSecretRef.current) {
          const { vault } = await loadVaultWithEmptyPasswordProbe(
            resolved.activeBytes,
            {
              password: sessionSecretRef.current.password,
              keyFile: sessionSecretRef.current.keyFile,
              probeEmptyPasswordWithKeyFile: false,
            },
            crypto,
          );
          vaultRef.current?.lock();
          vaultRef.current = vault;
          refreshVaultProjection(activeProfile.id, vault);
        }
        showToast('同步冲突已解决并对齐版本', 'success');
      } finally {
        setBusyMessage(null);
      }
    },
    [activeProfile, conflict, crypto, profileStore, refreshVaultProjection, showToast, webdav],
  );

  const copySensitive = useCallback(
    async (value: string, label: string) => {
      const copied = await copySecretSafely(value, label, securityPrefs.clipboardClearMs);
      if (copied) {
        const secs = Math.round(securityPrefs.clipboardClearMs / 1000);
        showToast(secs > 0 ? `已复制 · ${secs}s 后清除` : '已复制', 'success');
      } else {
        showToast('无法写入剪贴板', 'warning');
      }
    },
    [securityPrefs.clipboardClearMs, showToast],
  );

  const updateSecurityPrefs = useCallback(
    async (patch: Partial<SecurityPreferences>) => {
      const next = { ...securityPrefs, ...patch };
      setSecurityPrefs(next);
      const nativeStorage = getNativeStorage();
      if (nativeStorage && patch.secureScreenEnabled !== undefined) {
        await nativeStorage.setSecureScreen(patch.secureScreenEnabled).catch(() => {});
      }
      if (patch.autofillSyncEnabled === false) {
        await clearNativeAutofillSession().catch(() => {});
      } else if (patch.autofillSyncEnabled === true && activeProfile && vaultRef.current) {
        await pushUnlockedVaultToAutofill(activeProfile.id, vaultRef.current).catch(() => {});
      }
    },
    [activeProfile, securityPrefs],
  );

  const openAutofillSettings = useCallback(async () => {
    const nativeStorage = getNativeStorage();
    if (!nativeStorage) {
      showToast('仅 Android 真机/模拟器支持打开系统自动填充设置', 'warning');
      return;
    }
    await nativeStorage.openAutofillSettings();
  }, [showToast]);

  const dismissConflict = useCallback(() => setConflict(null), []);
  const dismissPendingAutofillSave = useCallback(() => setPendingAutofillSave(null), []);

  const value: VaultCoordinatorValue = {
    ready,
    busyMessage,
    profiles,
    defaultProfile,
    activeProfile,
    autoUnlockNonce,
    isUnlocked,
    vaultMeta,
    groups,
    entries,
    biometricCapability,
    autofillEnabled,
    pendingAutofillSave,
    conflict,
    securityPrefs,
    toast,
    crypto,
    selectProfile,
    setDefaultProfile,
    addLocalSafVault,
    createNewLocalVault,
    addWebDavVault,
    removeProfile,
    browseWebDavDirectory,
    unlockVault,
    unlockWithBiometric,
    lockVault,
    enableBiometricForActiveVault,
    disableBiometricForActiveVault,
    getEntryDetail,
    readEntryField,
    readEntryTotp,
    upsertEntry,
    deleteEntry,
    restoreEntry,
    upsertGroup,
    syncActiveVault,
    resolveConflict,
    dismissConflict,
    copySensitive,
    updateSecurityPrefs,
    openAutofillSettings,
    refreshPlatformStatus,
    dismissPendingAutofillSave,
    showToast,
  };

  return <CoordinatorContext.Provider value={value}>{children}</CoordinatorContext.Provider>;
}

export function useVaultCoordinator(): VaultCoordinatorValue {
  const ctx = useContext(CoordinatorContext);
  if (!ctx) throw new Error('useVaultCoordinator 必须在 VaultCoordinatorProvider 内使用。');
  return ctx;
}
