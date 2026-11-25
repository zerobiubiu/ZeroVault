/**
 * React Native 原生模块桥接封装。
 * 在 Node/Vitest 环境中自动识别无 React Native 宿主，允许测试注入内存模拟实现。
 */
import type {
  BiometricCapability,
  NativeBiometricBridge,
  NativeCryptoBridge,
  NativeStorageBridge,
  NativeWebDavBridge,
} from './types';

interface NativeModulesMap {
  ZeroVaultCrypto?: NativeCryptoBridge;
  ZeroVaultBiometric?: NativeBiometricBridge;
  ZeroVaultStorage?: NativeStorageBridge;
  ZeroVaultWebDav?: NativeWebDavBridge;
}

function resolveNativeModules(): NativeModulesMap {
  try {
    // 延迟按需读取，避免在纯 Node Vitest 单元测试中引入 react-native 宿主代码报错
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require('react-native') as { NativeModules?: NativeModulesMap };
    return rn.NativeModules ?? {};
  } catch {
    return {};
  }
}

export function getNativeCrypto(): NativeCryptoBridge | null {
  return resolveNativeModules().ZeroVaultCrypto ?? null;
}

export function getNativeBiometric(): NativeBiometricBridge | null {
  return resolveNativeModules().ZeroVaultBiometric ?? null;
}

export function getNativeStorage(): NativeStorageBridge | null {
  return resolveNativeModules().ZeroVaultStorage ?? null;
}

export function getNativeWebDav(): NativeWebDavBridge | null {
  return resolveNativeModules().ZeroVaultWebDav ?? null;
}

export async function queryBiometricCapability(): Promise<BiometricCapability> {
  const mod = getNativeBiometric();
  if (!mod) {
    return {
      available: false,
      hardwarePresent: false,
      enrolled: false,
      strongBoxSupported: false,
      statusCode: -1,
    };
  }
  return mod.getCapability();
}
