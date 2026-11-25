/**
 * 解锁门户页（UnlockScreen）：
 * 层级约束：
 * - Primary：默认密码库自动唤起解锁（生物识别自动弹窗 / 无密码直解 / 主密码自动聚焦）与唯一主按钮
 * - Secondary：多库切换列表（可切换与设为默认库）
 * - Tertiary：状态徽标（WebDAV / 本地 / 远程密钥 / StrongBox / 冲突），零冗余解释文案。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { BrandLogo } from '../components/BrandLogo';
import {
  AlertBanner,
  Badge,
  Button,
  EmptyState,
  FormField,
  SectionHeader,
  SurfaceCard,
  SwitchRow,
} from '../components/Primitives';
import { ContentFrame, useSafeInsets } from '../components/SafeLayout';
import { useVaultCoordinator } from '../state/VaultCoordinator';

export function UnlockScreen({
  onOpenSourceSetup,
}: {
  readonly onOpenSourceSetup: (initialTab?: 'webdav' | 'local' | 'create') => void;
}): React.JSX.Element {
  const { colors, spacing, radius, fontSize, fontWeight } = useTheme();
  const insets = useSafeInsets();
  const {
    profiles,
    defaultProfile,
    activeProfile,
    autoUnlockNonce,
    biometricCapability,
    selectProfile,
    setDefaultProfile,
    unlockVault,
    unlockWithBiometric,
  } = useVaultCoordinator();

  const [password, setPassword] = useState('');
  const [noPasswordComponent, setNoPasswordComponent] = useState(false);
  const [webdavPassword, setWebdavPassword] = useState('');
  const [remoteKeyPassword, setRemoteKeyPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const lastHandledNonceRef = useRef(0);

  useEffect(() => {
    setPassword('');
    setWebdavPassword('');
    setRemoteKeyPassword('');
    setErrorText(null);
    if (activeProfile) {
      setNoPasswordComponent(
        activeProfile.keyFileSource.kind !== 'none' && activeProfile.lastPasswordMode === 'no-password',
      );
    }
  }, [activeProfile?.id]);

  // 启动 App 或超时锁库回前台时，自动唤起默认密码库解锁（防重复弹窗）
  useEffect(() => {
    if (autoUnlockNonce <= 0 || autoUnlockNonce === lastHandledNonceRef.current) return;
    const target = activeProfile ?? defaultProfile;
    if (!target) return;
    lastHandledNonceRef.current = autoUnlockNonce;

    const timer = setTimeout(() => {
      // 1. 已绑定生物识别且设备可用 -> 自动弹出系统 BiometricPrompt
      if (target.biometricEnabled && biometricCapability.available) {
        setSubmitting(true);
        unlockWithBiometric(target.id)
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes('取消') && !msg.includes('CANCELED')) {
              setErrorText(msg);
            }
          })
          .finally(() => setSubmitting(false));
        return;
      }

      // 2. 无密码组件（仅密钥）或空密码库，且所需 WebDAV 凭据已就绪 -> 自动尝试直接解锁
      const davReady = target.sourceKind !== 'webdav' || target.hasCachedWebDavPassword;
      const keyReady =
        target.keyFileSource.kind !== 'webdav' ||
        target.hasCachedRemoteKeyFile ||
        target.hasCachedWebDavPassword;
      if (
        davReady &&
        keyReady &&
        (target.lastPasswordMode === 'no-password' || target.lastPasswordMode === 'empty-password')
      ) {
        setSubmitting(true);
        unlockVault({
          profileId: target.id,
          password: target.lastPasswordMode === 'no-password' ? null : '',
          probeEmptyPasswordWithKeyFile: target.keyFileSource.kind !== 'none',
          rememberSecretsInKeystore: true,
        })
          .catch((err) => {
            setErrorText(err instanceof Error ? err.message : String(err));
          })
          .finally(() => setSubmitting(false));
      }
    }, 180);

    return () => clearTimeout(timer);
  }, [activeProfile, autoUnlockNonce, biometricCapability.available, defaultProfile, unlockVault, unlockWithBiometric]);

  if (profiles.length === 0 || !activeProfile) {
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          paddingHorizontal: spacing['6'] + Math.max(insets.left, insets.right),
          paddingVertical: spacing['6'],
        }}
      >
        <ContentFrame style={{ maxWidth: 360 }}>
          <EmptyState
            iconNode={<BrandLogo size={76} />}
            title="ZeroVault"
            primaryLabel="连接 WebDAV"
            onPrimary={() => onOpenSourceSetup('webdav')}
          />
          <View style={{ gap: spacing['3'] }}>
            <Button label="打开本地文件" variant="secondary" onPress={() => onOpenSourceSetup('local')} />
            <Button label="新建密码库" variant="ghost" onPress={() => onOpenSourceSetup('create')} />
          </View>
        </ContentFrame>
      </ScrollView>
    );
  }

  const hasKeyFile = activeProfile.keyFileSource.kind !== 'none';
  const needWebDavPassword =
    activeProfile.sourceKind === 'webdav' && !activeProfile.hasCachedWebDavPassword;
  const needSeparateKeyDavPwd =
    activeProfile.keyFileSource.kind === 'webdav' &&
    !activeProfile.keyFileSource.useSameAuthAsVault &&
    !activeProfile.hasCachedRemoteKeyFile &&
    !activeProfile.hasCachedWebDavPassword;
  const showBiometricPrimary = activeProfile.biometricEnabled && biometricCapability.available;

  const handleUnlock = async () => {
    setErrorText(null);
    setSubmitting(true);
    try {
      await unlockVault({
        profileId: activeProfile.id,
        password: noPasswordComponent ? null : password,
        probeEmptyPasswordWithKeyFile: hasKeyFile && password.length === 0,
        webdavPassword: webdavPassword || undefined,
        remoteKeyWebdavPassword: remoteKeyPassword || undefined,
        rememberSecretsInKeystore: true,
      });
      setPassword('');
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleBiometric = async () => {
    setErrorText(null);
    setSubmitting(true);
    try {
      await unlockWithBiometric(activeProfile.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('取消') && !msg.includes('CANCELED')) {
        setErrorText(msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{
        paddingTop: spacing['4'],
        paddingBottom: spacing['8'],
        paddingLeft: spacing['4'] + insets.left,
        paddingRight: spacing['4'] + insets.right,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <ContentFrame style={{ gap: spacing['4'] }}>
        {/* 紧凑品牌顶栏 */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing['3'] }}>
            <BrandLogo size={40} />
            <Text style={{ color: colors.text, fontSize: fontSize.xl, fontWeight: fontWeight.semibold }}>
              ZeroVault
            </Text>
          </View>
          <Button label="+ 添加" variant="ghost" compact onPress={() => onOpenSourceSetup('webdav')} />
        </View>

        {/* 当前密码库状态与解锁卡 */}
        <SurfaceCard accentTone="primary">
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <Text
              numberOfLines={1}
              style={{ color: colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.semibold, flex: 1 }}
            >
              {activeProfile.name}
            </Text>
            <Badge
              label={activeProfile.sourceKind === 'webdav' ? 'WebDAV' : '本地'}
              tone={activeProfile.sourceKind === 'webdav' ? 'info' : 'primary'}
            />
          </View>

          <Text numberOfLines={1} style={{ color: colors.textMuted, fontSize: fontSize.xs, marginTop: 4 }}>
            {activeProfile.sourceKind === 'webdav'
              ? activeProfile.webdav?.url
              : activeProfile.localFileName || activeProfile.localSafUri}
          </Text>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
            {defaultProfile?.id === activeProfile.id ? <Badge label="默认" tone="primary" /> : null}
            {activeProfile.keyFileSource.kind === 'webdav' ? (
              <Badge label={`远程密钥 · ${activeProfile.keyFileSource.displayName}`} tone="info" />
            ) : activeProfile.keyFileSource.kind === 'local-saf' ? (
              <Badge label={`密钥 · ${activeProfile.keyFileSource.displayName}`} tone="neutral" />
            ) : null}
            {activeProfile.biometricEnabled ? (
              <Badge label={activeProfile.biometricStrongBox ? 'StrongBox' : 'TEE 生物识别'} tone="success" />
            ) : null}
            {activeProfile.syncMeta.state === 'conflict' ? (
              <Badge label="同步冲突" tone="danger" />
            ) : activeProfile.syncMeta.state === 'offline-dirty' || activeProfile.syncMeta.state === 'dirty' ? (
              <Badge label="待同步" tone="warning" />
            ) : null}
          </View>
        </SurfaceCard>

        {errorText ? <AlertBanner title="解锁失败" message={errorText} tone="danger" /> : null}

        <SurfaceCard>
          {showBiometricPrimary ? (
            <View style={{ marginBottom: spacing['4'] }}>
              <Button label="生物识别解锁" onPress={handleBiometric} loading={submitting} />
            </View>
          ) : null}

          {hasKeyFile ? (
            <View style={{ marginBottom: spacing['2'] }}>
              <SwitchRow
                label="仅密钥文件（无密码）"
                value={noPasswordComponent}
                onValueChange={setNoPasswordComponent}
              />
            </View>
          ) : null}

          {!noPasswordComponent ? (
            <FormField
              label="主密码"
              value={password}
              onChangeText={setPassword}
              placeholder="可留空"
              secure
              autoFocus={!showBiometricPrimary && activeProfile.lastPasswordMode === 'password'}
              returnKeyType="done"
              onSubmitEditing={handleUnlock}
            />
          ) : null}

          {needWebDavPassword ? (
            <FormField
              label="WebDAV 密码"
              value={webdavPassword}
              onChangeText={setWebdavPassword}
              placeholder="••••••••"
              secure
            />
          ) : null}

          {needSeparateKeyDavPwd ? (
            <FormField
              label="远程密钥 WebDAV 密码"
              value={remoteKeyPassword}
              onChangeText={setRemoteKeyPassword}
              placeholder="••••••••"
              secure
            />
          ) : null}

          <Button
            label="解锁"
            variant={showBiometricPrimary ? 'secondary' : 'primary'}
            onPress={handleUnlock}
            loading={submitting}
          />
        </SurfaceCard>

        {profiles.length > 1 ? (
          <View>
            <SectionHeader title={`密码库 (${profiles.length})`} />
            <View style={{ gap: spacing['2'] }}>
              {profiles.map((p) => {
                const isSelected = p.id === activeProfile.id;
                const isDef = defaultProfile?.id === p.id;
                return (
                  <Pressable
                    key={p.id}
                    onPress={() => selectProfile(p.id)}
                    style={{
                      backgroundColor: isSelected ? colors.actionSubtle : colors.surface,
                      borderRadius: radius.md,
                      paddingHorizontal: spacing['4'],
                      paddingVertical: spacing['3'],
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        numberOfLines={1}
                        style={{
                          color: isSelected ? colors.actionSubtleText : colors.text,
                          fontSize: fontSize.base,
                          fontWeight: fontWeight.semibold,
                        }}
                      >
                        {p.name}
                      </Text>
                      <Text
                        numberOfLines={1}
                        style={{
                          color: isSelected ? colors.actionSubtleText : colors.textMuted,
                          fontSize: fontSize.xs,
                          marginTop: 2,
                        }}
                      >
                        {p.sourceKind === 'webdav' ? 'WebDAV' : '本地'}
                        {p.keyFileSource.kind === 'webdav'
                          ? ' · 远程密钥'
                          : p.keyFileSource.kind === 'local-saf'
                            ? ' · 本地密钥'
                            : ''}
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      {isDef ? (
                        <Badge label="默认" tone="primary" />
                      ) : (
                        <Button
                          label="设为默认"
                          variant="ghost"
                          compact
                          onPress={() => setDefaultProfile(p.id)}
                        />
                      )}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}
      </ContentFrame>
    </ScrollView>
  );
}
