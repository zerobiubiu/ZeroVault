/**
 * 条目新建与编辑页（EntryEditorScreen）：
 * - 统一 ScreenHeader；Placeholder 仅放输入示例；零冗余说明。
 */
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { DEFAULT_PASSWORD_OPTIONS, generatePassword } from '../../security';
import { useTheme } from '../../theme';
import {
  AlertBanner,
  Button,
  FormField,
  SectionHeader,
  SurfaceCard,
  SwitchRow,
} from '../components/Primitives';
import { ContentFrame, ScreenHeader, useSafeInsets } from '../components/SafeLayout';
import { StrengthMeter } from '../components/StrengthMeter';
import { useVaultCoordinator } from '../state/VaultCoordinator';

interface EditableCustomField {
  readonly id: number;
  key: string;
  value: string;
  protected: boolean;
}

export function EntryEditorScreen({
  entryId,
  prefill,
  onClose,
  onSaved,
}: {
  readonly entryId?: string;
  readonly prefill?: { title?: string; username?: string; password?: string; url?: string };
  readonly onClose: () => void;
  readonly onSaved: (savedId: string) => void;
}): React.JSX.Element {
  const { colors, spacing, radius, fontSize, fontWeight } = useTheme();
  const insets = useSafeInsets();
  const { groups, crypto, getEntryDetail, readEntryField, upsertEntry } = useVaultCoordinator();

  const existing = useMemo(() => {
    if (!entryId) return null;
    try {
      return getEntryDetail(entryId);
    } catch {
      return null;
    }
  }, [entryId, getEntryDetail]);

  const selectableGroups = useMemo(() => groups.filter((g) => !g.isRecycleBin), [groups]);

  const [groupId, setGroupId] = useState(existing?.groupId ?? selectableGroups[0]?.id ?? '');
  const [title, setTitle] = useState(existing?.title ?? prefill?.title ?? '');
  const [username, setUsername] = useState(existing?.username ?? prefill?.username ?? '');
  const [password, setPassword] = useState(
    existing ? readEntryField(existing.id, 'Password') : (prefill?.password ?? ''),
  );
  const [url, setUrl] = useState(existing?.url ?? prefill?.url ?? '');
  const [totpUri, setTotpUri] = useState(existing ? readEntryField(existing.id, 'otp') : '');
  const [tagsText, setTagsText] = useState(existing ? existing.tags.join(', ') : '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [expires, setExpires] = useState(existing?.expires ?? false);
  const [expiryDate, setExpiryDate] = useState(
    existing?.expiryTime ? existing.expiryTime.slice(0, 10) : '',
  );
  const [customFields, setCustomFields] = useState<EditableCustomField[]>(() =>
    existing
      ? existing.customFields
          .filter((f) => f.key !== 'otp')
          .map((f, idx) => ({
            id: idx + 1,
            key: f.key,
            value: f.protected ? readEntryField(existing.id, f.key) : (f.value ?? ''),
            protected: f.protected,
          }))
      : [],
  );
  const [removedKeys, setRemovedKeys] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const handleQuickGenerate = () => {
    setPassword(generatePassword(DEFAULT_PASSWORD_OPTIONS, crypto));
  };

  const handleAddCustomField = () => {
    setCustomFields((prev) => [
      ...prev,
      { id: Date.now(), key: '', value: '', protected: false },
    ]);
  };

  const handleSave = async () => {
    if (!title.trim()) {
      setErrorText('请填写标题。');
      return;
    }
    setErrorText(null);
    setSaving(true);
    try {
      const patches = [
        ...removedKeys.map((key) => ({ key, value: null as string | null })),
        ...customFields
          .filter((f) => f.key.trim().length > 0)
          .map((f) => ({ key: f.key.trim(), value: f.value, protected: f.protected })),
      ];

      const expiryIso =
        expires && /^\d{4}-\d{2}-\d{2}$/.test(expiryDate.trim())
          ? `${expiryDate.trim()}T23:59:59Z`
          : undefined;

      const saved = await upsertEntry({
        id: existing?.id,
        groupId: groupId || undefined,
        title: title.trim(),
        username: username.trim(),
        password,
        url: url.trim(),
        totpUri: totpUri.trim(),
        tags: tagsText
          .split(/[,;，；]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        notes,
        expires,
        expiryTime: expiryIso,
        customFields: patches,
      });
      onSaved(saved.id);
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title={existing ? '编辑条目' : '新建条目'}
        left={<Button label="取消" variant="ghost" compact onPress={onClose} />}
        right={<Button label="保存" variant="primary" compact onPress={handleSave} loading={saving} />}
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
          {errorText ? <AlertBanner title="保存失败" message={errorText} tone="danger" /> : null}

          <SurfaceCard>
            {selectableGroups.length > 1 ? (
              <View style={{ marginBottom: 16 }}>
                <SectionHeader title="分组" />
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                  {selectableGroups.map((g) => {
                    const selected = g.id === groupId;
                    return (
                      <Pressable
                        key={g.id}
                        onPress={() => setGroupId(g.id)}
                        style={{
                          backgroundColor: selected ? colors.action : colors.surfaceSunken,
                          borderRadius: radius.full,
                          paddingHorizontal: 14,
                          height: 34,
                          justifyContent: 'center',
                        }}
                      >
                        <Text
                          style={{
                            color: selected ? colors.actionText : colors.textSecondary,
                            fontSize: fontSize.xs,
                            fontWeight: fontWeight.semibold,
                          }}
                        >
                          {g.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            ) : null}

            <FormField label="标题" value={title} onChangeText={setTitle} placeholder="GitHub" />
            <FormField label="用户名" value={username} onChangeText={setUsername} placeholder="alice@example.com" />
            <FormField
              label="密码"
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              secure
              monospace
              rightAction={{ label: '生成', onPress: handleQuickGenerate }}
            />
            {password.length > 0 ? (
              <View style={{ marginTop: -10, marginBottom: 18 }}>
                <StrengthMeter password={password} />
              </View>
            ) : null}
            <FormField
              label="网址"
              value={url}
              onChangeText={setUrl}
              placeholder="https://github.com"
              keyboardType="url"
            />
            <FormField
              label="TOTP (otpauth:// 或 Base32)"
              value={totpUri}
              onChangeText={setTotpUri}
              placeholder="otpauth://totp/..."
              monospace
            />
          </SurfaceCard>

          <SurfaceCard>
            <SectionHeader title="附加信息" />
            <FormField label="标签" value={tagsText} onChangeText={setTagsText} placeholder="工作, 重要" />
            <FormField label="备注" value={notes} onChangeText={setNotes} placeholder="" multiline />

            <SwitchRow label="设置到期日" value={expires} onValueChange={setExpires} topDivider />
            {expires ? (
              <View style={{ marginTop: spacing['2'] }}>
                <FormField
                  label="到期日期 (YYYY-MM-DD)"
                  value={expiryDate}
                  onChangeText={setExpiryDate}
                  placeholder="2027-06-30"
                />
              </View>
            ) : null}
          </SurfaceCard>

          <SurfaceCard>
            <SectionHeader title="自定义字段" actionLabel="+ 添加" onAction={handleAddCustomField} />
            {customFields.map((item, idx) => (
              <View
                key={item.id}
                style={{
                  paddingVertical: 12,
                  borderTopWidth: idx === 0 ? 0 : 1,
                  borderTopColor: colors.border,
                  gap: 8,
                }}
              >
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                  <TextInput
                    value={item.key}
                    onChangeText={(text) =>
                      setCustomFields((prev) =>
                        prev.map((f) => (f.id === item.id ? { ...f, key: text } : f)),
                      )
                    }
                    placeholder="字段名"
                    placeholderTextColor={colors.textMuted}
                    style={{
                      flex: 1,
                      backgroundColor: colors.surfaceSunken,
                      color: colors.text,
                      borderRadius: radius.sm,
                      paddingHorizontal: 12,
                      minHeight: 42,
                    }}
                  />
                  <Button
                    label="删除"
                    variant="danger-ghost"
                    compact
                    onPress={() => {
                      if (item.key.trim()) {
                        setRemovedKeys((prev) => [...prev, item.key.trim()]);
                      }
                      setCustomFields((prev) => prev.filter((f) => f.id !== item.id));
                    }}
                  />
                </View>
                <TextInput
                  value={item.value}
                  onChangeText={(text) =>
                    setCustomFields((prev) =>
                      prev.map((f) => (f.id === item.id ? { ...f, value: text } : f)),
                    )
                  }
                  placeholder="字段值"
                  placeholderTextColor={colors.textMuted}
                  secureTextEntry={item.protected}
                  style={{
                    backgroundColor: colors.surfaceSunken,
                    color: colors.text,
                    borderRadius: radius.sm,
                    paddingHorizontal: 12,
                    minHeight: 42,
                  }}
                />
                <SwitchRow
                  label="加密保护"
                  value={item.protected}
                  onValueChange={(val) =>
                    setCustomFields((prev) =>
                      prev.map((f) => (f.id === item.id ? { ...f, protected: val } : f)),
                    )
                  }
                />
              </View>
            ))}
          </SurfaceCard>
        </ContentFrame>
      </ScrollView>
    </View>
  );
}
