/**
 * P2-02 export-legacy：fan-out 导出、manifest、回读校验（C8 混合态夹具）。
 *
 * 夹具复刻真实混合态：中心库（common 页 + 未下沉 W1 的区页）+ 已下沉 W2 的 localized 工作区库。
 * 覆盖：dry-run 清单与源库分布 / 实跑逐文件 sha256 + front matter 比对 / 幂等复跑不新增文件 /
 * 冲突备份暂停不覆盖 / 同 id 跨库去重（localized 副本优先）/ --to 重定向 / 旧库只读（行不变）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createKnowledgeExportRouter } from '../src/api/knowledgeExportRoutes.js';
import { errorHandler } from '../src/api/routes.js';
import { listLegacyKnowledgeRows } from '../src/db/repos/knowledge.js';
import { parseKnowledgeDocument } from '@agentboard/shared';

// 本机（Windows AV）落盘抖动：放宽用例与钩子超时
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const sources = [{ source_id: 's', source_type: 'agent' as const, locator: 'issue:1', captured_at: 1, content_hash: '0123456789abcdef'.repeat(4), snapshot: 'verified' }];
const evidence = [{ source_id: 's', locator: 'issue:1' }];

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('P2-02 export-legacy（fan-out / manifest / 回读校验）', () => {
  let root: string;
  let center: TestDb;
  let wsDb: TestDb;
  let w1: string; // 未下沉区（行在中心库）
  let w2: string; // 已下沉区（行在工作区库）
  let commonDocs: string;
  let app: Express;

  const seed = (db: TestDb, over: {
    id: string; scope: 'workspace' | 'common'; workspace_id: string | null; slug: string; title: string; body: string;
    status?: 'active' | 'archived' | 'deleted'; revision?: number; category?: string | null; landed?: string | null;
    domain?: string | null; change_note?: string;
  }): void => {
    const now = 1700000000000;
    db.db.prepare(
      `INSERT INTO knowledge_page (id,scope,workspace_id,slug,title,body_md,status,revision,expires_at,created_by,updated_by,created_at,updated_at,category,landed,domain)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(over.id, over.scope, over.workspace_id, over.slug, over.title, over.body, over.status ?? 'active', over.revision ?? 1, null, 'seed', 'seed', now, now, over.category ?? 'legacy', over.landed ?? null, over.domain ?? null);
    const rev = over.revision ?? 1;
    db.db.prepare(
      `INSERT INTO knowledge_revision (id,page_id,revision,title_snapshot,body_snapshot,sources_json,evidence_json,change_kind,status_snapshot,expires_at_snapshot,change_note,actor,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(`rev-${over.id}`, over.id, rev, over.title, over.body, JSON.stringify(sources), JSON.stringify(evidence), rev === 1 ? 'create' : 'update', over.status ?? 'active', null, over.change_note ?? 'seed note', 'seed', now);
  };

  const docsOf = (workspaceId: string): string => {
    const row = center.db.prepare('SELECT path FROM workspace WHERE id=?').get(workspaceId) as { path: string };
    return join(row.path, '.agentboard', 'Docs');
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentboard-kb-export-'));
    center = createTestDb({ legacyKnowledge: true });
    wsDb = createTestDb({ legacyKnowledge: true });
    commonDocs = join(root, 'home', '.agentboard', 'Docs');
    const w1Path = join(root, 'ws-w1');
    const w2Path = join(root, 'ws-w2');
    mkdirSync(w1Path, { recursive: true });
    mkdirSync(w2Path, { recursive: true });
    w1 = createWorkspace(center.db, { name: 'W1', path: w1Path }).id;
    w2 = createWorkspace(center.db, { name: 'W2', path: w2Path }).id;
    // W2 已下沉：db_mode=localized + 工作区库内 meta/workspace 行副本（id 与中心注册一致）
    center.db.prepare("UPDATE workspace SET db_mode='localized' WHERE id=?").run(w2);
    wsDb.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    wsDb.db.prepare("INSERT INTO meta (key,value) VALUES ('localized','1'), ('workspace_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(w2);
    const w2Row = center.db.prepare('SELECT id, name, path, created_at FROM workspace WHERE id=?').get(w2) as { id: string; name: string; path: string; created_at: number };
    wsDb.db.prepare('INSERT INTO workspace (id,name,path,created_at) VALUES (?,?,?,?)').run(w2Row.id, w2Row.name, w2Row.path, w2Row.created_at);
    app = express();
    app.use(express.json());
    app.use('/api/knowledge', createKnowledgeExportRouter({
      db: center.db,
      listWorkspaceDbs: () => [wsDb.db],
      getWorkspaceRow: (workspaceId) => {
        const row = center.db.prepare('SELECT id, path FROM workspace WHERE id=?').get(workspaceId) as { id: string; path: string } | undefined;
        return row ?? null;
      },
      docsPaths: { commonDocsDir: () => commonDocs },
    }));
    app.use(errorHandler);
  });

  afterEach(() => {
    center.cleanup();
    wsDb.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  const rowsSnapshot = (): { center: unknown[]; ws: unknown[] } => ({
    center: listLegacyKnowledgeRows(center.db),
    ws: listLegacyKnowledgeRows(wsDb.db),
  });

  it('dry-run：混合态三源（中心 common + 未下沉 W1 区页 + localized W2 区页）清单与源库分布，不写文件', async () => {
    seed(center, { id: '11111111-0000-4000-8000-000000000001', scope: 'common', workspace_id: null, slug: 'common-a', title: '公共页A', body: '公共正文A' });
    seed(center, { id: '11111111-0000-4000-8000-000000000002', scope: 'workspace', workspace_id: w1, slug: 'w1-page', title: 'W1区页', body: 'W1正文' });
    seed(wsDb, { id: '11111111-0000-4000-8000-000000000003', scope: 'workspace', workspace_id: w2, slug: 'w2-page', title: 'W2区页', body: 'W2正文', category: 'design', landed: 'proposed', domain: 'knowledge' });
    const res = await request(app).post('/api/knowledge/export-legacy').send({ dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.dry_run).toBe(true);
    expect(res.body.summary).toEqual({ total: 3, create: 3, unchanged: 0, conflicts: 0, skipped: 0 });
    expect(res.body.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_db: 'workspace#1', pages: 1 }),
      expect.objectContaining({ source_db: 'center', pages: 2 }),
    ]));
    const targets = res.body.targets as Array<{ dir: string; create: number }>;
    expect(targets).toHaveLength(3);
    expect(targets.map(t => t.dir)).toEqual(expect.arrayContaining([commonDocs, docsOf(w1), docsOf(w2)]));
    expect(targets.every(t => t.create === 1)).toBe(true);
    // 清单逐页带目标与文件名
    const pages = res.body.pages as Array<{ id: string; target_dir: string; file: string; action: string }>;
    expect(pages.map(p => p.action)).toEqual(['create', 'create', 'create']);
    expect(pages.find(p => p.id.endsWith('0001'))!.file).toBe('common-a.md');
    expect(pages.find(p => p.id.endsWith('0003'))!.target_dir).toBe(docsOf(w2));
    // dry-run 不写任何东西
    expect(existsSync(commonDocs)).toBe(false);
    expect(existsSync(docsOf(w2))).toBe(false);
  });

  it('实跑：文件数=行集数、正文逐字节回读、front matter 字段保真、manifest sha256、旧库行不变、软删页跳过', async () => {
    seed(center, { id: '11111111-0000-4000-8000-000000000001', scope: 'common', workspace_id: null, slug: 'common-a', title: '公共页A', body: '公共正文A\n\n第二段', change_note: '导入备注' });
    seed(center, { id: '11111111-0000-4000-8000-000000000002', scope: 'workspace', workspace_id: w1, slug: 'w1-page', title: 'W1区页', body: 'W1正文' });
    seed(wsDb, { id: '11111111-0000-4000-8000-000000000003', scope: 'workspace', workspace_id: w2, slug: 'w2-page', title: 'W2区页', body: 'W2正文', status: 'archived' });
    seed(wsDb, { id: '11111111-0000-4000-8000-000000000004', scope: 'workspace', workspace_id: w2, slug: 'w2-deleted', title: 'W2软删页', body: '不应落盘', status: 'deleted' });
    const before = rowsSnapshot();
    const res = await request(app).post('/api/knowledge/export-legacy').send({});
    expect(res.status).toBe(200);
    expect(res.body.dry_run).toBe(false);
    expect(res.body.summary).toEqual({ total: 4, create: 3, unchanged: 0, conflicts: 0, skipped: 1 });
    // 文件数 = 行集数（非软删）
    const commonFile = join(commonDocs, 'common-a.md');
    const w2File = join(docsOf(w2), 'w2-page.md');
    expect(existsSync(commonFile)).toBe(true);
    expect(existsSync(join(docsOf(w1), 'w1-page.md'))).toBe(true);
    expect(existsSync(w2File)).toBe(true);
    expect(existsSync(join(docsOf(w2), 'w2-deleted.md'))).toBe(false);
    // 正文逐字节 + front matter 字段保真（category/landed/domain 缺省保真、change_note 取当前 revision）
    const parsed = parseKnowledgeDocument(readFileSync(commonFile, 'utf8'));
    expect(parsed.body_md).toBe('公共正文A\n\n第二段');
    expect(parsed.meta).toMatchObject({ id: '11111111-0000-4000-8000-000000000001', slug: 'common-a', title: '公共页A', revision: 1, scope: 'common', workspace_id: null, status: 'active', domain: '', category: 'legacy', landed: null, change_note: '导入备注', created_by: 'seed', updated_by: 'seed' });
    expect(parsed.meta.sources).toEqual(sources);
    expect(parsed.meta.evidence).toEqual(evidence);
    const w2Parsed = parseKnowledgeDocument(readFileSync(w2File, 'utf8'));
    expect(w2Parsed.meta).toMatchObject({ status: 'archived', scope: 'workspace', workspace_id: w2 });
    // manifest sha256 与文件一致
    const manifest = JSON.parse(readFileSync(join(commonDocs, '.export-manifest.json'), 'utf8'));
    expect(manifest.format).toBe('agentboard.knowledge-export/1');
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0]).toMatchObject({ file: 'common-a.md', page_id: '11111111-0000-4000-8000-000000000001', slug: 'common-a', revision: 1 });
    expect(manifest.files[0].sha256).toBe(sha256(readFileSync(commonFile, 'utf8')));
    // 旧库行集逐字节不变（只读边界）
    const after = rowsSnapshot();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('幂等复跑：全部已一致、不新增文件、manifest 不重写', async () => {
    seed(center, { id: '11111111-0000-4000-8000-000000000001', scope: 'common', workspace_id: null, slug: 'common-a', title: '公共页A', body: '公共正文A' });
    expect((await request(app).post('/api/knowledge/export-legacy').send({})).status).toBe(200);
    const manifestPath = join(commonDocs, '.export-manifest.json');
    const manifestBefore = readFileSync(manifestPath, 'utf8');
    const filesBefore = readFileSync(join(commonDocs, 'common-a.md'), 'utf8');
    const res = await request(app).post('/api/knowledge/export-legacy').send({});
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ total: 1, create: 0, unchanged: 1, conflicts: 0, skipped: 0 });
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
    expect(readFileSync(join(commonDocs, 'common-a.md'), 'utf8')).toBe(filesBefore);
    expect((res.body.manifests as Array<{ written: boolean }>)[0].written).toBe(false);
  });

  it('冲突：目标已存在且内容不同 → 409 暂停、原文件不被覆盖、备份落 .export-backup；dry-run 只报告不备份', async () => {
    seed(center, { id: '11111111-0000-4000-8000-000000000001', scope: 'common', workspace_id: null, slug: 'common-a', title: '公共页A', body: '新正文' });
    mkdirSync(commonDocs, { recursive: true });
    const target = join(commonDocs, 'common-a.md');
    writeFileSync(target, '人工/旧文件内容，不能被静默覆盖', 'utf8');
    // dry-run：报告冲突，不备份不写
    const dry = await request(app).post('/api/knowledge/export-legacy').send({ dry_run: true });
    expect(dry.status).toBe(200);
    expect(dry.body.summary.conflicts).toBe(1);
    expect(dry.body.conflicts[0]).toMatchObject({ file: 'common-a.md', page_id: '11111111-0000-4000-8000-000000000001' });
    expect(existsSync(join(commonDocs, '.export-backup'))).toBe(false);
    // 实跑：409 + 备份 + 原文件不动
    const res = await request(app).post('/api/knowledge/export-legacy').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('KNOWLEDGE_EXPORT_CONFLICT');
    expect(readFileSync(target, 'utf8')).toBe('人工/旧文件内容，不能被静默覆盖');
    const backupDir = join(commonDocs, '.export-backup');
    expect(existsSync(backupDir)).toBe(true);
    const stampDirs = readdirSync(backupDir);
    expect(stampDirs).toHaveLength(1);
    expect(readFileSync(join(backupDir, stampDirs[0]!, 'common-a.md'), 'utf8')).toBe('人工/旧文件内容，不能被静默覆盖');
  });

  it('C8 同 id 双副本：localized 工作区库为准，中心库残留副本跳过（不双写）', async () => {
    const sharedId = '11111111-0000-4000-8000-000000000009';
    seed(center, { id: sharedId, scope: 'workspace', workspace_id: w2, slug: 'dup-page', title: '中心旧副本', body: '中心正文（过期）', revision: 2 });
    seed(wsDb, { id: sharedId, scope: 'workspace', workspace_id: w2, slug: 'dup-page', title: 'W2现役副本', body: 'W2正文（现役）', revision: 5 });
    const res = await request(app).post('/api/knowledge/export-legacy').send({});
    expect(res.status).toBe(200);
    expect(res.body.summary.total).toBe(1);
    expect(res.body.summary.create).toBe(1);
    const file = join(docsOf(w2), 'dup-page.md');
    const parsed = parseKnowledgeDocument(readFileSync(file, 'utf8'));
    expect(parsed.body_md).toBe('W2正文（现役）');
    expect(parsed.meta.revision).toBe(5);
    expect(parsed.meta.title).toBe('W2现役副本');
  });

  it('--to 重定向输出根：common → <to>/Docs，工作区 → <to>/ws-<id>/Docs', async () => {
    seed(center, { id: '11111111-0000-4000-8000-000000000001', scope: 'common', workspace_id: null, slug: 'common-a', title: '公共页A', body: '正文' });
    seed(wsDb, { id: '11111111-0000-4000-8000-000000000003', scope: 'workspace', workspace_id: w2, slug: 'w2-page', title: 'W2区页', body: '正文' });
    const to = join(root, 'staging');
    const res = await request(app).post('/api/knowledge/export-legacy').send({ to });
    expect(res.status).toBe(200);
    expect(existsSync(join(to, 'Docs', 'common-a.md'))).toBe(true);
    expect(existsSync(join(to, `ws-${w2}`, 'Docs', 'w2-page.md'))).toBe(true);
    expect(existsSync(commonDocs)).toBe(false);
  });

  it('参数校验：scope=workspace 缺 workspace_id → 400；非法 scope → 400', async () => {
    expect((await request(app).post('/api/knowledge/export-legacy').send({ scope: 'workspace' })).status).toBe(400);
    expect((await request(app).post('/api/knowledge/export-legacy').send({ scope: 'bogus' })).status).toBe(400);
    expect((await request(app).post('/api/knowledge/export-legacy').send({ scope: 'center', workspace_id: 'x' })).status).toBe(400);
  });

  it('scope=center：不 fan-out 工作区库，只导中心库行集', async () => {
    seed(center, { id: '11111111-0000-4000-8000-000000000001', scope: 'common', workspace_id: null, slug: 'common-a', title: '公共页A', body: '正文' });
    seed(wsDb, { id: '11111111-0000-4000-8000-000000000003', scope: 'workspace', workspace_id: w2, slug: 'w2-page', title: 'W2区页', body: '正文' });
    const res = await request(app).post('/api/knowledge/export-legacy').send({ scope: 'center', dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.summary.total).toBe(1);
    expect(res.body.pages.map((p: { id: string }) => p.id)).toEqual(['11111111-0000-4000-8000-000000000001']);
  });
});
