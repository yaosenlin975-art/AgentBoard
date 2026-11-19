/**
 * P2-01（方向 B §8 #4）：scope=both = 工作区 Docs + 公共 Docs 两目录合并（旧跨库 fan-out 已放弃）。
 *
 * - /search both：两目录命中合并、统一 (updated_at desc, id asc) 排序、X-Knowledge-Truncated 置位；
 * - /pages both：合并排序切片、next_offset 精确（窗口法，不报假总数）；
 * - /resolve both：common 与 workspace 两路命中、跨目录同 slug 歧义 409；
 * - /backlinks both：工作页双链到公共页的反链跨目录合并；
 * - /graph both：跨目录 link 边存在；目标页删除（撤文件）后边转 unresolved:<slug> 合成节点（P2-03 S-5）；
 * - /reparse：语义改为重建两目录扫描索引（晚建目标的链接随之解析）。
 * 页面经 REST 创建落文件；需要精确 updated_at 的用例直接写合法 md（renderDocWithHash）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 本机（Windows AV）落盘抖动：放宽用例与钩子超时
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createKnowledgeRouter } from '../src/api/knowledgeRoutes.js';
import { errorHandler } from '../src/api/routes.js';
import { mergeKnowledgeRowsByRecency } from '../src/db/repos/knowledgeSearch.js';
import { renderDocWithHash } from '../src/knowledge/frontMatter.js';
import { docFileNameFor } from '@agentboard/shared';

const sources = [{ source_id: 's', source_type: 'agent' as const, locator: 'issue:1', captured_at: 1, content_hash: '0123456789abcdef'.repeat(4), snapshot: 'verified' }];
const evidence = [{ source_id: 's', locator: 'issue:1' }];

describe('knowledge both 两目录合并（P2-01，替代旧 STORE-4c 跨库合并）', () => {
  let t: TestDb;
  let root: string;
  let commonDocs: string;
  let wsPath: string;
  let ws: string;
  let app: Express;

  const pageInput = (over: Record<string, unknown>) => ({
    domain: 'knowledge', actor: 'tester', sources, evidence, ...over,
  });
  const createCommon = async (slug: string, body = '缓存失效后 WAL checkpoint') => {
    const res = await request(app).post('/api/knowledge/pages').send(pageInput({ scope: 'common', slug, title: `公共-${slug}`, body_md: body }));
    expect(res.status).toBe(200);
    return res.body as { id: string; slug: string; revision: number; created_at: number };
  };
  const createWs = async (slug: string, body = '缓存失效后 WAL checkpoint') => {
    const res = await request(app).post('/api/knowledge/pages').send(pageInput({ scope: 'workspace', workspace_id: ws, slug, title: `区页-${slug}`, body_md: body }));
    expect(res.status).toBe(200);
    return res.body as { id: string; slug: string; revision: number; created_at: number };
  };
  /** 直接写两目录的合法 md（控制 updated_at / id；正文与 hash 一致，索引按有效页收录） */
  const writeDoc = (dir: string, over: { id: string; slug: string; title: string; updated_at: number; body?: string }) => {
    const meta = {
      id: over.id, slug: over.slug, title: over.title, revision: 1,
      scope: dir === commonDocs ? 'common' as const : 'workspace' as const,
      workspace_id: dir === commonDocs ? null : ws,
      status: 'active' as const, domain: 'knowledge', category: 'open', landed: null,
      sources, evidence,
      expires_at: null, created_at: over.updated_at, updated_at: over.updated_at,
      created_by: 'tester', updated_by: 'tester', change_note: '',
    } as unknown as Parameters<typeof renderDocWithHash>[0];
    const { content } = renderDocWithHash(meta, over.body ?? '缓存失效后 WAL checkpoint');
    const target = join(dir, docFileNameFor(over.slug));
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, content, 'utf8');
    return over.id;
  };

  beforeEach(() => {
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-both-'));
    commonDocs = join(root, 'common-docs');
    mkdirSync(commonDocs, { recursive: true });
    wsPath = join(root, 'ws-a');
    mkdirSync(wsPath, { recursive: true });
    ws = createWorkspace(t.db, { name: 'A', path: wsPath }).id;
    app = express();
    app.use(express.json());
    // P2-01：两目录装配（不再有 getWorkspaceDb/listWorkspaceDbs 跨库注入）
    app.use('/api/knowledge', createKnowledgeRouter({
      getWorkspaceRow: (workspaceId) => {
        const row = t.db.prepare('SELECT id, name, path FROM workspace WHERE id=?').get(workspaceId) as { id: string; name: string; path: string } | undefined;
        return row ?? null;
      },
      listWorkspaceRows: () => [{ id: ws, path: wsPath }],
      docsPaths: { commonDocsDir: () => commonDocs },
    }));
    app.use(errorHandler);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    t.cleanup();
  });

  it('mergeKnowledgeRowsByRecency sorts by updated_at desc then id asc', () => {
    const rows = [
      { id: 'b', updated_at: 5 }, { id: 'a', updated_at: 5 }, { id: 'z', updated_at: 9 }, { id: 'c', updated_at: 1 },
    ];
    expect(mergeKnowledgeRowsByRecency([rows.slice(0, 2), rows.slice(2)]).map(row => row.id)).toEqual(['z', 'a', 'b', 'c']);
  });

  it('search both merges two dirs with unified recency order and truncated header', async () => {
    const commonId = writeDoc(commonDocs, { id: '11111111-1111-4111-8111-000000000001', slug: 'shared', title: '公共-shared', updated_at: 2000 });
    const localId = writeDoc(join(wsPath, '.agentboard', 'Docs'), { id: '11111111-1111-4111-8111-000000000002', slug: 'local', title: '区-local', updated_at: 1000 });
    const long = await request(app).get('/api/knowledge/search').query({ scope: 'both', workspace_id: ws, q: '缓存失效' });
    expect(long.status).toBe(200);
    expect(long.headers['x-knowledge-truncated']).toBe('false');
    expect(long.body.map((row: { page_id: string }) => row.page_id)).toEqual([commonId, localId]);
    const short = await request(app).get('/api/knowledge/search').query({ scope: 'both', workspace_id: ws, q: '缓存' });
    expect(short.body.map((row: { page_id: string }) => row.page_id)).toEqual([commonId, localId]);
    // 反转时间序：公共页改旧 → 工作区页排前面（两目录统一排序键，两次调用一致）
    writeDoc(commonDocs, { id: commonId, slug: 'shared', title: '公共-shared', updated_at: 500 });
    const again = await request(app).get('/api/knowledge/search').query({ scope: 'both', workspace_id: ws, q: '缓存失效' });
    expect(again.body.map((row: { page_id: string }) => row.page_id)).toEqual([localId, commonId]);
    // 截断：命中数超过 limit → truncated 置位（合并后无精确总数，不报假总数）
    writeDoc(commonDocs, { id: '11111111-1111-4111-8111-000000000003', slug: 'shared-2', title: '公共-shared-2', updated_at: 3000 });
    const truncated = await request(app).get('/api/knowledge/search').query({ scope: 'both', workspace_id: ws, q: '缓存失效', limit: 1 });
    expect(truncated.body).toHaveLength(1);
    expect(truncated.headers['x-knowledge-truncated']).toBe('true');
  });

  it('pages both merges with exact next_offset across dirs', async () => {
    writeDoc(commonDocs, { id: '22222222-2222-4222-8222-000000000001', slug: 'c1', title: '公共 c1', updated_at: 1000 });
    writeDoc(join(wsPath, '.agentboard', 'Docs'), { id: '22222222-2222-4222-8222-000000000002', slug: 'w1', title: '区 w1', updated_at: 2000 });
    writeDoc(commonDocs, { id: '22222222-2222-4222-8222-000000000003', slug: 'c2', title: '公共 c2', updated_at: 3000 });
    writeDoc(join(wsPath, '.agentboard', 'Docs'), { id: '22222222-2222-4222-8222-000000000004', slug: 'w2', title: '区 w2', updated_at: 4000 });
    const all = await request(app).get('/api/knowledge/pages').query({ scope: 'both', workspace_id: ws, limit: 10 });
    expect(all.status).toBe(200);
    expect(all.body.items.map((row: { id: string }) => row.id)).toEqual([
      '22222222-2222-4222-8222-000000000004',
      '22222222-2222-4222-8222-000000000003',
      '22222222-2222-4222-8222-000000000002',
      '22222222-2222-4222-8222-000000000001',
    ]);
    expect(all.body.next_offset).toBeNull();
    const first = await request(app).get('/api/knowledge/pages').query({ scope: 'both', workspace_id: ws, limit: 2 });
    expect(first.body.items.map((row: { id: string }) => row.id)).toEqual([
      '22222222-2222-4222-8222-000000000004',
      '22222222-2222-4222-8222-000000000003',
    ]);
    expect(first.body.next_offset).toBe(2);
    const second = await request(app).get('/api/knowledge/pages').query({ scope: 'both', workspace_id: ws, limit: 2, offset: 2 });
    expect(second.body.items.map((row: { id: string }) => row.id)).toEqual([
      '22222222-2222-4222-8222-000000000002',
      '22222222-2222-4222-8222-000000000001',
    ]);
    expect(second.body.next_offset).toBeNull();
    // 单目录路径不变：common 只看公共 Docs
    const commonOnly = await request(app).get('/api/knowledge/pages').query({ scope: 'common', limit: 10 });
    expect(commonOnly.body.items.map((row: { id: string }) => row.id)).toEqual([
      '22222222-2222-4222-8222-000000000003',
      '22222222-2222-4222-8222-000000000001',
    ]);
  });

  it('resolve both finds pages across dirs and flags cross-dir slug ambiguity', async () => {
    const common = await createCommon('shared');
    const local = await createWs('local');
    const dupCommon = await createCommon('dup');
    const dupLocal = await createWs('dup');
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

  it('workspace page links to common page: link resolves cross-dir, backlinks and graph merge; deleted target drops edges', async () => {
    const common = await createCommon('shared');
    const w1 = await createWs('w1', '参见 [[shared]] 与缓存');
    const w2 = await createWs('w2', '也参见 [[shared]]');
    // 反链 both：两目录合并 + page_total 精确求和 + 窗口翻页
    const backlinks = await request(app).get(`/api/knowledge/pages/${common.id}/backlinks`).query({ scope: 'both', workspace_id: ws });
    expect(backlinks.status).toBe(200);
    expect(backlinks.body.page_total).toBe(2);
    expect(backlinks.body.items.map((row: { page_id: string }) => row.page_id).sort()).toEqual([w1.id, w2.id].sort());
    const windowed = await request(app).get(`/api/knowledge/pages/${common.id}/backlinks`).query({ scope: 'both', workspace_id: ws, limit: 1, offset: 1 });
    expect(windowed.body.page_total).toBe(2);
    expect(windowed.body.items).toHaveLength(1);
    // 单目录边界：scope=common 反链只看公共 Docs（跨目录反链走 both）
    const commonOnly = await request(app).get(`/api/knowledge/pages/${common.id}/backlinks`).query({ scope: 'common' });
    expect(commonOnly.body.page_total).toBe(0);
    // 图谱 both：跨目录 link 边存在。边方向经 pairKey 字典序归一（既有行为），按无序对断言
    const graph = await request(app).get('/api/knowledge/graph').query({ scope: 'both', workspace_id: ws, edge_kinds: 'link' });
    expect(graph.status).toBe(200);
    const linkEdges = graph.body.edges.filter((edge: { kind: string }) => edge.kind === 'link');
    const hasLinkEdge = (left: string, right: string) => linkEdges.some((edge: { source: string; target: string }) =>
      (edge.source === left && edge.target === right) || (edge.source === right && edge.target === left));
    expect(hasLinkEdge(w1.id, common.id)).toBe(true);
    expect(hasLinkEdge(w2.id, common.id)).toBe(true);
    // 目标页删除（撤文件）：P2-03 S-5——边转 unresolved:<slug> 合成节点（kind:'link'），不报错
    const deleted = await request(app).post(`/api/knowledge/pages/${common.id}/actions`)
      .send({ scope: 'common', action: 'delete', expected_revision: 1, actor: 'tester' });
    expect(deleted.status).toBe(200);
    const graphAfter = await request(app).get('/api/knowledge/graph').query({ scope: 'both', workspace_id: ws, edge_kinds: 'link' });
    expect(graphAfter.status).toBe(200);
    const linkEdgesAfter = graphAfter.body.edges.filter((edge: { kind: string }) => edge.kind === 'link');
    expect(linkEdgesAfter).toHaveLength(2);
    expect(linkEdgesAfter).toContainEqual({ source: w1.id, target: 'unresolved:shared', weight: 1, kind: 'link' });
    expect(linkEdgesAfter).toContainEqual({ source: w2.id, target: 'unresolved:shared', weight: 1, kind: 'link' });
    const unresolvedAfter = graphAfter.body.nodes.find((node: { id: string }) => node.id === 'unresolved:shared');
    expect(unresolvedAfter).toMatchObject({ title: 'shared', node_type: 'unresolved' });
    // 已删目标页的反链查询保持 404（不 500）
    const backlinksAfter = await request(app).get(`/api/knowledge/pages/${common.id}/backlinks`).query({ scope: 'both', workspace_id: ws });
    expect(backlinksAfter.status).toBe(404);
  });

  it('reparse rebuilds both dir indexes and resolves late-created target', async () => {
    const w1 = await createWs('late-link', '参见 [[late]]');
    // 目标未建：P2-03 S-5——边指向 unresolved:<slug> 合成节点（而非无边）
    const graphBefore = await request(app).get('/api/knowledge/graph').query({ scope: 'both', workspace_id: ws, edge_kinds: 'link' });
    expect(graphBefore.status).toBe(200);
    expect(graphBefore.body.edges.filter((edge: { kind: string }) => edge.kind === 'link')).toEqual([
      { source: w1.id, target: 'unresolved:late', weight: 1, kind: 'link' },
    ]);
    const unresolvedBefore = graphBefore.body.nodes.find((node: { id: string }) => node.id === 'unresolved:late');
    expect(unresolvedBefore).toMatchObject({ title: 'late', node_type: 'unresolved' });
    const late = await createCommon('late');
    const reparse = await request(app).post('/api/knowledge/reparse').send({});
    expect(reparse.status).toBe(200);
    expect(reparse.body.pages).toBeGreaterThan(0);
    expect(reparse.body.links).toBeGreaterThan(0);
    // 晚建目标：重建索引后链接解析（重扫是幂等全量重建）
    const graph = await request(app).get('/api/knowledge/graph').query({ scope: 'both', workspace_id: ws, edge_kinds: 'link' });
    const linkEdges = graph.body.edges.filter((edge: { kind: string }) => edge.kind === 'link');
    expect(linkEdges.some((edge: { source: string; target: string }) =>
      (edge.source === w1.id && edge.target === late.id) || (edge.source === late.id && edge.target === w1.id))).toBe(true);
    expect(graph.body.nodes.some((node: { id: string }) => node.id === 'unresolved:late')).toBe(false);
  });
});
