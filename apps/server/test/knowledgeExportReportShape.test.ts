/**
 * S4-P2-5：export-legacy 报告 `pages[]` 曾混入一条 `id=''` 的合成行（action='skip-duplicate'）。
 *
 * 问题：
 * - `ExportPageEntry` 契约要求 `id/slug/scope/workspace_id/status/revision/source_db/target_dir/file`
 *   全部有效，合成行填了 9 个假值（`scope: 'common'`、`revision: 0` 都是撒谎）
 * - CLI 被迫 `.filter(item => item.id !== '')` 补偿
 * - `summary.skipped` 里加了恒为 0 的 `skip-duplicate`，而 `duplicates` 那些页从未进入 `planned`
 *   → `total = create+unchanged+conflicts+skipped` 在混合态下不成立
 *
 * 修法（甲）：`duplicates` 走 `summary.duplicates` 独立字段，不碰 `pages[]`。
 * 本测试锁：`pages[]` 每项 id 非空、等式恒成立、duplicates 独立可读。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createKnowledgeExportRouter } from '../src/api/knowledgeExportRoutes.js';
import { errorHandler } from '../src/api/routes.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const sources = [{ source_id: 's', source_type: 'agent' as const, locator: 'issue:1', captured_at: 1, content_hash: '0123456789abcdef'.repeat(4), snapshot: 'verified' }];
const evidence = [{ source_id: 's', locator: 'issue:1' }];

interface ExportPageEntry {
  id: string; slug: string; title: string; scope: string; workspace_id: string | null;
  status: string; revision: number; source_db: string; target_dir: string; file: string;
  action: string; reason?: string;
}
interface ExportReport {
  pages: ExportPageEntry[];
  summary: { total: number; create: number; unchanged: number; conflicts: number; skipped: number; duplicates: number };
}

describe('S4-P2-5 export-legacy 报告不污染 pages[]', () => {
  let root: string;
  let center: TestDb;
  let wsDb: TestDb;
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
    root = mkdtempSync(join(tmpdir(), 'agentboard-s4-'));
    center = createTestDb({ legacyKnowledge: true });
    wsDb = createTestDb({ legacyKnowledge: true });
    commonDocs = join(root, 'home', '.agentboard', 'Docs');
    app = express();
    app.use(express.json());
    app.use('/api/knowledge', createKnowledgeExportRouter({
      db: center.db,
      listWorkspaceDbs: () => [wsDb.db],
      getWorkspaceRow: () => null,
      docsPaths: { commonDocsDir: () => commonDocs },
    }));
    app.use(errorHandler);
  });
  afterEach(() => {
    center.cleanup();
    wsDb.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  it('每项 pages[].id 非空（契约要求；原实现混入一条 id="" 合成行）', async () => {
    seed(center, { id: '11111111-0000-4000-8000-000000000001', slug: 'a', title: 'A', body: '正文 A\n' });
    const res = await request(app).post('/api/knowledge/export-legacy').send({ dry_run: true });
    expect(res.status).toBe(200);
    const report = res.body as ExportReport;
    expect(report.pages.length).toBeGreaterThan(0);
    for (const page of report.pages) {
      expect(page.id).not.toBe('');
      expect(page.slug).not.toBe('');
      expect(page.file).not.toBe('');
    }
  });

  it('summary.duplicates 是独立字段，且 total = create+unchanged+conflicts+skipped 恒成立', async () => {
    seed(center, { id: '11111111-0000-4000-8000-000000000001', slug: 'a', title: 'A', body: '正文 A\n' });
    seed(center, { id: '11111111-0000-4000-8000-000000000002', slug: 'b', title: 'B', body: '正文 B\n' });
    const res = await request(app).post('/api/knowledge/export-legacy').send({ dry_run: true });
    const { summary } = res.body as ExportReport;
    expect(summary.duplicates).toBe(0);
    expect(summary.total).toBe(summary.create + summary.unchanged + summary.conflicts + summary.skipped);
  });

  it('混合态（同 id 在中心库与工作区库各一份）→ duplicates 计数 +1，pages[] 仍无空 id', async () => {
    // 同一个 id 同时存在于工作区库与中心库 → collect 时后者被去重计入 duplicates。
    // 用 common scope（workspace_id=null）规避 knowledge_page.workspace_id 的 FK，
    // 不影响本用例要验的去重语义。
    const sharedId = '11111111-0000-4000-8000-00000000000a';
    const seedCommon = (db: TestDb): void => {
      seed(db, { id: sharedId, slug: 'dup', title: '重复页', body: '正文\n', scope: 'common', workspace_id: null });
    };
    seedCommon(wsDb);
    seedCommon(center);

    const res = await request(app).post('/api/knowledge/export-legacy').send({ dry_run: true });
    expect(res.status).toBe(200);
    const report = res.body as ExportReport;
    // 关键：duplicates 独立计数，不伪装成一条页行
    expect(report.summary.duplicates).toBe(1);
    expect(report.pages.filter(page => page.id === '')).toHaveLength(0);
    // 该页只出现一次（工作区库副本为准）
    expect(report.pages.filter(page => page.id === sharedId)).toHaveLength(1);
    // 等式仍成立
    expect(report.summary.total).toBe(
      report.summary.create + report.summary.unchanged + report.summary.conflicts + report.summary.skipped,
    );
  });

  it('pages[].action 不含 skip-duplicate（该值已从联合类型删除）', async () => {
    seed(center, { id: '11111111-0000-4000-8000-000000000001', slug: 'a', title: 'A', body: '正文 A\n' });
    const res = await request(app).post('/api/knowledge/export-legacy').send({ dry_run: true });
    const report = res.body as ExportReport;
    expect(report.pages.some(page => page.action === 'skip-duplicate')).toBe(false);
  });

  it('实跑写盘后报告形状一致（非 dry_run 分支）', async () => {
    seed(center, { id: '11111111-0000-4000-8000-000000000001', slug: 'written', title: '写入页', body: '正文\r\n第二行\r\n' });
    const res = await request(app).post('/api/knowledge/export-legacy').send({});
    expect(res.status).toBe(200);
    const report = res.body as ExportReport;
    expect(report.pages.every(page => page.id !== '')).toBe(true);
    expect(report.summary.duplicates).toBe(0);
    expect(existsSync(join(commonDocs, 'written.md'))).toBe(true);
    // manifest 与文件都在
    expect(readdirSync(commonDocs).filter(name => name.endsWith('.md'))).toHaveLength(1);
  });
});
