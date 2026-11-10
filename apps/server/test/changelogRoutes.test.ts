/**
 * LOG01｜工作区变更日志 REST（设计 §6）与旧 CHANGELOG preview/apply 服务（设计 §8）：
 * - 活动 CRUD 仅限定 URL 所属工作区，跨工作区一律 404 CHANGELOG_NOT_FOUND；
 * - CAS 过期 409 且不改数据；Idempotency-Key 重放不重复写入；
 * - 分页稳定、字面搜索、类型筛选；archive 只读且按 origin_workspace_id 隔离；
 * - 导入：preview 无副作用并返回 SHA，apply 校验 SHA、拒绝不可解析/冲突条目、回执与日志同事务。
 */
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, issuePayload, type TestDb } from './helpers.js';
import { createWorkspace, deleteWorkspace } from '../src/db/repos/workspace.js';
import { createRouter, errorHandler } from '../src/api/routes.js';
import { applyLegacyChangelog, previewLegacyChangelog } from '../src/services/changelogImport.js';

let t: TestDb;
let app: Express;
let wsA: string;
let wsB: string;
let spaceDir: string;

const uuid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`;

beforeEach(() => {
  t = createTestDb();
  spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-changelog-'));
  mkdirSync(join(spaceDir, 'Docs'), { recursive: true });
  wsA = createWorkspace(t.db, { name: 'A 空间', path: join(spaceDir, 'A') }).id;
  wsB = createWorkspace(t.db, { name: 'B 空间', path: join(spaceDir, 'B') }).id;
  app = express();
  app.use(express.json());
  app.use('/api', createRouter({ db: t.db, getAdapter: () => { throw new Error('unused'); }, broadcast: () => {} }));
  app.use(errorHandler);
});

afterEach(() => {
  rmSync(spaceDir, { recursive: true, force: true });
  t.cleanup();
});

function body(extra: Record<string, unknown> = {}) {
  return { title: '标题', body_md: '正文', change_type: '新增', actor: 'user', ...extra };
}

const post = (workspaceId: string, payload: Record<string, unknown>, key?: string) => {
  const req = request(app).post(`/api/workspaces/${workspaceId}/changelog`).send(payload);
  return key ? req.set('Idempotency-Key', key) : req;
};

describe('活动变更日志 REST', () => {
  it('CRUD 全链路：201 创建 → 列表 → 详情 → PATCH 递增 revision → DELETE 204 → 404', async () => {
    const created = await post(wsA, body());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      workspace_id: wsA,
      origin_workspace_id: wsA,
      origin_workspace_name: 'A 空间',
      title: '标题',
      change_type: '新增',
      revision: 1,
      created_by: 'user',
      updated_by: 'user',
    });

    const list = await request(app).get(`/api/workspaces/${wsA}/changelog`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([created.body.id]);
    expect(list.body.next_offset).toBeNull();

    const detail = await request(app).get(`/api/workspaces/${wsA}/changelog/${created.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.body_md).toBe('正文');

    const patched = await request(app)
      .patch(`/api/workspaces/${wsA}/changelog/${created.body.id}`)
      .send({ expected_revision: 1, actor: 'agent:codex', title: '标题改', change_type: '调整' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ revision: 2, title: '标题改', change_type: '调整', updated_by: 'agent:codex' });

    const removed = await request(app)
      .delete(`/api/workspaces/${wsA}/changelog/${created.body.id}`)
      .send({ expected_revision: 2, actor: 'user' });
    expect(removed.status).toBe(204);
    expect((await request(app).get(`/api/workspaces/${wsA}/changelog/${created.body.id}`)).status).toBe(404);
  });

  it('跨工作区与不存在的工作区：404；非法体与历史类型：400', async () => {
    const created = await post(wsA, body());
    const otherWs = await request(app).get(`/api/workspaces/${wsB}/changelog/${created.body.id}`);
    expect(otherWs.status).toBe(404);
    expect(otherWs.body.error.code).toBe('CHANGELOG_NOT_FOUND');
    expect((await request(app).delete(`/api/workspaces/${wsB}/changelog/${created.body.id}`).send({ expected_revision: 1, actor: 'user' })).status).toBe(404);

    expect((await request(app).get('/api/workspaces/nope/changelog')).status).toBe(404);
    expect((await post(wsA, body({ title: '' }))).status).toBe(400);
    expect((await post(wsA, body({ change_type: '历史' }))).status).toBe(400);
    expect((await post(wsA, body({ change_type: '发布' }))).status).toBe(400);
    expect((await request(app).patch(`/api/workspaces/${wsA}/changelog/${created.body.id}`).send({ expected_revision: 1, actor: 'user' })).status).toBe(400);
  });

  it('CAS 冲突：过期 expected_revision 的 PATCH/DELETE 返回 409 + details.current_revision，数据不变', async () => {
    const created = await post(wsA, body());
    await request(app)
      .patch(`/api/workspaces/${wsA}/changelog/${created.body.id}`)
      .send({ expected_revision: 1, actor: 'user', title: 'v2' });

    const stalePatch = await request(app)
      .patch(`/api/workspaces/${wsA}/changelog/${created.body.id}`)
      .send({ expected_revision: 1, actor: 'user', title: 'stale' });
    expect(stalePatch.status).toBe(409);
    expect(stalePatch.body.error).toMatchObject({ code: 'CHANGELOG_REVISION_CONFLICT', details: { current_revision: 2 } });

    const staleDelete = await request(app)
      .delete(`/api/workspaces/${wsA}/changelog/${created.body.id}`)
      .send({ expected_revision: 1, actor: 'user' });
    expect(staleDelete.status).toBe(409);

    const detail = await request(app).get(`/api/workspaces/${wsA}/changelog/${created.body.id}`);
    expect(detail.body).toMatchObject({ title: 'v2', revision: 2 });
  });

  it('Idempotency-Key：重放不重复写入，同 key 换 payload 返回 409', async () => {
    const key = uuid('1');
    const first = await post(wsA, body({ title: '幂等' }), key);
    const replay = await post(wsA, body({ title: '幂等' }), key);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    expect((await request(app).get(`/api/workspaces/${wsA}/changelog`)).body.items).toHaveLength(1);

    const reused = await post(wsA, body({ title: '换了内容' }), key);
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('N4-03：issue_id 在创建/列表/详情回显，且必须是本工作区真实任务', async () => {
    const card = await request(app).post('/api/issues').send(issuePayload(wsA, { title: '归属卡' }));
    expect(card.status).toBe(200);
    const issueId = card.body.id as string;

    const created = await post(wsA, body({ issue_id: issueId }));
    expect(created.status).toBe(201);
    expect(created.body.issue_id).toBe(issueId);
    expect((await request(app).get(`/api/workspaces/${wsA}/changelog`)).body.items[0].issue_id).toBe(issueId);
    expect((await request(app).get(`/api/workspaces/${wsA}/changelog/${created.body.id}`)).body.issue_id).toBe(issueId);

    // 不存在的卡 → 400，不落库
    const ghost = await post(wsA, body({ title: '幽灵归属', issue_id: uuid('999') }));
    expect(ghost.status).toBe(400);
    // 别的空间的卡 → 400
    const other = await request(app).post('/api/issues').send(issuePayload(wsB, { title: 'B 卡' }));
    expect((await post(wsA, body({ issue_id: other.body.id }))).status).toBe(400);
    // 不带 issue_id 仍然允许，回显 null
    const plain = await post(wsA, body({ title: '无归属' }));
    expect(plain.status).toBe(201);
    expect(plain.body.issue_id).toBeNull();
  });

  it('分页与筛选：limit+1 探测 next_offset、q 字面搜索、change_type 组合、越界 400', async () => {
    for (let i = 0; i < 51; i += 1) {
      const res = await post(wsA, body({ title: `条目 ${String(i).padStart(2, '0')}`, occurred_at: 1000 + i }));
      expect(res.status).toBe(201);
    }
    await post(wsA, body({ title: '缓存失效 100%', body_md: '含 a_b', occurred_at: 5000, change_type: '修复' }));

    const page1 = await request(app).get(`/api/workspaces/${wsA}/changelog`).query({ limit: 50 });
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(50);
    expect(page1.body.next_offset).toBe(50);
    expect(page1.body.items[0].title).toBe('缓存失效 100%'); // occurred_at 最大者置顶

    const page2 = await request(app).get(`/api/workspaces/${wsA}/changelog`).query({ limit: 50, offset: 50 });
    expect(page2.body.items).toHaveLength(2);
    expect(page2.body.next_offset).toBeNull();

    const literal = await request(app).get(`/api/workspaces/${wsA}/changelog`).query({ q: '100%' });
    expect(literal.body.items).toHaveLength(1);
    expect((await request(app).get(`/api/workspaces/${wsA}/changelog`).query({ q: 'a_b' })).body.items).toHaveLength(1);
    expect((await request(app).get(`/api/workspaces/${wsA}/changelog`).query({ q: 'a%b' })).body.items).toHaveLength(0);
    expect((await request(app).get(`/api/workspaces/${wsA}/changelog`).query({ q: '条目', change_type: '新增' })).body.items).toHaveLength(50);
    expect((await request(app).get(`/api/workspaces/${wsA}/changelog`).query({ q: '条目', change_type: '修复' })).body.items).toHaveLength(0);
    expect((await request(app).get(`/api/workspaces/${wsA}/changelog`).query({ q: '', limit: 100 })).body.items).toHaveLength(52);

    expect((await request(app).get(`/api/workspaces/${wsA}/changelog`).query({ limit: 0 })).status).toBe(400);
    expect((await request(app).get(`/api/workspaces/${wsA}/changelog`).query({ limit: 101 })).status).toBe(400);
    expect((await request(app).get(`/api/workspaces/${wsA}/changelog`).query({ limit: 'abc' })).status).toBe(400);
  });
});

