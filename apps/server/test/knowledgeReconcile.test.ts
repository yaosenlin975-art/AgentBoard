/**
 * P2：`GET /api/knowledge/reconcile` + `kb knowledge reconcile`。
 *
 * 这条路径此前只有文档、没有入口：`reconcileDocsDir()` 早就存在，但唯一调用点是
 * `POST /api/knowledge/reparse` 的附加字段。文档却把 reconcile 写成 `KNOWLEDGE_FILE_CONFLICT`
 * 的标准处置入口，用户照文档跑 → 「未知命令 reconcile」。
 *
 * 本测试锁三件事：
 * - 只读：调用前后所有 `.md` 的 sha256 **与** mtime 全等
 * - 冲突可见：构造 file_name_mismatch / content_hash 两类真实冲突，issues 能报出来
 * - 契约：scope=both 缺 workspace_id → 400；scope=common 带 workspace_id → 400
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKnowledgeRestFixture } from './helpers.js';

describe('P2 知识页 reconcile 只读报告', () => {
  let f: ReturnType<typeof createKnowledgeRestFixture>;
  let a: string;

  beforeEach(() => {
    f = createKnowledgeRestFixture();
    a = f.a;
  });
  afterEach(() => f.cleanup());

  const pageBody = (overrides: Record<string, unknown> = {}) => ({
    domain: 'knowledge', scope: 'workspace', workspace_id: a, slug: 'p2-page', title: 'P2 页',
    body_md: '原始正文', actor: 'tester',
    sources: [{ source_id: 's', source_type: 'agent', locator: 'issue:1', captured_at: 1, content_hash: '0123456789abcdef'.repeat(4), snapshot: 'ok' }],
    evidence: [{ source_id: 's', locator: 'issue:1' }],
    ...overrides,
  });

  const create = async (overrides: Record<string, unknown> = {}) => {
    const res = await request(f.app).post('/api/knowledge/pages').send(pageBody(overrides));
    expect(res.status).toBe(200);
    return res.body.id as string;
  };

  /** Docs 目录下所有 .md 的 { name → { sha256, mtimeMs } } */
  const snapshotDocs = (): Record<string, { sha256: string; mtimeMs: number }> => {
    const dir = f.docsOf(a);
    const result: Record<string, { sha256: string; mtimeMs: number }> = {};
    let names: string[] = [];
    try { names = readdirSync(dir).filter(name => name.endsWith('.md')); } catch { return result; }
    for (const name of names) {
      const path = join(dir, name);
      result[name] = { sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), mtimeMs: statSync(path).mtimeMs };
    }
    return result;
  };

  it('正常页集合 → 200、issues 为空、checked/valid 计数正确', async () => {
    await create({ slug: 'p2-a', title: 'A' });
    await create({ slug: 'p2-b', title: 'B' });
    const res = await request(f.app).get('/api/knowledge/reconcile').query({ scope: 'workspace', workspace_id: a });
    expect(res.status).toBe(200);
    expect(res.body.issues).toEqual([]);
    expect(res.body.checked).toBe(2);
    expect(res.body.valid).toBe(2);
    expect(res.body.stale_tmp).toEqual([]);
    expect(res.body.stale_locks).toEqual([]);
    expect(typeof res.body.duration_ms).toBe('number');
    expect(res.body.docs_dirs).toHaveLength(1);
  });

  it('只读：调用前后所有 .md 的 sha256 与 mtime 全等', async () => {
    await create({ slug: 'p2-a', title: 'A' });
    await create({ slug: 'p2-b', title: 'B' });
    // 再制造一处冲突，确保报告非空（证明「有问题时也不改文件」）
    const path = join(f.docsOf(a), 'p2-b.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('原始正文', '外部篡改'), 'utf8');
    const before = snapshotDocs();
    expect(Object.keys(before).sort()).toEqual(['p2-a.md', 'p2-b.md']);

    const res = await request(f.app).get('/api/knowledge/reconcile').query({ scope: 'workspace', workspace_id: a });
    expect(res.status).toBe(200);
    expect(res.body.issues.length).toBeGreaterThan(0);

    const after = snapshotDocs();
    // sha256 全等（内容未变）
    for (const name of Object.keys(before)) {
      expect(after[name]!.sha256).toBe(before[name]!.sha256);
    }
    // mtime 全等（未被重写；sha256 相同但 mtime 变了说明被重新落盘过）
    for (const name of Object.keys(before)) {
      expect(after[name]!.mtimeMs).toBe(before[name]!.mtimeMs);
    }
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  });

  it('构造 content_hash 冲突 → issues 报 content_hash 且带 suggestion', async () => {
    await create({ slug: 'p2-bad-hash', title: '坏 hash' });
    const path = join(f.docsOf(a), 'p2-bad-hash.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('原始正文', '外部篡改的正文'), 'utf8');

    const res = await request(f.app).get('/api/knowledge/reconcile').query({ scope: 'workspace', workspace_id: a });
    expect(res.status).toBe(200);
    const issue = (res.body.issues as Array<{ fileName: string; kind: string; detail: string; suggestion?: string }>)
      .find(item => item.fileName === 'p2-bad-hash.md');
    expect(issue).toBeDefined();
    expect(issue!.kind).toBe('content_hash');
    expect(issue!.detail).toContain('content_hash');
    expect(typeof issue!.suggestion).toBe('string');
    // issues 里能定位到目录
    expect(typeof issue!.docs_dir).toBe('string');
  });

  it('构造 file_name_mismatch 冲突 → issues 报 slug 与文件名不一致', async () => {
    await create({ slug: 'p2-rename-me', title: '改名' });
    // 手动改名（不走 rename 命令）→ slug 与文件名不一致
    renameSync(join(f.docsOf(a), 'p2-rename-me.md'), join(f.docsOf(a), 'p2-renamed.md'));

    const res = await request(f.app).get('/api/knowledge/reconcile').query({ scope: 'workspace', workspace_id: a });
    expect(res.status).toBe(200);
    const issue = (res.body.issues as Array<{ fileName: string; kind: string; detail: string }>)
      .find(item => item.kind === 'file_name_mismatch');
    expect(issue).toBeDefined();
    // fileName = 磁盘上的实际文件名；detail = 该 slug 应落成的文件名
    expect(issue!.fileName).toBe('p2-renamed.md');
    expect(issue!.detail).toContain('p2-rename-me');
    expect(issue!.detail).toContain('p2-rename-me.md');
  });

  it('scope=both 缺 workspace_id → 400；scope=common 带 workspace_id → 400', async () => {
    const missing = await request(f.app).get('/api/knowledge/reconcile').query({ scope: 'both' });
    expect(missing.status).toBe(400);
    const forbidden = await request(f.app).get('/api/knowledge/reconcile').query({ scope: 'common', workspace_id: a });
    expect(forbidden.status).toBe(400);
  });

  it('scope=both 带 workspace_id → 200，docs_dirs 含两个目录', async () => {
    await create({ slug: 'p2-ws', title: '工作区页' });
    const res = await request(f.app).get('/api/knowledge/reconcile').query({ scope: 'both', workspace_id: a });
    expect(res.status).toBe(200);
    expect(res.body.docs_dirs).toHaveLength(2);
    expect(res.body.scope).toBe('both');
  });

  it('scope=common → 200，只检查公共目录', async () => {
    await create({ slug: 'p2-common', title: '公共页', scope: 'common', workspace_id: undefined });
    const res = await request(f.app).get('/api/knowledge/reconcile').query({ scope: 'common' });
    expect(res.status).toBe(200);
    expect(res.body.docs_dirs).toHaveLength(1);
    expect(res.body.docs_dirs[0]).toBe(f.commonDocs);
  });
});
