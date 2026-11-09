/**
 * STATUS-1：状态模型迁移与 workspace_status 字典。
 *
 * 覆盖：
 * - 存量库（issue.status 带 CHECK 枚举）→ 重建为无 CHECK + due_date/due_time，数据与触发器/索引保留；
 * - 迁移前备份 `.pre-status-migration.<ts>`，迁移幂等（第二次不再备份）；
 * - 每个工作区种入 5 条内置状态（既有工作区补齐、新工作区同步种入）；
 * - 写入非法 status → 400 且文案列出可用状态；内置状态写入正常、claim/done 流转不变。
 */
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { mkdtempSync as mkTmp } from 'node:fs';
import { openDb, type Db } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';
import { migrateIssueStatusModel } from '../src/db/migrations/issueStatusModel.js';
import { migrateWorkspaceStatusKinds } from '../src/db/migrations/workspaceStatus.js';
import { createTestDb, type TestDb, issuePayload } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';

/** 迁移前（旧）四表 + issue_comment 的最小结构；issue 的 status 仍带 CHECK 枚举 */
const LEGACY_DDL = `
CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE issue (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT '中' CHECK (priority IN ('低','中','高')),
  labels TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT '待规划' CHECK (status IN ('待规划','进行中','待验收','已关闭')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT, claimed_at INTEGER, session_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE issue_comment (
  id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
  author TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE session (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  issue_id TEXT REFERENCES issue(id) ON DELETE SET NULL,
  cli TEXT NOT NULL, model TEXT, status TEXT NOT NULL DEFAULT '运行中'
    CHECK (status IN ('运行中','已结束','失败')),
  adapter_session_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE message (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','event','error')),
  content TEXT NOT NULL, ts INTEGER NOT NULL);
`;

const objectNames = (db: Db): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
    .map(row => row.name);

