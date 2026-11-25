/**
 * WebDAV 版本冲突解决页（ConflictResolveScreen）：
 * 保留关键版本口径（大小与 SHA-256 前缀）与不可逆操作后果，动作简洁明确。
 */
import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { ConflictResolution } from '../../storage';
import { hashBytes } from '../../storage';
import { useTheme } from '../../theme';
import { AlertBanner, Button, MONO_FONT, SectionHeader, SurfaceCard } from '../components/Primitives';
import { ContentFrame, ScreenHeader, useSafeInsets } from '../components/SafeLayout';
import { useVaultCoordinator } from '../state/VaultCoordinator';

export function ConflictResolveScreen({
  onClose,
}: {
  readonly onClose: () => void;
}): React.JSX.Element {
  const { colors, spacing, fontSize } = useTheme();
  const insets = useSafeInsets();
  const { activeProfile, conflict, crypto, resolveConflict } = useVaultCoordinator();
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  if (!conflict || !activeProfile) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader
          title="同步冲突"
          right={<Button label="关闭" variant="ghost" compact onPress={onClose} />}
        />
      </View>
    );
  }

  const localHash = hashBytes(conflict.localBytes, crypto);

  const handleChoose = async (resolution: ConflictResolution) => {
    setErrorText(null);
    setBusy(true);
    try {
      await resolveConflict(resolution);
      onClose();
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title="同步冲突"
        subtitle={activeProfile.name}
        right={<Button label="关闭" variant="ghost" compact onPress={onClose} />}
      />

      <ScrollView
        contentContainerStyle={{
          paddingTop: spacing['4'],
          paddingBottom: spacing['8'],
          paddingLeft: spacing['4'] + insets.left,
          paddingRight: spacing['4'] + insets.right,
        }}
      >
        <ContentFrame style={{ gap: spacing['4'] }}>
          <AlertBanner
            title="双端均已修改"
            message="未自动覆盖。请选择保留或导出策略。"
            tone="danger"
          />

          {errorText ? <AlertBanner title="操作失败" message={errorText} tone="danger" /> : null}

          <SurfaceCard>
            <SectionHeader title="版本摘要 (SHA-256)" />
            <Text style={{ color: colors.textSecondary, fontSize: fontSize.xs }}>
              本地 · {(conflict.localBytes.byteLength / 1024).toFixed(1)} KB
            </Text>
            <Text style={{ color: colors.text, fontFamily: MONO_FONT, fontSize: fontSize.xs, marginTop: 2 }}>
              {localHash.slice(0, 32)}…
            </Text>

            <Text style={{ color: colors.textSecondary, fontSize: fontSize.xs, marginTop: 12 }}>
              远端 · {(conflict.remoteBytes.byteLength / 1024).toFixed(1)} KB
            </Text>
            <Text style={{ color: colors.text, fontFamily: MONO_FONT, fontSize: fontSize.xs, marginTop: 2 }}>
              {conflict.remoteHash.slice(0, 32)}…
            </Text>
          </SurfaceCard>

          <SurfaceCard>
            <SectionHeader title="处理方式" />
            <View style={{ gap: spacing['3'] }}>
              <Button
                label="另存本地副本并采用远端"
                onPress={() => handleChoose('save-local-recovery-then-use-remote')}
                loading={busy}
              />
              <Button
                label="采用远端（放弃本地修改）"
                variant="secondary"
                onPress={() => handleChoose('use-remote-discard-local')}
                disabled={busy}
              />
              <Button
                label="覆盖远端（丢弃远端变更）"
                variant="danger"
                onPress={() => handleChoose('keep-local-overwrite-remote')}
                disabled={busy}
              />
            </View>
          </SurfaceCard>
        </ContentFrame>
      </ScrollView>
    </View>
  );
}
