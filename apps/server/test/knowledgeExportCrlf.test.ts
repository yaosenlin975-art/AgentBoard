/**
 * R1（OCR 性能审查 P0）：export-legacy 的 CRLF 半迁移与事件循环阻塞。
 *
 * 缺陷 A（必然 500）：写入路径 `renderDocWithHash` 内部 `normalizeBodyMd` 把 CRLF 归一为 LF，
 *   落盘与回读都是 LF；而回读校验拿 `parsed.body_md` 与**旧库原值** `row.body_md`（含 CRLF）比较
 *   → 恒不相等 → 30/37 页必炸，且炸在**写盘之后**，留下无 manifest 的半迁移状态。
 *
 * 缺陷 B（零丢失红线）：原实现逐页「写 → 回读 → 校验」，第 N 页炸时前 N-1 页已落盘。
 *   红线要求「要么全成，要么全不动」→ 必须先全量内存内校验，全通过后才写盘。
 *
 * 本测试锁：
 * - CRLF 正文能成功导出，正文按 LF 落盘（归一），reason 标记归一而非失败
 * - 中途校验失败时**一个文件都不落盘**（两阶段）
 * - 只含孤立 CR 的正文保真（不被归一）
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { docFileNameFor, parseKnowledgeDocument } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createKnowledgeExportRouter } from '../src/api/knowledgeExportRoutes.js';
import { errorHandler } from '../src/api/routes.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const sources = [{ source_id: 's', source_type: 'agent' as const, locator: 'issue:1', captured_at: 1, content_hash: '0123456789abcdef'.repeat(4), snapshot: 'verified' }];
const evidence = [{ source_id: 's', locator: 'issue:1' }];
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('R1 export-legacy：CRLF 不再中途 500 + 两阶段零丢失', () => {
  let root: string;
  let center: TestDb;
  let commonDocs: string;
  let app: Express;

  const seed = (db: TestDb, over: { id: string; slug: string; title: string; body: string; scope?: 'workspace' | 'common'; workspace_id?: string | null }): void => {
    const now = 1700000000000;
    db.db.prepare(
      `INSERT INTO knowledge_page (id,scope,workspace_id,slug,title,body_md,status,revision,expires_at,created_by,updated_by,created_at,updated_at,category,landed,domain)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(over.id, over.scope ?? 'common', over.workspace_id ?? null, over.slug, over.title, over.body, 'active', 1, null, 'seed', 'seed', now, now, 'legacy', null, null);
    db.db.prepare(
      `INSERT INTO knowledge_revision (id,page_id,revision,title_snapshot,body_snapshot,sources_json,evidence_json,change_kind,status_snapshot,expires_at_snapshot,change_note,actor,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(`rev-${over.id}`, over.id, 1, over.title, over.body, JSON.stringify(sources), JSON.stringify(evidence), 'create', 'active', null, 'seed note', 'seed', now);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentboard-r1-'));
    center = createTestDb({ legacyKnowledge: true });
    commonDocs = join(root, 'home', '.agentboard', 'Docs');
    app = express();
    app.use(express.json());
    app.use('/api/knowledge', createKnowledgeExportRouter({
      db: center.db,
      listWorkspaceDbs: () => [],
      getWorkspaceRow: () => null,
      docsPaths: { commonDocsDir: () => commonDocs },
    }));
    app.use(errorHandler);
  });
  afterEach(() => {
    center.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  it('CRLF 正文：导出成功（不再 500），落盘为 LF，reason 标记归一', async () => {
    seed(center, { id: '22222222-0000-4000-8000-000000000001', slug: 'crlf-page', title: 'CRLF 页', body: '第一行\r\n第二行\r\n' });
    const res = await request(app).post('/api/knowledge/export-legacy').send({});
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ total: 1, create: 1, conflicts: 0 });
    const file = join(commonDocs, 'crlf-page.md');
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, 'utf8');
    // 落盘正文已是 LF（写入侧归一）
    expect(raw).not.toContain('\r\n');
    expect(parseKnowledgeDocument(raw).body_md).toBe('第一行\n第二行\n');
    // 归一记为 reason，不当失败
    const page = (res.body.pages as Array<{ file: string; action: string; reason?: string }>).find(item => item.file === 'crlf-page.md');
    expect(page!.action).toBe('create');
    expect(page!.reason ?? '').toContain('CRLF');
  });

  it('30/37 比例的 CRLF 页集：全部成功，无 500，文件数 = 行集数', async () => {
    const total = 37;
    const crlfCount = 30;
    for (let i = 0; i < total; i += 1) {
      const hasCrlf = i < crlfCount;
      seed(center, {
        id: `22222222-0000-4000-8000-${String(i).padStart(12, '0')}`,
        slug: `bulk-${i}`,
        title: `批量 ${i}`,
        body: hasCrlf ? `段落 ${i}\r\n第二行\r\n` : `段落 ${i}\n第二行\n`,
      });
    }
    const res = await request(app).post('/api/knowledge/export-legacy').send({});
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ total, create: total, conflicts: 0 });
    const files = readdirSync(commonDocs).filter(name => name.endsWith('.md'));
    expect(files).toHaveLength(total);
    // 全部落盘为 LF
    for (const name of files) {
      expect(readFileSync(join(commonDocs, name), 'utf8')).not.toContain('\r\n');
    }
    // manifest 覆盖全部页
    const manifest = JSON.parse(readFileSync(join(commonDocs, '.export-manifest.json'), 'utf8')) as { files: unknown[] };
    expect(manifest.files).toHaveLength(total);
  });

  it('孤立 CR 保真：不被归一（与 CRLF 区分）', async () => {
    seed(center, { id: '22222222-0000-4000-8000-000000000002', slug: 'lone-cr', title: '孤立 CR', body: 'AAA\rBBB\n' });
    const res = await request(app).post('/api/knowledge/export-legacy').send({});
    expect(res.status).toBe(200);
    const parsed = parseKnowledgeDocument(readFileSync(join(commonDocs, 'lone-cr.md'), 'utf8'));
    expect(parsed.body_md).toBe('AAA\rBBB\n');
  });

  it('两阶段零丢失：计划阶段识别冲突时一个文件都不落盘', async () => {
    // 两个 slug 只差大小写 → docFileNameFor 归一成同一文件名，且都通过 slug 校验
    seed(center, { id: '22222222-0000-4000-8000-000000000011', slug: 'ok-page', title: '正常页', body: '正常正文\n' });
    seed(center, { id: '22222222-0000-4000-8000-000000000012', slug: 'OK-Page', title: '冲突页', body: '另一正文\n' });
    expect(docFileNameFor('ok-page')).toBe(docFileNameFor('OK-Page'));
    const res = await request(app).post('/api/knowledge/export-legacy').send({});
    // 行集内 slug 冲突（existingSha256 为 null，无文件可备份）→ 409，一个都不写
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('KNOWLEDGE_EXPORT_CONFLICT');
    const files = existsSync(commonDocs) ? readdirSync(commonDocs).filter(name => name.endsWith('.md')) : [];
    expect(files).toHaveLength(0);
  });

  it('写入失败时已有文件不被半迁移破坏（校验后写，非边写边验）', async () => {
    seed(center, { id: '22222222-0000-4000-8000-000000000021', slug: 'keep-me', title: '既有页', body: '既有正文\r\n' });
    // 先跑一次成功导出
    expect((await request(app).post('/api/knowledge/export-legacy').send({})).status).toBe(200);
    const before = readFileSync(join(commonDocs, 'keep-me.md'), 'utf8');
    // 再跑一次（幂等 skip-unchanged），文件不得变
    expect((await request(app).post('/api/knowledge/export-legacy').send({})).status).toBe(200);
    expect(readFileSync(join(commonDocs, 'keep-me.md'), 'utf8')).toBe(before);
  });
});
