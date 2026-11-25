/**
 * 强密码与易记词组生成器页（GeneratorScreen）：
 * - 统一 ScreenHeader、SwitchRow 与短动词操作按钮；零技术宣传副标题。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import {
  DEFAULT_PASSPHRASE_OPTIONS,
  DEFAULT_PASSWORD_OPTIONS,
  generatePassphrase,
  generatePassword,
  generatePin,
} from '../../security';
import { useTheme } from '../../theme';
import {
  Button,
  MONO_FONT,
  SectionHeader,
  SegmentTabs,
  SurfaceCard,
  SwitchRow,
} from '../components/Primitives';
import { ContentFrame, ScreenHeader, useSafeInsets } from '../components/SafeLayout';
import { StrengthMeter } from '../components/StrengthMeter';
import { useVaultCoordinator } from '../state/VaultCoordinator';

type GenMode = 'password' | 'passphrase' | 'pin';

function StepperRow({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly onChange: (next: number) => void;
}): React.JSX.Element {
  const { colors, radius, fontSize, fontWeight } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        minHeight: 48,
        paddingVertical: 8,
      }}
    >
      <Text style={{ color: colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.semibold }}>
        {label}：{value}
      </Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable
          accessibilityLabel={`减少${label}`}
          onPress={() => onChange(Math.max(min, value - step))}
          style={{
            minWidth: 44,
            minHeight: 38,
            borderRadius: radius.sm,
            backgroundColor: colors.surfaceSunken,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.semibold }}>−</Text>
        </Pressable>
        <Pressable
          accessibilityLabel={`增加${label}`}
          onPress={() => onChange(Math.min(max, value + step))}
          style={{
            minWidth: 44,
            minHeight: 38,
            borderRadius: radius.sm,
            backgroundColor: colors.surfaceSunken,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.semibold }}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function GeneratorScreen(): React.JSX.Element {
  const { colors, spacing, radius, fontSize } = useTheme();
  const insets = useSafeInsets();
  const { crypto, copySensitive } = useVaultCoordinator();

  const [mode, setMode] = useState<GenMode>('password');
  const [pwdOpts, setPwdOpts] = useState(DEFAULT_PASSWORD_OPTIONS);
  const [phraseOpts, setPhraseOpts] = useState(DEFAULT_PASSPHRASE_OPTIONS);
  const [pinLen, setPinLen] = useState(6);
  const [generated, setGenerated] = useState('');

  const regenerate = useCallback(() => {
    if (mode === 'password') {
      setGenerated(generatePassword(pwdOpts, crypto));
    } else if (mode === 'passphrase') {
      setGenerated(generatePassphrase(phraseOpts, crypto));
    } else {
      setGenerated(generatePin(pinLen, crypto));
    }
  }, [crypto, mode, phraseOpts, pinLen, pwdOpts]);

  useEffect(() => {
    regenerate();
  }, [regenerate]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="生成器" />

      <ScrollView
        contentContainerStyle={{
          paddingTop: spacing['4'],
          paddingBottom: spacing['8'],
          paddingLeft: spacing['4'] + insets.left,
          paddingRight: spacing['4'] + insets.right,
        }}
      >
        <ContentFrame style={{ gap: spacing['4'] }}>
          <SegmentTabs
            items={[
              { key: 'password' as GenMode, label: '密码' },
              { key: 'passphrase' as GenMode, label: '词组' },
              { key: 'pin' as GenMode, label: 'PIN' },
            ]}
            active={mode}
            onChange={setMode}
          />

          <SurfaceCard accentTone="primary">
            <View
              style={{
                backgroundColor: colors.surfaceSunken,
                borderRadius: radius.md,
                padding: spacing['4'],
                minHeight: 82,
                justifyContent: 'center',
              }}
            >
              <Text
                selectable
                style={{
                  color: colors.text,
                  fontSize: fontSize.xl,
                  fontFamily: MONO_FONT,
                  lineHeight: 30,
                  letterSpacing: 0.6,
                }}
              >
                {generated}
              </Text>
            </View>

            <View style={{ marginTop: spacing['3'] }}>
              <StrengthMeter password={generated} />
            </View>

            <View style={{ flexDirection: 'row', gap: spacing['3'], marginTop: spacing['4'] }}>
              <Button label="复制" onPress={() => copySensitive(generated, '密码')} style={{ flex: 1 }} />
              <Button label="刷新" variant="secondary" onPress={regenerate} />
            </View>
          </SurfaceCard>

          <SurfaceCard>
            <SectionHeader title="参数" />
            {mode === 'password' ? (
              <>
                <StepperRow
                  label="长度"
                  value={pwdOpts.length}
                  min={8}
                  max={64}
                  step={2}
                  onChange={(length) => setPwdOpts((p) => ({ ...p, length }))}
                />
                <SwitchRow
                  label="大写 (A-Z)"
                  value={pwdOpts.uppercase}
                  onValueChange={(uppercase) => setPwdOpts((p) => ({ ...p, uppercase }))}
                  topDivider
                />
                <SwitchRow
                  label="小写 (a-z)"
                  value={pwdOpts.lowercase}
                  onValueChange={(lowercase) => setPwdOpts((p) => ({ ...p, lowercase }))}
                  topDivider
                />
                <SwitchRow
                  label="数字 (0-9)"
                  value={pwdOpts.digits}
                  onValueChange={(digits) => setPwdOpts((p) => ({ ...p, digits }))}
                  topDivider
                />
                <SwitchRow
                  label="符号 (!@#$%…)"
                  value={pwdOpts.symbols}
                  onValueChange={(symbols) => setPwdOpts((p) => ({ ...p, symbols }))}
                  topDivider
                />
                <SwitchRow
                  label="排除易混淆字符 (0 O o 1 l I |)"
                  value={pwdOpts.excludeAmbiguous}
                  onValueChange={(excludeAmbiguous) => setPwdOpts((p) => ({ ...p, excludeAmbiguous }))}
                  topDivider
                />
              </>
            ) : null}

            {mode === 'passphrase' ? (
              <>
                <StepperRow
                  label="词数"
                  value={phraseOpts.wordCount}
                  min={3}
                  max={10}
                  onChange={(wordCount) => setPhraseOpts((p) => ({ ...p, wordCount }))}
                />
                <SwitchRow
                  label="首字母大写"
                  value={phraseOpts.capitalize}
                  onValueChange={(capitalize) => setPhraseOpts((p) => ({ ...p, capitalize }))}
                  topDivider
                />
                <SwitchRow
                  label="包含数字"
                  value={phraseOpts.includeNumber}
                  onValueChange={(includeNumber) => setPhraseOpts((p) => ({ ...p, includeNumber }))}
                  topDivider
                />
                <View style={{ paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border }}>
                  <SectionHeader title="分隔符" />
                  <SegmentTabs
                    items={[
                      { key: '-', label: '-' },
                      { key: '.', label: '.' },
                      { key: '_', label: '_' },
                      { key: ' ', label: '空格' },
                    ]}
                    active={phraseOpts.separator}
                    onChange={(separator) => setPhraseOpts((p) => ({ ...p, separator }))}
                  />
                </View>
              </>
            ) : null}

            {mode === 'pin' ? (
              <StepperRow label="位数" value={pinLen} min={4} max={16} onChange={setPinLen} />
            ) : null}
          </SurfaceCard>
        </ContentFrame>
      </ScrollView>
    </View>
  );
}