describe('status model migration (STATUS-1)', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentboard-status-migration-'));
    db = openDb(join(dir, 'legacy.db'));
    db.exec(LEGACY_DDL);
    const now = 1_700_000_000_000;
    db.prepare('INSERT INTO workspace (id, name, path, created_at) VALUES (?,?,?,?)').run('ws-legacy', '老空间', 'D:\\legacy', now);
    const insert = db.prepare(`INSERT INTO issue (id, workspace_id, title, description, priority, labels, status, sort_order, created_at, updated_at)
      VALUES (?,?,?,?,'中','[]',?,0,?,?)`);
    insert.run('i-open', 'ws-legacy', '待规划卡', '', '待规划', now, now);
    insert.run('i-started', 'ws-legacy', '进行中卡', '', '进行中', now + 1, now + 1);
    insert.run('i-review', 'ws-legacy', '待验收卡', '', '待验收', now + 2, now + 2);
    insert.run('i-closed', 'ws-legacy', '已关闭卡', '', '已关闭', now + 3, now + 3);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('rebuildsThePinnedIssueTableAndKeepsData', () => {    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name='issue'").get() as { sql: string }).sql)
      .toMatch(/CHECK\s*\(\s*status\s+IN/i);

    initSchema(db);

    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='issue'").get() as { sql: string }).sql;
    expect(sql).not.toMatch(/CHECK\s*\(\s*status\s+IN/i);
    const columns = (db.prepare('PRAGMA table_info(issue)').all() as Array<{ name: string }>).map(row => row.name);
    expect(columns).toEqual(expect.arrayContaining(['due_date', 'due_time', 'parent_issue_id', 'last_seen_comment_id']));

    // 数据与状态原样保留
    const rows = db.prepare('SELECT id, status, due_date, due_time FROM issue ORDER BY created_at').all() as Array<Record<string, unknown>>;
    expect(rows.map(row => row.status)).toEqual(['待规划', '进行中', '待验收', '已关闭']);
    expect(rows.every(row => row.due_date === null && row.due_time === null)).toBe(true);
    expect(rows).toHaveLength(4);

    // 索引与触发器随重建恢复
    const names = objectNames(db);
    expect(names).toEqual(expect.arrayContaining([
      'issue_parent_order',
      'issue_parent_same_workspace_insert',
      'issue_parent_same_workspace_update',
      'issue_parent_no_cycle_update',
      'issue_monotonic_time',
    ]));
    // 触发器真的生效：updated_at 单调递增
    db.prepare("UPDATE issue SET updated_at=1 WHERE id='i-open'").run();
    expect((db.prepare("SELECT updated_at FROM issue WHERE id='i-open'").get() as { updated_at: number }).updated_at).toBeGreaterThan(1);
    // FK 仍然连着 issue（子表 → issue 的级联可用）
    db.prepare("INSERT INTO issue_comment (id, issue_id, author, content, ts) VALUES ('c1','i-open','user','hi',1)").run();
    db.prepare("DELETE FROM issue WHERE id='i-open'").run();
    expect((db.prepare("SELECT COUNT(*) AS n FROM issue_comment WHERE issue_id='i-open'").get() as { n: number }).n).toBe(0);
  });

  it('backsUpOnceAndIsIdempotent', () => {
    const first = migrateIssueStatusModel(db, 1_700_000_111_111);
    expect(first).toMatchObject({ migrated: true, rowCount: 4 });
    expect(first.backupPath).toContain('.pre-status-migration.1700000111111');
    expect(readdirSync(dir).some(name => name.includes('.pre-status-migration.'))).toBe(true);

    const second = migrateIssueStatusModel(db, 1_700_000_222_222);
    expect(second).toEqual({ migrated: false, backupPath: null, rowCount: 0 });
    // 只有第一次那份备份
    expect(readdirSync(dir).filter(name => name.includes('.pre-status-migration.'))).toHaveLength(1);
    initSchema(db); // 再跑一遍完整初始化也不能再备份
    expect(readdirSync(dir).filter(name => name.includes('.pre-status-migration.'))).toHaveLength(1);
  });

  it('survivesTriggersOnOtherTablesThatReferenceIssue', () => {
    // 实测踩到的坑：`issue_dependency_*` 触发器挂在别的表上却引用 issue，
    // `DROP TABLE issue` 时 SQLite 会重新解析它们并报 no such table: main.issue。
    db.exec(`
      CREATE TABLE issue_dependency (
        blocked_issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
        blocker_issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (blocked_issue_id, blocker_issue_id));
      CREATE TRIGGER issue_dependency_same_workspace BEFORE INSERT ON issue_dependency
        WHEN NOT EXISTS (SELECT 1 FROM issue blocked JOIN issue blocker ON blocker.id = new.blocker_issue_id
          WHERE blocked.id = new.blocked_issue_id AND blocked.workspace_id = blocker.workspace_id)
        BEGIN SELECT RAISE(ABORT,'issue dependency workspace mismatch'); END;
    `);

    expect(migrateIssueStatusModel(db, 1_700_000_333_333).migrated).toBe(true);

    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='issue_dependency_same_workspace'")
      .get() as { sql?: string } | undefined;
    expect(trigger?.sql).toContain('issue dependency workspace mismatch');
    // 装回后仍然生效：跨工作区建边被触发器拦住
    db.prepare('INSERT INTO workspace (id, name, path, created_at) VALUES (?,?,?,?)').run('ws-other', '别处', 'D:\\other', 1);
    db.prepare("INSERT INTO issue (id, workspace_id, title, description, priority, labels, status, sort_order, created_at, updated_at) VALUES ('i-other','ws-other','外区卡','','中','[]','待规划',0,1,1)").run();
    expect(() => db.prepare('INSERT INTO issue_dependency (blocked_issue_id, blocker_issue_id, created_at) VALUES (?,?,?)')
      .run('i-open', 'i-other', 1)).toThrow(/workspace mismatch/);
    db.prepare('INSERT INTO issue_dependency (blocked_issue_id, blocker_issue_id, created_at) VALUES (?,?,?)').run('i-open', 'i-started', 1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM issue_dependency').get() as { n: number }).n).toBe(1);
  });

  it('rebuildsLegacyWorkspaceStatusCheckToAcceptBlocked', () => {
    // 旧版 workspace_status：CHECK 只有五 kind，blocked 写不进去
    db.exec(`
      CREATE TABLE workspace_status (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('open','started','review','done','deprecated')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_builtin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE (workspace_id, name));
    `);
    const now = 1_700_000_000_000;
    let insert = db.prepare('INSERT INTO workspace_status (id, workspace_id, name, kind, sort_order, is_builtin, created_at) VALUES (?,?,?,?,?,?,?)');
    insert.run('builtin-ws-legacy-open', 'ws-legacy', '待规划', 'open', 0, 1, now);
    insert.run('custom-review', 'ws-legacy', '等外部确认', 'review', 50, 0, now + 1);
    expect(() => insert.run('custom-blocked', 'ws-legacy', '阻塞卡', 'blocked', 60, 0, now + 2)).toThrow(/CHECK/);

    const before = db.prepare('SELECT id, name, kind, sort_order, is_builtin, created_at FROM workspace_status ORDER BY id').all();

    expect(migrateWorkspaceStatusKinds(db)).toBe(true);
    // 存量行（含 id/kind/sort_order/created_at）原样保留
    expect(db.prepare('SELECT id, name, kind, sort_order, is_builtin, created_at FROM workspace_status ORDER BY id').all()).toEqual(before);
    // 幂等：新 CHECK 已含 blocked，不再重建
    expect(migrateWorkspaceStatusKinds(db)).toBe(false);

    insert = db.prepare('INSERT INTO workspace_status (id, workspace_id, name, kind, sort_order, is_builtin, created_at) VALUES (?,?,?,?,?,?,?)');
    insert.run('custom-blocked', 'ws-legacy', '阻塞卡', 'blocked', 60, 0, now + 2);
    expect((db.prepare("SELECT kind FROM workspace_status WHERE id='custom-blocked'").get() as { kind: string }).kind).toBe('blocked');
    // CHECK 约束仍生效：非法 kind 照旧被拒
    expect(() => insert.run('custom-bad', 'ws-legacy', '乱写', 'nope', 70, 0, now + 3)).toThrow(/CHECK/);
    // 完整初始化后内置五状态不会被迁移重复种入
    initSchema(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM workspace_status WHERE workspace_id=?').get('ws-legacy') as { n: number }).n).toBe(7);
  });

  it('seedsFiveBuiltinStatusesForEveryWorkspace', () => {
    initSchema(db);
    const seeded = db.prepare('SELECT name, kind, sort_order, is_builtin FROM workspace_status WHERE workspace_id=? ORDER BY sort_order')
      .all('ws-legacy') as Array<{ name: string; kind: string; sort_order: number; is_builtin: number }>;
    expect(seeded).toEqual([
      { name: '待规划', kind: 'open', sort_order: 0, is_builtin: 1 },
      { name: '进行中', kind: 'started', sort_order: 10, is_builtin: 1 },
      { name: '待验收', kind: 'review', sort_order: 20, is_builtin: 1 },
      { name: '已关闭', kind: 'done', sort_order: 30, is_builtin: 1 },
      { name: '已废弃', kind: 'deprecated', sort_order: 40, is_builtin: 1 },
    ]);
    // 幂等：重复初始化不产生重复种子
    initSchema(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM workspace_status WHERE workspace_id=?').get('ws-legacy') as { n: number }).n).toBe(5);
  });
});

describe('workspace status dictionary on a fresh database', () => {
  let t: TestDb;
  let app: Express;
  let spaceDir: string;
  let workspaceId: string;

  const mkIssue = async (title: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const res = await request(app).post('/api/issues').send(issuePayload(workspaceId, { title, ...extra }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as Record<string, unknown>;
  };

  beforeEach(async () => {
    t = createTestDb();
    spaceDir = mkTmp(join(tmpdir(), 'agentboard-status-space-'));
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => {
        if (id === 'fake') return adapter;
        throw new Error(`未知适配器 id: ${id}`);
      },
      adapters: [adapter],
      refreshClisOnBoot: false,
    });
    app = created.app;
    workspaceId = createWorkspace(t.db, { name: '状态空间', path: spaceDir }).id;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(spaceDir, { recursive: true, force: true });
  });

  it('seedsBuiltinStatusesWhenWorkspaceIsCreated', () => {
    const rows = t.db.prepare('SELECT name FROM workspace_status WHERE workspace_id=? ORDER BY sort_order').all(workspaceId) as Array<{ name: string }>;
    expect(rows.map(row => row.name)).toEqual(['待规划', '进行中', '待验收', '已关闭', '已废弃']);
    expect(readdirSync(join(spaceDir, '..')).filter(name => name.includes('.pre-status-migration.'))).toHaveLength(0);
  });

  it('acceptsBuiltinStatusWritesAndRejectsUnknownOnes', async () => {
    const issue = await mkIssue('状态写入');
    const ok = await request(app).patch(`/api/issues/${issue.id}`).send({ status: '已废弃' }).set('Content-Type', 'application/json');
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('已废弃');

    const bad = await request(app).patch(`/api/issues/${issue.id}`).send({ status: '乱写的状态' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('必须是本工作区已定义的状态');
    expect(bad.body.error.message).toContain('已废弃');
    // 拒绝后状态未被改动
    expect((t.db.prepare('SELECT status FROM issue WHERE id=?').get(issue.id) as { status: string }).status).toBe('已废弃');
  });

  it('keepsDueDateAndDueTimeFields', async () => {
    const issue = await mkIssue('带截止', { due_date: '2026-11-10', due_time: '14:30' });
    expect(issue).toMatchObject({ due_date: '2026-11-10', due_time: '14:30' });
    const cleared = await request(app).patch(`/api/issues/${issue.id}`).send({ due_date: null, due_time: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ due_date: null, due_time: null });
    const badFormat = await request(app).patch(`/api/issues/${issue.id}`).send({ due_date: '2026/11/10' });
    expect(badFormat.status).toBe(400);
  });

  it('keepsClaimAndDoneFlowUnchanged', async () => {
    const issue = await mkIssue('流转卡');
    const claim = await request(app).post(`/api/issues/${issue.id}/claim`).send({ agent_id: 'fake' });
    expect(claim.status).toBe(200);
    expect(claim.body.status).toBe('进行中');
    const done = await request(app).post(`/api/issues/${issue.id}/done`).send({ workspace_id: workspaceId, agent_id: 'fake', notes: '' });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('待验收');
    // done 已释放占用；fail 用另一张卡验证「进行中 → 待规划」同样不受状态校验影响
    const second = await mkIssue('流转卡二');
    expect((await request(app).post(`/api/issues/${second.id}/claim`).send({ agent_id: 'fake' })).status).toBe(200);
    const fail = await request(app).post(`/api/issues/${second.id}/fail`).send({ workspace_id: workspaceId, agent_id: 'fake', reason: '回退' });
    expect(fail.status).toBe(200);
    expect(fail.body.status).toBe('待规划');
  });
});

/** 空文件占位不需要，仅确保 writeFileSync 导入被使用（夹具里写临时标记时用到） */
void writeFileSync;
