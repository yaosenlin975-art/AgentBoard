/**
 * STORE-4c：知识读路径 both 跨库合并 + knowledge_link 外键松绑后的跨库链接语义。
 *
 * 真双库（中心库 + 工作区库文件）+ createKnowledgeRouter 按 4a 选项装配：
 * - /search both：两库命中合并、统一 (updated_at desc, id asc) 排序、X-Knowledge-Truncated 置位；
 * - /pages both：合并排序切片、next_offset 精确（窗口法，不报假总数）；
 * - /resolve both：common 与 workspace 两路命中、跨库同 slug 歧义 409；
 * - /backlinks both：工作区页双链到 common 页的反链跨库合并、page_total 精确求和；
 * - /graph both：跨库 link 边存在（resolved 语义）；目标页软删后边消失且不报错；
 * - 升级路径：老结构（target 外键）工作区库首个知识请求处自动松绑，随后跨库链接可建可解析；
 * - /reparse：跨库未解析链接回填（工作区库带中心库句柄）；
 * - 图片按 page.scope 落中心/工作区目录，跨库 locate 可读。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createKnowledgePage } from '../src/db/repos/knowledge.js';
import { createKnowledgeRouter } from '../src/api/knowledgeRoutes.js';
import { errorHandler } from '../src/api/routes.js';
import { openDb, type Db } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';
import { bindEntityLocatorCenter } from '../src/db/repos/entityLocator.js';
import { mergeKnowledgeRowsByRecency } from '../src/db/repos/knowledgeSearch.js';
import { knowledgeAttachmentsRoot } from '../src/services/knowledgeImages.js';

const sources = [{ source_id: 's', source_type: 'agent' as const, locator: 'issue:1', captured_at: 1, content_hash: 'a'.repeat(64), snapshot: 'verified' }];
const evidence = [{ source_id: 's', locator: 'issue:1' }];

/** 最小 PNG（签名 + IHDR），尺寸读取只依赖这两段 */
function png(): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(17);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(2, 8);
  ihdr.writeUInt32BE(2, 12);
  ihdr[16] = 8;
  return Buffer.concat([sig, ihdr]);
}

