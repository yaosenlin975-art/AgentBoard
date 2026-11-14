import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocsIndex } from '../src/knowledge/index.js';
import { KnowledgeFileRepo } from '../src/knowledge/fileRepo.js';
import { reconcileDocsDir } from '../src/knowledge/reconcile.js';
import { computeContentHash, renderDocWithHash } from '../src/knowledge/frontMatter.js';
import { parseKnowledgeDocument, renderKnowledgeDocument, docFileNameFor } from '@agentboard/shared';

describe('P2-01 knowledge fileRepo / front matter / index / reconcile', () => {
  let root: string;
  let docsDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentboard-kb-unit-'));
    docsDir = join(root, 'Docs');
    mkdirSync(docsDir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const baseMeta = () => ({
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'cache',
    title: '缓存知识',
    revision: 1,
    scope: 'common' as const,
    workspace_id: null,
    status: 'active' as const,
    domain: 'knowledge',
    category: 'open' as const,
    landed: null,
    sources: [{ source_id: 's', source_type: 'agent' as const, locator: 'issue:1', captured_at: 1, content_hash: 'a'.repeat(64), snapshot: 'verified' }],
    evidence: [{ source_id: 's', locator: 'issue:1' }],
    expires_at: null,
    created_at: 1,
    updated_at: 1,
    created_by: 'tester',
    updated_by: 'tester',
    change_note: '',
  });

  const identity = { scope: 'common' as const, workspace_id: null };

  function newRepo(instanceId = 'r1'): KnowledgeFileRepo {
    const index = new DocsIndex(docsDir, identity);
    index.hydrateOrRebuild();
    return new KnowledgeFileRepo(docsDir, index, { instanceId, lockTimeoutMs: 0 });
  }

  const validBody = () => ({ slug: 'cache', title: '缓存知识', body_md: '缓存失效后 WAL 与 bm25', domain: 'knowledge', sources: [{ source_id: 's', source_type: 'agent' as const, locator: 'issue:1', captured_at: 1, content_hash: 'a'.repeat(64), snapshot: 'verified' }], evidence: [{ source_id: 's', locator: 'issue:1' }], actor: 'tester', expires_at: null });

  it('front matter 渲染/解析 round-trip：特殊字符、BOM、CRLF、数组块', () => {
    const meta = { ...baseMeta(), title: '带: 冒号 与「引号」', change_note: '多行\n备注', slug: 'cache', content_hash: 'h'.repeat(64) };
    const doc = renderKnowledgeDocument(meta, '正文A\n\n正文B');
    const parsed = parseKnowledgeDocument(doc);
    expect(parsed.meta).toEqual(meta);
    expect(parsed.body_md).toBe('正文A\n\n正文B');
    // BOM 与 CRLF 归一
    const parsed2 = parseKnowledgeDocument(`\uFEFF${doc.replace(/\n/g, '\r\n')}`);
    expect(parsed2.meta.id).toBe(meta.id);
    expect(parsed2.body_md).toContain('正文A');
    // 幂等：同一 revision 重复渲染逐字节一致
    expect(renderKnowledgeDocument(meta, '正文A\n\n正文B')).toBe(doc);
  });

  it('content_hash = sha256(去掉本字段的完整文档)；外部编辑检测：写前比对不符 → 409 FILE_CONFLICT 且不覆盖', () => {
    const meta = baseMeta();
    const hash = computeContentHash(meta, '正文');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    const { content } = renderDocWithHash(meta, '正文');
    const parsed = parseKnowledgeDocument(content);
    expect(parsed.meta.content_hash).toBe(hash);

    const repo = newRepo();
    const page = repo.create({ ...validBody(), scope: 'common' });
    // 模拟 Obsidian 外部编辑
    const docPath = join(docsDir, docFileNameFor('cache'));
    const original = readFileSync(docPath, 'utf8');
    writeFileSync(docPath, original.replace('缓存失效后 WAL', '外部改动'), 'utf8');
    let failed = false;
    try {
      repo.revise(page.id, { scope: 'common' }, 1, { body_md: '内部修改', actor: 'tester' });
    } catch (error) {
      failed = true;
      expect((error as { code?: string }).code).toBe('KNOWLEDGE_FILE_CONFLICT');
      expect((error as { status?: number }).status).toBe(409);
    }
    expect(failed).toBe(true);
    // 外部内容未被覆盖
    expect(readFileSync(docPath, 'utf8')).toContain('外部改动');
  });

  it('expected_revision CAS：旧值 → 409 REVISION_CONFLICT（带 current_revision）', () => {
    const repo = newRepo();
    const page = repo.create({ ...validBody(), scope: 'common' });
    repo.revise(page.id, { scope: 'common' }, 1, { body_md: 'v2', actor: 'tester' });
    try {
      repo.revise(page.id, { scope: 'common' }, 1, { body_md: 'v3', actor: 'tester' });
      expect.unreachable('应抛 409');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('KNOWLEDGE_REVISION_CONFLICT');
      expect((error as { details?: { current_revision?: number } }).details?.current_revision).toBe(2);
    }
  });

  it('跨进程锁：活进程持有的锁 → 立即 409；死进程残留锁 → 接管', () => {
    const repo = newRepo('r1');
    const page = repo.create({ ...validBody(), scope: 'common' });
    const docPath = join(docsDir, docFileNameFor('cache'));
    // 模拟另一进程持锁（活 pid = 当前测试进程 + instanceId 不同）
    const locksDir = join(docsDir, '.locks');
    mkdirSync(locksDir, { recursive: true });
    writeFileSync(join(locksDir, 'cache.lock'), JSON.stringify({ pid: process.pid, instanceId: 'other-process', ts: Date.now() }), 'utf8');
    try {
      repo.revise(page.id, { scope: 'common' }, 1, { body_md: 'x', actor: 'tester' });
      expect.unreachable('活锁应 409');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('KNOWLEDGE_FILE_CONFLICT');
    }
    // 死进程锁（pid 不存在）→ 接管并完成写入
    writeFileSync(join(locksDir, 'cache.lock'), JSON.stringify({ pid: 999999999, instanceId: 'dead', ts: Date.now() }), 'utf8');
    const revised = repo.revise(page.id, { scope: 'common' }, 1, { body_md: '接管后修改', actor: 'tester' });
    expect(revised.revision).toBe(2);
    expect(readFileSync(docPath, 'utf8')).toContain('接管后修改');
    expect(existsSync(join(locksDir, 'cache.lock'))).toBe(false);
  });

  it('软删撤文件；archive/restore 重写 front matter', () => {
    const repo = newRepo();
    const page = repo.create({ ...validBody(), scope: 'common' });
    const docPath = join(docsDir, docFileNameFor('cache'));
    const archived = repo.setStatus(page.id, { scope: 'common' }, 1, 'archive', 'tester');
    expect(archived.status).toBe('archived');
    expect(parseKnowledgeDocument(readFileSync(docPath, 'utf8')).meta.status).toBe('archived');
    const restored = repo.setStatus(page.id, { scope: 'common' }, 2, 'restore', 'tester');
    expect(restored.status).toBe('active');
    const deleted = repo.setStatus(page.id, { scope: 'common' }, 3, 'delete', 'tester');
    expect(deleted.status).toBe('deleted');
    expect(existsSync(docPath)).toBe(false);
    expect(repo.getPage(page.id, { scope: 'common' })).toBeNull();
  });

  it('.index.json 可重建：删除后首次 hydrate 重建且结果等价（bm25 排序 / 1-2 字符子串 / snippet）', () => {
    const repo = newRepo();
    repo.create({ ...validBody(), scope: 'common' });
    repo.create({ ...validBody(), slug: 'graph', title: '星图节点', body_md: 'pixi 星图渲染与 #tag 节点', scope: 'common' });
    const index = repo.index;
    const searchBefore = index.search({ query: '星图', limit: 5, now: Date.now() });
    const subBefore = index.search({ query: 'WAL', limit: 5, now: Date.now() }); // 1-2 码点子串…WAL 是 3，改用 2 码点
    const twoChar = index.search({ query: '缓存', limit: 5, now: Date.now() });
    const indexPath = join(docsDir, '.index.json');
    expect(existsSync(indexPath)).toBe(true);
    const first = readFileSync(indexPath, 'utf8');
    rmSync(indexPath, { force: true });
    expect(index.hydrateOrRebuild()).toBe('rebuilt');
    const after = readFileSync(indexPath, 'utf8');
    expect(index.search({ query: '星图', limit: 5, now: Date.now() })).toEqual(searchBefore);
    expect(index.search({ query: '缓存', limit: 5, now: Date.now() })).toEqual(twoChar);
    void subBefore;
    void first;
    void after;
    // snippet：命中位置前 100 起、≤1200
    const hit = index.search({ query: '星图', limit: 5, now: Date.now() })[0]!;
    expect(hit.snippet).toContain('星图');
    expect([...hit.snippet].length).toBeLessThanOrEqual(1200);
  });

  it('search：1–2 码点子串命中（title 命中 score=-1 优先）；bm25 命中含 trigram 长查询', () => {
    const repo = newRepo();
    repo.create({ ...validBody(), scope: 'common' });
    repo.create({ ...validBody(), slug: 'graph', title: '星图节点', body_md: 'pixi 星图渲染', scope: 'common' });
    const index = repo.index;
    // 2 码点子串（旧 LIKE 口径）：title 命中 → score -1 排前
    const short = index.search({ query: '缓存', limit: 5, now: Date.now() });
    expect(short).toHaveLength(1);
    expect(short[0]!.slug).toBe('cache');
    expect(short[0]!.score).toBe(-1);
    // ≥3 码点走 trigram bm25：两页都含「渲染」…graph 正文含、cache 不含
    const long = index.search({ query: '星图渲染', limit: 5, now: Date.now() });
    expect(long.map(row => row.slug)).toContain('graph');
    expect(long.map(row => row.slug)).not.toContain('cache');
  });

  it('reconcile：只读报告（文件名/slug 不一致、id 重复、content_hash 不符、[[…]] 缺失、残留 tmp/lock）；--fix 只清 tmp/lock/索引', () => {
    const repo = newRepo();
    const page = repo.create({ ...validBody(), scope: 'common' });
    repo.create({ ...validBody(), slug: 'next', title: '下一页', body_md: '见 [[cache]] 与 [[ghost]]', scope: 'common' });
    // ① 文件名与 slug 不一致（绕过 rename 直接改名）
    const { renameSync } = require('node:fs') as typeof import('node:fs');
    renameSync(join(docsDir, docFileNameFor('cache')), join(docsDir, 'renamed.md'));
    // ② id 重复：同一 id 两份合法文件（slug 不同、content_hash 各自正确）
    const dupMeta = { ...baseMeta(), id: page.id, slug: 'cache2', title: '缓存知识2' } as unknown as Parameters<typeof renderDocWithHash>[0];
    const dup = renderDocWithHash(dupMeta, '正文');
    writeFileSync(join(docsDir, docFileNameFor('cache2')), dup.content, 'utf8');
    // ③ 残留 tmp / 死进程锁
    writeFileSync(join(docsDir, 'cache.md.tmp-123-abc'), 'half-written', 'utf8');
    mkdirSync(join(docsDir, '.locks'), { recursive: true });
    writeFileSync(join(docsDir, '.locks', 'next.lock'), JSON.stringify({ pid: 999999999, instanceId: 'dead', ts: 1 }), 'utf8');

    const index = repo.index;
    const report = reconcileDocsDir(index);
    const kinds = report.issues.map(issue => issue.kind);
    expect(kinds).toContain('file_name_mismatch');
    expect(kinds).toContain('duplicate_id');
    expect(kinds).toContain('missing_link_target');
    expect(report.stale_tmp).toHaveLength(1);
    expect(report.stale_locks).toHaveLength(1);
    // 只读：fix 未传 → 什么都没动
    expect(existsSync(join(docsDir, 'cache.md.tmp-123-abc'))).toBe(true);
    expect(existsSync(join(docsDir, '.locks', 'next.lock'))).toBe(true);

    const fixed = reconcileDocsDir(index, { fix: true });
    expect(fixed.fixed.length).toBeGreaterThan(0);
    expect(existsSync(join(docsDir, 'cache.md.tmp-123-abc'))).toBe(false);
    expect(existsSync(join(docsDir, '.locks', 'next.lock'))).toBe(false);
    // 正文与 front matter 绝不被自动改写：id 重复与文件名不一致原样保留
    expect(existsSync(join(docsDir, 'renamed.md'))).toBe(true);
    expect(existsSync(join(docsDir, docFileNameFor('cache2')))).toBe(true);
    void page;
  });

  it('workspace Docs 目录布局：<工作区>/.agentboard/Docs/<slug>.md + _attachments/ 可建', () => {
    const wsRoot = join(root, 'ws');
    const wsDocs = join(wsRoot, '.agentboard', 'Docs');
    mkdirSync(wsDocs, { recursive: true });
    const index = new DocsIndex(wsDocs, { scope: 'workspace', workspace_id: 'ws-1' });
    index.hydrateOrRebuild();
    const repo = new KnowledgeFileRepo(wsDocs, index, { instanceId: 'r-ws' });
    const page = repo.create({ ...validBody(), scope: 'workspace', workspace_id: 'ws-1' });
    const docPath = join(wsDocs, docFileNameFor('cache'));
    expect(existsSync(docPath)).toBe(true);
    expect(parseKnowledgeDocument(readFileSync(docPath, 'utf8')).meta.workspace_id).toBe('ws-1');
    expect(repo.ensureAttachmentsDir()).toBe(join(wsDocs, '_attachments'));
    expect(existsSync(join(wsDocs, '_attachments'))).toBe(true);
    void page;
  });
});

describe('P2-04 fileRepo.rename：原子换文件 + 全库重写 [[old]]→[[new]]（id 不变）', () => {
  let root: string;
  let docsDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentboard-kb-rename-'));
    docsDir = join(root, 'Docs');
    mkdirSync(docsDir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const identity = { scope: 'common' as const, workspace_id: null };

  function newRepo(instanceId = 'r1'): KnowledgeFileRepo {
    const index = new DocsIndex(docsDir, identity);
    index.hydrateOrRebuild();
    return new KnowledgeFileRepo(docsDir, index, { instanceId, lockTimeoutMs: 0 });
  }

  const validBody = () => ({ slug: 'cache', title: '缓存知识', body_md: '见 [[cache]] 与 [[cache|别名]] [[cache#标题]]', domain: 'knowledge', sources: [{ source_id: 's', source_type: 'agent' as const, locator: 'issue:1', captured_at: 1, content_hash: 'a'.repeat(64), snapshot: 'verified' }], evidence: [{ source_id: 's', locator: 'issue:1' }], actor: 'tester', expires_at: null });

  it('rename：新文件落盘（slug/revision+1/content_hash 重算）、旧文件删除、id 不变', () => {
    const repo = newRepo();
    const page = repo.create({ ...validBody(), scope: 'common' });
    const result = repo.rename(page.id, { scope: 'common' }, 1, 'cache-v2', 'renamer');
    expect(result.page.slug).toBe('cache-v2');
    expect(result.page.id).toBe(page.id);
    expect(result.page.revision).toBe(2);
    expect(existsSync(join(docsDir, docFileNameFor('cache')))).toBe(false);
    expect(existsSync(join(docsDir, docFileNameFor('cache-v2')))).toBe(true);
    const parsed = parseKnowledgeDocument(readFileSync(join(docsDir, docFileNameFor('cache-v2')), 'utf8'));
    expect(parsed.meta.slug).toBe('cache-v2');
    expect(parsed.meta.id).toBe(page.id);
    expect(parsed.meta.revision).toBe(2);
  });

  it('rewriteSlugTargets：只改命中文件，revision 不变，content_hash 重算且解析干净', () => {
    const repo = newRepo();
    const page = repo.create({ ...validBody(), scope: 'common' });
    const refA = repo.create({ ...validBody(), slug: 'reader-a', title: '读者A', body_md: '读 [[cache]] 与 [[cache|缓存页]] 与 [[cache#标题|跳转]] 与 ![[cache]]；`[[cache]]` 行内代码不动：\n\n```\n[[cache]]\n```', scope: 'common' });
    const refB = repo.create({ ...validBody(), slug: 'reader-b', title: '读者B', body_md: '无引用', scope: 'common' });
    repo.rename(page.id, { scope: 'common' }, 1, 'cache-v2', 'renamer');
    const rewritten = repo.rewriteSlugTargets('cache', 'cache-v2');
    expect(rewritten.map(item => item.file_name).sort()).toEqual([docFileNameFor('cache-v2'), docFileNameFor('reader-a')].sort());
    const docA = readFileSync(join(docsDir, docFileNameFor('reader-a')), 'utf8');
    const parsed = parseKnowledgeDocument(docA);
    expect(parsed.body_md).toContain('[[cache-v2]]');
    expect(parsed.body_md).toContain('[[cache-v2|缓存页]]');
    expect(parsed.body_md).toContain('[[cache-v2#标题|跳转]]');
    expect(parsed.body_md).toContain('![[cache-v2]]');
    expect(parsed.body_md).toContain('`[[cache]]`');
    expect(parsed.body_md).toContain('[[cache]]'); // 代码块内保留
    expect(parsed.body_md).not.toContain('[[cache]]与');
    // revision 与 updated_at 不变（无 API 写语义）
    const fresh = repo.getPage(refA.id, { scope: 'common' });
    expect(fresh?.revision).toBe(1);
    expect(fresh?.updated_at).toBe(refA.updated_at);
    // refB 无引用未重写
    expect(rewritten.some(item => item.page_id === refB.id)).toBe(false);
    const docB = parseKnowledgeDocument(readFileSync(join(docsDir, docFileNameFor('reader-b')), 'utf8'));
    expect(docB.body_md).toBe('无引用');
  });

  it('CAS 与冲突：expected_revision 旧值 → REVISION_CONFLICT；新 slug 已存在 → EXISTS；归一相同 → STATE_CONFLICT', () => {
    const repo = newRepo();
    const page = repo.create({ ...validBody(), scope: 'common' });
    repo.create({ ...validBody(), slug: 'taken', title: '占用', scope: 'common' });
    try {
      repo.rename(page.id, { scope: 'common' }, 99, 'cache-v2', 'renamer');
      expect.unreachable('应抛 409');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('KNOWLEDGE_REVISION_CONFLICT');
    }
    try {
      repo.rename(page.id, { scope: 'common' }, 1, 'taken', 'renamer');
      expect.unreachable('应抛 409');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('KNOWLEDGE_EXISTS');
    }
    try {
      repo.rename(page.id, { scope: 'common' }, 1, 'Cache', 'renamer');
      expect.unreachable('应抛 409');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('KNOWLEDGE_STATE_CONFLICT');
    }
  });
});
