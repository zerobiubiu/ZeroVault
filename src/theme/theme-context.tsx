import React, { createContext, useContext, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import {
  darkColors,
  lightColors,
  primitiveTokens,
  type ThemeColors,
  type ThemeMode,
} from './tokens';

export interface ThemeContextValue {
  readonly mode: ThemeMode;
  readonly isDark: boolean;
  readonly colors: ThemeColors;
  readonly spacing: typeof primitiveTokens.spacing;
  readonly radius: typeof primitiveTokens.radius;
  readonly fontSize: typeof primitiveTokens.fontSize;
  readonly fontWeight: typeof primitiveTokens.fontWeight;
  readonly borderWidth: typeof primitiveTokens.borderWidth;
  readonly setMode: (next: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const systemScheme = useColorScheme();
  const [mode, setMode] = useState<ThemeMode>('system');

  const value = useMemo<ThemeContextValue>(() => {
    const isDark = mode === 'dark' || (mode === 'system' && systemScheme === 'dark');
    return {
      mode,
      isDark,
      colors: isDark ? darkColors : lightColors,
      spacing: primitiveTokens.spacing,
      radius: primitiveTokens.radius,
      fontSize: primitiveTokens.fontSize,
      fontWeight: primitiveTokens.fontWeight,
      borderWidth: primitiveTokens.borderWidth,
      setMode,
    };
  }, [mode, systemScheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme 必须在 ThemeProvider 内使用。');
  }
  return ctx;
}
