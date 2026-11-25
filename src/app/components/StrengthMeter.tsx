/**
 * 密码熵值与强度可视化仪表（纯语义色 + 文本等级双重信号）。
 */
import React from 'react';
import { Text, View } from 'react-native';
import { evaluatePasswordStrength } from '../../security';
import { useTheme } from '../../theme';

export function StrengthMeter({ password }: { readonly password: string }): React.JSX.Element {
  const { colors, radius, fontSize, fontWeight } = useTheme();
  const report = evaluatePasswordStrength(password);
  const activeSegments =
    report.level === 'very-weak'
      ? 1
      : report.level === 'weak'
        ? 2
        : report.level === 'fair'
          ? 3
          : report.level === 'strong'
            ? 4
            : 5;

  const toneColor =
    report.level === 'very-weak' || report.level === 'weak'
      ? colors.danger
      : report.level === 'fair'
        ? colors.warning
        : colors.success;

  return (
    <View style={{ marginTop: 4 }}>
      <View style={{ flexDirection: 'row', gap: 5 }}>
        {[1, 2, 3, 4, 5].map((idx) => (
          <View
            key={idx}
            style={{
              flex: 1,
              height: 5,
              borderRadius: radius.full,
              backgroundColor: idx <= activeSegments && password.length > 0 ? toneColor : colors.surfaceSunken,
            }}
          />
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
        <Text style={{ color: password.length > 0 ? toneColor : colors.textMuted, fontSize: fontSize.xs, fontWeight: fontWeight.semibold }}>
          强度：{report.label}（{report.score}/100）
        </Text>
        <Text style={{ color: colors.textMuted, fontSize: fontSize.xs }}>{report.entropyBits} bits 熵</Text>
      </View>
      {report.warnings.length > 0 ? (
        <Text style={{ color: colors.textMuted, fontSize: fontSize.xs, marginTop: 4 }}>
          {report.warnings[0]}
        </Text>
      ) : null}
    </View>
  );
}
