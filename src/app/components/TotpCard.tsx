/**
 * 实时 TOTP 一次性验证码卡片（RFC 6238）：
 * - 视觉排序：Primary = 6/8 位等宽验证码，Secondary = 剩余秒数与倒计时条，Tertiary = 签发方标签
 * - 临近刷新（<=5 秒）同步切换 danger 语义色与文字提示，不单靠颜色。
 */
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { computeTotp, createFallbackCryptoProvider, type TotpConfig } from '../../kdbx';
import { useTheme } from '../../theme';
import { MONO_FONT, SurfaceCard } from './Primitives';

const totpCrypto = createFallbackCryptoProvider();

function formatOtpCode(code: string): string {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  return code;
}

export function TotpCard({
  config,
  onCopy,
}: {
  readonly config: TotpConfig;
  readonly onCopy: (code: string) => void;
}): React.JSX.Element {
  const { colors, radius, fontSize, fontWeight } = useTheme();
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  const result = computeTotp(config, totpCrypto, tick);
  const ratio = Math.max(0, Math.min(1, result.remainingSeconds / result.period));
  const expiring = result.remainingSeconds <= 5;
  const barColor = expiring ? colors.danger : colors.action;

  return (
    <SurfaceCard accentTone={expiring ? 'danger' : 'info'}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.textMuted, fontSize: fontSize.xs, fontWeight: fontWeight.semibold }}>
            TOTP{result.issuer ? ` · ${result.issuer}` : ''}
          </Text>
          <Text
            style={{
              color: expiring ? colors.danger : colors.text,
              fontSize: fontSize['2xl'],
              fontWeight: fontWeight.semibold,
              fontFamily: MONO_FONT,
              letterSpacing: 2,
              marginTop: 4,
            }}
          >
            {formatOtpCode(result.code)}
          </Text>
        </View>

        <Pressable
          onPress={() => onCopy(result.code)}
          style={{
            backgroundColor: colors.actionSubtle,
            borderRadius: radius.md,
            paddingHorizontal: 14,
            minHeight: 44,
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <Text style={{ color: colors.actionSubtleText, fontSize: fontSize.sm, fontWeight: fontWeight.semibold }}>
            复制
          </Text>
        </Pressable>
      </View>

      <View
        style={{
          height: 5,
          backgroundColor: colors.surfaceSunken,
          borderRadius: radius.full,
          marginTop: 12,
          overflow: 'hidden',
        }}
      >
        <View style={{ height: '100%', width: `${Math.round(ratio * 100)}%`, backgroundColor: barColor }} />
      </View>
      <Text style={{ color: expiring ? colors.danger : colors.textMuted, fontSize: fontSize.xs, marginTop: 6 }}>
        {result.remainingSeconds}s
      </Text>
    </SurfaceCard>
  );
}
