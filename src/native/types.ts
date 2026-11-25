/**
 * Android 原生模块（ZeroVaultCrypto / ZeroVaultBiometric / ZeroVaultStorage）的类型契约。
 */

export interface BiometricCapability {
  readonly available: boolean;
  readonly hardwarePresent: boolean;
  readonly enrolled: boolean;
  readonly strongBoxSupported: boolean;
  readonly statusCode: number;
}

export interface SealedPayload {
  readonly ivB64: string;
  readonly ciphertextB64: string;
  readonly strongBox?: boolean;
}

export interface SafDocumentHandle {
  readonly uri: string;
  readonly displayName: string;
  readonly size: number;
}

export interface AutofillEntryPayload {
  readonly id: string;
  readonly title: string;
  readonly username: string;
  readonly password: string;
  readonly url: string;
}

export interface PendingAutofillSave {
  readonly packageName: string;
  readonly webDomain: string | null;
  readonly username: string;
  readonly password: string;
  readonly capturedAt: number;
}

export interface NativeCryptoBridge {
  randomBytes(length: number): Promise<string>;
  randomBytesSync(length: number): string;
  argon2(
    variant: 'argon2d' | 'argon2id',
    passwordB64: string,
    saltB64: string,
    iterations: number,
    memoryKiB: number,
    parallelism: number,
    version: number,
    hashLength: number,
  ): Promise<string>;
  aesKdf(seedB64: string, keyB64: string, roundsStr: string): Promise<string>;
  aesCbcEncrypt(keyB64: string, ivB64: string, plaintextB64: string): Promise<string>;
  aesCbcDecrypt(keyB64: string, ivB64: string, ciphertextB64: string): Promise<string>;
  chacha20(keyB64: string, nonceB64: string, dataB64: string): Promise<string>;
  twofishCbcCrypt(
    encrypt: boolean,
    keyB64: string,
    ivB64: string,
    dataB64: string,
  ): Promise<string>;
}

export interface NativeBiometricBridge {
  getCapability(): Promise<BiometricCapability>;
  sealWithBiometric(
    alias: string,
    plaintextB64: string,
    title: string,
    subtitle: string,
  ): Promise<SealedPayload>;
  unsealWithBiometric(
    alias: string,
    ivB64: string,
    ciphertextB64: string,
    title: string,
    subtitle: string,
  ): Promise<string>;
  sealDeviceSecret(alias: string, plaintextB64: string): Promise<SealedPayload>;
  unsealDeviceSecret(alias: string, ivB64: string, ciphertextB64: string): Promise<string>;
  deleteKey(alias: string, biometric: boolean): Promise<boolean>;
  hasKey(alias: string, biometric: boolean): Promise<boolean>;
}

export interface NativeWebDavResponse {
  readonly status: number;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly bodyB64: string;
}

export interface NativeWebDavBridge {
  request(
    url: string,
    method: 'GET' | 'PUT' | 'HEAD' | 'PROPFIND',
    headers: Readonly<Record<string, string>>,
    bodyB64: string | null,
    contentType: string | null,
    timeoutMs: number,
  ): Promise<NativeWebDavResponse>;
}

export interface SystemWindowInsets {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export interface NativeStorageBridge {
  pickDocument(): Promise<SafDocumentHandle>;
  createDocument(suggestedName: string): Promise<SafDocumentHandle>;
  readDocumentBase64(uriString: string): Promise<string>;
  writeDocumentBase64(uriString: string, dataB64: string): Promise<boolean>;
  readPrivateFileBase64(relativePath: string): Promise<string | null>;
  writePrivateFileBase64(relativePath: string, dataB64: string): Promise<boolean>;
  deletePrivateFile(relativePath: string): Promise<boolean>;
  setSecureScreen(enabled: boolean): Promise<boolean>;
  getSystemInsetsSync?(): SystemWindowInsets;
  setSystemBarsStyle?(darkIcons: boolean): void;
  copySensitiveToClipboard(text: string, label: string, clearAfterMs: number): Promise<boolean>;
  isAutofillServiceEnabled(): Promise<boolean>;
  openAutofillSettings(): Promise<boolean>;
  syncAutofillSession(vaultId: string, entries: readonly AutofillEntryPayload[]): Promise<boolean>;
  clearAutofillSession(): Promise<boolean>;
  consumePendingAutofillSave(): Promise<PendingAutofillSave | null>;
}
