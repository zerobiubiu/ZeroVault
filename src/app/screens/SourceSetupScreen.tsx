/**
 * 来源配置与新建密码库页（SourceSetupScreen）：
 * - 严格避让顶部状态栏与刘海/挖孔区（含内嵌 WebDAV 目录浏览 Modal）；
 * - 零冗余说明文字，Placeholder 全部使用真实示例，仅保留明文 HTTP 安全风险提示。
 */
import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { generateKeyFileV2, toBase64, type KdbxVersion, type VaultCredentials } from '../../kdbx';
import { getNativeStorage } from '../../native';
import type { KeyFileSourceConfig, WebDavDirectoryItem } from '../../storage';
import { useTheme } from '../../theme';
import {
  AlertBanner,
  Badge,
  Button,
  FormField,
  SectionHeader,
  SegmentTabs,
  SurfaceCard,
  SwitchRow,
} from '../components/Primitives';
import { ContentFrame, ScreenHeader, useSafeInsets } from '../components/SafeLayout';
import { StrengthMeter } from '../components/StrengthMeter';
import { useVaultCoordinator } from '../state/VaultCoordinator';

type SetupTab = 'webdav' | 'local' | 'create';
type KeyFileMode = 'none' | 'local-saf' | 'webdav';

export function SourceSetupScreen({
  initialTab = 'webdav',
  onClose,
}: {
  readonly initialTab?: SetupTab;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { colors, spacing, radius, fontSize, fontWeight } = useTheme();
  const insets = useSafeInsets();
  const {
    crypto,
    addWebDavVault,
    addLocalSafVault,
    createNewLocalVault,
    browseWebDavDirectory,
    showToast,
  } = useVaultCoordinator();

  const [tab, setTab] = useState<SetupTab>(initialTab);
  const [vaultName, setVaultName] = useState('');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // WebDAV 状态
  const [davUrl, setDavUrl] = useState('https://');
  const [davUsername, setDavUsername] = useState('');
  const [davPassword, setDavPassword] = useState('');
  const [allowHttp, setAllowHttp] = useState(false);
  const [cacheSecrets, setCacheSecrets] = useState(true);

  // 密钥文件状态
  const [keyMode, setKeyMode] = useState<KeyFileMode>('none');
  const [localKeyUri, setLocalKeyUri] = useState('');
  const [localKeyName, setLocalKeyName] = useState('');
  const [remoteKeyUrl, setRemoteKeyUrl] = useState('https://');
  const [remoteKeySameAuth, setRemoteKeySameAuth] = useState(true);
  const [remoteKeyUser, setRemoteKeyUser] = useState('');
  const [remoteKeyPass, setRemoteKeyPass] = useState('');

  // 本地 SAF 打开状态
  const [localVaultUri, setLocalVaultUri] = useState('');
  const [localVaultName, setLocalVaultName] = useState('');

  // 新建库状态
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('');
  const [allowEmptyNewPassword, setAllowEmptyNewPassword] = useState(false);
  const [createVersion, setCreateVersion] = useState<KdbxVersion>('4.1');
  const [generatedKeyBytes, setGeneratedKeyBytes] = useState<Uint8Array | null>(null);
  const [generatedKeyUri, setGeneratedKeyUri] = useState('');
  const [generatedKeyName, setGeneratedKeyName] = useState('');

  // WebDAV 远程目录浏览器模态状态
  const [browserTarget, setBrowserTarget] = useState<'vault' | 'keyfile' | null>(null);
  const [browserUrl, setBrowserUrl] = useState('');
  const [browserItems, setBrowserItems] = useState<WebDavDirectoryItem[]>([]);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);

  const openBrowser = async (target: 'vault' | 'keyfile', initialDirUrl: string) => {
    setBrowserTarget(target);
    const cleaned = initialDirUrl.replace(/\/[^/]*\.[a-zA-Z0-9]+$/, '/');
    setBrowserUrl(cleaned);
    await loadDirectory(cleaned, target);
  };

  const loadDirectory = async (dirUrl: string, target: 'vault' | 'keyfile') => {
    setBrowserLoading(true);
    setBrowserError(null);
    try {
      const creds =
        target === 'keyfile' && !remoteKeySameAuth
          ? { username: remoteKeyUser, password: remoteKeyPass }
          : { username: davUsername, password: davPassword };
      const list = await browseWebDavDirectory(dirUrl, creds, allowHttp);
      setBrowserUrl(dirUrl);
      setBrowserItems(list);
    } catch (err) {
      setBrowserError(err instanceof Error ? err.message : String(err));
      setBrowserItems([]);
    } finally {
      setBrowserLoading(false);
    }
  };

  const handlePickLocalVault = async () => {
    const native = getNativeStorage();
    if (!native) {
      setErrorText('无法调用系统文件选择器。');
      return;
    }
    try {
      const doc = await native.pickDocument();
      setLocalVaultUri(doc.uri);
      setLocalVaultName(doc.displayName);
      if (!vaultName.trim()) {
        setVaultName(doc.displayName.replace(/\.kdbx$/i, ''));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('取消')) setErrorText(msg);
    }
  };

  const handlePickLocalKeyFile = async () => {
    const native = getNativeStorage();
    if (!native) {
      setErrorText('无法调用系统文件选择器。');
      return;
    }
    try {
      const doc = await native.pickDocument();
      setLocalKeyUri(doc.uri);
      setLocalKeyName(doc.displayName);
      setKeyMode('local-saf');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('取消')) setErrorText(msg);
    }
  };

  const handleGenerateKeyFileForNewVault = async () => {
    const native = getNativeStorage();
    const bytes = generateKeyFileV2(crypto);
    if (native) {
      try {
        const doc = await native.createDocument(`${vaultName.trim() || 'zerovault'}.keyx`);
        await native.writeDocumentBase64(doc.uri, toBase64(bytes));
        setGeneratedKeyBytes(bytes);
        setGeneratedKeyUri(doc.uri);
        setGeneratedKeyName(doc.displayName);
        showToast('已生成密钥文件', 'success');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('取消')) setErrorText(msg);
      }
    } else {
      setGeneratedKeyBytes(bytes);
      setGeneratedKeyName('zerovault.keyx');
    }
  };

  const buildKeyFileConfig = (): KeyFileSourceConfig => {
    if (keyMode === 'local-saf' && localKeyUri) {
      return { kind: 'local-saf', uri: localKeyUri, displayName: localKeyName || 'keyfile' };
    }
    if (keyMode === 'webdav' && remoteKeyUrl.trim().length > 8) {
      const name = decodeURIComponent(remoteKeyUrl.trim().split('/').pop() || 'remote.keyx');
      return {
        kind: 'webdav',
        url: remoteKeyUrl.trim(),
        displayName: name,
        useSameAuthAsVault: remoteKeySameAuth,
        username: remoteKeySameAuth ? undefined : remoteKeyUser.trim(),
        allowInsecureHttp: allowHttp,
      };
    }
    return { kind: 'none' };
  };

  const handleSubmit = async () => {
    setErrorText(null);
    setSubmitting(true);
    try {
      if (tab === 'webdav') {
        await addWebDavVault({
          name: vaultName,
          vaultUrl: davUrl,
          username: davUsername,
          password: davPassword,
          allowInsecureHttp: allowHttp,
          keyFileSource: buildKeyFileConfig(),
          remoteKeyWebdavPassword: remoteKeySameAuth ? undefined : remoteKeyPass,
          cacheWebDavSecrets: cacheSecrets,
        });
        onClose();
        return;
      }

      if (tab === 'local') {
        if (!localVaultUri) {
          throw new Error('请选择 .kdbx 文件。');
        }
        await addLocalSafVault({
          name: vaultName,
          safUri: localVaultUri,
          fileName: localVaultName,
          keyFileSource: buildKeyFileConfig(),
        });
        onClose();
        return;
      }

      if (!allowEmptyNewPassword && !generatedKeyBytes && newPassword.length === 0) {
        throw new Error('请填写主密码、开启空密码或生成密钥文件。');
      }
      if (newPassword !== newPasswordConfirm) {
        throw new Error('两次输入的密码不一致。');
      }

      const native = getNativeStorage();
      let targetUri = '';
      let targetName = `${vaultName.trim() || 'ZeroVault'}.kdbx`;
      if (native) {
        const createdDoc = await native.createDocument(targetName);
        targetUri = createdDoc.uri;
        targetName = createdDoc.displayName;
      }

      const credentials: VaultCredentials =
        generatedKeyBytes && newPassword.length === 0 && !allowEmptyNewPassword
          ? { password: null, keyFile: generatedKeyBytes }
          : { password: newPassword, keyFile: generatedKeyBytes ?? undefined };

      const keyCfg: KeyFileSourceConfig = generatedKeyUri
        ? { kind: 'local-saf', uri: generatedKeyUri, displayName: generatedKeyName }
        : { kind: 'none' };

      await createNewLocalVault({
        name: vaultName.trim() || 'ZeroVault',
        safUri: targetUri,
        fileName: targetName,
        credentials,
        keyFileSource: keyCfg,
        options: { version: createVersion },
      });
      onClose();
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title="添加密码库"
        right={<Button label="关闭" variant="ghost" compact onPress={onClose} />}
      />

      <ScrollView
        contentContainerStyle={{
          paddingTop: spacing['4'],
          paddingBottom: spacing['8'],
          paddingLeft: spacing['4'] + insets.left,
          paddingRight: spacing['4'] + insets.right,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <ContentFrame style={{ gap: spacing['4'] }}>
          <SegmentTabs
            items={[
              { key: 'webdav', label: 'WebDAV' },
              { key: 'local', label: '本地文件' },
              { key: 'create', label: '新建' },
            ]}
            active={tab}
            onChange={(next) => {
              setTab(next);
              setErrorText(null);
            }}
          />

          {errorText ? <AlertBanner title="操作失败" message={errorText} tone="danger" /> : null}

          <SurfaceCard>
            <FormField
              label="名称"
              value={vaultName}
              onChangeText={setVaultName}
              placeholder="个人主库"
            />

            {tab === 'webdav' ? (
              <>
                <FormField
                  label="数据库地址 (.kdbx)"
                  value={davUrl}
                  onChangeText={setDavUrl}
                  placeholder="https://dav.example.com/vault.kdbx"
                  keyboardType="url"
                  rightAction={{
                    label: '浏览目录',
                    onPress: () => openBrowser('vault', davUrl),
                  }}
                />
                <FormField
                  label="用户名"
                  value={davUsername}
                  onChangeText={setDavUsername}
                  placeholder="alice@example.com"
                />
                <FormField
                  label="密码"
                  value={davPassword}
                  onChangeText={setDavPassword}
                  placeholder="••••••••"
                  secure
                />

                <SwitchRow
                  label="允许 HTTP"
                  note="明文传输，仅限受信任局域网"
                  value={allowHttp}
                  onValueChange={setAllowHttp}
                  tone="warning"
                  topDivider
                />
                <SwitchRow
                  label="硬件加密缓存凭据与远程密钥"
                  value={cacheSecrets}
                  onValueChange={setCacheSecrets}
                  topDivider
                />
              </>
            ) : null}

            {tab === 'local' ? (
              <Button
                label={localVaultName ? `已选：${localVaultName}` : '选择 .kdbx 文件'}
                variant="secondary"
                onPress={handlePickLocalVault}
              />
            ) : null}

            {tab === 'create' ? (
              <>
                <FormField
                  label="主密码"
                  value={newPassword}
                  onChangeText={setNewPassword}
                  placeholder={allowEmptyNewPassword ? '可留空' : '••••••••'}
                  secure
                />
                {newPassword.length > 0 ? (
                  <View style={{ marginTop: -10, marginBottom: 16 }}>
                    <StrengthMeter password={newPassword} />
                  </View>
                ) : null}
                <FormField
                  label="确认主密码"
                  value={newPasswordConfirm}
                  onChangeText={setNewPasswordConfirm}
                  placeholder="••••••••"
                  secure
                />

                <SwitchRow
                  label="允许空密码"
                  value={allowEmptyNewPassword}
                  onValueChange={setAllowEmptyNewPassword}
                  topDivider
                />

                <View style={{ marginTop: spacing['3'] }}>
                  <SectionHeader title="格式" />
                  <SegmentTabs
                    items={[
                      { key: '4.1' as KdbxVersion, label: 'KDBX 4.1' },
                      { key: '3.1' as KdbxVersion, label: 'KDBX 3.1' },
                    ]}
                    active={createVersion}
                    onChange={setCreateVersion}
                  />
                </View>

                <View style={{ marginTop: spacing['4'] }}>
                  <Button
                    label={generatedKeyName ? `密钥：${generatedKeyName}` : '生成密钥文件 (可选)'}
                    variant="secondary"
                    onPress={handleGenerateKeyFileForNewVault}
                  />
                </View>
              </>
            ) : null}
          </SurfaceCard>

          {tab !== 'create' ? (
            <SurfaceCard>
              <SectionHeader title="密钥文件" />
              <SegmentTabs
                items={[
                  { key: 'none' as KeyFileMode, label: '无' },
                  { key: 'webdav' as KeyFileMode, label: 'WebDAV 远程' },
                  { key: 'local-saf' as KeyFileMode, label: '本地' },
                ]}
                active={keyMode}
                onChange={setKeyMode}
              />

              {keyMode === 'local-saf' ? (
                <View style={{ marginTop: spacing['4'] }}>
                  <Button
                    label={localKeyName ? `已选：${localKeyName}` : '选择密钥文件'}
                    variant="secondary"
                    onPress={handlePickLocalKeyFile}
                  />
                </View>
              ) : null}

              {keyMode === 'webdav' ? (
                <View style={{ marginTop: spacing['4'] }}>
                  <FormField
                    label="远程密钥地址"
                    value={remoteKeyUrl}
                    onChangeText={setRemoteKeyUrl}
                    placeholder="https://dav.example.com/master.keyx"
                    keyboardType="url"
                    rightAction={{
                      label: '浏览目录',
                      onPress: () => openBrowser('keyfile', remoteKeyUrl.length > 8 ? remoteKeyUrl : davUrl),
                    }}
                  />
                  {tab === 'webdav' ? (
                    <SwitchRow
                      label="复用数据库认证"
                      value={remoteKeySameAuth}
                      onValueChange={setRemoteKeySameAuth}
                    />
                  ) : null}
                  {!remoteKeySameAuth || tab !== 'webdav' ? (
                    <View style={{ marginTop: spacing['2'] }}>
                      <FormField
                        label="密钥服务用户名"
                        value={remoteKeyUser}
                        onChangeText={setRemoteKeyUser}
                        placeholder="alice@example.com"
                      />
                      <FormField
                        label="密钥服务密码"
                        value={remoteKeyPass}
                        onChangeText={setRemoteKeyPass}
                        placeholder="••••••••"
                        secure
                      />
                    </View>
                  ) : null}
                </View>
              ) : null}
            </SurfaceCard>
          ) : null}

          <Button
            label={tab === 'webdav' ? '添加' : tab === 'local' ? '添加' : '创建'}
            onPress={handleSubmit}
            loading={submitting}
          />
        </ContentFrame>
      </ScrollView>

      {/* WebDAV PROPFIND 远程目录浏览弹窗（显式启用状态栏安全区） */}
      <Modal
        visible={browserTarget !== null}
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setBrowserTarget(null)}
      >
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          <ScreenHeader
            title={browserTarget === 'vault' ? '选择数据库' : '选择远程密钥'}
            subtitle={browserUrl}
            includeTopInset
            right={<Button label="关闭" variant="ghost" compact onPress={() => setBrowserTarget(null)} />}
          />

          <ScrollView
            contentContainerStyle={{
              paddingTop: spacing['4'],
              paddingBottom: spacing['6'] + insets.bottom,
              paddingLeft: spacing['4'] + insets.left,
              paddingRight: spacing['4'] + insets.right,
              gap: spacing['2'],
            }}
          >
            {browserError ? <AlertBanner title="读取失败" message={browserError} tone="danger" /> : null}
            {browserLoading ? (
              <Text style={{ color: colors.textMuted, textAlign: 'center', padding: spacing['6'] }}>
                加载中…
              </Text>
            ) : null}
            {browserItems.map((item) => (
              <Pressable
                key={item.url}
                onPress={() => {
                  if (item.isDirectory) {
                    loadDirectory(item.url, browserTarget!);
                  } else if (browserTarget === 'vault') {
                    setDavUrl(item.url);
                    if (!vaultName.trim()) setVaultName(item.name.replace(/\.kdbx$/i, ''));
                    setBrowserTarget(null);
                  } else {
                    setRemoteKeyUrl(item.url);
                    setBrowserTarget(null);
                  }
                }}
                style={{
                  backgroundColor: colors.surface,
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
                  <Text numberOfLines={1} style={{ color: colors.text, fontSize: fontSize.base, fontWeight: fontWeight.semibold }}>
                    {item.name}
                  </Text>
                  {item.size !== null ? (
                    <Text style={{ color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 }}>
                      {(item.size / 1024).toFixed(1)} KB
                    </Text>
                  ) : null}
                </View>
                <Badge label={item.isDirectory ? '目录' : '选用'} tone={item.isDirectory ? 'neutral' : 'primary'} />
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}
