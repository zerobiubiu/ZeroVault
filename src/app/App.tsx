/**
 * ZeroVault 根入口与主导航框架：
 * - 通过 useSafeInsets() 结合 Android 原生 DisplayCutout + StatusBar 精确避让刘海屏、挖孔屏与底部手势栏；
 * - 实时同步状态栏与导航栏图标深浅色；
 * - 完整响应 Android 物理返回键（BackHandler）并包裹根级 AppErrorBoundary。
 */
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  StatusBar,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { getNativeStorage } from '../native';
import { ThemeProvider, useTheme } from '../theme';
import { BrandLogo } from './components/BrandLogo';
import { useSafeInsets } from './components/SafeLayout';
import { ConflictResolveScreen } from './screens/ConflictResolveScreen';
import { EntryDetailScreen } from './screens/EntryDetailScreen';
import { EntryEditorScreen } from './screens/EntryEditorScreen';
import { GeneratorScreen } from './screens/GeneratorScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { SourceSetupScreen } from './screens/SourceSetupScreen';
import { UnlockScreen } from './screens/UnlockScreen';
import { VaultListScreen } from './screens/VaultListScreen';
import { useVaultCoordinator, VaultCoordinatorProvider } from './state/VaultCoordinator';

type MainTab = 'vault' | 'generator' | 'settings';

type OverlayRoute =
  | { readonly kind: 'none' }
  | { readonly kind: 'source-setup'; readonly initialTab?: 'webdav' | 'local' | 'create' }
  | { readonly kind: 'detail'; readonly entryId: string }
  | {
      readonly kind: 'editor';
      readonly entryId?: string;
      readonly prefill?: { title?: string; username?: string; password?: string; url?: string };
    }
  | { readonly kind: 'conflict' };

