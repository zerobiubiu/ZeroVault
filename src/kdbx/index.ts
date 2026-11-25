/**
 * src/kdbx 模块公开门面。
 */
export * from './types';
export {
  buildCredentialsFromMode,
  deriveCompositeKey,
  generateKeyFileV2,
  parseKeyFileComponent,
  type CredentialMode,
} from './credentials';
export { createFallbackCryptoProvider } from './crypto-fallback';
export { createRuntimeCryptoProvider } from './crypto-native';
export { computeTotp, decodeBase32, encodeBase32, extractTotpFromFields, parseOtpAuthUri } from './totp';
export { createVault, loadVault, loadVaultWithEmptyPasswordProbe } from './vault';
export { decodeUtf8, encodeUtf8, fromBase64, fromHex, toBase64, toHex, wipeBytes } from './binary';
