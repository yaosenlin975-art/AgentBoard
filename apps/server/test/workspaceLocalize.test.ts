/**
 * STORE-2（M2a）第一步：`enable` 的前置检查与 dry-run。
 *
 * 本步**全部只读**：不建库、不搬数据、不改中心库；只验六条硬拒绝与统计口径。
 * 八阶段状态机（backup/create/copy/…/finalize）在 M2a 后续提交里继续，切换判定见卡评论 b1e03bf1。
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { createKnowledgePage } from '../src/db/repos/knowledge.js';
import {
  LOCALIZE_STAGES,
  countWorkspacePayload,
  dryRunLocalize,
  localizeStatePath,
  preflightLocalize,
  readLocalizeState,
  writeLocalizeState,
} from '../src/services/workspaceLocalize.js';

/** STORE-4e：dry-run 与真实迁移终态统一的 counts 键集（契约见 shared WorkspaceLocalizeJobView.counts） */
const AGGREGATE_COUNT_KEYS = ['rows_total', 'attachment_files', 'attachment_bytes', 'db_bytes', 'estimated_bytes'];
const UNIFIED_COUNT_KEYS = [
  'workspace_status', 'issue', 'issue_comment', 'issue_dependency', 'issue_git_baseline', 'issue_draft_audit',
  'session', 'message', 'attachment', 'workspace_change_log',
  'knowledge_page', 'knowledge_revision', 'knowledge_link', 'knowledge_attachment',
  ...AGGREGATE_COUNT_KEYS,
];

