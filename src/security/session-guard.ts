/**
 * ZeroVault 安全会话守护：
 * - 统一管理自动锁定超时、防截屏开关、剪贴板自动清除时长
 * - 同步/清空 Android 系统 AutofillSessionStore，确保锁库瞬间不留任何明文凭据
 */
import type { VaultModel } from '../kdbx';
import { getNativeStorage, type AutofillEntryPayload } from '../native';

export type AutoLockTimeoutMs = 0 | 60_000 | 300_000 | 900_000 | 1_800_000 | -1;

export interface SecurityPreferences {
  readonly autoLockTimeoutMs: AutoLockTimeoutMs;
  readonly clipboardClearMs: number;
  readonly secureScreenEnabled: boolean;
  readonly autofillSyncEnabled: boolean;
}

export const DEFAULT_SECURITY_PREFERENCES: SecurityPreferences = {
  autoLockTimeoutMs: 300_000, // 默认切后台 5 分钟自动锁定
  clipboardClearMs: 30_000, // 默认敏感剪贴板 30 秒自动清除
  secureScreenEnabled: true, // 默认开启 FLAG_SECURE 防截屏
  autofillSyncEnabled: true,
};

export const AUTO_LOCK_OPTIONS: ReadonlyArray<{ label: string; value: AutoLockTimeoutMs }> = [
  { label: '切后台立即锁定', value: 0 },
  { label: '1 分钟', value: 60_000 },
  { label: '5 分钟（推荐）', value: 300_000 },
  { label: '15 分钟', value: 900_000 },
  { label: '30 分钟', value: 1_800_000 },
  { label: '仅手动锁定', value: -1 },
];

export const CLIPBOARD_CLEAR_OPTIONS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '15 秒', value: 15_000 },
  { label: '30 秒（推荐）', value: 30_000 },
  { label: '60 秒', value: 60_000 },
  { label: '不自动清除', value: 0 },
];

export function shouldAutoLock(
  backgroundedAtMs: number | null,
  nowMs: number,
  timeoutMs: AutoLockTimeoutMs,
): boolean {
  if (backgroundedAtMs === null) return false;
  if (timeoutMs < 0) return false;
  if (timeoutMs === 0) return true;
  return nowMs - backgroundedAtMs >= timeoutMs;
}

/**
 * 将已解锁库的可填充非回收站条目同步到 Android 进程内 AutofillSessionStore。
 */
export async function pushUnlockedVaultToAutofill(vaultId: string, vault: VaultModel): Promise<void> {
  const native = getNativeStorage();
  if (!native || vault.locked) return;
  const entries = vault.listEntries({ includeRecycled: false });
  const payload: AutofillEntryPayload[] = [];
  for (const item of entries) {
    if (!item.url && !item.username) continue;
    const password = vault.readField(item.id, 'Password');
    payload.push({
      id: item.id,
      title: item.title,
      username: item.username,
      password,
      url: item.url,
    });
  }
  await native.syncAutofillSession(vaultId, payload);
}

export async function clearNativeAutofillSession(): Promise<void> {
  const native = getNativeStorage();
  if (!native) return;
  await native.clearAutofillSession();
}

export async function copySecretSafely(
  text: string,
  label: string,
  clearAfterMs: number,
): Promise<boolean> {
  const native = getNativeStorage();
  if (!native) return false;
  return native.copySensitiveToClipboard(text, label, clearAfterMs);
}
