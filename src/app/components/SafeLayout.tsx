/**
 * 异形屏 / 刘海屏 / 挖孔屏 / 状态栏与底部手势栏统一安全区布局工具：
 * 结合 react-native-safe-area-context、Android 原生 WindowInsetsCompat（含 DisplayCutout）
 * 与 StatusBar.currentHeight 三层兜底，确保任何机型与弹窗下界面内容永不越过系统顶部状态栏。
 */
import React, { useMemo } from 'react';
import { Platform, StatusBar, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getNativeStorage } from '../../native';
import { useTheme } from '../../theme';

export interface ResolvedInsets {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export function useSafeInsets(): ResolvedInsets {
  const rnInsets = useSafeAreaInsets();
  return useMemo(() => {
    let nativeTop = 0;
    let nativeBottom = 0;
    let nativeLeft = 0;
    let nativeRight = 0;
    try {
      const native = getNativeStorage();
      if (native && typeof native.getSystemInsetsSync === 'function') {
        const raw = native.getSystemInsetsSync();
        nativeTop = Number(raw?.top) || 0;
        nativeBottom = Number(raw?.bottom) || 0;
        nativeLeft = Number(raw?.left) || 0;
        nativeRight = Number(raw?.right) || 0;
      }
    } catch {
      // 回退到 RN insets 与 StatusBar.currentHeight
    }

    const androidFallbackTop = Platform.OS === 'android' ? Math.max(StatusBar.currentHeight ?? 0, 24) : 0;

    return {
      top: Math.ceil(Math.max(rnInsets.top, nativeTop, androidFallbackTop)),
      bottom: Math.ceil(Math.max(rnInsets.bottom, nativeBottom)),
      left: Math.ceil(Math.max(rnInsets.left, nativeLeft)),
      right: Math.ceil(Math.max(rnInsets.right, nativeRight)),
    };
  }, [rnInsets.bottom, rnInsets.left, rnInsets.right, rnInsets.top]);
}

/**
 * 统一规范顶栏：
 * 背景延伸至系统状态栏背后，实际交互区与文字严格位于 insets.top 下方，绝不侵入状态栏或挖孔区。
 */
export function ScreenHeader({
  title,
  subtitle,
  left,
  right,
  includeTopInset = false,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly left?: React.ReactNode;
  readonly right?: React.ReactNode;
  /** 若页面自身处于 Modal 或独立全屏容器未由外层填充顶部安全区，设为 true */
  readonly includeTopInset?: boolean;
}): React.JSX.Element {
  const { colors, spacing, fontSize, fontWeight } = useTheme();
  const insets = useSafeInsets();

  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        paddingTop: includeTopInset ? insets.top : 0,
        paddingLeft: spacing['4'] + insets.left,
        paddingRight: spacing['4'] + insets.right,
      }}
    >
      <View
        style={{
          minHeight: 54,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: spacing['2'],
          paddingVertical: 8,
        }}
      >
        {left ? <View style={{ flexShrink: 0 }}>{left}</View> : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            numberOfLines={1}
            style={{
              color: colors.text,
              fontSize: fontSize.lg,
              fontWeight: fontWeight.semibold,
              lineHeight: 24,
            }}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text
              numberOfLines={1}
              style={{
                color: colors.textMuted,
                fontSize: fontSize.xs,
                marginTop: 2,
              }}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
        {right ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 }}>{right}</View> : null}
      </View>
    </View>
  );
}

/**
 * 规整居中内容容器：平板与横屏保持最佳阅读与表单宽度（maxWidth: 640），并自动避让横屏左右挖孔。
 */
export function ContentFrame({
  children,
  style,
}: {
  readonly children: React.ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  return (
    <View style={[{ width: '100%', maxWidth: 640, alignSelf: 'center' }, style]}>
      {children}
    </View>
  );
}
