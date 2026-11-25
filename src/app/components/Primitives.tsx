/**
 * ZeroVault 语义化基础 UI 原语（遵循 Refactoring UI 规则与极简文案密度规范）：
 * - 仅消费 ThemeColors 语义令牌；
 * - 表单组内距 6px < 组间距 18px；所有可交互行最小高度 46-48dp；
 * - 统一 SwitchRow、ListRow、Button、SurfaceCard、Badge、AlertBanner、EmptyState。
 */
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type ReturnKeyTypeOptions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme';

export const MONO_FONT = Platform.select({ android: 'monospace', ios: 'Menlo', default: 'monospace' });

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost';

export interface ButtonProps {
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: ButtonVariant;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly compact?: boolean;
  readonly style?: StyleProp<ViewStyle>;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  compact = false,
  style,
}: ButtonProps): React.JSX.Element {
  const { colors, radius, fontSize, fontWeight, spacing } = useTheme();
  const isDisabled = disabled || loading;

  const getContainerStyle = (pressed: boolean): ViewStyle => {
    const base: ViewStyle = {
      minHeight: compact ? 38 : 46,
      paddingHorizontal: compact ? spacing['3'] : spacing['4'],
      paddingVertical: compact ? 8 : 11,
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      opacity: isDisabled ? 0.45 : pressed ? 0.85 : 1,
    };
    switch (variant) {
      case 'primary':
        return { ...base, backgroundColor: pressed ? colors.actionPressed : colors.action };
      case 'secondary':
        return {
          ...base,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.borderStrong,
        };
      case 'danger':
        return { ...base, backgroundColor: colors.danger };
      case 'danger-ghost':
      case 'ghost':
        return { ...base, backgroundColor: 'transparent', paddingHorizontal: compact ? 8 : 12 };
    }
  };

  const textColor =
    variant === 'primary'
      ? colors.actionText
      : variant === 'danger'
        ? colors.dangerText
        : variant === 'danger-ghost'
          ? colors.danger
          : variant === 'ghost'
            ? colors.action
            : colors.text;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [getContainerStyle(pressed), style]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={textColor} />
      ) : (
        <Text
          style={{
            color: textColor,
            fontSize: compact ? fontSize.sm : fontSize.base,
            fontWeight: fontWeight.semibold,
          }}
          numberOfLines={1}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export function SurfaceCard({
  children,
  accentTone,
  style,
}: {
  readonly children: React.ReactNode;
  readonly accentTone?: Tone;
  readonly style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const { colors, radius, spacing } = useTheme();
  const accentColor =
    accentTone === 'danger'
      ? colors.danger
      : accentTone === 'warning'
        ? colors.warning
        : accentTone === 'success'
          ? colors.success
          : accentTone === 'info'
            ? colors.info
            : accentTone === 'primary'
              ? colors.action
              : undefined;

  return (
    <View
      style={[
        {
          backgroundColor: colors.surface,
          borderRadius: radius.lg,
          padding: spacing['4'],
          ...(accentColor ? { borderLeftWidth: 4, borderLeftColor: accentColor } : {}),
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Badge({
  label,
  tone = 'neutral',
}: {
  readonly label: string;
  readonly tone?: Tone;
}): React.JSX.Element {
  const { colors, radius, fontSize, fontWeight } = useTheme();
  const map: Record<Tone, { bg: string; fg: string }> = {
    neutral: { bg: colors.surfaceSunken, fg: colors.textSecondary },
    primary: { bg: colors.actionSubtle, fg: colors.actionSubtleText },
    success: { bg: colors.successSubtle, fg: colors.successSubtleText },
    warning: { bg: colors.warningSubtle, fg: colors.warningSubtleText },
    danger: { bg: colors.dangerSubtle, fg: colors.dangerSubtleText },
    info: { bg: colors.infoSubtle, fg: colors.infoSubtleText },
  };
  const palette = map[tone];
  return (
    <View
      style={{
        backgroundColor: palette.bg,
        borderRadius: radius.full,
        paddingHorizontal: 10,
        paddingVertical: 3,
        alignSelf: 'flex-start',
      }}
    >
      <Text
        numberOfLines={1}
        style={{
          color: palette.fg,
          fontSize: fontSize.xs,
          fontWeight: fontWeight.semibold,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

export function AlertBanner({
  title,
  message,
  tone = 'info',
  actionLabel,
  onAction,
}: {
  readonly title: string;
  readonly message: string;
  readonly tone?: Exclude<Tone, 'neutral' | 'primary'>;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}): React.JSX.Element {
  const { colors, radius, spacing, fontSize, fontWeight } = useTheme();
  const palette = {
    info: { bg: colors.infoSubtle, fg: colors.infoSubtleText, bar: colors.info },
    success: { bg: colors.successSubtle, fg: colors.successSubtleText, bar: colors.success },
    warning: { bg: colors.warningSubtle, fg: colors.warningSubtleText, bar: colors.warning },
    danger: { bg: colors.dangerSubtle, fg: colors.dangerSubtleText, bar: colors.danger },
  }[tone];

  return (
    <View
      accessibilityRole="alert"
      style={{
        backgroundColor: palette.bg,
        borderLeftWidth: 4,
        borderLeftColor: palette.bar,
        borderRadius: radius.md,
        padding: spacing['3'],
        gap: 4,
      }}
    >
      <Text style={{ color: palette.fg, fontSize: fontSize.sm, fontWeight: fontWeight.semibold }}>
        {title}
      </Text>
      <Text style={{ color: palette.fg, fontSize: fontSize.sm, lineHeight: 20 }}>{message}</Text>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} style={{ marginTop: 4, alignSelf: 'flex-start', paddingVertical: 4 }}>
          <Text
            style={{
              color: palette.fg,
              fontSize: fontSize.sm,
              fontWeight: fontWeight.semibold,
              textDecorationLine: 'underline',
            }}
          >
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export interface FormFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (text: string) => void;
  readonly placeholder?: string;
  readonly error?: string;
  readonly secure?: boolean;
  readonly monospace?: boolean;
  readonly multiline?: boolean;
  readonly autoFocus?: boolean;
  readonly returnKeyType?: ReturnKeyTypeOptions;
  readonly onSubmitEditing?: () => void;
  readonly keyboardType?: KeyboardTypeOptions;
  readonly autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  readonly rightAction?: { readonly label: string; readonly onPress: () => void };
}

export function FormField({
  label,
  value,
  onChangeText,
  placeholder,
  error,
  secure = false,
  monospace = false,
  multiline = false,
  autoFocus = false,
  returnKeyType,
  onSubmitEditing,
  keyboardType,
  autoCapitalize = 'none',
  rightAction,
}: FormFieldProps): React.JSX.Element {
  const { colors, radius, fontSize, fontWeight } = useTheme();
  const [revealed, setRevealed] = useState(false);

  return (
    <View style={styles.fieldGroup}>
      <View style={styles.fieldLabelRow}>
        <Text style={{ color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: fontWeight.semibold }}>
          {label}
        </Text>
        <View style={styles.fieldLabelActions}>
          {secure ? (
            <Pressable onPress={() => setRevealed((v) => !v)} hitSlop={8}>
              <Text style={{ color: colors.action, fontSize: fontSize.xs, fontWeight: fontWeight.semibold }}>
                {revealed ? '隐藏' : '显示'}
              </Text>
            </Pressable>
          ) : null}
          {rightAction ? (
            <Pressable onPress={rightAction.onPress} hitSlop={8}>
              <Text style={{ color: colors.action, fontSize: fontSize.xs, fontWeight: fontWeight.semibold }}>
                {rightAction.label}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        secureTextEntry={secure && !revealed}
        multiline={multiline}
        autoFocus={autoFocus}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        style={{
          backgroundColor: colors.surfaceSunken,
          color: colors.text,
          borderColor: error ? colors.danger : colors.borderStrong,
          borderWidth: 1,
          borderRadius: radius.md,
          paddingHorizontal: 14,
          paddingVertical: multiline ? 12 : 10,
          minHeight: multiline ? 92 : 46,
          fontSize: fontSize.base,
          fontFamily: monospace ? MONO_FONT : undefined,
          textAlignVertical: multiline ? 'top' : 'center',
        }}
      />
      {error ? (
        <Text style={{ color: colors.danger, fontSize: fontSize.xs, marginTop: 4 }}>{error}</Text>
      ) : null}
    </View>
  );
}

export function SwitchRow({
  label,
  note,
  value,
  onValueChange,
  disabled = false,
  tone = 'primary',
  topDivider = false,
}: {
  readonly label: string;
  readonly note?: string;
  readonly value: boolean;
  readonly onValueChange: (next: boolean) => void;
  readonly disabled?: boolean;
  readonly tone?: 'primary' | 'warning';
  readonly topDivider?: boolean;
}): React.JSX.Element {
  const { colors, fontSize, fontWeight } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        minHeight: 48,
        paddingVertical: 8,
        gap: 12,
        ...(topDivider ? { borderTopWidth: 1, borderTopColor: colors.border } : {}),
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.semibold }}>
          {label}
        </Text>
        {note ? (
          <Text
            style={{
              color: tone === 'warning' ? colors.warning : colors.textMuted,
              fontSize: fontSize.xs,
              marginTop: 2,
            }}
          >
            {note}
          </Text>
        ) : null}
      </View>
      <Switch
        disabled={disabled}
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: colors.borderStrong, true: tone === 'warning' ? colors.warning : colors.action }}
      />
    </View>
  );
}

export function SectionHeader({
  title,
  right,
  actionLabel,
  onAction,
}: {
  readonly title: string;
  readonly right?: React.ReactNode;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}): React.JSX.Element {
  const { colors, fontSize, fontWeight } = useTheme();
  return (
    <View style={styles.sectionHeader}>
      <Text
        numberOfLines={1}
        style={{
          color: colors.textMuted,
          fontSize: fontSize.xs,
          fontWeight: fontWeight.semibold,
          letterSpacing: 0.5,
          flexShrink: 1,
        }}
      >
        {title}
      </Text>
      {right ? (
        <View style={{ flexShrink: 0 }}>{right}</View>
      ) : actionLabel && onAction ? (
        <Pressable onPress={onAction} hitSlop={8}>
          <Text style={{ color: colors.action, fontSize: fontSize.xs, fontWeight: fontWeight.semibold }}>
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function EmptyState({
  iconNode,
  symbol,
  title,
  description,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
}: {
  readonly iconNode?: React.ReactNode;
  readonly symbol?: string;
  readonly title: string;
  readonly description?: string;
  readonly primaryLabel?: string;
  readonly onPrimary?: () => void;
  readonly secondaryLabel?: string;
  readonly onSecondary?: () => void;
}): React.JSX.Element {
  const { colors, radius, spacing, fontSize, fontWeight } = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingVertical: spacing['8'], paddingHorizontal: spacing['4'] }}>
      {iconNode ? (
        <View style={{ marginBottom: spacing['4'] }}>{iconNode}</View>
      ) : symbol ? (
        <View
          style={{
            width: 56,
            height: 56,
            borderRadius: radius.full,
            backgroundColor: colors.actionSubtle,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: spacing['4'],
          }}
        >
          <Text style={{ color: colors.actionSubtleText, fontSize: 22, fontWeight: fontWeight.semibold }}>
            {symbol}
          </Text>
        </View>
      ) : null}
      <Text
        style={{
          color: colors.text,
          fontSize: fontSize.lg,
          fontWeight: fontWeight.semibold,
          textAlign: 'center',
          marginBottom: description ? spacing['2'] : spacing['6'],
        }}
      >
        {title}
      </Text>
      {description ? (
        <Text
          style={{
            color: colors.textSecondary,
            fontSize: fontSize.sm,
            textAlign: 'center',
            lineHeight: 20,
            maxWidth: 300,
            marginBottom: spacing['6'],
          }}
        >
          {description}
        </Text>
      ) : null}
      {primaryLabel && onPrimary ? (
        <Button label={primaryLabel} onPress={onPrimary} style={{ minWidth: 200 }} />
      ) : null}
      {secondaryLabel && onSecondary ? (
        <Button label={secondaryLabel} variant="ghost" onPress={onSecondary} style={{ marginTop: spacing['2'] }} />
      ) : null}
    </View>
  );
}

export function SegmentTabs<T extends string>({
  items,
  active,
  onChange,
}: {
  readonly items: ReadonlyArray<{ readonly key: T; readonly label: string }>;
  readonly active: T;
  readonly onChange: (key: T) => void;
}): React.JSX.Element {
  const { colors, radius, fontSize, fontWeight } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: colors.surfaceSunken,
        borderRadius: radius.md,
        padding: 4,
        gap: 4,
      }}
    >
      {items.map((item) => {
        const selected = item.key === active;
        return (
          <Pressable
            key={item.key}
            onPress={() => onChange(item.key)}
            style={{
              flex: 1,
              minHeight: 38,
              borderRadius: radius.sm,
              backgroundColor: selected ? colors.surface : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: 8,
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                color: selected ? colors.text : colors.textMuted,
                fontSize: fontSize.sm,
                fontWeight: selected ? fontWeight.semibold : fontWeight.regular,
              }}
            >
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  fieldGroup: {
    marginBottom: 18,
  },
  fieldLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  fieldLabelActions: {
    flexDirection: 'row',
    gap: 14,
    alignItems: 'center',
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    gap: 8,
  },
});
