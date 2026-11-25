/**
 * 条目详情页（EntryDetailScreen）：
 * - 统一 ScreenHeader 与规整分组卡片；密码 20 秒自动隐藏；零冗余说明文案。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import {
  AlertBanner,
  Badge,
  Button,
  MONO_FONT,
  SectionHeader,
  SurfaceCard,
} from '../components/Primitives';
import { ContentFrame, ScreenHeader, useSafeInsets } from '../components/SafeLayout';
import { StrengthMeter } from '../components/StrengthMeter';
import { TotpCard } from '../components/TotpCard';
import { useVaultCoordinator } from '../state/VaultCoordinator';

export function EntryDetailScreen({
  entryId,
  onBack,
  onEdit,
}: {
  readonly entryId: string;
  readonly onBack: () => void;
  readonly onEdit: (entryId: string) => void;
}): React.JSX.Element {
  const { colors, spacing, fontSize, fontWeight } = useTheme();
  const insets = useSafeInsets();
  const {
    getEntryDetail,
    readEntryField,
    readEntryTotp,
    copySensitive,
    deleteEntry,
    restoreEntry,
    showToast,
  } = useVaultCoordinator();

  const [passwordRevealed, setPasswordRevealed] = useState(false);
  const [revealedCustomKeys, setRevealedCustomKeys] = useState<Record<string, boolean>>({});

  const detail = useMemo(() => {
    try {
      return getEntryDetail(entryId);
    } catch {
      return null;
    }
  }, [entryId, getEntryDetail]);

  const totpConfig = useMemo(() => readEntryTotp(entryId), [entryId, readEntryTotp]);

  useEffect(() => {
    if (!passwordRevealed) return;
    const timer = setTimeout(() => setPasswordRevealed(false), 20_000);
    return () => clearTimeout(timer);
  }, [passwordRevealed]);

  if (!detail) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader
          title="条目详情"
          left={<Button label="返回" variant="ghost" compact onPress={onBack} />}
        />
        <View style={{ flex: 1, justifyContent: 'center', padding: spacing['6'] }}>
          <AlertBanner title="条目不存在" message="该条目已删除或被远端同步移除。" tone="warning" />
        </View>
      </View>
    );
  }

  const currentPassword = detail.hasPassword ? readEntryField(detail.id, 'Password') : '';

  const handleOpenUrl = async () => {
    if (!detail.url) return;
    const normalized = detail.url.includes('://') ? detail.url : `https://${detail.url}`;
    try {
      await Linking.openURL(normalized);
    } catch {
      showToast('链接无效', 'warning');
    }
  };

  const handleDelete = () => {
    const permanent = detail.recycled;
    Alert.alert(
      permanent ? '永久删除' : '移入回收站',
      permanent ? `永久删除「${detail.title}」后无法恢复。` : `将「${detail.title}」移入回收站。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: permanent ? '永久删除' : '移入回收站',
          style: 'destructive',
          onPress: async () => {
            await deleteEntry(detail.id, permanent);
            onBack();
          },
        },
      ],
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title={detail.title}
        subtitle={detail.groupPath}
        left={<Button label="返回" variant="ghost" compact onPress={onBack} />}
        right={
          detail.recycled ? (
            <Button
              label="恢复"
              variant="secondary"
              compact
              onPress={async () => {
                await restoreEntry(detail.id);
                onBack();
              }}
            />
          ) : (
            <Button label="编辑" variant="primary" compact onPress={() => onEdit(detail.id)} />
          )
        }
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
          {detail.tags.length > 0 ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {detail.tags.map((tag) => (
                <Badge key={tag} label={`#${tag}`} tone="neutral" />
              ))}
            </View>
          ) : null}

          {detail.isExpired ? (
            <AlertBanner
              title="已过期"
              message={`到期日：${detail.expiryTime ? detail.expiryTime.slice(0, 10) : '未知'}`}
              tone="danger"
            />
          ) : null}

          {totpConfig ? (
            <TotpCard config={totpConfig} onCopy={(code) => copySensitive(code, 'TOTP')} />
          ) : null}

          <SurfaceCard>
            <SectionHeader title="凭据" />

            <View style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
              <Text style={{ color: colors.textMuted, fontSize: fontSize.xs }}>用户名</Text>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                <Text style={{ color: colors.text, fontSize: fontSize.base, flex: 1 }}>
                  {detail.username || '—'}
                </Text>
                {detail.username ? (
                  <Button
                    label="复制"
                    variant="ghost"
                    compact
                    onPress={() => copySensitive(detail.username, '用户名')}
                  />
                ) : null}
              </View>
            </View>

            <View style={{ paddingTop: 12 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ color: colors.textMuted, fontSize: fontSize.xs }}>密码</Text>
                {detail.hasPassword ? (
                  <View style={{ flexDirection: 'row', gap: 14 }}>
                    <Pressable onPress={() => setPasswordRevealed((v) => !v)} hitSlop={8}>
                      <Text style={{ color: colors.action, fontSize: fontSize.xs, fontWeight: fontWeight.semibold }}>
                        {passwordRevealed ? '隐藏' : '显示'}
                      </Text>
                    </Pressable>
                    <Pressable onPress={() => copySensitive(currentPassword, '密码')} hitSlop={8}>
                      <Text style={{ color: colors.action, fontSize: fontSize.xs, fontWeight: fontWeight.semibold }}>
                        复制
                      </Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>

              <Text
                selectable={passwordRevealed}
                style={{
                  color: colors.text,
                  fontSize: fontSize.base,
                  fontFamily: MONO_FONT,
                  marginTop: 6,
                  letterSpacing: passwordRevealed ? 0.5 : 2,
                }}
              >
                {!detail.hasPassword ? '—' : passwordRevealed ? currentPassword : '••••••••••••••••'}
              </Text>

              {detail.hasPassword ? (
                <View style={{ marginTop: 10 }}>
                  <StrengthMeter password={currentPassword} />
                </View>
              ) : null}
            </View>
          </SurfaceCard>

          {detail.url ? (
            <SurfaceCard>
              <SectionHeader title="网址" />
              <Text style={{ color: colors.text, fontSize: fontSize.sm, marginBottom: 10 }}>{detail.url}</Text>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Button label="打开" variant="secondary" compact onPress={handleOpenUrl} />
                <Button label="复制" variant="ghost" compact onPress={() => copySensitive(detail.url, '网址')} />
              </View>
            </SurfaceCard>
          ) : null}

          {detail.customFields.filter((f) => f.key !== 'otp').length > 0 ? (
            <SurfaceCard>
              <SectionHeader title="自定义字段" />
              {detail.customFields
                .filter((f) => f.key !== 'otp')
                .map((field) => {
                  const isShown = !field.protected || revealedCustomKeys[field.key];
                  const fieldVal = field.protected ? readEntryField(detail.id, field.key) : (field.value ?? '');
                  return (
                    <View
                      key={field.key}
                      style={{
                        paddingVertical: 10,
                        borderBottomWidth: 1,
                        borderBottomColor: colors.border,
                      }}
                    >
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Text style={{ color: colors.textMuted, fontSize: fontSize.xs }}>
                          {field.key}
                          {field.protected ? ' · 加密' : ''}
                        </Text>
                        <View style={{ flexDirection: 'row', gap: 14 }}>
                          {field.protected ? (
                            <Pressable
                              onPress={() =>
                                setRevealedCustomKeys((prev) => ({ ...prev, [field.key]: !prev[field.key] }))
                              }
                              hitSlop={8}
                            >
                              <Text style={{ color: colors.action, fontSize: fontSize.xs, fontWeight: fontWeight.semibold }}>
                                {isShown ? '隐藏' : '显示'}
                              </Text>
                            </Pressable>
                          ) : null}
                          <Pressable onPress={() => copySensitive(fieldVal, field.key)} hitSlop={8}>
                            <Text style={{ color: colors.action, fontSize: fontSize.xs, fontWeight: fontWeight.semibold }}>
                              复制
                            </Text>
                          </Pressable>
                        </View>
                      </View>
                      <Text
                        style={{
                          color: colors.text,
                          fontSize: fontSize.sm,
                          fontFamily: field.protected ? MONO_FONT : undefined,
                          marginTop: 4,
                        }}
                      >
                        {isShown ? fieldVal : '••••••••••••'}
                      </Text>
                    </View>
                  );
                })}
            </SurfaceCard>
          ) : null}

          {detail.notes ? (
            <SurfaceCard>
              <SectionHeader title="备注" />
              <Text style={{ color: colors.text, fontSize: fontSize.sm, lineHeight: 22 }}>{detail.notes}</Text>
            </SurfaceCard>
          ) : null}

          {detail.attachments.length > 0 ? (
            <SurfaceCard>
              <SectionHeader title={`附件 (${detail.attachments.length})`} />
              {detail.attachments.map((att) => (
                <View
                  key={att.id}
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    paddingVertical: 8,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.border,
                  }}
                >
                  <Text style={{ color: colors.text, fontSize: fontSize.sm }}>{att.name}</Text>
                  <Text style={{ color: colors.textMuted, fontSize: fontSize.xs }}>
                    {(att.size / 1024).toFixed(1)} KB
                  </Text>
                </View>
              ))}
            </SurfaceCard>
          ) : null}

          {detail.history.length > 0 ? (
            <SurfaceCard>
              <SectionHeader title={`历史版本 (${detail.history.length})`} />
              {detail.history.map((snap) => (
                <View
                  key={snap.index}
                  style={{
                    paddingVertical: 8,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.border,
                  }}
                >
                  <Text style={{ color: colors.textSecondary, fontSize: fontSize.sm }}>
                    #{snap.index + 1} · {snap.title || '—'}
                  </Text>
                  <Text style={{ color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 }}>
                    {snap.modifiedAt ? snap.modifiedAt.slice(0, 19).replace('T', ' ') : '—'}
                  </Text>
                </View>
              ))}
            </SurfaceCard>
          ) : null}

          <View style={{ alignItems: 'center', gap: 6, paddingTop: spacing['2'] }}>
            <Text style={{ color: colors.textMuted, fontSize: fontSize.xs }}>
              更新于 {detail.modifiedAt ? detail.modifiedAt.slice(0, 19).replace('T', ' ') : '—'}
            </Text>
            <Button
              label={detail.recycled ? '永久删除' : '移入回收站'}
              variant="danger-ghost"
              onPress={handleDelete}
            />
          </View>
        </ContentFrame>
      </ScrollView>
    </View>
  );
}
