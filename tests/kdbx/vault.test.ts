import { describe, expect, it } from 'vitest';
import {
  computeTotp,
  createFallbackCryptoProvider,
  createVault,
  generateKeyFileV2,
  loadVault,
  loadVaultWithEmptyPasswordProbe,
  VaultError,
} from '../../src/kdbx';

const crypto = createFallbackCryptoProvider();

// 单测使用较低 KDF 成本加速执行，生产环境采用安全默认参数
const FAST_KDBX4 = { kdfIterations: 1, kdfMemoryKiB: 1024, kdfParallelism: 1 };
const FAST_KDBX3 = { version: '3.1' as const, aesRounds: 200 };

describe('KDBX 3.1 / 4.x 核心引擎端到端读写与完整性', () => {
  it('KDBX 4.1（Argon2id + AES-256-CBC）完整往返：CRUD、受保护字段、TOTP、历史、回收站、附件', async () => {
    const keyFile = generateKeyFileV2(crypto);
    const vault = createVault(
      { password: 'ZeroVault-Master#2026', keyFile },
      { name: '个人金库', description: '商业测试库', ...FAST_KDBX4 },
      crypto,
    );

    const workGroup = vault.upsertGroup({ name: '工作账号', iconId: 49 });
    const created = vault.upsertEntry({
      groupId: workGroup.id,
      title: 'GitHub 企业版',
      username: 'dev@zerovault.app',
      password: 'Init#Password99!',
      url: 'https://github.com/login',
      notes: '核心代码仓库账号',
      tags: ['开发', '重要'],
      totpUri: 'otpauth://totp/GitHub:dev@zerovault.app?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
      customFields: [
        { key: 'RecoveryPin', value: '8848-9921', protected: true },
        { key: 'Org', value: 'ZeroVault', protected: false },
      ],
    });

    // 更新条目产生历史快照
    vault.upsertEntry({
      id: created.id,
      title: 'GitHub 企业版',
      username: 'dev@zerovault.app',
      password: 'New#StrongerPassword2026!',
      url: 'https://github.com/login',
    });

    // 新增附件
    const attBytes = new TextEncoder().encode('SSH-RECOVERY-KEY-DATA');
    const attMeta = vault.addAttachment(created.id, 'recovery.txt', attBytes);
    expect(attMeta.size).toBe(attBytes.byteLength);

    // 导出二进制
    const binary = await vault.serialize();
    expect(binary.byteLength).toBeGreaterThan(200);

    // 重新解密加载验证完整往返
    const reloaded = await loadVault(binary, { password: 'ZeroVault-Master#2026', keyFile }, crypto);
    expect(reloaded.format).toEqual({
      version: '4.1',
      cipher: 'aes256-cbc',
      kdf: 'argon2id',
      compression: 'gzip',
    });
    expect(reloaded.name).toBe('个人金库');

    const summaries = reloaded.listEntries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].hasPassword).toBe(true);
    expect(summaries[0].hasTotp).toBe(true);
    expect(summaries[0].tags).toEqual(['开发', '重要']);

    const detail = reloaded.getEntry(created.id);
    expect(detail.history).toHaveLength(1);
    expect(detail.customFields).toEqual([
      { key: 'otp', protected: true },
      { key: 'RecoveryPin', protected: true },
      { key: 'Org', protected: false, value: 'ZeroVault' },
    ]);
    expect(reloaded.readField(created.id, 'Password')).toBe('New#StrongerPassword2026!');
    expect(reloaded.readField(created.id, 'RecoveryPin')).toBe('8848-9921');

    const totpCfg = reloaded.readTotpConfig(created.id);
    expect(totpCfg).not.toBeNull();
    expect(computeTotp(totpCfg!, crypto).code).toMatch(/^\d{6}$/);

    const readAtt = reloaded.readAttachment(created.id, attMeta.id);
    expect(new TextDecoder().decode(readAtt)).toBe('SSH-RECOVERY-KEY-DATA');

    // 软删除进回收站与恢复
    reloaded.deleteEntry(created.id);
    expect(reloaded.listEntries({ includeRecycled: false })).toHaveLength(0);
    expect(reloaded.listEntries({ includeRecycled: true })[0].recycled).toBe(true);
    reloaded.restoreEntry(created.id, workGroup.id);
    expect(reloaded.listEntries({ includeRecycled: false })).toHaveLength(1);

    // 锁定后拒绝一切读写
    reloaded.lock();
    expect(reloaded.locked).toBe(true);
    expect(() => reloaded.listEntries()).toThrowError(VaultError);
  });

  it('完整支持空密码解锁、仅远程/本地密钥文件（password: null）与智能空密码探测', async () => {
    // 场景 A：纯空密码（无密钥文件）
    const emptyOnly = createVault({ password: '' }, { name: '空密码库', ...FAST_KDBX4 }, crypto);
    emptyOnly.upsertEntry({ title: '测试站点', username: 'u1', password: 'p1', url: 'https://a.example' });
    const emptyBytes = await emptyOnly.serialize();

    const loadedEmpty = await loadVault(emptyBytes, { password: '' }, crypto);
    expect(loadedEmpty.readField(loadedEmpty.listEntries()[0].id, 'Password')).toBe('p1');

    // 场景 B：仅密钥文件（password: null）
    const remoteKey = generateKeyFileV2(crypto);
    const keyOnlyVault = createVault({ password: null, keyFile: remoteKey }, { name: '仅密钥库', ...FAST_KDBX4 }, crypto);
    keyOnlyVault.upsertEntry({ title: '内网网关', username: 'admin', password: 'secret', url: 'https://gw.local' });
    const keyOnlyBytes = await keyOnlyVault.serialize();

    // 传入空密码 '' + keyFile 应严格失败，不与 null 混同
    await expect(loadVault(keyOnlyBytes, { password: '', keyFile: remoteKey }, crypto)).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });

    // 智能探测应先命中 no-password
    const probe1 = await loadVaultWithEmptyPasswordProbe(
      keyOnlyBytes,
      { password: null, keyFile: remoteKey, probeEmptyPasswordWithKeyFile: true },
      crypto,
    );
    expect(probe1.resolvedPasswordMode).toBe('no-password');

    // 场景 C：显式空密码 '' + 密钥文件
    const emptyPlusKey = createVault({ password: '', keyFile: remoteKey }, { name: '空密码+密钥库', ...FAST_KDBX4 }, crypto);
    const emptyPlusKeyBytes = await emptyPlusKey.serialize();
    const probe2 = await loadVaultWithEmptyPasswordProbe(
      emptyPlusKeyBytes,
      { password: null, keyFile: remoteKey, probeEmptyPasswordWithKeyFile: true },
      crypto,
    );
    expect(probe2.resolvedPasswordMode).toBe('empty-password');
  });

  it('支持 KDBX 4.0（ChaCha20 + Argon2d）与 KDBX 3.1（AES-256-CBC + AES-KDF + Salsa20）互操作', async () => {
    // KDBX 4.0 + ChaCha20 + Argon2d
    const v40 = createVault(
      { password: 'chacha-password' },
      { version: '4.0', cipher: 'chacha20', kdf: 'argon2d', ...FAST_KDBX4 },
      crypto,
    );
    const e40 = v40.upsertEntry({ title: 'ChaCha 条目', username: 'c1', password: 'pw40', url: 'https://chacha.test' });
    const b40 = await v40.serialize();
    const r40 = await loadVault(b40, { password: 'chacha-password' }, crypto);
    expect(r40.format.cipher).toBe('chacha20');
    expect(r40.format.kdf).toBe('argon2d');
    expect(r40.readField(e40.id, 'Password')).toBe('pw40');

    // KDBX 3.1
    const v31 = createVault({ password: 'kdbx31-password' }, FAST_KDBX3, crypto);
    const e31 = v31.upsertEntry({ title: '经典 3.1 条目', username: 'u31', password: 'pw31', url: 'https://v31.test' });
    v31.addAttachment(e31.id, 'note.bin', new Uint8Array([9, 8, 7, 6]));
    const b31 = await v31.serialize();
    const r31 = await loadVault(b31, { password: 'kdbx31-password' }, crypto);
    expect(r31.format.version).toBe('3.1');
    expect(r31.readField(e31.id, 'Password')).toBe('pw31');
    expect(Array.from(r31.readAttachment(e31.id, '0'))).toEqual([9, 8, 7, 6]);
  });

  it('篡改密文块时拒绝加载并抛出 INTEGRITY_FAILURE；fork 事务隔离互不影响', async () => {
    const v = createVault({ password: 'integrity-pass' }, FAST_KDBX4, crypto);
    const e = v.upsertEntry({ title: '原始条目', username: 'orig', password: 'p1', url: 'https://orig.test' });

    // fork 事务副本修改不影响主会话
    const forked = v.fork();
    forked.upsertEntry({ id: e.id, title: '副本修改', username: 'orig', url: 'https://orig.test' });
    expect(v.getEntry(e.id).title).toBe('原始条目');
    expect(forked.getEntry(e.id).title).toBe('副本修改');
    forked.lock();

    const bin = await v.serialize();
    const tampered = bin.slice();
    tampered[tampered.length - 10] ^= 0xff;
    await expect(loadVault(tampered, { password: 'integrity-pass' }, crypto)).rejects.toMatchObject({
      code: 'INTEGRITY_FAILURE',
    });
  });
});
