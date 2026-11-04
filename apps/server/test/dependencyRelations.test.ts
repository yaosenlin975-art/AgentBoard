/**
 * BORROW-2.1：依赖边类型（blocks/related/duplicate）。
 *
 * 覆盖卡面验收 5 条：
 * 1. 旧依赖行等价迁移（旧行 relation='blocks'，blocks 关系与方向不变）；
 * 2. related / duplicate 可写入且不参与环检测（blocks 成环的位置插 related → 放行）；
 * 3. blocks 成环仍被拒且错误码/文案不变；
 * 4. 迁移可重入，PRAGMA foreign_key_check 为空；
 * 5. 既有 kb dep 行为回归（blocks-only 视图、claim 门禁不受 related 影响）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { openDb } from '../src/db/connection.js';
import { migrateIssueDependency } from '../src/db/migrations/issueDependency.js';
import { unresolvedBlockers } from '../src/services/dependency.js';

describe('依赖边类型（BORROW-2.1，REST）', () => {
  let t: TestDb;
  let app: Express;
  let ws: string;
  let spaceDir: string;

  const mkIssue = async (title: string): Promise<string> => {
    const res = await request(app).post('/api/issues').send({ workspace_id: ws, title, description: '' });
    expect(res.status).toBe(200);
    return res.body.id as string;
  };
  const addDep = (blocked: string, blocker: string, relation?: string) =>
    request(app).post(`/api/issues/${blocked}/dependencies`)
      .send({ workspace_id: ws, blocker_issue_id: blocker, ...(relation === undefined ? {} : { relation }) });
  const lsDep = (id: string) => request(app).get(`/api/issues/${id}/dependencies`).query({ workspace_id: ws });

  beforeEach(async () => {
    t = createTestDb();
    const adapter = new FakeAdapter();
    spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-dep-rel-'));
    const created = await createApp({ db: t.db, getAdapter: () => adapter, adapters: [adapter], refreshClisOnBoot: false });
    app = created.app;
    ws = ((await request(app).post('/api/workspaces').send({ name: 'dep-rel 空间', path: spaceDir })).body as { id: string }).id;
  });

  afterEach(() => {
    t.cleanup();
    rmSync(spaceDir, { recursive: true, force: true });
  });

  it('relation 缺省 = blocks：不传 relation 的既有调用行为不变', async () => {
    const a = await mkIssue('A');
    const b = await mkIssue('B');
    const res = await addDep(a, b);
    expect(res.status).toBe(201);
    const row = t.db.prepare('SELECT relation FROM issue_dependency WHERE blocked_issue_id=? AND blocker_issue_id=?').get(a, b) as { relation: string };
    expect(row.relation).toBe('blocks');
    expect((await lsDep(a)).body.blockers).toHaveLength(1);
  });

  it('blocks 成环仍被拒：错误码与文案不变；同位置 related 边放行且不参与环检测', async () => {
    const a = await mkIssue('A');
    const b = await mkIssue('B');
    // a 以 b 为前置，再让 b 以 a 为前置 → blocks 成环
    expect((await addDep(a, b)).status).toBe(201);
    const cycle = await addDep(b, a);
    expect(cycle.status).toBe(409);
    expect(cycle.body.error.code).toBe('DEPENDENCY_CYCLE');
    expect(cycle.body.error.message).toContain('依赖会成环');
    // 同位置插 related：放行（PK 含 relation? 不含——同向同对已存在 blocks 边 → DEPENDENCY_EXISTS）
    // → 用第三张卡验证 related 允许构成「blocks 意义上的环」
    const c = await mkIssue('C');
    expect((await addDep(b, c)).status).toBe(201);   // b ← c（c 是 b 的前置）
    const related = await addDep(c, a, 'related');   // c 以 a 为前置（blocks 会成环 a←b←c→a）
    expect(related.status).toBe(201);
    const row = t.db.prepare('SELECT relation FROM issue_dependency WHERE blocked_issue_id=? AND blocker_issue_id=?').get(c, a) as { relation: string };
    expect(row.relation).toBe('related');
    // claim 门禁不受 related 影响：c 的 blocks 前置无未解除项（a 是 related）
    expect(unresolvedBlockers(t.db, c)).toHaveLength(0);
    const claimRes = await request(app).post(`/api/issues/${c}/claim`).send({ agent_id: 'fake' });
    expect(claimRes.status).toBe(200);
  });

  it('duplicate 可写入；related/duplicate 不进 blockers/blocked 视图（kb dep ls 仍只看 blocks）', async () => {
    const a = await mkIssue('A');
    const b = await mkIssue('B');
    expect((await addDep(a, b, 'duplicate')).status).toBe(201);
    expect((await addDep(b, a, 'related')).status).toBe(201);
    const view = (await lsDep(a)).body;
    expect(view.blockers).toHaveLength(0);
    expect(view.blocked).toHaveLength(0);
    // 库里两条边都在
    const n = t.db.prepare('SELECT COUNT(*) AS n FROM issue_dependency').get() as { n: number };
    expect(n.n).toBe(2);
  });

  it('BORROW-2.2：分组视图——related/duplicate 追加为数组且 refs 带 relation；顺序稳定', async () => {
    const a = await mkIssue('A');
    const b = await mkIssue('B');
    const c = await mkIssue('C');
    const d = await mkIssue('D');
    expect((await addDep(a, b)).status).toBe(201);            // blocks（blocked 视图）
    expect((await addDep(a, c, 'related')).status).toBe(201);
    // 同对 (blocked,blocker) 是主键，同向只能持一条边：duplicate 用另一对
    expect((await addDep(a, d, 'duplicate')).status).toBe(201);
    const view = (await lsDep(a)).body as {
      blockers: Array<{ issue_id: string; relation?: string }>;
      blocked: Array<{ issue_id: string }>;
      related?: Array<{ issue_id: string; relation?: string }>;
      duplicate?: Array<{ issue_id: string; relation?: string }>;
    };
    expect(view.blockers.map(x => x.issue_id)).toEqual([b]);
    expect(view.blocked).toHaveLength(0);
    expect(view.related?.map(x => x.issue_id)).toEqual([c]);
    expect(view.related?.[0]?.relation).toBe('related');
    expect(view.duplicate?.map(x => x.issue_id)).toEqual([d]);
    expect(view.duplicate?.[0]?.relation).toBe('duplicate');
  });

  it('BORROW-2.2：违规检测——祖先卡为 blocks 前置（历史/直写库）→ 列表 dependency_violation 标记；正常卡为 null', async () => {
    // 父子结构：parent ← child（parent_issue_id）；绕过 API 守卫直插「child 以 parent 为 blocks 前置」→ 违规
    const parentRes = await request(app).post('/api/issues').send({ workspace_id: ws, title: '父卡', description: '' });
    const parent = parentRes.body.id as string;
    const childRes = await request(app).post('/api/issues').send({ workspace_id: ws, title: '子卡', description: '', parent_issue_id: parent });
    const child = childRes.body.id as string;
    t.db.prepare("INSERT INTO issue_dependency (blocked_issue_id, blocker_issue_id, relation, created_at) VALUES (?,?, 'blocks', ?)")
      .run(child, parent, Date.now());
    const list = await request(app).get('/api/issues').query({ workspace: ws });
    const byId = new Map<string, { dependency_violation?: string | null }>(list.body.map((i: { id: string }) => [i.id, i]));
    expect(byId.get(child)?.dependency_violation).toBe('blocked-by-ancestor');
    expect(byId.get(parent)?.dependency_violation ?? null).toBeNull();
  });

  it('非法 relation 400；related/duplicate 不受 blocks 独有守卫限制（占用卡可加标注边）', async () => {
    const a = await mkIssue('A');
    const b = await mkIssue('B');
    const bad = await addDep(a, b, 'sibling');
    expect(bad.status).toBe(400);
    // 占用 a 后：blocks 边被拒，related 边放行
    expect((await request(app).post(`/api/issues/${a}/claim`).send({ agent_id: 'fake' })).status).toBe(200);
    expect((await addDep(a, b)).status).toBe(409);
    expect((await addDep(a, b, 'related')).status).toBe(201);
  });
});

describe('依赖迁移（老库等价迁移 + 重入 + FK）', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentboard-dep-legacy-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** 老库模拟：无 relation 列的 issue_dependency + 最小 issue/workspace 表 + 一条存量 blocks 边 */
  function buildLegacyDb(): ReturnType<typeof openDb> {
    const db = openDb(join(dir, 'legacy.db'));
    db.exec(`
      CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT, path TEXT);
      CREATE TABLE issue (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id),
        title TEXT, status TEXT, created_at INTEGER, updated_at INTEGER);
      INSERT INTO workspace (id, name, path) VALUES ('ws1', 'ws', 'D:/legacy');
      INSERT INTO issue (id, workspace_id, title, status, created_at, updated_at)
        VALUES ('a1', 'ws1', '甲', '待规划', 1, 1), ('b1', 'ws1', '乙', '待规划', 2, 2);
      CREATE TABLE issue_dependency (
        blocked_issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
        blocker_issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (blocked_issue_id, blocker_issue_id),
        CHECK (blocked_issue_id <> blocker_issue_id));
      INSERT INTO issue_dependency (blocked_issue_id, blocker_issue_id, created_at) VALUES ('a1', 'b1', 10);
    `);
    return db;
  }

  it('旧行等价迁移为 blocks；blocks 环仍拦；重入幂等；foreign_key_check 为空', () => {
    const db = buildLegacyDb();
    migrateIssueDependency(db);
    // 旧行保留且 relation='blocks'（行数与方向不变）
    const row = db.prepare('SELECT blocked_issue_id, blocker_issue_id, relation FROM issue_dependency').get() as
      { blocked_issue_id: string; blocker_issue_id: string; relation: string };
    expect(row).toEqual({ blocked_issue_id: 'a1', blocker_issue_id: 'b1', relation: 'blocks' });
    // blocks 环兜底触发器仍然工作（绕过服务层直接插）
    expect(() => db.prepare("INSERT INTO issue_dependency (blocked_issue_id, blocker_issue_id, relation, created_at) VALUES ('b1','a1','blocks',11)").run())
      .toThrowError(/issue dependency cycle/);
    // related 环形状放行（触发器不拦标注边）
    expect(() => db.prepare("INSERT INTO issue_dependency (blocked_issue_id, blocker_issue_id, relation, created_at) VALUES ('b1','a1','related',12)").run())
      .not.toThrow();
    // 重入：再跑两遍不抛错、结构不重复
    migrateIssueDependency(db);
    migrateIssueDependency(db);
    const triggers = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name='issue_dependency'").get() as { n: number };
    expect(triggers.n).toBe(2);
    const cols = db.prepare('PRAGMA table_info(issue_dependency)').all() as Array<{ name: string }>;
    expect(cols.filter((c) => c.name === 'relation')).toHaveLength(1);
    const fkIssues = db.pragma('foreign_key_check') as unknown[];
    expect(fkIssues).toHaveLength(0);
    db.close();
  });
});
