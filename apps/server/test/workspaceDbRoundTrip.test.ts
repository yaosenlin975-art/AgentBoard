/**
 * ARCH-08：数据下沉主干回归——enable → status → revert 一致性。
 *
 * 只做回归，不改 workspaceDb 实现：在临时工作区目录 + 临时中心库上完整走一遍
 * 下沉（localize）→ 状态查询 → 回迁（revert），断言 issue / issue_comment /
 * knowledge_page / workspace_change_log（卡面称作 changelog）四张表的行数与业务内容
 * 在回迁后与下沉前一致。
 *
 * 不覆盖：中断恢复（job 状态机另立）、附件二进制。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { addComment } from '../src/db/repos/comment.js';
import { createKnowledgePage } from '../src/db/repos/knowledge.js';
import { createChangeLog } from '../src/db/repos/workspaceChangeLog.js';
import type { Db } from '../src/db/connection.js';
import { closeWorkspaceDbs, resetResolverState, workspaceDbPath } from '../src/db/resolver.js';
import { localizeWorkspace } from '../src/services/workspaceLocalizeRun.js';
import { buildWorkspaceDbStatus } from '../src/services/workspaceDbStatus.js';
import { revertWorkspace } from '../src/services/workspaceDbOps.js';
import { WORKSPACE_TABLE_QUERIES } from '../src/services/workspaceScopedQueries.js';

/** 四张必测表（changelog 的真实表名是 workspace_change_log） */
const TABLES = ['issue', 'issue_comment', 'knowledge_page', 'workspace_change_log'] as const;
type TableName = (typeof TABLES)[number];

/**
 * 内容比对列：只取业务列。updated_at 由真实回迁原样复制，这里不依赖它；
 * 若将来回迁开始刷新时间戳，业务列比对仍能抓住真正的数据丢失/错位。
 */
const CONTENT_COLUMNS: Record<TableName, string[]> = {
  issue: ['id', 'workspace_id', 'title', 'description', 'priority', 'labels', 'status', 'sort_order', 'parent_issue_id', 'due_date', 'due_time', 'created_at'],
  issue_comment: ['id', 'issue_id', 'author', 'content', 'ts'],
  knowledge_page: ['id', 'scope', 'workspace_id', 'slug', 'title', 'body_md', 'status', 'revision', 'category', 'landed', 'domain', 'created_at'],
  workspace_change_log: ['id', 'workspace_id', 'origin_workspace_id', 'origin_workspace_name', 'origin_workspace_path', 'title', 'body_md', 'change_type', 'occurred_at', 'created_by', 'updated_by', 'revision'],
};

interface Snapshot {
  counts: Record<TableName, number>;
  /** 按 id 排序后逐行投影的 JSON，直接做内容等值比较 */
  rows: Record<TableName, string>;
}

function scopedQuery(table: TableName): string {
  const found = WORKSPACE_TABLE_QUERIES.find((query) => query.table === table);
  if (found === undefined) throw new Error(`表 ${table} 不在 WORKSPACE_TABLE_QUERIES 内`);
  return found.sql;
}

/** 读某库中该工作区的四表行数与内容（只读语义由调用方保证：不执行任何写语句） */
function snapshot(db: Db, workspaceId: string): Snapshot {
  const counts = {} as Record<TableName, number>;
  const rows = {} as Record<TableName, string>;
  for (const table of TABLES) {
    const projection = CONTENT_COLUMNS[table].join(',');
    const records = db
      .prepare(`SELECT ${projection} FROM (${scopedQuery(table)}) ORDER BY id`)
      .all(workspaceId) as Array<Record<string, unknown>>;
    counts[table] = records.length;
    rows[table] = JSON.stringify(records);
  }
  return { counts, rows };
}

