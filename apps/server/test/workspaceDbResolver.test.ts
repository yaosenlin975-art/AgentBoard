/**
 * STORE-1（M1）：按工作区选库的**判定表**与每工作区锁。
 *
 * 本卡只验「解析层 + 判定」：不改任何业务数据、不建库、不搬数据。
 * 判定表的四档输入：中心 `db_mode` × 工作区库文件 × 库内 `meta`（localized / workspace_id）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decideWorkspaceDb,
  listOpenWorkspaceDbs,
  readWorkspaceMeta,
  resetResolverState,
  workspaceDbPath,
  workspaceStateDir,
} from '../src/db/resolver.js';
import { createTestDb, type TestDb } from './helpers.js';
import { acquireServerLock, releaseServerLock } from '../src/services/serverLock.js';
import { initSchema } from '../src/db/schema.js';

describe('STORE-1（M1）按工作区选库：判定表', () => {
  const CENTER = 'C:/center/agentboard.db';
  const WS_ID = 'ws-1';
  let root: string;
  let wsPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentboard-store1-'));
    wsPath = join(root, 'workspace');
    mkdirSync(wsPath, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  const decide = (over: Partial<Parameters<typeof decideWorkspaceDb>[0]> = {}) => decideWorkspaceDb({
    workspaceId: WS_ID,
    workspacePath: wsPath,
    centerDbMode: 'center',
    centerDbPath: CENTER,
    ...over,
  });

  it('① 无 .agentboard/agentboard.db → 走中心库、无错误（与现状一致）', () => {
    const d = decide();
    expect(d).toMatchObject({ target: 'center', dbPath: CENTER, error: null });
    expect(d.reason).toContain('未下沉');
  });

  it('② 文件在但 meta.localized=0 → 中间态：读中心库 + WORKSPACE_DB_MIGRATING', () => {
    const d = decide({ fileExists: () => true, readMeta: () => ({ localized: false, workspaceId: WS_ID }) });
    expect(d).toMatchObject({ target: 'center', dbPath: CENTER, error: 'WORKSPACE_DB_MIGRATING' });
  });

  it('② 文件在但读不到 meta（损坏/无 meta 表）→ 同样按中间态处理', () => {
    const d = decide({ fileExists: () => true, readMeta: () => null });
    expect(d.error).toBe('WORKSPACE_DB_MIGRATING');
  });

  it('③ 中心=localized 但文件缺失 → WORKSPACE_DB_MISSING，且**不回退**中心库路径以外的东西', () => {
    const d = decide({ centerDbMode: 'localized', fileExists: () => false });
    expect(d).toMatchObject({ error: 'WORKSPACE_DB_MISSING' });
    expect(d.reason).toContain('不回退');
  });

  it('③ 文件在 + meta.localized=1 + id 匹配 → 走工作区库（路径 = <ws>/.agentboard/agentboard.db）', () => {
    const d = decide({ centerDbMode: 'localized', fileExists: () => true, readMeta: () => ({ localized: true, workspaceId: WS_ID }) });
    expect(d).toMatchObject({ target: 'workspace', dbPath: workspaceDbPath(wsPath), error: null });
  });

  it('④ 文件在但库内 workspace_id 与目录不一致 → WORKSPACE_DB_ID_MISMATCH', () => {
    const d = decide({ fileExists: () => true, readMeta: () => ({ localized: true, workspaceId: 'other-ws' }) });
    expect(d).toMatchObject({ error: 'WORKSPACE_DB_ID_MISMATCH' });
  });

  it('判定优先级：中心=localized + 文件缺失 > 其它一切（先报缺失）', () => {
    const d = decide({ centerDbMode: 'localized', fileExists: () => false, readMeta: () => ({ localized: true, workspaceId: WS_ID }) });
    expect(d.error).toBe('WORKSPACE_DB_MISSING');
  });

  it('真实读取 meta：initSchema 出来的库没有 meta 表 → localized=false，不抛', () => {
    const { db, cleanup } = createTestDb();
    try {
      const meta = readWorkspaceMeta(db.name);
      expect(meta).toEqual({ localized: false, workspaceId: null });
    } finally {
      cleanup();
    }
  });

  it('真实读取 meta：手写 meta 表读到 localized/workspace_id', () => {
    const dbPath = join(wsPath, '.agentboard', 'agentboard.db');
    mkdirSync(join(wsPath, '.agentboard'), { recursive: true });
    const db = new Database(dbPath);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO meta (key, value) VALUES ('localized','1'), ('workspace_id','ws-1')").run();
    db.close();
    expect(readWorkspaceMeta(dbPath)).toEqual({ localized: true, workspaceId: 'ws-1' });
  });
});

describe('STORE-1（M1）每工作区锁：同一工作区库只允许一个活实例打开', () => {
  let t: TestDb;
  let root: string;
  beforeEach(() => {
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-store1-lock-'));
  });
  afterEach(() => {
    resetResolverState();
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('第二实例在同一 .agentboard 上取锁被拒（活持有者存在）；持有者死后可接管', () => {
    const wsPath = join(root, 'ws');
    const stateDir = workspaceStateDir(wsPath);
    mkdirSync(stateDir, { recursive: true });
    const first = acquireServerLock({ configDir: stateDir, dbPath: join(stateDir, 'agentboard.db'), port: 1887, pid: 1111, instanceId: 'inst-a' });
    expect(first.ok).toBe(true);
    // 另一个活进程（不同 pid）想打开同一个工作区库 → 拒绝
    const second = acquireServerLock({ configDir: stateDir, dbPath: join(stateDir, 'agentboard.db'), port: 1888, pid: 2222, instanceId: 'inst-b', alive: (pid) => pid === 1111 });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('held-by-live');
    // 持有者死后可接管（与 server.lock 同一套陈旧锁语义）
    const takeover = acquireServerLock({ configDir: stateDir, dbPath: join(stateDir, 'agentboard.db'), port: 1888, pid: 3333, instanceId: 'inst-c', alive: () => false });
    expect(takeover.ok).toBe(true);
    if (takeover.ok) expect(takeover.tookOver?.pid).toBe(1111);
    releaseServerLock(stateDir, { pid: 3333, instanceId: 'inst-c' });
  });

  it('句柄与可观测列表：未打开任何工作区库时为空（M1 不改数据、不预开库）', () => {
    expect(listOpenWorkspaceDbs()).toEqual([]);
  });
});