describe('归档只读接口', () => {
  it('删除工作区后日志转归档：列表按 origin 分组、详情只读、不混入活动空间', async () => {
    const kept = await post(wsA, body({ title: 'A 的日志', occurred_at: 2000 }));
    await post(wsA, body({ title: 'A 的第二条', occurred_at: 1000 }));
    const bLog = await post(wsB, body({ title: 'B 的日志' }));
    expect(kept.status).toBe(201);

    deleteWorkspace(t.db, wsA);

    const archived = await request(app).get('/api/changelog/archived-workspaces');
    expect(archived.status).toBe(200);
    expect(archived.body.items).toEqual([
      { origin_workspace_id: wsA, origin_workspace_name: 'A 空间', origin_workspace_path: join(spaceDir, 'A'), entry_count: 2, last_occurred_at: 2000 },
    ]);

    const entries = await request(app).get(`/api/changelog/archived-workspaces/${wsA}/entries`);
    expect(entries.status).toBe(200);
    expect(entries.body.items.map((item: { title: string }) => item.title)).toEqual(['A 的日志', 'A 的第二条']);
    expect(entries.body.items.every((item: { workspace_id: string | null }) => item.workspace_id === null)).toBe(true);

    const detail = await request(app).get(`/api/changelog/archived-workspaces/${wsA}/entries/${kept.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.title).toBe('A 的日志');

    // 归档作用域只认 origin：B 的 id 在 A 的归档里 404；活动空间列表不含归档
    expect((await request(app).get(`/api/changelog/archived-workspaces/${wsA}/entries/${bLog.body.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/workspaces/${wsB}/changelog`)).body.items.map((item: { title: string }) => item.title)).toEqual(['B 的日志']);
    // 归档是只读的：没有写端点
    expect((await request(app).post(`/api/changelog/archived-workspaces/${wsA}/entries`).send(body())).status).toBe(404);
  });
});

const LEGACY = `# CHANGELOG.md

## [2026-11-01] 第一条历史

- 第一条内容
- 第二行

## [2026-11-02] 第二条历史

第二条正文。
`;

function writeLegacy(content = LEGACY, name = 'CHANGELOG.md'): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentboard-legacy-'));
  const file = join(dir, name);
  writeFileSync(file, content, 'utf8');
  return file;
}

describe('旧 CHANGELOG preview/apply 服务', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'agentboard-legacy-ws-'));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function wsWithDir(): string {
    return createWorkspace(t.db, { name: '导入空间', path: workspaceDir }).id;
  }

  function legacyIn(dir: string, content = LEGACY): string {
    const docs = join(dir, 'Docs');
    mkdirSync(docs, { recursive: true });
    const file = join(docs, 'CHANGELOG.md');
    writeFileSync(file, content, 'utf8');
    return file;
  }

  it('preview 无副作用：返回 SHA、条目与解析结果，不写库', async () => {
    const ws = wsWithDir();
    const file = legacyIn(workspaceDir);
    const preview = previewLegacyChangelog(t.db, { workspace_id: ws, source_path: file });
    expect(preview.entry_count).toBe(2);
    expect(preview.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.parsed.map((e) => e.title)).toEqual(['第一条历史', '第二条历史']);
    expect(preview.parsed[0]!.body_md).toContain('第一条内容');
    expect(preview.parsed[0]!.occurred_at).toBe(Date.parse('2026-11-01T00:00:00.000Z'));
    expect(preview.unparsable).toEqual([]);
    expect(preview.added).toHaveLength(2);
    expect(preview.already_imported).toEqual([]);
    expect(preview.conflicting).toEqual([]);
    expect(t.db.prepare('SELECT COUNT(*) n FROM workspace_change_log').get()).toEqual({ n: 0 });
  });

  it('apply 成功：写入历史类型 + legacy_source_key + 回执；相同 SHA 重放不重复', async () => {
    const ws = wsWithDir();
    const file = legacyIn(workspaceDir);
    const preview = previewLegacyChangelog(t.db, { workspace_id: ws, source_path: file });

    const applied = applyLegacyChangelog(t.db, { workspace_id: ws, source_path: file, preview_sha256: preview.source_sha256, actor: 'user' });
    expect(applied.imported).toBe(2);
    expect(applied.source_sha256).toBe(preview.source_sha256);

    const rows = t.db.prepare('SELECT change_type,legacy_source_key,title FROM workspace_change_log ORDER BY occurred_at').all() as Array<Record<string, string>>;
    expect(rows.map((r) => r.change_type)).toEqual(['历史', '历史']);
    expect(rows.every((r) => typeof r.legacy_source_key === 'string' && r.legacy_source_key.length === 64)).toBe(true);
    expect(t.db.prepare('SELECT COUNT(*) n FROM workspace_change_log_import').get()).toEqual({ n: 1 });

    const replay = applyLegacyChangelog(t.db, { workspace_id: ws, source_path: file, preview_sha256: preview.source_sha256, actor: 'user' });
    expect(replay.imported).toBe(0);
    expect(replay.receipt_id).toBe(applied.receipt_id);
    expect(t.db.prepare('SELECT COUNT(*) n FROM workspace_change_log').get()).toEqual({ n: 2 });
    expect(t.db.prepare('SELECT COUNT(*) n FROM workspace_change_log_import').get()).toEqual({ n: 1 });
  });

  it('源文件变化：预览 SHA 不匹配 → 409 且零写入', async () => {
    const ws = wsWithDir();
    const file = legacyIn(workspaceDir);
    const preview = previewLegacyChangelog(t.db, { workspace_id: ws, source_path: file });
    writeFileSync(file, `${LEGACY}\n## [2026-11-03] 追加条目\n\n新增内容\n`, 'utf8');

    expect(() =>
      applyLegacyChangelog(t.db, { workspace_id: ws, source_path: file, preview_sha256: preview.source_sha256, actor: 'user' }),
    ).toThrow(expect.objectContaining({ code: 'CHANGELOG_SOURCE_CHANGED', status: 409 }));
    expect(t.db.prepare('SELECT COUNT(*) n FROM workspace_change_log').get()).toEqual({ n: 0 });
    expect(t.db.prepare('SELECT COUNT(*) n FROM workspace_change_log_import').get()).toEqual({ n: 0 });
  });

  it('不可解析条目 → preview 明示，apply 409 且零写入', async () => {
    const ws = wsWithDir();
    const file = legacyIn(workspaceDir, '# CHANGELOG.md\n\n## [不是日期] 坏标题\n\n## [2026-11-01] 好条目\n\n正文\n');
    const preview = previewLegacyChangelog(t.db, { workspace_id: ws, source_path: file });
    expect(preview.unparsable.length).toBeGreaterThan(0);
    expect(preview.entry_count).toBe(1);

    expect(() =>
      applyLegacyChangelog(t.db, { workspace_id: ws, source_path: file, preview_sha256: preview.source_sha256, actor: 'user' }),
    ).toThrow(expect.objectContaining({ code: 'CHANGELOG_PARSE_FAILED', status: 409 }));
    expect(t.db.prepare('SELECT COUNT(*) n FROM workspace_change_log').get()).toEqual({ n: 0 });
    expect(t.db.prepare('SELECT COUNT(*) n FROM workspace_change_log_import').get()).toEqual({ n: 0 });
  });

  it('内容不一致条目阻止 apply；回执与日志同事务（注入失败回滚无半成品）', async () => {
    const ws = wsWithDir();
    const file = legacyIn(workspaceDir);
    const preview = previewLegacyChangelog(t.db, { workspace_id: ws, source_path: file });

    // 同事务验证：第二次插入被临时触发器打断 → 不得留下任何日志或回执
    t.db.exec(`CREATE TRIGGER test_fail_second BEFORE INSERT ON workspace_change_log WHEN new.title='第二条历史' BEGIN SELECT RAISE(ABORT,'injected failure'); END;`);
    try {
      expect(() =>
        applyLegacyChangelog(t.db, { workspace_id: ws, source_path: file, preview_sha256: preview.source_sha256, actor: 'user' }),
      ).toThrow(/injected failure/);
    } finally {
      t.db.exec('DROP TRIGGER IF EXISTS test_fail_second');
    }
    expect(t.db.prepare('SELECT COUNT(*) n FROM workspace_change_log').get()).toEqual({ n: 0 });
    expect(t.db.prepare('SELECT COUNT(*) n FROM workspace_change_log_import').get()).toEqual({ n: 0 });

    // 正常 apply 后篡改一条正文 → preview 报 conflicting，apply 拒绝
    applyLegacyChangelog(t.db, { workspace_id: ws, source_path: file, preview_sha256: preview.source_sha256, actor: 'user' });
    t.db.prepare("UPDATE workspace_change_log SET body_md='被改过' WHERE title='第一条历史'").run();
    const again = previewLegacyChangelog(t.db, { workspace_id: ws, source_path: file });
    expect(again.conflicting).toHaveLength(1);
    expect(() =>
      applyLegacyChangelog(t.db, { workspace_id: ws, source_path: file, preview_sha256: again.source_sha256, actor: 'user' }),
    ).toThrow(expect.objectContaining({ code: 'CHANGELOG_IMPORT_CONFLICT', status: 409 }));
  });

  it('路径限制：源文件必须在所选工作区内，越界 400', async () => {
    const ws = wsWithDir();
    const outside = writeLegacy();
    expect(() => previewLegacyChangelog(t.db, { workspace_id: ws, source_path: outside })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => previewLegacyChangelog(t.db, { workspace_id: ws, source_path: join(workspaceDir, 'Docs', 'nope.md') })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
});

/** LOG02｜导入与退役复核端点：CLI 消费的 HTTP 面（薄壳，逻辑全在 services/changelogImport.ts） */
describe('旧 CHANGELOG 导入 REST（preview / apply / verify-retire）', () => {
  let dirs: string[];

  const call = (workspaceId: string, action: string, payload: Record<string, unknown>, key?: string) => {
    const req = request(app).post(`/api/workspaces/${workspaceId}/changelog/import/${action}`).send(payload);
    return key === undefined ? req : req.set('Idempotency-Key', key);
  };
  const retiredRows = () => t.db.prepare('SELECT COUNT(*) n FROM workspace_change_log').get();

  beforeEach(() => {
    dirs = [];
  });

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  /** 每个用例独立目录 + 独立 workspace（workspace.path 唯一） */
  function wsWithDoc(content = LEGACY): { workspaceId: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-legacy-api-'));
    dirs.push(dir);
    const workspaceId = createWorkspace(t.db, { name: `导入空间-${dirs.length}`, path: dir }).id;
    const docs = join(dir, 'Docs');
    mkdirSync(docs, { recursive: true });
    const file = join(docs, 'CHANGELOG.md');
    writeFileSync(file, content, 'utf8');
    return { workspaceId, file };
  }

  it('preview → apply → 同 SHA 重放：重放 imported=0 且不产生重复行', async () => {
    const { workspaceId, file } = wsWithDoc();
    const preview = await call(workspaceId, 'preview', { source_path: file, actor: 'user' });
    expect(preview.status).toBe(200);
    expect(preview.body.entry_count).toBe(2);
    expect(preview.body.added).toHaveLength(2);
    expect(retiredRows()).toEqual({ n: 0 }); // preview 无副作用

    const applied = await call(workspaceId, 'apply', { source_path: file, preview_sha256: preview.body.source_sha256, actor: 'user' });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ imported: 2, source_sha256: preview.body.source_sha256 });

    const replay = await call(workspaceId, 'apply', { source_path: file, preview_sha256: preview.body.source_sha256, actor: 'user' });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ imported: 0, receipt_id: applied.body.receipt_id });
    expect(retiredRows()).toEqual({ n: 2 });
    expect(t.db.prepare('SELECT COUNT(*) n FROM workspace_change_log_import').get()).toEqual({ n: 1 });
  });

  it('apply 幂等键：同 Key 重放不重复，换 payload 返回 409', async () => {
    const { workspaceId, file } = wsWithDoc();
    const preview = await call(workspaceId, 'preview', { source_path: file, actor: 'user' });
    const key = uuid('9');
    const payload = { source_path: file, preview_sha256: preview.body.source_sha256, actor: 'user' };
    expect((await call(workspaceId, 'apply', payload, key)).status).toBe(200);
    expect((await call(workspaceId, 'apply', payload, key)).status).toBe(200);
    expect(retiredRows()).toEqual({ n: 2 });
    const reused = await call(workspaceId, 'apply', { ...payload, actor: 'codex' }, key);
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('preview 后源文件被改：apply 返回 409 CHANGELOG_SOURCE_CHANGED 且零写入', async () => {
    const { workspaceId, file } = wsWithDoc();
    const preview = await call(workspaceId, 'preview', { source_path: file, actor: 'user' });
    writeFileSync(file, `${LEGACY}\n## [2026-11-03] 追加\n\n新增内容\n`, 'utf8');

    const applied = await call(workspaceId, 'apply', { source_path: file, preview_sha256: preview.body.source_sha256, actor: 'user' });
    expect(applied.status).toBe(409);
    expect(applied.body.error.code).toBe('CHANGELOG_SOURCE_CHANGED');
    expect(retiredRows()).toEqual({ n: 0 });
    expect(t.db.prepare('SELECT COUNT(*) n FROM workspace_change_log_import').get()).toEqual({ n: 0 });
  });

  it('不可解析与内容不一致：apply 409 且不部分提交', async () => {
    const bad = wsWithDoc('# CHANGELOG.md\n\n## [坏日期] 坏条目\n\n## [2026-11-01] 好条目\n\n正文\n');
    const badPreview = await call(bad.workspaceId, 'preview', { source_path: bad.file, actor: 'user' });
    expect(badPreview.body.unparsable.length).toBeGreaterThan(0);
    const parseFailed = await call(bad.workspaceId, 'apply', { source_path: bad.file, preview_sha256: badPreview.body.source_sha256, actor: 'user' });
    expect(parseFailed.status).toBe(409);
    expect(parseFailed.body.error.code).toBe('CHANGELOG_PARSE_FAILED');
    expect(retiredRows()).toEqual({ n: 0 });

    const { workspaceId, file } = wsWithDoc();
    const preview = await call(workspaceId, 'preview', { source_path: file, actor: 'user' });
    await call(workspaceId, 'apply', { source_path: file, preview_sha256: preview.body.source_sha256, actor: 'user' });
    t.db.prepare("UPDATE workspace_change_log SET body_md='被改过' WHERE title='第一条历史'").run();
    const fresh = await call(workspaceId, 'preview', { source_path: file, actor: 'user' });
    const conflict = await call(workspaceId, 'apply', { source_path: file, preview_sha256: fresh.body.source_sha256, actor: 'user' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('CHANGELOG_IMPORT_CONFLICT');
    expect(retiredRows()).toEqual({ n: 2 });
  });

  it('跨工作区与越界路径：不存在 workspace 404、源文件不在目标空间内 400', async () => {
    const { workspaceId, file } = wsWithDoc();
    expect((await call('nope', 'preview', { source_path: file, actor: 'user' })).status).toBe(404);
    const otherDir = mkdtempSync(join(tmpdir(), 'agentboard-legacy-other-'));
    try {
      const other = createWorkspace(t.db, { name: '其它空间', path: otherDir }).id;
      const outside = await call(other, 'preview', { source_path: file, actor: 'user' });
      expect(outside.status).toBe(400);
      expect(outside.body.error.code).toBe('VALIDATION_ERROR');
      // 目标空间自身合法
      expect((await call(workspaceId, 'preview', { source_path: file, actor: 'user' })).status).toBe(200);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('verify-retire ① 无回执：不可退役，原因指向需重新预览并应用', async () => {
    const { workspaceId, file } = wsWithDoc();
    const verdict = await call(workspaceId, 'verify-retire', { source_path: file });
    expect(verdict.status).toBe(200);
    expect(verdict.body).toMatchObject({ can_retire: false, receipt: null });
    expect(verdict.body.reason).toContain('回执');
  });

  it('verify-retire ② 有回执但仍有未导入条目：不可退役并给出条数', async () => {
    const { workspaceId, file } = wsWithDoc();
    const preview = await call(workspaceId, 'preview', { source_path: file, actor: 'user' });
    await call(workspaceId, 'apply', { source_path: file, preview_sha256: preview.body.source_sha256, actor: 'user' });
    const first = t.db.prepare("SELECT id FROM workspace_change_log WHERE title='第一条历史'").get() as { id: string };
    t.db.prepare('DELETE FROM workspace_change_log WHERE id=?').run(first.id);

    const verdict = await call(workspaceId, 'verify-retire', { source_path: file });
    expect(verdict.body).toMatchObject({ can_retire: false, receipt: { entry_count: 2 } });
    expect(verdict.body.reason).toContain('未导入');
    expect(verdict.body.added).toHaveLength(1);
  });

  it('verify-retire ③ 有回执但内容不一致：不可退役并要求对账', async () => {
    const { workspaceId, file } = wsWithDoc();
    const preview = await call(workspaceId, 'preview', { source_path: file, actor: 'user' });
    await call(workspaceId, 'apply', { source_path: file, preview_sha256: preview.body.source_sha256, actor: 'user' });
    t.db.prepare("UPDATE workspace_change_log SET body_md='被改过' WHERE title='第二条历史'").run();

    const verdict = await call(workspaceId, 'verify-retire', { source_path: file });
    expect(verdict.body).toMatchObject({ can_retire: false, receipt: { entry_count: 2 } });
    expect(verdict.body.reason).toContain('不一致');
    expect(verdict.body.conflicting).toHaveLength(1);
  });

  it('verify-retire ④ 已全部对账：可退役，且源文件与 SHA 不被改动', async () => {
    const { workspaceId, file } = wsWithDoc();
    const preview = await call(workspaceId, 'preview', { source_path: file, actor: 'user' });
    const sha = preview.body.source_sha256 as string;
    await call(workspaceId, 'apply', { source_path: file, preview_sha256: sha, actor: 'user' });

    const before = readFileSync(file);
    const verdict = await call(workspaceId, 'verify-retire', { source_path: file });
    expect(verdict.status).toBe(200);
    expect(verdict.body).toMatchObject({ can_retire: true, receipt: { entry_count: 2 } });
    expect(verdict.body).toMatchObject({ added: [], conflicting: [], unparsable: [] });
    expect(verdict.body.source_sha256).toBe(sha);
    expect(readFileSync(file)).toEqual(before);
  });

  it('verify-retire 发现无法解析内容时拒绝退役', async () => {
    const { workspaceId, file } = wsWithDoc('# CHANGELOG.md\n\n## [坏日期] 坏条目\n\n## [2026-11-01] 好条目\n\n正文\n');
    const verdict = await call(workspaceId, 'verify-retire', { source_path: file });
    expect(verdict.body).toMatchObject({ can_retire: false, receipt: null });
    expect(verdict.body.reason).toContain('无法解析');
  });
});
