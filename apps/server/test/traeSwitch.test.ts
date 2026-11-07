/**
 * ACC-SW-TRAE：Trae 桌面登录态切换全链（15 条目录级快照 + 必清 + 回滚）。
 *
 * 全部走 fake 文件系统 / fake 进程 / fake vault（内存），不碰真机 Trae 目录；
 * 真机接线（能力表 switch:true + 端点 202→succeeded）在真机装有 Trae CN 时才跑（与 traeCapture.test.ts 同口径）。
 *
 * 夹具时序与真机一致：账号 A 在登录态 A 时捕获，随后客户端切成 B 并捕获 B（此刻 live=B），
 * 切换目标是 A——还原 A 的快照、核验身份回到 A。
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { encryptTcEnvelope, type AgentAdapter } from '@agentboard/adapters';
import { createApp } from '../src/index.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createTestDb, type TestDb } from './helpers.js';
import { TRAE_CLIENT_INSTANCE, TRAE_STORAGE_KEY, TraeDesktopProvider, defaultTraeStoragePath, identityHashOfStorageBytes, type TraeVault } from '../src/services/accounts/traeProvider.js';
import { accountProviderCapability } from '../src/services/accounts/registry.js';
import { ApiError } from '../src/errors.js';
import type { ClientProcessControl } from '../src/services/accounts/clientProcess.js';
import type { TraeFileSystem } from '../src/services/accounts/traeSnapshot.js';

// ---- fake 基建 ----

/** 内存文件系统：目录由文件路径隐式表达；copyFile 可注入失败计数 */
function memoryTraeFs(initial: Record<string, string | Buffer>) {
  const files = new Map<string, Buffer>();
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  for (const [key, value] of Object.entries(initial)) files.set(norm(key), Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'utf8'));
  const failures = { copy: 0 };
  const hasChildren = (key: string): boolean => {
    const prefix = `${key}/`;
    for (const k of files.keys()) if (k.startsWith(prefix)) return true;
    return false;
  };
  const fs: TraeFileSystem = {
    exists: async p => { const key = norm(p); return files.has(key) || hasChildren(key); },
    readFile: async p => {
      const value = files.get(norm(p));
      if (value === undefined) throw new Error(`ENOENT ${p}`);
      return Buffer.from(value);
    },
    writeFile: async (p, data) => { files.set(norm(p), Buffer.from(data)); },
    mkdir: async () => {},
    listDir: async p => {
      const key = norm(p);
      const names = new Map<string, boolean>();
      for (const k of files.keys()) {
        if (!k.startsWith(`${key}/`)) continue;
        const rest = k.slice(key.length + 1);
        names.set(rest.split('/')[0]!, rest.includes('/'));
      }
      return [...names].map(([name, isDirectory]) => ({ name, isDirectory }));
    },
    copyFile: async (from, to) => {
      if (failures.copy > 0) { failures.copy -= 1; throw new Error('EPERM'); }
      const value = files.get(norm(from));
      if (value === undefined) throw new Error(`ENOENT ${from}`);
      files.set(norm(to), Buffer.from(value));
    },
    remove: async p => {
      const key = norm(p);
      files.delete(key);
      const prefix = `${key}/`;
      for (const k of [...files.keys()]) if (k.startsWith(prefix)) files.delete(k);
    },
    rename: async (from, to) => {
      const f = norm(from);
      const t = norm(to);
      const movedDir = [...files.keys()].some(k => k.startsWith(`${f}/`));
      const movedFile = files.get(f);
      if (!movedDir && movedFile === undefined) throw new Error(`ENOENT ${from}`);
      if (movedFile !== undefined) { files.set(t, movedFile); files.delete(f); }
      for (const k of [...files.keys()]) {
        if (!k.startsWith(`${f}/`)) continue;
        files.set(`${t}${k.slice(f.length)}`, files.get(k)!);
        files.delete(k);
      }
    },
  };
  return { fs, files, failures, norm };
}