function multipartBody(fields: Record<string, string>, file: { filename: string; contentType: string; data: Buffer }, boundary = '----agentboard-4c'): { body: Buffer; contentType: string } {
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`));
  chunks.push(file.data);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('STORE-4c 知识 both 跨库合并', () => {
  let t: TestDb;
  let wsDir: string;
  let wsDb: Db;
  let ws: string;
  let app: Express;
  const pageInput = (over: Record<string, unknown>) => ({
    domain: 'knowledge', actor: 'tester', sources, evidence, ...over,
  });
  const createCommon = (slug: string, body = '缓存失效后 WAL checkpoint') =>
    createKnowledgePage(t.db, pageInput({ scope: 'common', slug, title: `公共-${slug}`, body_md: body }));
  const createWs = (slug: string, body = '缓存失效后 WAL checkpoint') =>
    createKnowledgePage(wsDb, pageInput({ scope: 'workspace', workspace_id: ws, slug, title: `区页-${slug}`, body_md: body }));
  /** 直接控制 updated_at（Date.now() 同毫秒会让 revise 无法制造严格递增，fixture 直改是确定性做法） */
  const setUpdatedAt = (db: Db, id: string, ts: number) => {
    db.prepare('UPDATE knowledge_page SET updated_at=? WHERE id=?').run(ts, id);
  };

  beforeEach(() => {
    t = createTestDb();
    wsDir = mkdtempSync(join(tmpdir(), 'agentboard-4c-ws-'));
    wsDb = openDb(join(wsDir, 'ws.db'));
    initSchema(wsDb);
    bindEntityLocatorCenter(wsDb, t.db);
    ws = createWorkspace(t.db, { name: 'A', path: 'A' }).id;
    // 工作区行副本（localize 的 create 阶段同款；createKnowledgePage 的存在性校验需要）
    const row = t.db.prepare('SELECT * FROM workspace WHERE id=?').get(ws) as Record<string, unknown>;
    const cols = Object.keys(row);
    wsDb.prepare(`INSERT INTO workspace (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => row[c] as never));
    app = express();
    app.use(express.json());
    app.use('/api/knowledge', createKnowledgeRouter(t.db, { getWorkspaceDb: () => wsDb, listWorkspaceDbs: () => [wsDb] }));
    app.use(errorHandler);
  });
  afterEach(() => {
    wsDb.close();
    rmSync(wsDir, { recursive: true, force: true });
    t.cleanup();
  });

  it('mergeKnowledgeRowsByRecency sorts by updated_at desc then id asc', () => {
    const rows = [
      { id: 'b', updated_at: 5 }, { id: 'a', updated_at: 5 }, { id: 'z', updated_at: 9 }, { id: 'c', updated_at: 1 },
    ];
    expect(mergeKnowledgeRowsByRecency([rows.slice(0, 2), rows.slice(2)]).map(row => row.id)).toEqual(['z', 'a', 'b', 'c']);
  });

  it('search both merges two dbs with unified recency order and truncated header', async () => {
    const common = createCommon('shared');
    const local = createWs('local');
    setUpdatedAt(wsDb, local.id, 1000);
    setUpdatedAt(t.db, common.id, 2000);
    const long = await request(app).get('/api/knowledge/search').query({ scope: 'both', workspace_id: ws, q: '缓存失效' });
    expect(long.status).toBe(200);
    expect(long.headers['x-knowledge-truncated']).toBe('false');
    expect(long.body.map((row: { page_id: string }) => row.page_id)).toEqual([common.id, local.id]);
    const short = await request(app).get('/api/knowledge/search').query({ scope: 'both', workspace_id: ws, q: '缓存' });
    expect(short.body.map((row: { page_id: string }) => row.page_id)).toEqual([common.id, local.id]);
    // 反转时间序：公共页改旧 → 工作区页排前面（跨库统一排序键，两次调用一致）
    setUpdatedAt(t.db, common.id, 500);
    const again = await request(app).get('/api/knowledge/search').query({ scope: 'both', workspace_id: ws, q: '缓存失效' });
    expect(again.body.map((row: { page_id: string }) => row.page_id)).toEqual([local.id, common.id]);
    // 截断：中心库命中数超过 limit → truncated 置位（合并后无精确总数，不报假总数）
    createCommon('shared-2');
    const truncated = await request(app).get('/api/knowledge/search').query({ scope: 'both', workspace_id: ws, q: '缓存失效', limit: 1 });
    expect(truncated.body).toHaveLength(1);
    expect(truncated.headers['x-knowledge-truncated']).toBe('true');
  });

  it('pages both merges with exact next_offset across dbs', async () => {
    const c1 = createCommon('c1');
    const w1 = createWs('w1');
    const c2 = createCommon('c2');
    const w2 = createWs('w2');
    setUpdatedAt(t.db, c1.id, 1000);
    setUpdatedAt(wsDb, w1.id, 2000);
    setUpdatedAt(t.db, c2.id, 3000);
    setUpdatedAt(wsDb, w2.id, 4000);
    const all = await request(app).get('/api/knowledge/pages').query({ scope: 'both', workspace_id: ws, limit: 10 });
    expect(all.status).toBe(200);
    expect(all.body.items.map((row: { id: string }) => row.id)).toEqual([w2.id, c2.id, w1.id, c1.id]);
    expect(all.body.next_offset).toBeNull();
    const first = await request(app).get('/api/knowledge/pages').query({ scope: 'both', workspace_id: ws, limit: 2 });
    expect(first.body.items.map((row: { id: string }) => row.id)).toEqual([w2.id, c2.id]);
    expect(first.body.next_offset).toBe(2);
    const second = await request(app).get('/api/knowledge/pages').query({ scope: 'both', workspace_id: ws, limit: 2, offset: 2 });
    expect(second.body.items.map((row: { id: string }) => row.id)).toEqual([w1.id, c1.id]);
    expect(second.body.next_offset).toBeNull();
    // 单库路径不变：common 只看中心库
    const commonOnly = await request(app).get('/api/knowledge/pages').query({ scope: 'common', limit: 10 });
    expect(commonOnly.body.items.map((row: { id: string }) => row.id)).toEqual([c2.id, c1.id]);
  });

  it('resolve both finds pages across dbs and flags cross-db slug ambiguity', async () => {
    const common = createCommon('shared');
    const local = createWs('local');
    const dupCommon = createCommon('dup');
    const dupLocal = createWs('dup');
    const bySlugCommon = await request(app).get('/api/knowledge/resolve').query({ ref: 'shared', scope: 'both', workspace_id: ws });
    expect(bySlugCommon.status).toBe(200);
    expect(bySlugCommon.body.id).toBe(common.id);
    expect(bySlugCommon.body.scope).toBe('common');
    const bySlugLocal = await request(app).get('/api/knowledge/resolve').query({ ref: 'local', scope: 'both', workspace_id: ws });
    expect(bySlugLocal.status).toBe(200);
    expect(bySlugLocal.body.id).toBe(local.id);
    const ambiguous = await request(app).get('/api/knowledge/resolve').query({ ref: 'dup', scope: 'both', workspace_id: ws });
    expect(ambiguous.status).toBe(409);
    expect([...ambiguous.body.error.details.candidates].sort()).toEqual([dupCommon.id, dupLocal.id].sort());
    const byWsId = await request(app).get('/api/knowledge/resolve').query({ ref: dupLocal.id, scope: 'both', workspace_id: ws });
    expect(byWsId.status).toBe(200);
    expect(byWsId.body.id).toBe(dupLocal.id);
  });

  it('workspace page links to common page: link resolves cross-db, backlinks and graph merge', async () => {
    const common = createCommon('shared');
    const w1 = createWs('w1', '参见 [[shared]] 与缓存');
    const w2 = createWs('w2', '也参见 [[shared]]');
    // 写路径跨库解析：ws 库的 link 行存中心库目标 id 且 resolved=1（按 source id 排序比对，与创建序无关）
    const linkRows = (wsDb.prepare('SELECT source_page_id, target_page_id, resolved FROM knowledge_link').all() as Array<{ source_page_id: string; target_page_id: string; resolved: number }>)
      .sort((left, right) => (left.source_page_id < right.source_page_id ? -1 : 1));
    expect(linkRows).toEqual([
      { source_page_id: w1.id, target_page_id: common.id, resolved: 1 },
      { source_page_id: w2.id, target_page_id: common.id, resolved: 1 },
    ].sort((left, right) => (left.source_page_id < right.source_page_id ? -1 : 1)));
    // 反链 both：两路合并 + page_total 精确求和 + 窗口翻页
    const backlinks = await request(app).get(`/api/knowledge/pages/${common.id}/backlinks`).query({ scope: 'both', workspace_id: ws });
    expect(backlinks.status).toBe(200);
    expect(backlinks.body.page_total).toBe(2);
    expect(backlinks.body.items.map((row: { page_id: string }) => row.page_id).sort()).toEqual([w1.id, w2.id].sort());
    const windowed = await request(app).get(`/api/knowledge/pages/${common.id}/backlinks`).query({ scope: 'both', workspace_id: ws, limit: 1, offset: 1 });
    expect(windowed.body.page_total).toBe(2);
    expect(windowed.body.items).toHaveLength(1);
    // 单库边界：scope=common 反链只查中心库（跨库反链走 both）
    const commonOnly = await request(app).get(`/api/knowledge/pages/${common.id}/backlinks`).query({ scope: 'common' });
    expect(commonOnly.body.page_total).toBe(0);
    // 图谱 both：跨库 link 边存在（两端都在加载集合里）。边方向经 pairKey 字典序归一（既有行为），按无序对断言
    const graph = await request(app).get('/api/knowledge/graph').query({ scope: 'both', workspace_id: ws, edge_kinds: 'link' });
    expect(graph.status).toBe(200);
    const linkEdges = graph.body.edges.filter((edge: { kind: string }) => edge.kind === 'link');
    const hasLinkEdge = (left: string, right: string) => linkEdges.some((edge: { source: string; target: string }) =>
      (edge.source === left && edge.target === right) || (edge.source === right && edge.target === left));
    expect(hasLinkEdge(w1.id, common.id)).toBe(true);
    expect(hasLinkEdge(w2.id, common.id)).toBe(true);
    // 目标页软删：图谱边消失（读时解析在端点层收口）、不报错；reparse 后存疑 resolved 行收敛为 0
    const deleted = await request(app).post(`/api/knowledge/pages/${common.id}/actions`)
      .send({ scope: 'common', action: 'delete', expected_revision: 1, actor: 'tester' });
    expect(deleted.status).toBe(200);
    const graphAfter = await request(app).get('/api/knowledge/graph').query({ scope: 'both', workspace_id: ws, edge_kinds: 'link' });
    expect(graphAfter.status).toBe(200);
    expect(graphAfter.body.edges.filter((edge: { kind: string }) => edge.kind === 'link')).toEqual([]);
    expect((wsDb.prepare('SELECT resolved FROM knowledge_link WHERE source_page_id=?').get(w1.id) as { resolved: number }).resolved).toBe(1);
    const reparse = await request(app).post('/api/knowledge/reparse').send({});
    expect(reparse.status).toBe(200);
    expect((wsDb.prepare('SELECT resolved, target_page_id FROM knowledge_link WHERE source_page_id=?').get(w1.id) as { resolved: number; target_page_id: string | null }).resolved).toBe(0);
    // 已删目标页的反链查询保持 404（不 500）
    const backlinksAfter = await request(app).get(`/api/knowledge/pages/${common.id}/backlinks`).query({ scope: 'both', workspace_id: ws });
    expect(backlinksAfter.status).toBe(404);
  });

  it('reparse resolves late-created cross-db target via center handle', async () => {
    const w1 = createWs('late-link', '参见 [[late]]');
    expect((wsDb.prepare('SELECT resolved FROM knowledge_link WHERE source_page_id=?').get(w1.id) as { resolved: number }).resolved).toBe(0);
    const late = createCommon('late');
    const reparse = await request(app).post('/api/knowledge/reparse').send({});
    expect(reparse.status).toBe(200);
    const row = wsDb.prepare('SELECT target_page_id, resolved FROM knowledge_link WHERE source_page_id=?').get(w1.id) as { target_page_id: string; resolved: number };
    expect(row).toEqual({ target_page_id: late.id, resolved: 1 });
  });

  it('legacy fk workspace db is relaxed on first knowledge request, then cross-db links work', async () => {
    // 模拟升级前 localize 的工作区库：knowledge_link 仍是老结构（target 外键）
    wsDb.exec('DROP TABLE knowledge_link');
    wsDb.exec(`CREATE TABLE knowledge_link (
      id TEXT PRIMARY KEY,
      source_page_id TEXT NOT NULL REFERENCES knowledge_page(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, target_slug_norm TEXT NOT NULL, raw_target TEXT NOT NULL,
      alias TEXT, heading TEXT,
      target_page_id TEXT REFERENCES knowledge_page(id) ON DELETE SET NULL,
      resolved INTEGER NOT NULL CHECK(resolved IN (0,1)), weight INTEGER NOT NULL DEFAULT 1 CHECK(weight>0),
      created_at INTEGER NOT NULL)`);
    const common = createCommon('shared');
    const probe = await request(app).get('/api/knowledge/search').query({ scope: 'workspace', workspace_id: ws, q: '缓存' });
    expect(probe.status).toBe(200);
    const sql = (wsDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_link'").get() as { sql: string }).sql;
    expect(sql).not.toMatch(/target_page_id\s+TEXT\s+REFERENCES/i);
    // 松绑后：工作区页双链 common 页可建且跨库解析
    const created = await request(app).post('/api/knowledge/pages').send(pageInput({
      scope: 'workspace', workspace_id: ws, slug: 'after-relax', title: '松绑后', body_md: '参见 [[shared]]',
    }));
    expect(created.status).toBe(200);
    const row = wsDb.prepare('SELECT target_page_id, resolved FROM knowledge_link WHERE source_page_id=?').get(created.body.id) as { target_page_id: string; resolved: number };
    expect(row).toEqual({ target_page_id: common.id, resolved: 1 });
  });

  it('images follow page scope: common into center dir, workspace into ws dir, cross-db locate serves both', async () => {
    const common = createCommon('img-common');
    const local = createWs('img-local');
    const upload = async (pageId: string, scope: 'common' | 'workspace') => {
      const { body, contentType } = multipartBody(
        scope === 'common' ? { scope: 'common' } : { scope: 'workspace', workspace_id: ws },
        { filename: 'px.png', contentType: 'image/png', data: png() },
      );
      return request(app).post(`/api/knowledge/pages/${pageId}/images`)
        .set('Content-Type', contentType)
        .send(body);
    };
    const commonImg = await upload(common.id, 'common');
    expect(commonImg.status).toBe(201);
    const localImg = await upload(local.id, 'workspace');
    expect(localImg.status).toBe(201);
    const centerRoot = knowledgeAttachmentsRoot(t.db);
    const wsRoot = knowledgeAttachmentsRoot(wsDb);
    expect(centerRoot).not.toBe(wsRoot);
    expect(existsSync(join(centerRoot, 'knowledge', common.id, `${commonImg.body.id}.png`))).toBe(true);
    expect(existsSync(join(wsRoot, 'knowledge', local.id, `${localImg.body.id}.png`))).toBe(true);
    // 工作区图片行在工作区库：locate 跨库找到并返回
    const servedCommon = await request(app).get(`/api/knowledge/images/${commonImg.body.id}`).query({ scope: 'common' });
    expect(servedCommon.status).toBe(200);
    const servedLocal = await request(app).get(`/api/knowledge/images/${localImg.body.id}`).query({ scope: 'workspace', workspace_id: ws });
    expect(servedLocal.status).toBe(200);
  });
});
