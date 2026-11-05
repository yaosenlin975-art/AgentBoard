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
  closeWorkspaceDbs,
  decideWorkspaceDb,
  getDbForWorkspace,
  listOpenWorkspaceDbs,
  locateDbByScan,
  readWorkspaceMeta,
  resetResolverState,
  workspaceDbPath,
  workspaceStateDir,
  type ResolverDeps,
  type WorkspaceLike,
} from '../src/db/resolver.js';
import { wireWorkspaceDbCloseOnExit } from '../src/index.js';
import { createTestDb, type TestDb } from './helpers.js';
import { acquireServerLock, releaseServerLock } from '../src/services/serverLock.js';
import { initSchema } from '../src/db/schema.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { assertWorkspaceDbWritable } from '../src/db/resolver.js';

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

  it('②（D4）中心 db_mode=failed：即使 meta.localized=1 也不放行工作区库（读中心库、写阻断）', () => {
    const d = decide({ centerDbMode: 'failed', fileExists: () => true, readMeta: () => ({ localized: true, workspaceId: WS_ID }) });
    expect(d).toMatchObject({ target: 'center', dbPath: CENTER, error: 'WORKSPACE_DB_MIGRATING' });
    expect(d.reason).toContain('failed');
  });

  it('② 中心 db_mode=localizing：迁移进行中，目标库未建好也冻结写（读中心库、WORKSPACE_DB_MIGRATING）', () => {
    const d = decide({ centerDbMode: 'localizing', fileExists: () => false });
    expect(d).toMatchObject({ target: 'center', dbPath: CENTER, error: 'WORKSPACE_DB_MIGRATING' });
  });

  it('②（D3）文件在但打不开（损坏/非 SQLite）→ WORKSPACE_DB_UNREADABLE，不再归 MIGRATING；读不得静默回退中心库', () => {
    const d = decide({ fileExists: () => true, readMeta: () => null });
    expect(d).toMatchObject({ target: 'center', dbPath: CENTER, error: 'WORKSPACE_DB_UNREADABLE' });
    // getDbForWorkspace 对非 MIGRATING 错误直接抛（读路径报错，不回退中心库）
    expect(() => getDbForWorkspace(
      { centerDb: { name: CENTER } as never, instanceId: 'inst-d3', port: 0, fileExists: () => true, readMeta: () => null },
      { id: WS_ID, path: wsPath, dbMode: 'center' },
    )).toThrow(/打不开|损坏/);
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

  it('④（D5）localized=1 但库内 workspace_id 缺失（null）→ 不再直接放行，按身份不明拒绝打开', () => {
    const d = decide({ fileExists: () => true, readMeta: () => ({ localized: true, workspaceId: null }) });
    expect(d).toMatchObject({ target: 'center', error: 'WORKSPACE_DB_ID_MISMATCH' });
    expect(d.reason).toContain('缺失');
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
  let ws: string;
  beforeEach(() => {
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-store1-lock-'));
    ws = createWorkspace(t.db, { name: '锁区', path: join(root, 'unused') }).id;
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

  it('localized_open[] 扩展：读路径首开记 read，写闸门首开记 first-write；M2 只记录不回收（reclaimable=false）', () => {
    const wsPath = join(root, 'ws-open');
    mkdirSync(join(wsPath, '.agentboard'), { recursive: true });
    const dbPath = workspaceDbPath(wsPath);
    const wsDb = new Database(dbPath);
    wsDb.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    wsDb.prepare("INSERT INTO meta (key, value) VALUES ('workspace_id', ?), ('localized','1')").run(ws);
    wsDb.close();
    t.db.prepare("UPDATE workspace SET db_mode='localized', path=? WHERE id=?").run(wsPath, ws);

    const read = getDbForWorkspace({ centerDb: t.db, instanceId: 'inst-open', port: 0, openWorkspaceDbs: true }, { id: ws, path: wsPath, dbMode: 'localized' });
    const opened = listOpenWorkspaceDbs();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ workspaceId: ws, dbPath, openReason: 'read', reclaimable: false });
    expect(opened[0]!.openedAt).toBeGreaterThan(0);
    read.db.close();
    resetResolverState();

    const write = assertWorkspaceDbWritable({ centerDb: t.db, instanceId: 'inst-open2', port: 0, openWorkspaceDbs: true }, { id: ws, path: wsPath, dbMode: 'localized' });
    expect(write.target).toBe('workspace');
    expect(listOpenWorkspaceDbs()[0]).toMatchObject({ workspaceId: ws, openReason: 'first-write', reclaimable: false });
    closeWorkspaceDbs('inst-open2');
    expect(listOpenWorkspaceDbs()).toEqual([]);
  });

  it('（D6）closeWorkspaceDbs 已接线服务退出：退出钩子关闭全部句柄并清空 localized_open', () => {
    const wsPath = join(root, 'ws-d6');
    mkdirSync(join(wsPath, '.agentboard'), { recursive: true });
    const dbPath = workspaceDbPath(wsPath);
    const wsDb = new Database(dbPath);
    wsDb.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    wsDb.prepare("INSERT INTO meta (key, value) VALUES ('workspace_id', ?), ('localized','1')").run(ws);
    wsDb.close();
    t.db.prepare("UPDATE workspace SET db_mode='localized', path=? WHERE id=?").run(wsPath, ws);

    const { db: handle } = getDbForWorkspace({ centerDb: t.db, instanceId: 'inst-d6', port: 0, openWorkspaceDbs: true }, { id: ws, path: wsPath, dbMode: 'localized' });
    expect(handle.open).toBe(true);

    let exitHook: (() => void) | undefined;
    wireWorkspaceDbCloseOnExit('inst-d6', (hook) => { exitHook = hook; });
    expect(exitHook).toBeTypeOf('function');
    exitHook!();

    expect(handle.open).toBe(false);
    expect(listOpenWorkspaceDbs()).toEqual([]);
  });
});


describe('STORE-4a（M3）locateDbByScan：entity_locator（4b）落地前的按 id fan-out 定位', () => {
  let t: TestDb;
  let root: string;
  let wsPath: string;
  let ws: string;
  beforeEach(() => {
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-store4a-locate-'));
    wsPath = join(root, 'ws');
    mkdirSync(join(wsPath, '.agentboard'), { recursive: true });
    ws = createWorkspace(t.db, { name: '扫描区', path: wsPath }).id;
  });
  afterEach(() => {
    closeWorkspaceDbs('scan-test');
    resetResolverState();
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const mkLocalizedWsDb = (): void => {
    const dbPath = workspaceDbPath(wsPath);
    const db = new Database(dbPath);
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare("INSERT INTO meta (key, value) VALUES ('workspace_id', ?), ('localized','1')").run(ws);
    db.close();
    t.db.prepare("UPDATE workspace SET db_mode='localized' WHERE id=?").run(ws);
  };
  const deps = (): ResolverDeps => ({ centerDb: t.db, instanceId: 'scan-test', port: 0, openWorkspaceDbs: true });
  const candidate = (): WorkspaceLike => ({ id: ws, path: wsPath, dbMode: 'localized' });

  it('中心命中即中心（不打开任何工作区库）', () => {
    const row = { marker: 'center-hit' };
    const hit = locateDbByScan(deps(), [candidate()], (db) => (db === t.db ? row : null));
    expect(hit).not.toBeNull();
    expect(hit!.db).toBe(t.db);
    expect(hit!.value).toEqual(row);
    expect(listOpenWorkspaceDbs()).toEqual([]);
  });

  it('中心未中 → fan-out 工作区库命中（首开句柄进缓存，openReason=read）', () => {
    mkLocalizedWsDb();
    const hit = locateDbByScan(deps(), [candidate()], (db) => (db !== t.db ? { marker: 'ws-hit' } : null));
    expect(hit).not.toBeNull();
    expect(hit!.db).not.toBe(t.db);
    expect(hit!.value).toEqual({ marker: 'ws-hit' });
    expect(listOpenWorkspaceDbs()[0]).toMatchObject({ workspaceId: ws, openReason: 'read' });
  });

  it('全部未中 → null；候选区打不开（localized 但文件缺失）→ 扫描完原样抛 WORKSPACE_DB_MISSING，不伪装 404', () => {
    expect(locateDbByScan(deps(), [], () => null)).toBeNull();
    mkLocalizedWsDb();
    rmSync(workspaceDbPath(wsPath), { force: true });
    expect(() => locateDbByScan(deps(), [candidate()], () => null)).toThrow();
    try {
      locateDbByScan(deps(), [candidate()], () => null);
      expect.unreachable('应抛出判定错误');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('WORKSPACE_DB_MISSING');
    }
  });

  it('有命中时忽略其它候选区的打开失败（坏区在前面也先扫过再命中好区）', () => {
    mkLocalizedWsDb();
    const badPath = join(root, 'bad');
    mkdirSync(join(badPath, '.agentboard'), { recursive: true });
    const badWs = createWorkspace(t.db, { name: '坏区', path: badPath }).id;
    t.db.prepare("UPDATE workspace SET db_mode='localized' WHERE id=?").run(badWs);
    writeFileSync(join(badPath, '.agentboard', 'agentboard.db'), 'not a sqlite file');

    const hit = locateDbByScan(
      deps(),
      [{ id: badWs, path: badPath, dbMode: 'localized' }, candidate()],
      (db) => (db.name === workspaceDbPath(wsPath) ? { marker: 'good' } : null),
    );
    expect(hit).not.toBeNull();
    expect(hit!.value).toEqual({ marker: 'good' });
    expect(hit!.db.name).toBe(workspaceDbPath(wsPath));
  });
});