/** fake vault：scope 严格比对（与 SecretVault DPAPI entropy 同语义） */
class FakeTraeVault implements TraeVault {
  readonly entries = new Map<string, { data: Buffer; scope: string }>();
  readonly deletedRefs: string[] = [];
  private seq = 0;
  async protect(data: Buffer, scope: { app_id: string; client_instance_id: string; identity_hash: string; purpose: string }): Promise<string> {
    this.seq += 1;
    const ref = `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`;
    this.entries.set(ref, { data: Buffer.from(data), scope: JSON.stringify(scope) });
    return ref;
  }
  async unprotect(ref: string, scope: { app_id: string; client_instance_id: string; identity_hash: string; purpose: string }): Promise<Buffer> {
    const entry = this.entries.get(ref);
    if (!entry || entry.scope !== JSON.stringify(scope)) throw new ApiError(503, 'VAULT_READ_FAILED', '凭据不可读取或 scope 不匹配');
    return Buffer.from(entry.data);
  }
  async delete(ref: string): Promise<void> {
    this.entries.delete(ref);
    this.deletedRefs.push(ref);
  }
}

/** fake 进程：running 状态可翻转，stop/start 可注入失败 */
function fakeProcess(initialRunning: boolean): ClientProcessControl & { calls: string[]; setRunning(v: boolean): void; failNextStop(): void; failNextStart(): void } {
  const calls: string[] = [];
  let running = initialRunning;
  let stopFails = false;
  let startFails = false;
  return {
    calls,
    setRunning: v => { running = v; },
    failNextStop: () => { stopFails = true; },
    failNextStart: () => { startFails = true; },
    isRunning: async () => { calls.push('isRunning'); return running; },
    stop: async () => {
      calls.push('stop');
      if (stopFails) throw new ApiError(409, 'CLIENT_STOP_TIMEOUT', '客户端未在超时内退出');
      running = false;
    },
    start: async () => {
      calls.push('start');
      if (startFails) throw new ApiError(409, 'CLIENT_START_FAILED', '启动客户端失败');
      running = true;
    },
  };
}

// ---- 夹具 ----

const DATA = 'C:/fake/Trae CN';
const STORAGE = `${DATA}/User/globalStorage/storage.json`;
const VSCDB = `${DATA}/User/globalStorage/state.vscdb`;
const WAL = `${DATA}/User/globalStorage/state.vscdb-wal`;
const MACHINEID = `${DATA}/machineid`;
const EXE = 'C:/fake/Trae CN/Trae CN.exe';
const BACKUP_ROOT = 'C:/fake/agentboard-backups/trae-snapshots';
const jwt = (sub: string): string => `h.${Buffer.from(JSON.stringify({ sub }), 'utf8').toString('base64url')}.s`;
const envelopeFor = (token: string): string => encryptTcEnvelope({ token, host: 'https://api.trae.cn' }, Buffer.alloc(32, 5));
// 信封每次加密产生新密文：同一登录态的内容在模块级只生成一次，字节断言才有稳定基准
const STORAGE_A = JSON.stringify({ [TRAE_STORAGE_KEY]: envelopeFor(jwt('user-a')) });
const STORAGE_B = JSON.stringify({ [TRAE_STORAGE_KEY]: envelopeFor(jwt('user-b')) });
const identityOf = (sub: string, storage: string): string => {
  const hash = identityHashOfStorageBytes(Buffer.from(storage, 'utf8'));
  if (hash === null) throw new Error('fixture identity unreadable');
  void sub;
  return hash;
};