describe('STORE-2（M2a）enable 前置检查与 dry-run', () => {
  let t: TestDb;
  let root: string;
  let ws: string;
  let wsPath: string;

  const mkIssueRow = (title: string): void => {
    createIssue(t.db, { workspace_id: ws, title, description: '', priority: '中', labels: [] } as never);
  };

  beforeEach(() => {
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-store2-'));
    wsPath = join(root, 'ws');
    mkdirSync(wsPath, { recursive: true });
    ws = createWorkspace(t.db, { name: '下线区', path: wsPath }).id;
    mkIssueRow('卡一');
    mkIssueRow('卡二');
  });
  afterEach(() => {
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const preflight = (over: Record<string, unknown> = {}) => preflightLocalize(t.db, {
    workspaceId: ws,
    freeBytes: async () => 1024 * 1024 * 1024,
    ...over,
  });

  it('通过前置检查并给出统计（行数按工作区过滤，附件按该区 storage_key 口径、字节来自文件系统）', async () => {
    const attachDir = join(root, 'attachments');
    mkdirSync(attachDir, { recursive: true });
    writeFileSync(join(attachDir, 'a.bin'), Buffer.alloc(1024, 1));
    // STORE-4e：附件统计走该区 storage_key（与真实拷贝同集合）——同目录放一个别区的文件不计数
    writeFileSync(join(attachDir, 'other-ws.bin'), Buffer.alloc(4096, 1));
    t.db.prepare(
      "INSERT INTO attachment (id, workspace_id, storage_key, file_name, mime_type, kind, size_bytes, status, created_at, expires_at) VALUES ('att-dry', ?, 'a.bin', 'a.bin', 'application/octet-stream', 'file', 1024, 'attached', 1, 9999999999999)",
    ).run(ws);
    const result = await preflight({ attachmentsDir: attachDir });
    expect(result.workspace).toEqual({ id: ws, path: wsPath });
    expect(result.targetDbPath).toBe(join(wsPath, '.agentboard', 'agentboard.db'));
    expect(result.counts.issue).toBe(2);
    expect(result.counts.attachment).toBe(1);
    expect(result.counts.attachment_files).toBe(1);
    expect(result.counts.attachment_bytes).toBe(1024);
    expect(result.counts.db_bytes).toBeGreaterThan(0);
    expect(result.counts.estimated_bytes).toBe(result.counts.attachment_bytes + result.counts.db_bytes);
  });

  it('六条硬拒绝：非本地盘 / 目标已存在 / 空间不足 / 中心库不健康 / 工作区忙 / 已下沉', async () => {
    const unc = createWorkspace(t.db, { name: '网络盘', path: '\\\\server\\share\\proj' }).id;
    await expect(preflightLocalize(t.db, { workspaceId: unc, freeBytes: async () => 1e12 })).rejects.toMatchObject({ code: 'WORKSPACE_PATH_NOT_LOCAL' });

    mkdirSync(join(wsPath, '.agentboard'), { recursive: true });
    writeFileSync(join(wsPath, '.agentboard', 'agentboard.db'), 'existing');
    await expect(preflight()).rejects.toMatchObject({ code: 'TARGET_DB_EXISTS' });
    await expect(preflight({ overwrite: true })).resolves.toBeTruthy();
    rmSync(join(wsPath, '.agentboard', 'agentboard.db'), { force: true });

    await expect(preflight({ freeBytes: async () => 1 })).rejects.toMatchObject({ code: 'INSUFFICIENT_SPACE' });
    await expect(preflight({ integrityCheck: () => 'database disk image is malformed' })).rejects.toMatchObject({ code: 'CENTER_DB_UNHEALTHY' });

    t.db.prepare("INSERT INTO session (id, workspace_id, cli, status, created_at) VALUES ('s1', ?, 'fake', '运行中', 1)").run(ws);
    await expect(preflight()).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
    t.db.prepare("UPDATE session SET status='已结束' WHERE id='s1'").run();

    t.db.prepare("UPDATE workspace SET db_mode='localized' WHERE id=?").run(ws);
    await expect(preflight()).rejects.toMatchObject({ code: 'ALREADY_LOCALIZED' });
  });

  it('已有 localize.json（中间态）→ MIGRATION_BUSY，不重复开始', async () => {
    writeLocalizeState(wsPath, {
      migration_id: 'mig-1', workspace_id: ws, stage: 'copy', center_db: t.db.name,
      backup_path: null, started_at: 1, counts: {}, last_error: null,
    });
    await expect(preflight()).rejects.toMatchObject({ code: 'MIGRATION_BUSY' });
    expect(readLocalizeState(wsPath)).toMatchObject({ migration_id: 'mig-1', stage: 'copy' });
    expect(localizeStatePath(wsPath)).toBe(join(wsPath, '.agentboard', 'localize.json'));
  });

  it('dry-run：不产生库文件、不改中心库大小、不落 localize.json（验收 1）', async () => {
    const before = statSync(t.db.name).size;
    const result = await dryRunLocalize(t.db, { workspaceId: ws, freeBytes: async () => 1e12 });
    expect(result.counts.issue).toBe(2);
    expect(statSync(t.db.name).size).toBe(before);
    expect(readLocalizeState(wsPath)).toBeNull();
    // 目录可能被 mkdir（可写探测需要），但**库文件绝不能存在**
    try {
      statSync(join(wsPath, '.agentboard', 'agentboard.db'));
      throw new Error('dry-run 不应创建库文件');
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
    }
  });

  it('统计口径：知识页/修订只算 scope=workspace 且属于本区的', async () => {
    const commonDir = join(root, 'c');
    mkdirSync(commonDir, { recursive: true });
    createKnowledgePage(t.db, { domain: 'knowledge',
      scope: 'workspace', workspace_id: ws, slug: 'ws-page', title: '本区页', body_md: '正文',
      sources: [{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: 'a'.repeat(64) }],
      evidence: [{ source_id: 'file:README.md', locator: 'file:1-20' }], actor: 'tester',
    } as never);
    createKnowledgePage(t.db, { domain: 'knowledge',
      scope: 'common', slug: 'common-page', title: '公共页', body_md: '正文',
      sources: [{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: 'a'.repeat(64) }],
      evidence: [{ source_id: 'file:README.md', locator: 'file:1-20' }], actor: 'tester',
    } as never);
    const counts = countWorkspacePayload(t.db, { id: ws, path: wsPath }, { attachmentsDir: join(root, 'none') });
    expect(counts.knowledge_page).toBe(1);
    expect(counts.knowledge_revision).toBe(1);
    expect(counts.attachment).toBe(0);
    expect(counts.attachment_files).toBe(0);
  });

  it('STORE-4e 键集统一：dry-run counts 与真实迁移终态同一键集（14 张 scoped 表 + 5 个聚合键）', async () => {
    const result = await dryRunLocalize(t.db, { workspaceId: ws, freeBytes: async () => 1e12 });
    expect(Object.keys(result.counts).sort()).toEqual(UNIFIED_COUNT_KEYS.slice().sort());
    // rows_total = Σ scoped 表（含 workspace_status），change_log 旧键不复存在
    const rowKeys = UNIFIED_COUNT_KEYS.filter((key) => !AGGREGATE_COUNT_KEYS.includes(key));
    expect(result.counts.rows_total).toBe(rowKeys.reduce((sum, key) => sum + result.counts[key]!, 0));
    expect(result.counts).toHaveProperty('workspace_change_log');
    expect(result.counts).not.toHaveProperty('change_log');
  });

  it('阶段顺序常量固定（设计 §6.3）', () => {
    expect([...LOCALIZE_STAGES]).toEqual(['preflight', 'backup', 'create', 'copy', 'copy_attachments', 'verify', 'switch', 'finalize']);
  });
});
