/**
 * P2-03：星图较完整 Obsidian 语法（§7.4 语法处置表 / §8 #1）。
 *
 * 真实 app 探针（S-1~S-7 / S-9 语义）：
 * - S-1 `[[a]]` → link 边，重复出现 weight 合并；S-2/S-3 四形态归一到页级；
 * - S-7 `![[b]]` → kind:'embed' 边；`![[x.png]]` → attachment 节点（+embed 边）；
 *   `[[a#^blk]]` → 页级边（heading 保留锚点）；`#tag` → tag 节点；
 *   附件本体落 <Docs>/_attachments/、GET /attachments/:name 兼容读取；
 * - S-5 unresolved 独立节点、unresolved 端点返回未命中目标；
 * - S-6 scope 三态：workspace 页解析到公共页、common 不指工作区页、不画 workspace↔workspace 边；
 * - S-9 改文件即改图（PUT 后索引差量刷新）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { KnowledgeSource } from '@agentboard/shared';
import { createKnowledgeRestFixture } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const source = (locator: string): KnowledgeSource => ({
  source_id: locator, source_type: 'file', locator, captured_at: 1_700_000_000_000, content_hash: createHash('sha256').update(locator).digest('hex'),
});

describe('knowledge graph obsidian syntax (P2-03)', () => {
  let fixture: ReturnType<typeof createKnowledgeRestFixture>;
  let app: Express;
  let workspaceId: string;
  let spaceDir: string;

  beforeEach(async () => {
    fixture = createKnowledgeRestFixture();
    spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-p2-03-'));
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: fixture.t.db,
      getAdapter: (id: string) => { if (id === 'fake') return adapter; throw new Error(`未知适配器 id: ${id}`); },
      adapters: [adapter],
      refreshClisOnBoot: false,
      knowledgeDocsPaths: { commonDocsDir: () => fixture.commonDocs },
    });
    app = created.app;
    // rest fixture 的两个工作区已建；本文件统一用新建的目录（避免与 fixture 默认目录混淆）
    workspaceId = createWorkspace(fixture.t.db, { name: 'P2-03 空间', path: spaceDir }).id;
  });
  afterEach(() => {
    fixture.cleanup();
    rmSync(spaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const page = async (slug: string, body: string, target = workspaceId, scope: 'workspace' | 'common' = 'workspace') => {
    const res = await request(app).post('/api/knowledge/pages').send({
      domain: 'knowledge', scope, ...(scope === 'workspace' ? { workspace_id: target } : {}),
      slug, title: `页 ${slug}`, body_md: body,
      sources: [source(`file:${slug}.ts`)], evidence: [{ source_id: `file:${slug}.ts`, locator: `file:${slug}.ts` }], actor: 'user',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { id: string };
  };

  const graph = async (query: string) => {
    const res = await request(app).get(`/api/knowledge/graph?${query}`);
    expect(res.status).toBe(200);
    return res.body as {
      nodes: Array<{ id: string; title: string; node_type?: string; degree: number }>;
      edges: Array<{ source: string; target: string; kind: string; weight: number }>;
    };
  };

  it('S-1/S-7：[[a]] link 边 weight 合并；![[b]] embed 边；[[a#^blk]] 页级边带锚点', async () => {
    const a = await page('alpha', '目标页内容');
    const b = await page('beta', '见 [[alpha]] 与 [[alpha|别名]] 与 [[alpha#^blk]]；嵌入 ![[alpha]]');
    const payload = await graph(`scope=workspace&workspace_id=${workspaceId}&edge_kinds=link,embed&include_isolated=true`);
    const pageEdges = payload.edges.filter(edge => edge.source === b.id || edge.target === b.id);
    // [[alpha]]×1 + [[alpha|别名]]（同一 target 合并，weight=2）→ 一条 link 边 weight 2；[[alpha#^blk]] 同 target 再并（weight 3）
    const link = pageEdges.find(edge => edge.kind === 'link');
    expect(link).toBeDefined();
    expect([link!.source, link!.target].sort()).toEqual([a.id, b.id].sort());
    expect(link!.weight).toBe(3);
    // ![[alpha]] → 独立 embed 边
    const embed = pageEdges.find(edge => edge.kind === 'embed');
    expect(embed).toBeDefined();
    expect([embed!.source, embed!.target].sort()).toEqual([a.id, b.id].sort());
    expect(embed!.weight).toBe(1);
    // 别名不产生新节点（S-2）
    expect(payload.nodes.map(node => node.title)).not.toContain('别名');
  });

  it('S-7：#tag 生成 tag 节点；![[x.png]] 生成 attachment 节点（embed 边）', async () => {
    const b = await page('taggy', '正文 #主线 与 #子任务；图片 ![[x.png]] 与 ![[x.png]]');
    const payload = await graph(`scope=workspace&workspace_id=${workspaceId}&edge_kinds=link,embed&include_isolated=true`);
    const tagNode = payload.nodes.find(node => node.node_type === 'tag');
    expect(tagNode).toBeDefined();
    expect(tagNode!.title).toBe('#主线');
    const attachmentNode = payload.nodes.find(node => node.node_type === 'attachment');
    expect(attachmentNode).toBeDefined();
    expect(attachmentNode!.title).toBe('x.png');
    // tag 边（kind link）
    expect(payload.edges).toContainEqual(expect.objectContaining({ source: b.id, target: tagNode!.id, kind: 'link', weight: 1 }));
    // 附件边（kind embed；两次出现合并 weight=2）
    expect(payload.edges).toContainEqual(expect.objectContaining({ source: b.id, target: attachmentNode!.id, kind: 'embed', weight: 2 }));
    // 两个 tag 都成节点
    expect(payload.nodes.filter(node => node.node_type === 'tag').map(node => node.title).sort()).toEqual(['#主线', '#子任务']);
  });

  it('S-7：附件上传落 <Docs>/_attachments/、GET /attachments/:name 兼容读取、正文相对路径成 attachment 节点', async () => {
    const a = await page('attach-host', '见 ![[_attachments/shot.png]]');
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const uploaded = await request(app).post(`/api/knowledge/pages/${a.id}/attachments`)
      .set('Content-Type', 'multipart/form-data; boundary=X')
      .attach('file', png, { filename: 'shot.png', contentType: 'image/png' })
      .field('scope', 'workspace')
      .field('workspace_id', workspaceId);
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    expect(uploaded.body.file_name).toBe('shot.png');
    expect(uploaded.body.path).toBe('_attachments/shot.png');
    // 本体真实落在 <Docs>/_attachments/
    const docsDir = join(spaceDir, '.agentboard', 'Docs');
    expect(existsSync(join(docsDir, '_attachments', 'shot.png'))).toBe(true);
    // 兼容读取
    const read = await request(app).get(`/api/knowledge/attachments/shot.png?scope=workspace&workspace_id=${workspaceId}`);
    expect(read.status).toBe(200);
    expect(read.headers['content-type']).toContain('image/png');
    expect(read.body.equals(png)).toBe(true);
    // 路径逃逸拒绝
    const escaped = await request(app).get(`/api/knowledge/attachments/..%2F..%2F..%2Fevil.md?scope=workspace&workspace_id=${workspaceId}`);
    expect([400, 404]).toContain(escaped.status);
    // 图数据源：attachment 节点 + embed 边
    const payload = await graph(`scope=workspace&workspace_id=${workspaceId}&edge_kinds=embed&include_isolated=true`);
    const attachmentNode = payload.nodes.find(node => node.node_type === 'attachment');
    expect(attachmentNode).toBeDefined();
    expect(payload.edges).toContainEqual(expect.objectContaining({ source: a.id, target: attachmentNode!.id, kind: 'embed', weight: 1 }));
  });

  it('S-5：unresolved 独立节点 + unresolved 端点返回未命中目标 + 点击目标不在页节点里', async () => {
    const a = await page('ghost-host', '指向 [[missing-page|缺失]] 与 ![[ghost-embed]]');
    const payload = await graph(`scope=workspace&workspace_id=${workspaceId}&edge_kinds=link&include_isolated=true`);
    // 节点按 id 排序，按 id 精确取（两个 unresolved 节点）
    const missing = payload.nodes.find(node => node.id === 'unresolved:missing-page');
    const ghost = payload.nodes.find(node => node.id === 'unresolved:ghost-embed');
    expect(missing).toBeDefined();
    expect(missing!.title).toBe('missing-page');
    expect(ghost).toBeDefined();
    expect(payload.nodes.map(node => node.id)).not.toContain('missing-page'); // 不是页节点
    expect(payload.edges).toContainEqual(expect.objectContaining({ source: a.id, target: 'unresolved:missing-page', kind: 'link', weight: 1 }));
    // unresolved 端点
    const list = await request(app).get(`/api/knowledge/pages/${a.id}/unresolved?scope=workspace&workspace_id=${workspaceId}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toContainEqual({ raw_target: 'missing-page', alias: '缺失', heading: null });
    // 详情端点 unresolved_links 统计包含
    const detail = await request(app).get(`/api/knowledge/pages/${a.id}?scope=workspace&workspace_id=${workspaceId}`);
    expect(detail.body.unresolved_links).toContainEqual(expect.objectContaining({ raw_target: 'missing-page' }));
  });

  it('S-4：/pages/:id/backlinks 命中（[[a]] 与 ![[a]] 都算引用）', async () => {
    const a = await page('backlink-target', '被指向');
    const b = await page('backlink-source', '[[backlink-target]] 与 ![[backlink-target]] 与 [[backlink-target#节标题]]');
    const res = await request(app).get(`/api/knowledge/pages/${a.id}/backlinks?scope=workspace&workspace_id=${workspaceId}`);
    expect(res.status).toBe(200);
    expect(res.body.page_total).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].page_id).toBe(b.id);
    // 详情 backlinks_count 与反链面板计数一致（S-4）
    const detail = await request(app).get(`/api/knowledge/pages/${a.id}?scope=workspace&workspace_id=${workspaceId}`);
    expect(detail.body.backlinks_count).toBe(1);
  });

  it('S-6：scope 三态；workspace 页解析公共页（scope=both 画边）；common 不指工作区页', async () => {
    const ws = await page('ws-page', '工作区页 [[common-shared]]（跨目录解析）');
    const common = await page('common-shared', '公共页 [[ws-page]]（不指工作区页 → unresolved）', null, 'common');
    // scope=workspace：只本区（跨目录边在 scope=both 合并图中呈现）
    const onlyWs = await graph(`scope=workspace&workspace_id=${workspaceId}&edge_kinds=link&include_isolated=true`);
    expect(onlyWs.nodes.map(node => node.id)).toContain(ws.id);
    expect(onlyWs.nodes.map(node => node.id)).not.toContain(common.id);
    // scope=common：只公共目录；common 页指向工作区页 → unresolved（不画 ws 边）
    const onlyCommon = await graph(`scope=common&edge_kinds=link&include_isolated=true`);
    expect(onlyCommon.nodes.map(node => node.id)).toContain(common.id);
    expect(onlyCommon.nodes.map(node => node.id)).not.toContain(ws.id);
    expect(onlyCommon.edges.some(edge => edge.source === common.id && edge.target === ws.id)).toBe(false);
    const commonUnresolved = onlyCommon.nodes.find(node => node.id === 'unresolved:ws-page');
    expect(commonUnresolved).toBeDefined();
    expect(commonUnresolved!.title).toBe('ws-page');
    // scope=both：合并；S-6 跨目录边在本查询断言（workspace 页 → 公共页）
    const both = await graph(`scope=both&workspace_id=${workspaceId}&edge_kinds=link&include_isolated=true`);
    expect(both.nodes.map(node => node.id)).toEqual(expect.arrayContaining([ws.id, common.id]));
    expect(both.edges).toContainEqual(expect.objectContaining({ source: ws.id, target: common.id, kind: 'link' }));
    // common 页不指工作区页：无 common→ws 边
    expect(both.edges.some(edge => edge.source === common.id && edge.target === ws.id)).toBe(false);
  });

  it('edge_kinds 校验：embed 合法，未知值 400', async () => {
    expect((await request(app).get(`/api/knowledge/graph?scope=workspace&workspace_id=${workspaceId}&edge_kinds=embed`)).status).toBe(200);
    expect((await request(app).get(`/api/knowledge/graph?scope=workspace&workspace_id=${workspaceId}&edge_kinds=embed,link`)).status).toBe(200);
    expect((await request(app).get(`/api/knowledge/graph?scope=workspace&workspace_id=${workspaceId}&edge_kinds=foo`)).status).toBe(400);
  });

  it('S-9：改文件即改图（PUT 后新边出现；目标删除后转 unresolved）', async () => {
    const a = await page('mutable', '初始正文，无链接');
    const b = await page('mutable-target', '目标');
    const before = await graph(`scope=workspace&workspace_id=${workspaceId}&edge_kinds=link&include_isolated=true`);
    expect(before.edges.some(edge => edge.source === a.id && edge.target === b.id)).toBe(false);
    // 改文件（API 写路径 = 文件事实源写）：新增 [[mutable-target]]
    const put = await request(app).put(`/api/knowledge/pages/${a.id}`).send({
      scope: 'workspace', workspace_id: workspaceId, body_md: '改后正文 [[mutable-target]]', expected_revision: 1, actor: 'user',
    });
    expect(put.status).toBe(200);
    const after = await graph(`scope=workspace&workspace_id=${workspaceId}&edge_kinds=link&include_isolated=true`);
    expect(after.edges).toContainEqual(expect.objectContaining({ source: a.id, target: b.id, kind: 'link' }));
    // 删除目标页 → 该边转 unresolved，其它页不受影响
    const del = await request(app).post(`/api/knowledge/pages/${b.id}/actions`).send({
      scope: 'workspace', workspace_id: workspaceId, action: 'delete', expected_revision: 1, actor: 'user',
    });
    expect(del.status).toBe(200);
    const post = await graph(`scope=workspace&workspace_id=${workspaceId}&edge_kinds=link&include_isolated=true`);
    expect(post.edges.some(edge => edge.target === b.id)).toBe(false);
    expect(post.nodes.filter(node => node.node_type === 'unresolved').map(node => node.title)).toContain('mutable-target');
    // a 仍可解析（不影响其它页）
    expect(post.nodes.map(node => node.id)).toContain(a.id);
  });

  it('代码块内的 [[ 与 # 不解析（maskCode 规则沿用）', async () => {
    const a = await page('code-block', '代码：\n```md\n[[not-a-link]]\n#not-a-tag\n```\n行内 `[[also-not]]`');
    const payload = await graph(`scope=workspace&workspace_id=${workspaceId}&edge_kinds=link&include_isolated=true`);
    expect(payload.nodes.filter(node => node.node_type === 'unresolved')).toHaveLength(0);
    expect(payload.edges.filter(edge => edge.source === a.id)).toHaveLength(0);
  });
});