function withReadonlyDb<T>(dbPath: string, run: (db: Db) => T): T {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

describe('ARCH-08 数据下沉主干回归：enable → status → revert', () => {
  let t: TestDb;
  let root: string;
  let wsPath: string;
  let ws: string;

  const attachmentsDir = (): string => join(root, 'attachments');

  const seed = (): void => {
    const workspace = { id: ws, name: '往返区', path: wsPath } as never;
    const issueA = createIssue(t.db, {
      workspace_id: ws,
      title: '主干卡一',
      description: '下沉前内容 A',
      priority: '高',
      labels: ['server', '测试'],
      status: '待规划',
    });
    const issueB = createIssue(t.db, {
      workspace_id: ws,
      title: '主干卡二',
      description: '下沉前内容 B',
      priority: '中',
      labels: [],
      status: '待验收',
    });
    createIssue(t.db, { workspace_id: ws, title: '主干卡三', description: '', priority: '低', labels: [] });

    addComment(t.db, { issue_id: issueA.id, author: 'user', content: '卡一评论：范围确认' });
    addComment(t.db, { issue_id: issueA.id, author: 'agent:tester', content: '卡一评论：开始执行' });
    addComment(t.db, { issue_id: issueB.id, author: 'system', content: '卡二评论：状态流转' });

    for (const [slug, title] of [
      ['round-trip-a', '往返知识页 A'],
      ['round-trip-b', '往返知识页 B'],
    ] as const) {
      createKnowledgePage(t.db, {
        domain: 'knowledge',
        scope: 'workspace',
        workspace_id: ws,
        slug,
        title,
        body_md: `# ${title}\n\n下沉/回迁内容一致性样本。`,
        sources: [{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: 'a'.repeat(64) }],
        evidence: [{ source_id: 'file:README.md', locator: 'file:1-20' }],
        actor: 'tester',
      } as never);
    }

    createChangeLog(t.db, workspace, { title: '变更一', body_md: '下沉前变更正文一', change_type: '新增', actor: 'tester' });
    createChangeLog(t.db, workspace, { title: '变更二', body_md: '下沉前变更正文二', change_type: '修复', actor: 'tester' });
  };

  beforeEach(() => {
    resetResolverState();
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-arch08-'));
    wsPath = join(root, 'ws');
    mkdirSync(wsPath, { recursive: true });
    ws = createWorkspace(t.db, { name: '往返区', path: wsPath }).id;
    seed();
  });

  afterEach(() => {
    // Windows：先关掉工作区库句柄再删临时目录
    closeWorkspaceDbs('arch08-cleanup');
    resetResolverState();
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('四表行数与内容：下沉前 = 下沉后（工作区库）= 回迁后（中心库）', async () => {
    const before = snapshot(t.db, ws);
    expect(before.counts).toMatchObject({ issue: 3, issue_comment: 3, knowledge_page: 2, workspace_change_log: 2 });

    // ---- enable ----
    const localized = await localizeWorkspace(
      t.db,
      { workspaceId: ws, freeBytes: async () => 10 * 1024 * 1024 * 1024, attachmentsDir: attachmentsDir() },
      { attachmentsDir: attachmentsDir() },
    );
    expect(localized.state).toBe('localized');
    expect(existsSync(workspaceDbPath(wsPath))).toBe(true);
    // 下沉后中心库该区四表清空，数据只应存在于工作区库
    const centerAfterEnable = snapshot(t.db, ws);
    for (const table of TABLES) expect(centerAfterEnable.counts[table]).toBe(0);
    const duringLocalized = withReadonlyDb(workspaceDbPath(wsPath), (db) => snapshot(db, ws));

    // ---- status ----
    const status = buildWorkspaceDbStatus(t.db, { workspaceId: ws }, { disabled: false });
    expect(status.dbMode).toBe('localized');
    expect(status.workspaceDbExists).toBe(true);
    expect(status.writeGate).toBe('open');
    expect(status.snapshotLagRows).toBe(0);
    for (const table of TABLES) expect(status.counts[table]).toBe(before.counts[table]);

    // ---- revert ----
    const reverted = await revertWorkspace(t.db, { workspaceId: ws }, { attachmentsDir: attachmentsDir() });
    const after = snapshot(t.db, ws);

    // 行数三栏对照（报告证据直接取这段输出）
    const finalComparison = Object.fromEntries(
      TABLES.map((table) => [table, { 下沉前: before.counts[table], 下沉后: duringLocalized.counts[table], 回迁后: after.counts[table] }]),
    );
    console.table(finalComparison);

    // 回迁结果自报 count 与真实库一致
    for (const table of TABLES) expect(reverted.counts[table]).toBe(before.counts[table]);

    // ① 行数一致
    for (const table of TABLES) {
      expect(duringLocalized.counts[table], `${table} 下沉后行数`).toBe(before.counts[table]);
      expect(after.counts[table], `${table} 回迁后行数`).toBe(before.counts[table]);
    }
    // ② 内容一致（按 id 排序逐行比较业务列）
    for (const table of TABLES) {
      expect(duringLocalized.rows[table], `${table} 下沉后内容`).toBe(before.rows[table]);
      expect(after.rows[table], `${table} 回迁后内容`).toBe(before.rows[table]);
    }

    // 下沉终态已回收：工作区库移入 backup、db_mode 回 center
    expect(existsSync(workspaceDbPath(wsPath))).toBe(false);
    expect((t.db.prepare('SELECT db_mode FROM workspace WHERE id = ?').get(ws) as { db_mode: string }).db_mode).toBe('center');
    expect(buildWorkspaceDbStatus(t.db, { workspaceId: ws }, { disabled: false }).dbMode).toBe('center');
  });
});
