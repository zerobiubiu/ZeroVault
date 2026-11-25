/**
 * 主密码库列表页（VaultListScreen）：
 * - 统一 ScreenHeader 与横屏安全区；空库隐藏搜索/筛选栏，零冗余说明文案；
 * - 仅消费 VaultEntrySummary 摘要，按需读密码复制。
 */
import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { VaultEntrySummary } from '../../kdbx';
import { useTheme } from '../../theme';
import { AlertBanner, Badge, Button, EmptyState } from '../components/Primitives';
import { ContentFrame, ScreenHeader, useSafeInsets } from '../components/SafeLayout';
import { useVaultCoordinator } from '../state/VaultCoordinator';

type FilterChip = 'all' | 'totp' | 'expired' | 'recycle' | `group:${string}`;

function syncBadgeMeta(state: string): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  switch (state) {
    case 'clean':
      return { label: '已同步', tone: 'success' };
    case 'dirty':
      return { label: '待同步', tone: 'warning' };
    case 'offline-dirty':
      return { label: '离线变更', tone: 'warning' };
    case 'conflict':
      return { label: '冲突', tone: 'danger' };
    default:
      return { label: '同步', tone: 'neutral' };
  }
}

export function VaultListScreen({
  onSelectEntry,
  onCreateEntry,
  onOpenConflict,
  onSaveAutofillPending,
}: {
  readonly onSelectEntry: (entryId: string) => void;
  readonly onCreateEntry: () => void;
  readonly onOpenConflict: () => void;
  readonly onSaveAutofillPending: () => void;
}): React.JSX.Element {
  const { colors, spacing, radius, fontSize, fontWeight } = useTheme();
  const insets = useSafeInsets();
  const {
    activeProfile,
    vaultMeta,
    groups,
    entries,
    conflict,
    pendingAutofillSave,
    lockVault,
    syncActiveVault,
    readEntryField,
    copySensitive,
    dismissPendingAutofillSave,
    showToast,
  } = useVaultCoordinator();

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterChip>('all');

  const activeEntries = useMemo(() => entries.filter((e) => !e.recycled), [entries]);
  const recycledCount = entries.length - activeEntries.length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((item) => {
      if (filter === 'recycle') {
        if (!item.recycled) return false;
      } else {
        if (item.recycled) return false;
        if (filter === 'totp' && !item.hasTotp) return false;
        if (filter === 'expired' && !item.isExpired) return false;
        if (filter.startsWith('group:')) {
          const gid = filter.slice(6);
          if (item.groupId !== gid) return false;
        }
      }
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.username.toLowerCase().includes(q) ||
        item.url.toLowerCase().includes(q) ||
        item.groupPath.toLowerCase().includes(q) ||
        item.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [entries, filter, query]);

  const syncBadge = syncBadgeMeta(activeProfile?.syncMeta.state ?? 'unknown');

  const handleSyncTap = async () => {
    if (conflict) {
      onOpenConflict();
      return;
    }
    try {
      await syncActiveVault();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'danger');
    }
  };

  const renderEntryRow = ({ item }: { item: VaultEntrySummary }) => {
    const initial = (item.title.trim()[0] || '?').toUpperCase();
    return (
      <ContentFrame>
        <Pressable
          onPress={() => onSelectEntry(item.id)}
          style={({ pressed }) => ({
            backgroundColor: colors.surface,
            borderRadius: radius.lg,
            paddingHorizontal: spacing['4'],
            paddingVertical: spacing['3'],
            marginBottom: spacing['2'],
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing['3'],
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: radius.md,
              backgroundColor: item.isExpired ? colors.dangerSubtle : colors.actionSubtle,
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Text
              style={{
                color: item.isExpired ? colors.dangerSubtleText : colors.actionSubtleText,
                fontSize: fontSize.base,
                fontWeight: fontWeight.semibold,
              }}
            >
              {initial}
            </Text>
          </View>

          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text
                numberOfLines={1}
                style={{
                  color: colors.text,
                  fontSize: fontSize.base,
                  fontWeight: fontWeight.semibold,
                  flexShrink: 1,
                }}
              >
                {item.title}
              </Text>
              {item.hasTotp ? <Badge label="2FA" tone="info" /> : null}
              {item.isExpired ? <Badge label="过期" tone="danger" /> : null}
            </View>
            <Text numberOfLines={1} style={{ color: colors.textSecondary, fontSize: fontSize.sm, marginTop: 2 }}>
              {item.username || item.url || item.groupPath}
            </Text>
          </View>

          {item.hasPassword && !item.recycled ? (
            <Pressable
              accessibilityLabel={`复制 ${item.title} 密码`}
              onPress={() => {
                const pwd = readEntryField(item.id, 'Password');
                copySensitive(pwd, item.title);
              }}
              style={{
                minWidth: 44,
                minHeight: 40,
                borderRadius: radius.md,
                backgroundColor: colors.surfaceSunken,
                alignItems: 'center',
                justifyContent: 'center',
                paddingHorizontal: 10,
                flexShrink: 0,
              }}
            >
              <Text style={{ color: colors.action, fontSize: fontSize.xs, fontWeight: fontWeight.semibold }}>
                复制
              </Text>
            </Pressable>
          ) : null}
        </Pressable>
      </ContentFrame>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title={vaultMeta?.name || activeProfile?.name || '密码库'}
        subtitle={`${activeEntries.length} 条 · KDBX ${vaultMeta?.format.version ?? '4.1'}`}
        right={
          <>
            {activeProfile?.sourceKind === 'webdav' ? (
              <Pressable onPress={handleSyncTap} hitSlop={8}>
                <Badge label={syncBadge.label} tone={syncBadge.tone} />
              </Pressable>
            ) : null}
            <Button label="锁定" variant="ghost" compact onPress={() => lockVault(false)} />
          </>
        }
      />

      {conflict ? (
        <View
          style={{
            paddingTop: spacing['3'],
            paddingLeft: spacing['4'] + insets.left,
            paddingRight: spacing['4'] + insets.right,
          }}
        >
          <ContentFrame>
            <AlertBanner
              title="WebDAV 版本冲突"
              message="本地与远端均已修改，已暂停自动覆盖。"
              tone="danger"
              actionLabel="处理冲突"
              onAction={onOpenConflict}
            />
          </ContentFrame>
        </View>
      ) : null}

      {pendingAutofillSave ? (
        <View
          style={{
            paddingTop: spacing['3'],
            paddingLeft: spacing['4'] + insets.left,
            paddingRight: spacing['4'] + insets.right,
          }}
        >
          <ContentFrame>
            <AlertBanner
              title="待保存凭据"
              message={`${pendingAutofillSave.webDomain || pendingAutofillSave.packageName} · ${pendingAutofillSave.username || '未知账号'}`}
              tone="info"
              actionLabel="审核保存"
              onAction={onSaveAutofillPending}
            />
            <Pressable onPress={dismissPendingAutofillSave} style={{ alignSelf: 'flex-end', paddingTop: 4 }}>
              <Text style={{ color: colors.textMuted, fontSize: fontSize.xs }}>忽略</Text>
            </Pressable>
          </ContentFrame>
        </View>
      ) : null}

      {entries.length > 0 ? (
        <View
          style={{
            paddingTop: spacing['3'],
            paddingLeft: spacing['4'] + insets.left,
            paddingRight: spacing['4'] + insets.right,
          }}
        >
          <ContentFrame>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="搜索"
              placeholderTextColor={colors.textMuted}
              style={{
                backgroundColor: colors.surface,
                color: colors.text,
                borderColor: colors.border,
                borderWidth: 1,
                borderRadius: radius.md,
                paddingHorizontal: 14,
                minHeight: 44,
                fontSize: fontSize.sm,
              }}
            />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingVertical: spacing['3'], gap: spacing['2'] }}
              style={{ flexGrow: 0 }}
            >
              {[
                { key: 'all' as FilterChip, label: `全部 (${activeEntries.length})` },
                { key: 'totp' as FilterChip, label: '2FA' },
                { key: 'expired' as FilterChip, label: '已过期' },
                ...groups
                  .filter((g) => !g.isRecycleBin && g.parentId !== null)
                  .map((g) => ({ key: `group:${g.id}` as FilterChip, label: `${g.name} (${g.entryCount})` })),
                ...(recycledCount > 0 ? [{ key: 'recycle' as FilterChip, label: `回收站 (${recycledCount})` }] : []),
              ].map((chip) => {
                const selected = filter === chip.key;
                return (
                  <Pressable
                    key={chip.key}
                    onPress={() => setFilter(chip.key)}
                    style={{
                      backgroundColor: selected ? colors.action : colors.surface,
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
                      {chip.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </ContentFrame>
        </View>
      ) : null}

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderEntryRow}
        contentContainerStyle={{
          paddingLeft: spacing['4'] + insets.left,
          paddingRight: spacing['4'] + insets.right,
          paddingBottom: 92,
          flexGrow: 1,
          justifyContent: filtered.length === 0 ? 'center' : undefined,
        }}
        ListEmptyComponent={
          entries.length === 0 ? (
            <EmptyState symbol="+" title="暂无条目" primaryLabel="新建条目" onPrimary={onCreateEntry} />
          ) : (
            <EmptyState
              symbol="?"
              title="无匹配条目"
              primaryLabel="重置筛选"
              onPrimary={() => {
                setQuery('');
                setFilter('all');
              }}
            />
          )
        }
      />

      {entries.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="新建条目"
          onPress={onCreateEntry}
          style={({ pressed }) => ({
            position: 'absolute',
            right: spacing['4'] + insets.right,
            bottom: spacing['4'],
            backgroundColor: pressed ? colors.actionPressed : colors.action,
            borderRadius: radius.full,
            paddingHorizontal: 18,
            minHeight: 50,
            alignItems: 'center',
            justifyContent: 'center',
            elevation: 6,
          })}
        >
          <Text style={{ color: colors.actionText, fontSize: fontSize.base, fontWeight: fontWeight.semibold }}>
            + 新建
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
