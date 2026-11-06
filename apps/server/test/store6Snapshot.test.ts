/**
 * STORE-6（M4b）：中心库快照 + 附件可携带 + `.agentboard` 进 git 接线。
 *
 * 覆盖卡面验收：
 * ① 未 enable 也能导出（从中心库按工作区过滤），.gitignore / README.md 随快照落位
 * ② 中心库快照的账号引用脱敏为 ***，grep 无明文
 * ③ --include-attachments 导出附件本体，import 后目标目录可用（文件 + 行都在）
 * ④ 缺附件时 import 明确报错并列出 storage_key
 * ⑤ 中心库快照 validate 覆盖（含脱敏自检与哈希篡改）
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from './helpers.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { createKnowledgePage } from '../src/db/repos/knowledge.js';
import { resetResolverState, workspaceStateDir } from '../src/db/resolver.js';
import { resetSessionManager } from '../src/services/sessionManager.js';
import { initSchema } from '../src/db/schema.js';
import { openDb } from '../src/db/connection.js';
import {
  exportWorkspaceSnapshot,
  importWorkspaceSnapshot,
  validateWorkspaceSnapshot,
} from '../src/services/workspaceSnapshot.js';
import {
  centerSnapshotDir,
  exportCenterSnapshot,
  validateCenterSnapshot,
} from '../src/services/centerSnapshot.js';

const ATT_KEY = 'att-1.png';
const KB_KEY = 'knowledge/page-1/kb-1.png';

describe('STORE-6（M4b）中心库快照 / 附件携带 / git 接线', () => {
  let t: TestDb;
  let root: string;
  let wsPath: string;
  let attachmentsDir: string;
  let ws: string;
  let other: string;
  let pageId: string;

  const seed = (db: TestDb['db']) => {
    mkdirSync(attachmentsDir, { recursive: true });
    const pngBytes = Buffer.from('fake-png-bytes-for-sha');
    writeFileSync(join(attachmentsDir, ATT_KEY), pngBytes);
    mkdirSync(join(attachmentsDir, 'knowledge/page-1'), { recursive: true });
    const kbBytes = Buffer.from('fake-knowledge-image');
    writeFileSync(join(attachmentsDir, KB_KEY), kbBytes);

    const now = Date.now();
    db.prepare(
      'INSERT INTO attachment (id, workspace_id, storage_key, file_name, mime_type, kind, size_bytes, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run('att-1', ws, ATT_KEY, 'a.png', 'image/png', 'image', pngBytes.length, 'staged', now, now + 86_400_000);
    db.prepare(
      'INSERT INTO knowledge_attachment (id, page_id, storage_key, mime, bytes, created_by, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run('kb-att-1', pageId, KB_KEY, 'image/png', kbBytes.length, 'tester', now);
    // 账号/签到元数据（引用字段必须脱敏）
    db.prepare(
      `INSERT INTO managed_account (id, app_id, client_instance_id, service_region, identity_hash, display_name,
        client_snapshot_ref, checkin_credential_ref, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('acc-1', 'trae', 'inst-1', 'cn', 'hash-1', '演示号', 'C:/secret/snapshot.json', 'cred-plain-123', now, now);
    db.prepare(
      `INSERT INTO account_operation (id, account_id, app_id, client_instance_id, operation, state, stage, recovery_ref, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run('op-1', 'acc-1', 'trae', 'inst-1', 'switch', 'succeeded', 'verify', 'C:/secret/recovery.json', now);
  };

  beforeEach(() => {
    resetResolverState();
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-store6-'));
    wsPath = join(root, 'ws');
    mkdirSync(wsPath, { recursive: true });
    attachmentsDir = join(root, 'attachments');
    ws = createWorkspace(t.db, { name: '本区', path: wsPath }).id;
    other = createWorkspace(t.db, { name: '别区', path: join(root, 'other') }).id;
    for (const title of ['卡一', '卡二']) {
      createIssue(t.db, { workspace_id: ws, title, description: '', priority: '中', labels: [] } as never);
    }
    createIssue(t.db, { workspace_id: other, title: '别区卡', description: '', priority: '中', labels: [] } as never);
    pageId = createKnowledgePage(t.db, {
      domain: 'knowledge',
      scope: 'workspace',
      workspace_id: ws,
      slug: 'ws-page',
      title: '本区页',
      body_md: '正文',
      sources: [{ source_id: 'file:a.md', source_type: 'file', locator: 'a.md', captured_at: 1, content_hash: 'a'.repeat(64) }],
      evidence: [{ source_id: 'file:a.md', locator: 'a.md:1-2' }],
      actor: 'tester',
    } as never).id;
    createKnowledgePage(t.db, {
      domain: 'knowledge',
      scope: 'common',
      workspace_id: null,
      slug: 'common-page',
      title: '公共页',
      body_md: '公共正文',
      sources: [{ source_id: 'file:b.md', source_type: 'file', locator: 'b.md', captured_at: 1, content_hash: 'b'.repeat(64) }],
      evidence: [{ source_id: 'file:b.md', locator: 'b.md:1-2' }],
      actor: 'tester',
    } as never);
    seed(t.db);
  });
  afterEach(() => {
    resetResolverState();
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const snapshotDir = () => join(workspaceStateDir(wsPath), 'snapshot');
  const exportFromCenter = (extra: { includeAttachments?: boolean; includeMessages?: boolean } = {}) =>
    exportWorkspaceSnapshot({
      db: t.db,
      workspaceId: ws,
      workspacePath: wsPath,
      sourceDbPath: t.db.name,
      attachmentsDir,
      ...extra,
    });

  it('① 未 enable 也能导出：按工作区过滤行集，.gitignore/README 随快照落位', () => {
    const result = exportFromCenter();
    expect(result.manifest.workspace_id).toBe(ws);
    expect(result.manifest.included_tables).not.toContain('message');
    expect(result.manifest.included_tables).not.toContain('attachment');
    const issues = readFileSync(join(result.dir, 'issues.jsonl'), 'utf8').trim().split('\n');
    expect(issues).toHaveLength(2);
    expect(issues.join('\n')).not.toContain('别区卡');
    // 公共知识页不属于本工作区快照
    expect(readFileSync(join(result.dir, 'knowledge_pages.jsonl'), 'utf8')).not.toContain('公共页');

    const stateDir = workspaceStateDir(wsPath);
    const gitignore = readFileSync(join(stateDir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('*.db');
    expect(gitignore).toContain('attachments/');
    expect(gitignore).toContain('localize.json');
    expect(readFileSync(join(stateDir, 'README.md'), 'utf8')).toContain('snapshot import');
    expect(validateWorkspaceSnapshot(snapshotDir()).rows.get('issue')?.length).toBe(2);
  });

  it('③ --include-attachments：导出清单 + 本体，import 后文件与行都在', () => {
    const result = exportFromCenter({ includeAttachments: true });
    expect(result.manifest.included_tables).toEqual(expect.arrayContaining(['attachment', 'knowledge_attachment']));
    const attachments = result.manifest.attachments ?? [];
    expect(attachments.map(item => item.storage_key).sort()).toEqual([ATT_KEY, KB_KEY].sort());
    for (const entry of attachments) expect(existsSync(join(result.dir, entry.file))).toBe(true);

    const dir = join(root, 'clone');
    const wsDir = join(dir, 'workspace');
    mkdirSync(wsDir, { recursive: true });
    const target = openDb(join(dir, 'agentboard.db'));
    try {
      initSchema(target);
      target.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      target.prepare('INSERT INTO workspace (id, name, path, created_at, sort_order) VALUES (?, ?, ?, ?, ?)').run(ws, 'clone', wsDir, Date.now(), 0);
      target.prepare("INSERT INTO meta (key, value) VALUES ('workspace_id', ?), ('localized', '1')").run(ws);
      const imported = importWorkspaceSnapshot({ db: target, dir: result.dir, workspaceId: ws, workspacePath: wsDir });
      expect(imported.tables.find(item => item.table === 'attachment')?.rows).toBe(1);
      expect(imported.tables.find(item => item.table === 'knowledge_attachment')?.rows).toBe(1);
      const targetAttachments = join(workspaceStateDir(wsDir), 'attachments');
      expect(readFileSync(join(targetAttachments, ATT_KEY), 'utf8')).toBe('fake-png-bytes-for-sha');
      expect(readFileSync(join(targetAttachments, KB_KEY), 'utf8')).toBe('fake-knowledge-image');
    } finally {
      target.close();
    }
  });

  it('③b 导入后真实 app 打开知识页图片返回 200（卡面验收 3）', async () => {
    const result = exportFromCenter({ includeAttachments: true });
    const cloneRoot = join(root, 'clone-http');
    const cloneWs = join(cloneRoot, 'workspace');
    const stateDir = workspaceStateDir(cloneWs);
    mkdirSync(stateDir, { recursive: true });
    const target = openDb(join(stateDir, 'agentboard.db'));
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      initSchema(target);
      target.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      target.prepare('INSERT INTO workspace (id, name, path, created_at, sort_order) VALUES (?, ?, ?, ?, ?)').run(ws, 'clone', cloneWs, Date.now(), 0);
      target.prepare("INSERT INTO meta (key, value) VALUES ('workspace_id', ?)").run(ws);
      importWorkspaceSnapshot({ db: target, dir: result.dir, workspaceId: ws, workspacePath: cloneWs });

      app = await createApp({ db: target, refreshClisOnBoot: false });
      const hit = await request(app.app).get('/api/knowledge/images/kb-att-1').query({ workspace_id: ws });
      expect(hit.status).toBe(200);
      expect(hit.type).toBe('image/png');
      expect(Buffer.from(hit.body).toString()).toBe('fake-knowledge-image');
    } finally {
      resetSessionManager();
      target.close();
    }
  });

  it('④ 缺附件：文件被删 → validate 明确报缺 storage_key；清单与行不一致 → import 拒绝', () => {
    const result = exportFromCenter({ includeAttachments: true });
    rmSync(join(result.dir, 'attachments', KB_KEY));
    expect(() => validateWorkspaceSnapshot(result.dir)).toThrowError(/附件文件缺失/);
    expect(() => validateWorkspaceSnapshot(result.dir)).toThrowError(new RegExp(KB_KEY.replace(/[/.]/g, '\\$&')));

    // 行在、manifest.attachments 被摘掉（等价「只导了清单」的坏快照）→ import 必须拒绝
    const second = exportFromCenter({ includeAttachments: true });
    const manifestPath = join(second.dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    delete manifest.attachments;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const targetPath = join(root, 'clone2');
    mkdirSync(targetPath, { recursive: true });
    const target = openDb(join(targetPath, 'agentboard.db'));
    try {
      initSchema(target);
      target.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      target.prepare('INSERT INTO workspace (id, name, path, created_at, sort_order) VALUES (?, ?, ?, ?, ?)').run(ws, 'clone2', targetPath, Date.now(), 0);
      target.prepare("INSERT INTO meta (key, value) VALUES ('workspace_id', ?), ('localized', '1')").run(ws);
      expect(() =>
        importWorkspaceSnapshot({ db: target, dir: second.dir, workspaceId: ws, workspacePath: targetPath }),
      ).toThrowError(/附件文件缺失/);
    } finally {
      target.close();
    }
  });

  it('⑤ 中心库快照：注册表/成员/账号元数据/公共知识，引用脱敏为 ***', () => {
    const result = exportCenterSnapshot({ db: t.db, centerDbPath: t.db.name });
    expect(result.dir).toBe(centerSnapshotDir(t.db.name));
    expect(result.manifest.files.map(item => item.file)).toEqual([
      'workspaces',
      'workspace_members',
      'managed_accounts',
      'account_operations',
      'common_knowledge_pages',
      'common_knowledge_revisions',
    ]);
    const accounts = readFileSync(join(result.dir, 'managed_accounts.jsonl'), 'utf8');
    expect(accounts).toContain('***');
    expect(accounts).not.toContain('secret');
    expect(accounts).not.toContain('cred-plain-123');
    const operations = readFileSync(join(result.dir, 'account_operations.jsonl'), 'utf8');
    expect(operations).not.toContain('recovery.json');
    const pages = readFileSync(join(result.dir, 'common_knowledge_pages.jsonl'), 'utf8');
    expect(pages).toContain('公共页');
    expect(pages).not.toContain('本区页');
    const workspaces = readFileSync(join(result.dir, 'workspaces.jsonl'), 'utf8');
    expect(workspaces).toContain('本区');
    expect(workspaces).toContain('别区');

    const checked = validateCenterSnapshot(result.dir);
    expect(checked.tables.find(item => item.table === 'knowledge_page')?.rows).toBe(1);
  });

  it('⑤b 中心库快照校验：哈希/行数篡改 → SNAPSHOT_INVALID', () => {
    const result = exportCenterSnapshot({ db: t.db, centerDbPath: t.db.name });
    expect(validateCenterSnapshot(result.dir).manifest.scope).toBe('center');
    writeFileSync(join(result.dir, 'account_operations.jsonl'), `${readFileSync(join(result.dir, 'account_operations.jsonl'), 'utf8')}\n`);
    expect(() => validateCenterSnapshot(result.dir)).toThrowError(/哈希不符|行数与 manifest 不符|不可导入/);
  });
});