function ZeroVaultShell(): React.JSX.Element {
  const { colors, isDark, spacing, radius, fontSize, fontWeight } = useTheme();
  const insets = useSafeInsets();
  const {
    ready,
    busyMessage,
    isUnlocked,
    pendingAutofillSave,
    dismissPendingAutofillSave,
    toast,
  } = useVaultCoordinator();

  const [tab, setTab] = useState<MainTab>('vault');
  const [overlay, setOverlay] = useState<OverlayRoute>({ kind: 'none' });

  // 同步 Android 系统状态栏与导航栏图标颜色
  useEffect(() => {
    const native = getNativeStorage();
    if (native && typeof native.setSystemBarsStyle === 'function') {
      native.setSystemBarsStyle(!isDark);
    }
  }, [isDark]);

  // 锁库时自动清理需要解锁状态的覆盖页
  useEffect(() => {
    if (!isUnlocked && overlay.kind !== 'source-setup') {
      setOverlay({ kind: 'none' });
    }
  }, [isUnlocked, overlay.kind]);

  // Android 物理返回键联动
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (overlay.kind !== 'none') {
        if (overlay.kind === 'editor' && overlay.entryId) {
          setOverlay({ kind: 'detail', entryId: overlay.entryId });
        } else {
          setOverlay({ kind: 'none' });
        }
        return true;
      }
      if (isUnlocked && tab !== 'vault') {
        setTab('vault');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [isUnlocked, overlay, tab]);

  const renderBody = (): React.JSX.Element => {
    if (!ready) {
      return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          <BrandLogo size={64} />
          <ActivityIndicator size="small" color={colors.action} />
        </View>
      );
    }

    if (overlay.kind === 'source-setup') {
      return (
        <SourceSetupScreen
          initialTab={overlay.initialTab}
          onClose={() => setOverlay({ kind: 'none' })}
        />
      );
    }

    if (!isUnlocked) {
      return (
        <UnlockScreen
          onOpenSourceSetup={(initialTab) => setOverlay({ kind: 'source-setup', initialTab })}
        />
      );
    }

    if (overlay.kind === 'conflict') {
      return <ConflictResolveScreen onClose={() => setOverlay({ kind: 'none' })} />;
    }

    if (overlay.kind === 'detail') {
      return (
        <EntryDetailScreen
          entryId={overlay.entryId}
          onBack={() => setOverlay({ kind: 'none' })}
          onEdit={(entryId) => setOverlay({ kind: 'editor', entryId })}
        />
      );
    }

    if (overlay.kind === 'editor') {
      return (
        <EntryEditorScreen
          entryId={overlay.entryId}
          prefill={overlay.prefill}
          onClose={() =>
            overlay.entryId
              ? setOverlay({ kind: 'detail', entryId: overlay.entryId })
              : setOverlay({ kind: 'none' })
          }
          onSaved={(savedId) => {
            if (pendingAutofillSave && overlay.prefill) {
              dismissPendingAutofillSave();
            }
            setOverlay({ kind: 'detail', entryId: savedId });
          }}
        />
      );
    }

    return (
      <View style={{ flex: 1 }}>
        <View style={{ flex: 1 }}>
          {tab === 'vault' ? (
            <VaultListScreen
              onSelectEntry={(entryId) => setOverlay({ kind: 'detail', entryId })}
              onCreateEntry={() => setOverlay({ kind: 'editor' })}
              onOpenConflict={() => setOverlay({ kind: 'conflict' })}
              onSaveAutofillPending={() => {
                if (!pendingAutofillSave) return;
                setOverlay({
                  kind: 'editor',
                  prefill: {
                    title: pendingAutofillSave.webDomain || pendingAutofillSave.packageName,
                    username: pendingAutofillSave.username,
                    password: pendingAutofillSave.password,
                    url: pendingAutofillSave.webDomain
                      ? `https://${pendingAutofillSave.webDomain}`
                      : `androidapp://${pendingAutofillSave.packageName}`,
                  },
                });
              }}
            />
          ) : null}

          {tab === 'generator' ? <GeneratorScreen /> : null}

          {tab === 'settings' ? (
            <SettingsScreen
              onOpenSourceSetup={(initialTab) => setOverlay({ kind: 'source-setup', initialTab })}
            />
          ) : null}
        </View>

        {/* 底部主导航栏：显式承接底部手势栏与横屏左右安全区 */}
        <View
          style={{
            flexDirection: 'row',
            backgroundColor: colors.tabBarBg,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            paddingTop: 4,
            paddingBottom: Math.max(insets.bottom, 8),
            paddingLeft: Math.max(insets.left, 8),
            paddingRight: Math.max(insets.right, 8),
          }}
        >
          {(
            [
              { key: 'vault', label: '密码库' },
              { key: 'generator', label: '生成器' },
              { key: 'settings', label: '设置' },
            ] as ReadonlyArray<{ key: MainTab; label: string }>
          ).map((item) => {
            const active = tab === item.key;
            return (
              <Pressable
                key={item.key}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                onPress={() => setTab(item.key)}
                style={{
                  flex: 1,
                  minHeight: 44,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderTopWidth: 2,
                  borderTopColor: active ? colors.tabActive : 'transparent',
                }}
              >
                <Text
                  numberOfLines={1}
                  style={{
                    color: active ? colors.tabActive : colors.tabInactive,
                    fontSize: fontSize.xs,
                    fontWeight: active ? fontWeight.semibold : fontWeight.regular,
                  }}
                >
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  };

  const toastPalette = toast
    ? {
        info: { bg: colors.infoSubtle, fg: colors.infoSubtleText },
        success: { bg: colors.successSubtle, fg: colors.successSubtleText },
        warning: { bg: colors.warningSubtle, fg: colors.warningSubtleText },
        danger: { bg: colors.dangerSubtle, fg: colors.dangerSubtleText },
      }[toast.tone]
    : null;

  const hasBottomTabBar = ready && isUnlocked && overlay.kind === 'none';

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />

      {/* 顶部系统状态栏 / 刘海 / 挖孔绝对安全隔离区：所有界面内容绝不进入此高度内 */}
      <View
        style={{
          height: insets.top,
          backgroundColor: ready && (isUnlocked || overlay.kind !== 'none') ? colors.surface : colors.background,
        }}
      />

      {/* 主界面容器（非 Tab 页底部自动补 insets.bottom 避让手势小白条） */}
      <View
        style={{
          flex: 1,
          paddingBottom: hasBottomTabBar ? 0 : insets.bottom,
        }}
      >
        {renderBody()}
      </View>

      {toast && toastPalette ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: spacing['4'] + insets.left,
            right: spacing['4'] + insets.right,
            bottom: (hasBottomTabBar ? 68 : 20) + insets.bottom,
            backgroundColor: toastPalette.bg,
            borderRadius: radius.md,
            paddingHorizontal: spacing['4'],
            paddingVertical: spacing['3'],
            elevation: 8,
          }}
        >
          <Text style={{ color: toastPalette.fg, fontSize: fontSize.sm, fontWeight: fontWeight.semibold }}>
            {toast.text}
          </Text>
        </View>
      ) : null}

      {busyMessage ? (
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(10, 14, 20, 0.56)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: spacing['6'],
          }}
        >
          <View
            style={{
              backgroundColor: colors.surfaceRaised,
              borderRadius: radius.lg,
              padding: spacing['6'],
              alignItems: 'center',
              gap: spacing['3'],
              minWidth: 220,
            }}
          >
            <ActivityIndicator size="large" color={colors.action} />
            <Text style={{ color: colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.semibold }}>
              {busyMessage}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

class AppErrorBoundary extends React.Component<
  { readonly children: React.ReactNode },
  { readonly error: Error | null }
> {
  state: { readonly error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { readonly error: Error } {
    return { error };
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <View style={{ flex: 1, backgroundColor: '#161c24', padding: 24, justifyContent: 'center' }}>
          <Text style={{ color: '#f8fafc', fontSize: 20, fontWeight: '600', marginBottom: 8 }}>
            ZeroVault 运行异常
          </Text>
          <Text style={{ color: '#cbd5e1', fontSize: 14, lineHeight: 20, marginBottom: 16 }}>
            {this.state.error.message || String(this.state.error)}
          </Text>
          <Pressable
            onPress={() => this.setState({ error: null })}
            style={{
              backgroundColor: '#2587a6',
              borderRadius: 10,
              paddingVertical: 12,
              alignItems: 'center',
            }}
          >
            <Text style={{ color: '#ffffff', fontSize: 16, fontWeight: '600' }}>重试</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

export function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <AppErrorBoundary>
        <ThemeProvider>
          <VaultCoordinatorProvider>
            <ZeroVaultShell />
          </VaultCoordinatorProvider>
        </ThemeProvider>
      </AppErrorBoundary>
    </SafeAreaProvider>
  );
}
