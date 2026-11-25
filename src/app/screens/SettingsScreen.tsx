/**
 * 安全与系统设置页（SettingsScreen）：
 * - 修复原卡片头错位问题，全部开关采用统一 SwitchRow；
 * - 零功能解释段落；支持切换启动默认密码库；底部紧凑展示 BrandLogo 与版本号。
 */
import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { AUTO_LOCK_OPTIONS, CLIPBOARD_CLEAR_OPTIONS } from '../../security';
import { useTheme, type ThemeMode } from '../../theme';
import { BrandLogo } from '../components/BrandLogo';
import {
  Badge,
  Button,
  SectionHeader,
  SegmentTabs,
  SurfaceCard,
  SwitchRow,
} from '../components/Primitives';
import { ContentFrame, ScreenHeader, useSafeInsets } from '../components/SafeLayout';
import { useVaultCoordinator } from '../state/VaultCoordinator';

export function SettingsScreen({
  onOpenSourceSetup,
}: {
  readonly onOpenSourceSetup: (initialTab?: 'webdav' | 'local' | 'create') => void;
}): React.JSX.Element {
  const { colors, spacing, radius, fontSize, fontWeight, mode, setMode } = useTheme();
  const insets = useSafeInsets();
  const {
    profiles,
    defaultProfile,
    activeProfile,
    vaultMeta,
    biometricCapability,
    autofillEnabled,
    securityPrefs,
    enableBiometricForActiveVault,
    disableBiometricForActiveVault,
    updateSecurityPrefs,
    openAutofillSettings,
    selectProfile,
    setDefaultProfile,
    removeProfile,
    lockVault,
    showToast,
  } = useVaultCoordinator();

  const [bioBusy, setBioBusy] = useState(false);

  const handleToggleBiometric = async (enable: boolean) => {
    setBioBusy(true);
    try {
      if (enable) {
        await enableBiometricForActiveVault();
      } else {
        await disableBiometricForActiveVault();
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      setBioBusy(false);
    }
  };

  const handleRemoveProfile = (id: string, name: string) => {
    Alert.alert(
      '移除密码库',
      `移除「${name}」会清除本地缓存与硬件密钥，不影响原 SAF 或 WebDAV 文件。`,
      [
        { text: '取消', style: 'cancel' },
        { text: '移除', style: 'destructive', onPress: () => removeProfile(id) },
      ],
    );
  };

  const bioBadge = !biometricCapability.available
    ? { label: '不可用', tone: 'neutral' as const }
    : biometricCapability.strongBoxSupported
      ? { label: 'StrongBox', tone: 'success' as const }
      : { label: 'TEE', tone: 'primary' as const };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="设置" />

      <ScrollView
        contentContainerStyle={{
          paddingTop: spacing['4'],
          paddingBottom: spacing['8'],
          paddingLeft: spacing['4'] + insets.left,
          paddingRight: spacing['4'] + insets.right,
        }}
      >
        <ContentFrame style={{ gap: spacing['4'] }}>
          {/* 1. 生物识别与硬件安全 */}
          <SurfaceCard accentTone={activeProfile?.biometricEnabled ? 'success' : 'primary'}>
            <SectionHeader title="生物识别" right={<Badge label={bioBadge.label} tone={bioBadge.tone} />} />
            <SwitchRow
              label="指纹 / 面容解锁"
              disabled={!biometricCapability.available || bioBusy || !activeProfile}
              value={Boolean(activeProfile?.biometricEnabled)}
              onValueChange={handleToggleBiometric}
            />
          </SurfaceCard>

          {/* 2. Android 系统自动填充 */}
          <SurfaceCard>
            <SectionHeader
              title="系统自动填充"
              right={
                <Badge
                  label={autofillEnabled ? '已启用' : '未启用'}
                  tone={autofillEnabled ? 'success' : 'warning'}
                />
              }
            />
            <SwitchRow
              label="同步已解锁凭据"
              value={securityPrefs.autofillSyncEnabled}
              onValueChange={(autofillSyncEnabled) => updateSecurityPrefs({ autofillSyncEnabled })}
            />
            <View style={{ marginTop: spacing['3'] }}>
              <Button
                label={autofillEnabled ? '系统设置' : '启用服务'}
                variant={autofillEnabled ? 'secondary' : 'primary'}
                onPress={openAutofillSettings}
              />
            </View>
          </SurfaceCard>

          {/* 3. 锁定与隐私 */}
          <SurfaceCard>
            <SectionHeader title="安全与隐私" />
            <SwitchRow
              label="防截屏 (FLAG_SECURE)"
              value={securityPrefs.secureScreenEnabled}
              onValueChange={(secureScreenEnabled) => updateSecurityPrefs({ secureScreenEnabled })}
            />

            <View style={{ marginTop: 10, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border }}>
              <Text style={{ color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: fontWeight.semibold, marginBottom: 8 }}>
                自动锁定
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {AUTO_LOCK_OPTIONS.map((opt) => {
                  const selected = securityPrefs.autoLockTimeoutMs === opt.value;
                  return (
                    <Pressable
                      key={opt.value}
                      onPress={() => updateSecurityPrefs({ autoLockTimeoutMs: opt.value })}
                      style={{
                        backgroundColor: selected ? colors.action : colors.surfaceSunken,
                        borderRadius: radius.full,
                        paddingHorizontal: 12,
                        paddingVertical: 7,
                      }}
                    >
                      <Text
                        style={{
                          color: selected ? colors.actionText : colors.textSecondary,
                          fontSize: fontSize.xs,
                          fontWeight: fontWeight.semibold,
                        }}
                      >
                        {opt.label.replace('（推荐）', '')}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={{ marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border }}>
              <Text style={{ color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: fontWeight.semibold, marginBottom: 8 }}>
                剪贴板自动清除
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {CLIPBOARD_CLEAR_OPTIONS.map((opt) => {
                  const selected = securityPrefs.clipboardClearMs === opt.value;
                  return (
                    <Pressable
                      key={opt.value}
                      onPress={() => updateSecurityPrefs({ clipboardClearMs: opt.value })}
                      style={{
                        backgroundColor: selected ? colors.action : colors.surfaceSunken,
                        borderRadius: radius.full,
                        paddingHorizontal: 12,
                        paddingVertical: 7,
                      }}
                    >
                      <Text
                        style={{
                          color: selected ? colors.actionText : colors.textSecondary,
                          fontSize: fontSize.xs,
                          fontWeight: fontWeight.semibold,
                        }}
                      >
                        {opt.label.replace('（推荐）', '')}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          </SurfaceCard>

          {/* 4. 外观 */}
          <SurfaceCard>
            <SectionHeader title="外观" />
            <SegmentTabs
              items={[
                { key: 'system' as ThemeMode, label: '跟随系统' },
                { key: 'light' as ThemeMode, label: '浅色' },
                { key: 'dark' as ThemeMode, label: '深色' },
              ]}
              active={mode}
              onChange={setMode}
            />
          </SurfaceCard>

          {/* 5. 密码库管理 */}
          <SurfaceCard>
            <SectionHeader
              title={`密码库 (${profiles.length})`}
              actionLabel="+ 添加"
              onAction={() => onOpenSourceSetup('webdav')}
            />
            {vaultMeta ? (
              <Text style={{ color: colors.textMuted, fontSize: fontSize.xs, marginBottom: 8 }}>
                KDBX {vaultMeta.format.version} · {vaultMeta.format.cipher.toUpperCase()} · {vaultMeta.format.kdf.toUpperCase()}
              </Text>
            ) : null}

            {profiles.map((p) => {
              const isCurrent = p.id === activeProfile?.id;
              const isDef = defaultProfile?.id === p.id;
              return (
                <View
                  key={p.id}
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    minHeight: 54,
                    paddingVertical: 10,
                    borderTopWidth: 1,
                    borderTopColor: colors.border,
                    gap: 8,
                  }}
                >
                  <Pressable onPress={() => selectProfile(p.id)} style={{ flex: 1, minWidth: 0 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text numberOfLines={1} style={{ color: colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.semibold, flexShrink: 1 }}>
                        {p.name}
                      </Text>
                      {isDef ? <Badge label="默认" tone="primary" /> : null}
                      {isCurrent && !isDef ? <Badge label="当前" tone="neutral" /> : null}
                    </View>
                    <Text numberOfLines={1} style={{ color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 }}>
                      {p.sourceKind === 'webdav' ? p.webdav?.url : p.localFileName}
                    </Text>
                  </Pressable>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    {!isDef ? (
                      <Button label="设默认" variant="ghost" compact onPress={() => setDefaultProfile(p.id)} />
                    ) : null}
                    <Button
                      label="移除"
                      variant="danger-ghost"
                      compact
                      onPress={() => handleRemoveProfile(p.id, p.name)}
                    />
                  </View>
                </View>
              );
            })}

            <View style={{ marginTop: spacing['3'] }}>
              <Button label="锁定" variant="secondary" onPress={() => lockVault(false)} />
            </View>
          </SurfaceCard>

          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: spacing['2'] }}>
            <BrandLogo size={24} />
            <Text style={{ color: colors.textMuted, fontSize: fontSize.xs }}>ZeroVault 0.1.3</Text>
          </View>
        </ContentFrame>
      </ScrollView>
    </View>
  );
}
