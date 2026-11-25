/**
 * ZeroVault React Native 启动入口。
 * 首行在 Hermes 宿主缺失 TextEncoder / TextDecoder 时注入严格 UTF-8 polyfill，
 * 确保 @noble/hashes、@noble/ciphers 等库及全部业务模块在真机零报错加载。
 */
import { decodeUtf8, encodeUtf8 } from './src/kdbx/binary';

if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = class HermesTextEncoder {
    encode(input = '') {
      return encodeUtf8(String(input));
    }
  };
}

if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class HermesTextDecoder {
    constructor(label = 'utf-8', options = {}) {
      this.encoding = String(label).toLowerCase();
      this.fatal = Boolean(options.fatal);
      this.ignoreBOM = Boolean(options.ignoreBOM);
    }
    decode(input) {
      if (!input) return '';
      const bytes =
        input instanceof Uint8Array
          ? input
          : ArrayBuffer.isView(input)
            ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
            : new Uint8Array(input);
      return decodeUtf8(bytes);
    }
  };
}

import { AppRegistry } from 'react-native';
import { App } from './src/app/App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