describe('trae 桌面切换 (ACC-SW-TRAE)', () => {
  let t: TestDb;
  let vault: FakeTraeVault;
  let memory: ReturnType<typeof memoryTraeFs>;
  let proc: ReturnType<typeof fakeProcess>;

  const initialFiles = (): Record<string, string | Buffer> => ({
    [STORAGE]: STORAGE_A,
    [VSCDB]: 'sqlite-main-a',
    [WAL]: 'wal-a',
    [MACHINEID]: 'machine-a',
    [`${DATA}/Preferences`]: '{}',
    [`${DATA}/aha/TinyStorage`]: 'aha-a',
    [`${DATA}/Local Storage/leveldb/000003.log`]: 'ls-a',
    [`${DATA}/Session Storage/000003.log`]: 'ss-a',
    [`${DATA}/Network/Cookies`]: 'cookies-a',
    [`${DATA}/Partitions/trae-webview/Local Storage/leveldb/000003.log`]: 'pv-a',
    [`${DATA}/Partitions/trae-webview/Cache/data_0`]: 'cache-not-identity',
    [`${DATA}/logs/trae.ai-code-completion/completion.log`]: 'PLAINTEXT JWT',
    [`${DATA}/code.lock`]: '',
    [EXE]: 'binary',
  });

  const buildProvider = (overrides: Partial<ConstructorParameters<typeof TraeDesktopProvider>[0]> = {}): TraeDesktopProvider =>
    new TraeDesktopProvider({
      db: t.db,
      vault,
      storagePath: STORAGE,
      dataDir: DATA,
      backupRoot: BACKUP_ROOT,
      clientExe: EXE,
      fs: memory.fs,
      process: proc,
      now: () => 1_700_000_000_000,
      stopSettleMs: 0,
      verifySettleTimeoutMs: 2_000,
      verifyPollMs: 10,
      ...overrides,
    });

  /** 把客户端登录态换成 sub（模拟用户在客户端里登了另一个号） */
  const loginAs = (which: 'a' | 'b'): void => {
    memory.files.set(memory.norm(STORAGE), Buffer.from(which === 'a' ? STORAGE_A : STORAGE_B, 'utf8'));
    memory.files.set(memory.norm(MACHINEID), Buffer.from(`machine-${which}`, 'utf8'));
    memory.files.set(memory.norm(VSCDB), Buffer.from(`sqlite-main-${which}`, 'utf8'));
    if (which === 'b') memory.files.delete(memory.norm(WAL)); // B 的本机状态没有 wal
  };

  /** 标准双账号夹具：A 先捕获（live=A），客户端切成 B 再捕获 B（live=B） */
  const captureBoth = async (provider: TraeDesktopProvider): Promise<{ a: Awaited<ReturnType<TraeDesktopProvider['captureCurrent']>>; b: Awaited<ReturnType<TraeDesktopProvider['captureCurrent']>> }> => {
    const a = await provider.captureCurrent();
    loginAs('b');
    const b = await provider.captureCurrent();
    return { a, b };
  };

  /** 备份根下还存活的快照目录 ref 集合 */
  const remainingBackupRefs = (): Set<string> => {
    const root = memory.norm(BACKUP_ROOT);
    return new Set([...memory.files.keys()].filter(k => k.startsWith(`${root}/`)).map(k => k.slice(root.length + 1).split('/')[0]));
  };

  /** 直接落一行账号（可指定是否带快照） */
  const insertAccountRow = (identityHash: string, snapshotRef: string | null): string => {
    const id = randomUUID();
    t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'trae','trae-desktop','cn',?,'夹具账号',NULL,?,1,1,1)`).run(id, identityHash, snapshotRef);
    return id;
  };

  beforeEach(() => {
    t = createTestDb();
    vault = new FakeTraeVault();
    memory = memoryTraeFs(initialFiles());
    proc = fakeProcess(true);
  });
  afterEach(() => { t.cleanup(); });

  it('captureCurrent 快照登录态：manifest 进 vault、备份目录镜像文件、重复捕获换 ref 删旧目录', async () => {
    const provider = buildProvider();
    const account = await provider.captureCurrent();
    expect(account.client_instance_id).toBe(TRAE_CLIENT_INSTANCE);
    expect(account.client_snapshot_ref).toMatch(/^[0-9a-f-]{36}$/);
    const snapshotDir = `${BACKUP_ROOT}/${account.client_snapshot_ref}`;
    expect(memory.files.get(memory.norm(`${snapshotDir}/User/globalStorage/storage.json`))).toBeDefined();
    expect(memory.files.get(memory.norm(`${snapshotDir}/machineid`))).toBeDefined();
    expect(memory.files.get(memory.norm(`${snapshotDir}/logs`))).toBeUndefined(); // logs 不是快照条目（必清残留）
    expect(memory.files.get(memory.norm(`${snapshotDir}/Partitions/trae-webview/Cache/data_0`))).toBeUndefined(); // 分区缓存不进快照
    expect(memory.files.get(memory.norm(`${snapshotDir}/Partitions/trae-webview/Local Storage/leveldb/000003.log`))).toBeDefined();
    // manifest 只含哈希与路径，不含 token 原文
    const manifestBytes = vault.entries.get(account.client_snapshot_ref!)!.data.toString('utf8');
    expect(manifestBytes).not.toContain(jwt('user-a'));
    expect(JSON.parse(manifestBytes)).toMatchObject({ version: 1 });

    // 重复捕获：换 ref、删旧目录与旧 manifest
    loginAs('a');
    const second = await provider.captureCurrent();
    expect(second.id).toBe(account.id);
    expect(second.client_snapshot_ref).not.toBe(account.client_snapshot_ref);
    expect(vault.deletedRefs).toContain(account.client_snapshot_ref!);
    expect(memory.files.get(memory.norm(`${snapshotDir}/machineid`))).toBeUndefined();
  }, 20000);

  it('捕获时客户端锁住登录目录 → 自动停机冷快照升级并拉回客户端（KB S0）', async () => {
    const provider = buildProvider();
    // 客户端在跑（stop 前）时 Chromium 独占持有这些目录里的文件，读直接 EBUSY
    const originalRead = memory.fs.readFile;
    memory.fs.readFile = async p => {
      const key = memory.norm(p);
      const lockedDir = ['/Session Storage/', '/Network/', '/Partitions/', '/Local Storage/'].some(seg => key.includes(seg));
      if (lockedDir && !proc.calls.includes('stop')) throw new Error('EBUSY');
      return await originalRead(p);
    };
    const account = await provider.captureCurrent();
    // 升级链：探测在跑 → 停 → 冷快照 → 拉回
    expect(proc.calls).toEqual(['isRunning', 'stop', 'start']);
    // 冷快照完整：webview 侧登录态目录都进了备份目录
    const snapshotDir = `${BACKUP_ROOT}/${account.client_snapshot_ref}`;
    expect(memory.files.get(memory.norm(`${snapshotDir}/Session Storage/000003.log`))).toBeDefined();
    expect(memory.files.get(memory.norm(`${snapshotDir}/Network/Cookies`))).toBeDefined();
    expect(memory.files.get(memory.norm(`${snapshotDir}/Partitions/trae-webview/Local Storage/leveldb/000003.log`))).toBeDefined();
    // 第一份不完整快照已被替换（备份根下只有冷快照一份）
    expect(remainingBackupRefs()).toEqual(new Set([account.client_snapshot_ref]));
    expect(memory.files.get(memory.norm(STORAGE))!.toString('utf8')).toBe(STORAGE_A); // 登录态文件未被改动
  }, 20000);

  it('切换成功全链：停机→快照→还原目标（machineid 成套）→必清 logs/code.lock/wal→start→verify→删回滚备份', async () => {
    const provider = buildProvider();
    const { a, b } = await captureBoth(provider);
    expect(await provider.getCurrentIdentityHash()).toBe(identityOf('user-b', STORAGE_B)); // live 此刻是 B

    const op = await provider.switchAccount(a.id);
    expect(op.state).toBe('succeeded');
    // live 已还原为 A 的快照内容（storage + machineid + state.vscdb 成套搬）
    expect(memory.files.get(memory.norm(STORAGE))!.toString('utf8')).toBe(STORAGE_A);
    expect(memory.files.get(memory.norm(MACHINEID))!.toString('utf8')).toBe('machine-a');
    expect(memory.files.get(memory.norm(VSCDB))!.toString('utf8')).toBe('sqlite-main-a');
    expect(await provider.getCurrentIdentityHash()).toBe(identityOf('user-a', STORAGE_A));
    // 必清：logs/（明文 JWT）与 code.lock 删除；B 的 wal 缺失，A 快照里的 wal 原样回来
    expect(memory.files.get(memory.norm(`${DATA}/logs`))).toBeUndefined();
    expect(memory.files.get(memory.norm(`${DATA}/code.lock`))).toBeUndefined();
    expect(memory.files.get(memory.norm(WAL))!.toString('utf8')).toBe('wal-a');
    // 进程：停了再拉起，verify 确认在跑
    expect(proc.calls).toEqual(['isRunning', 'stop', 'isRunning', 'start', 'isRunning']);
    // S2 回滚备份（B 的 live 状态）已删；两个账号各自的捕获快照保留
    expect(remainingBackupRefs()).toEqual(new Set([a.client_snapshot_ref, b.client_snapshot_ref]));
    expect(vault.entries.has(a.client_snapshot_ref!)).toBe(true);
    expect(vault.entries.has(b.client_snapshot_ref!)).toBe(true);
  }, 20000);

  it('切到当前同号 → 幂等成功（真机单活跃账号口径）', async () => {
    const provider = buildProvider();
    const account = await provider.captureCurrent();
    const op = await provider.switchAccount(account.id);
    expect(op.state).toBe('succeeded');
    expect(memory.files.get(memory.norm(STORAGE))!.toString('utf8')).toBe(STORAGE_A);
    expect(memory.files.get(memory.norm(MACHINEID))!.toString('utf8')).toBe('machine-a');
  }, 20000);

  it('verify 失败（客户端把登录态改回 B）→ 回滚恢复切换前状态，SWITCH_ROLLED_BACK', async () => {
    const provider = buildProvider();
    const { a } = await captureBoth(provider);
    // 模拟客户端启动后把 storage.json 写回 B（切换前 live 是 B）
    const originalStart = proc.start;
    proc.start = async () => {
      await originalStart();
      memory.files.set(memory.norm(STORAGE), Buffer.from(STORAGE_B, 'utf8'));
    };
    const op = await provider.switchAccount(a.id);
    expect(op.state).toBe('failed');
    expect(op.safe_error_code).toBe('SWITCH_ROLLED_BACK');
    // 回滚后 live 与切换前一致（S2 快照哈希校验还原），回滚前先停客户端
    expect(memory.files.get(memory.norm(STORAGE))!.toString('utf8')).toBe(STORAGE_B);
    expect(memory.files.get(memory.norm(MACHINEID))!.toString('utf8')).toBe('machine-b');
    expect(proc.calls).toEqual(['isRunning', 'stop', 'isRunning', 'start', 'stop']);
  }, 20000);

  it('start 失败 → 回滚（SWITCH_ROLLED_BACK），切换前内容恢复', async () => {
    const provider = buildProvider();
    const { a } = await captureBoth(provider);
    proc.failNextStart();
    const op = await provider.switchAccount(a.id);
    expect(op.state).toBe('failed');
    expect(op.safe_error_code).toBe('SWITCH_ROLLED_BACK');
    expect(memory.files.get(memory.norm(STORAGE))!.toString('utf8')).toBe(STORAGE_B);
    expect(proc.calls).toContain('stop'); // 回滚前先停客户端
  }, 20000);

  it('write 还原失败但自恢复成功 → SWITCH_WRITE_FAILED，实例不冻结、live 是切换前内容', async () => {
    const provider = buildProvider();
    const { a } = await captureBoth(provider);
    // 还原目标快照、往 live 写 A 的 storage.json 时失败；自恢复（写回 B 内容）放行
    const originalWrite = memory.fs.writeFile;
    memory.fs.writeFile = async (path, data) => {
      if (data.toString('utf8') === STORAGE_A) throw new Error('EACCES');
      await originalWrite(path, data);
    };
    const op = await provider.switchAccount(a.id);
    expect(op.state).toBe('failed');
    expect(op.safe_error_code).toBe('SWITCH_WRITE_FAILED');
    expect(memory.files.get(memory.norm(STORAGE))!.toString('utf8')).toBe(STORAGE_B);
    expect(memory.files.get(memory.norm(MACHINEID))!.toString('utf8')).toBe('machine-b');
    expect(op.stage).toBe('validate_target'); // 客户端目录已回到切换前：不冻结实例
  }, 20000);

  it('write 失败且自恢复也失败 → RECOVERY_REQUIRED + recovery_ref，restore 重放可解冻', async () => {
    const provider = buildProvider();
    const { a, b } = await captureBoth(provider);
    let failAllWrites = true;
    const originalWrite = memory.fs.writeFile;
    memory.fs.writeFile = async (path, data) => {
      if (failAllWrites) throw new Error('EACCES');
      await originalWrite(path, data);
    };
    const op = await provider.switchAccount(a.id);
    expect(op.state).toBe('recovery_required');
    expect(op.safe_error_code).toBe('RECOVERY_REQUIRED');
    expect(op.recovery_ref).toMatch(/^[0-9a-f-]{36}$/);
    failAllWrites = false;
    // restore 重放（账号=被冻结操作的目标账号 a，S2 快照 scope 按它构建）：还原成功 → live 回到切换前（B）
    await provider.restoreFromSnapshot({ account: a, snapshotRef: op.recovery_ref });
    expect(memory.files.get(memory.norm(STORAGE))!.toString('utf8')).toBe(STORAGE_B);
    expect(memory.files.get(memory.norm(MACHINEID))!.toString('utf8')).toBe('machine-b');
  }, 20000);

  it('verify 时进程已退出 → CLIENT_NOT_RUNNING 走回滚', async () => {
    const provider = buildProvider();
    const { a } = await captureBoth(provider);
    const originalStart = proc.start;
    proc.start = async () => { await originalStart(); proc.setRunning(false); };
    const op = await provider.switchAccount(a.id);
    expect(op.state).toBe('failed');
    expect(op.safe_error_code).toBe('SWITCH_ROLLED_BACK');
    expect(memory.files.get(memory.norm(STORAGE))!.toString('utf8')).toBe(STORAGE_B);
  }, 20000);

  it('目标账号没有快照 → SNAPSHOT_MISSING，登录态文件未被改动、S2 备份不残留', async () => {
    const provider = buildProvider();
    const { a, b } = await captureBoth(provider);
    const ghost = insertAccountRow('a'.repeat(64), null);
    const op = await provider.switchAccount(ghost);
    expect(op.state).toBe('failed');
    expect(op.safe_error_code).toBe('SNAPSHOT_MISSING');
    expect(memory.files.get(memory.norm(STORAGE))!.toString('utf8')).toBe(STORAGE_B);
    expect(proc.calls).toEqual(['isRunning', 'stop', 'isRunning']); // 停机是切换前提，但没碰登录态文件
    // S2 快照是中止时产生的回滚依据，中止即清（只留两个捕获快照）
    expect(remainingBackupRefs()).toEqual(new Set([a.client_snapshot_ref, b.client_snapshot_ref]));
  }, 20000);

  it('目标快照 manifest 损坏或缺设备字段 → TARGET_SNAPSHOT_INVALID', async () => {
    const provider = buildProvider();
    const { a } = await captureBoth(provider);
    // 损坏 A 的 manifest
    const scopeA = vault.entries.get(a.client_snapshot_ref!)!.scope;
    vault.entries.set(a.client_snapshot_ref!, { data: Buffer.from('not-json'), scope: scopeA });
    const op1 = await provider.switchAccount(a.id);
    expect(op1.state).toBe('failed');
    expect(op1.safe_error_code).toBe('TARGET_SNAPSHOT_INVALID');

    // 缺 machineid（三件套不齐）：重新捕获 A 拿新 manifest，再把 machineid 条目抹掉
    loginAs('a');
    const a2 = await provider.captureCurrent();
    const manifest = JSON.parse(vault.entries.get(a2.client_snapshot_ref!)!.data.toString('utf8')) as { entries: Array<{ path: string; status: string }> };
    manifest.entries = manifest.entries.filter(entry => entry.path !== 'machineid');
    vault.entries.set(a2.client_snapshot_ref!, { data: Buffer.from(JSON.stringify(manifest)), scope: vault.entries.get(a2.client_snapshot_ref!)!.scope });
    const op2 = await provider.switchAccount(a2.id);
    expect(op2.state).toBe('failed');
    expect(op2.safe_error_code).toBe('TARGET_SNAPSHOT_INVALID');
  }, 20000);

  it('preflight：storage.json 不存在 → TRAE_STORAGE_MISSING；exe 落空 → CLIENT_PATH_MISSING 且不动文件', async () => {
    const rowId = insertAccountRow('b'.repeat(64), null);
    const provider = buildProvider({ clientExe: undefined, probeExePath: async () => null });
    memory.files.delete(memory.norm(STORAGE));
    const op = await provider.switchAccount(rowId);
    expect(op.state).toBe('failed');
    expect(op.safe_error_code).toBe('TRAE_STORAGE_MISSING');

    loginAs('a');
    const op2 = await provider.switchAccount(rowId);
    expect(op2.state).toBe('failed');
    expect(op2.safe_error_code).toBe('CLIENT_PATH_MISSING');
    expect(memory.files.get(memory.norm(STORAGE))!.toString('utf8')).toBe(STORAGE_A);
  }, 20000);

  it('客户端停不下来 → CLIENT_STOP_TIMEOUT，登录态文件未被改动', async () => {
    const provider = buildProvider();
    await captureBoth(provider);
    proc.failNextStop();
    const ghostId = insertAccountRow('c'.repeat(64), null);
    const op = await provider.switchAccount(ghostId);
    expect(op.state).toBe('failed');
    expect(op.safe_error_code).toBe('CLIENT_STOP_TIMEOUT');
    expect(memory.files.get(memory.norm(STORAGE))!.toString('utf8')).toBe(STORAGE_B);
    expect(proc.calls).toEqual(['isRunning', 'stop']);
  }, 20000);

  it('exe 只能靠进程表探测（非默认盘安装位）→ 切换走通', async () => {
    const provider = buildProvider({ clientExe: undefined, probeExePath: async () => 'D:/Program Files/Trae CN/Trae CN.exe' });
    const account = await provider.captureCurrent();
    const op = await provider.switchAccount(account.id);
    expect(op.state).toBe('succeeded');
    expect(proc.calls).toContain('start');
    expect(memory.files.get(memory.norm(STORAGE))!.toString('utf8')).toBe(STORAGE_A);
  }, 20000);
});

describe('registry trae 行推导 (ACC-SW-TRAE)', () => {
  it('storage.json 在 → capture/switch 可用（OK）；不在 → 双关 + TRAE_STORAGE_MISSING', () => {
    expect(accountProviderCapability('trae', undefined, true)).toMatchObject({ capture: true, switch: true, checkin: true, reason_code: 'OK' });
    expect(accountProviderCapability('trae', undefined, false)).toMatchObject({ capture: false, switch: false, checkin: true, reason_code: 'TRAE_STORAGE_MISSING' });
  });
});

describe('trae 切换端点接线（RULE-3，真机装有 Trae CN 时才跑）', () => {
  let t2: TestDb;
  let vault2: FakeTraeVault;
  beforeEach(() => { t2 = createTestDb(); vault2 = new FakeTraeVault(); });
  afterEach(() => { t2.cleanup(); });

  it('能力表 trae switch:true + POST /switch 同号幂等切换 202→succeeded', async () => {
    if (!existsSync(defaultTraeStoragePath())) return; // 本机没装 Trae：跳过（不算失败）
    const realStorage = readFileSync(defaultTraeStoragePath());
    const memory2 = memoryTraeFs({
      [STORAGE]: realStorage,
      [VSCDB]: 'sqlite-fixture',
      [MACHINEID]: 'machine-fixture',
      [EXE]: 'binary',
    });
    const proc2 = fakeProcess(true);
    const provider = new TraeDesktopProvider({
      db: t2.db, vault: vault2, storagePath: STORAGE, dataDir: DATA, backupRoot: 'C:/fake/agentboard-route-backups',
      clientExe: EXE, fs: memory2.fs, process: proc2, stopSettleMs: 0, verifySettleTimeoutMs: 2_000, verifyPollMs: 10,
    });
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t2.db,
      getAdapter: (id: string): AgentAdapter => { if (id === 'fake') return adapter; throw new Error(`未知适配器 id: ${id}`); },
      adapters: [adapter],
      refreshClisOnBoot: false,
      desktopProviders: { trae: provider },
    });
    const capabilities = await request(created.app).get('/api/managed-account-capabilities?app=trae');
    expect(capabilities.status).toBe(200);
    expect(capabilities.body[0]).toMatchObject({ capture: true, switch: true });

    const captured = await request(created.app).post('/api/managed-accounts/trae/capture-current').send({});
    expect(captured.status).toBe(200);
    const accountId = captured.body.account.id as string;

    const switched = await request(created.app).post(`/api/managed-accounts/${accountId}/switch`).send({});
    expect(switched.status).toBe(202);
    expect(switched.body.operation_id).toMatch(/^[0-9a-f-]{36}$/);
    let final: { state: string; safe_error_code: string | null } | null = null;
    for (let i = 0; i < 200; i++) {
      const op = await request(created.app).get(`/api/account-operations/${switched.body.operation_id}`);
      if (['succeeded', 'failed', 'recovery_required'].includes(op.body.state)) { final = op.body; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(final).not.toBeNull();
    expect(final!.state, `operation safe_error_code=${final!.safe_error_code}`).toBe('succeeded');
    // 同号幂等切换：live storage.json 与真机原内容逐字节一致
    expect(memory2.files.get(memory2.norm(STORAGE))!.equals(realStorage)).toBe(true);
  }, 40000);
});
