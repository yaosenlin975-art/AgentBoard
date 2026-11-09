/**
 * STORE-2（M2a）八阶段状态机：真搬一次（隔离临时库，不碰 8787）。
 *
 * 覆盖卡面验收：②verify 七项全过 ③already_localized 幂等 ④跑两次行数不变
 * ⑤copy 阶段中断后（模拟 kill）带 overwrite 重跑能完成且行数一致。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { createKnowledgePage } from '../src/db/repos/knowledge.js';
import { createSession } from '../src/db/repos/session.js';
import { createPendingDecision, answerPendingDecision } from '../src/services/decision.js';
import { revertWorkspace } from '../src/services/workspaceDbOps.js';
import type { Db } from '../src/db/connection.js';
import { getDbForWorkspace, resetResolverState } from '../src/db/resolver.js';
import { localizeWorkspace } from '../src/services/workspaceLocalizeRun.js';
import { readLocalizeState, LOCALIZE_STAGES } from '../src/services/workspaceLocalize.js';

/** STORE-4e：真实迁移终态与 dry-run 统一的 counts 键集（同 workspaceLocalize.test.ts） */
const AGGREGATE_COUNT_KEYS = ['rows_total', 'attachment_files', 'attachment_bytes', 'db_bytes', 'estimated_bytes'];
const UNIFIED_COUNT_KEYS = [
  'workspace_status', 'issue',
  // CR2-1：决策三表与审批规则随区下沉
  'issue_decision', 'issue_decision_option', 'issue_decision_answer',
  'issue_comment', 'issue_dependency', 'issue_git_baseline', 'issue_draft_audit',
  'session', 'session_turn', 'session_step_ledger', 'message', 'attachment', 'approval_rule',
  'workspace_change_log',
  'knowledge_page', 'knowledge_revision', 'knowledge_link', 'knowledge_attachment',
  ...AGGREGATE_COUNT_KEYS,
];

describe('STORE-2（M2a）八阶段状态机', () => {
  let t: TestDb;
  let root: string;
  let ws: string;
  let wsPath: string;

  const seed = (): void => {
    for (const title of ['卡一', '卡二', '卡三']) createIssue(t.db, { workspace_id: ws, title, description: '', priority: '中', labels: [] } as never);
    createKnowledgePage(t.db, { domain: 'knowledge',
      scope: 'workspace', workspace_id: ws, slug: 'ws-page', title: '本区页', body_md: '正文',
      sources: [{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: 'a'.repeat(64) }],
      evidence: [{ source_id: 'file:README.md', locator: 'file:1-20' }], actor: 'tester',
    } as never);
  };

  beforeEach(() => {
    resetResolverState();
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-store2run-'));
    wsPath = join(root, 'ws');
    mkdirSync(wsPath, { recursive: true });
    ws = createWorkspace(t.db, { name: '下线区', path: wsPath }).id;
    seed();
  });
  afterEach(() => {
    resetResolverState();
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const run = (over: Record<string, unknown> = {}, deps: Parameters<typeof localizeWorkspace>[2] = {}) => localizeWorkspace(t.db, {
    workspaceId: ws,
    freeBytes: async () => 10 * 1024 * 1024 * 1024,
    attachmentsDir: join(root, 'attachments'),
    ...over,
  }, deps);

  it('八阶段全过：阶段顺序完整、verify 通过、中心 db_mode=localized、工作区库 meta.localized=1', async () => {
    mkdirSync(join(root, 'attachments'), { recursive: true });
    const result = await run().catch((error) => { console.log('STACK:', String(error?.stack ?? '').split('\n').slice(0, 8).join('\n')); throw error; });
    expect(result.state).toBe('localized');
    expect(result.stages).toEqual([...LOCALIZE_STAGES]);
    expect(result.counts.issue).toBe(3);
    expect(result.counts.knowledge_page).toBe(1);
    expect(existsSync(result.target_db_path)).toBe(true);
    // STORE-4e：终态 counts 与 dry-run 同一键集；rows_total = Σ scoped 表；聚合键取实盘（本例无附件）
    expect(Object.keys(result.counts).sort()).toEqual(UNIFIED_COUNT_KEYS.slice().sort());
    const rowKeys = UNIFIED_COUNT_KEYS.filter((key) => !AGGREGATE_COUNT_KEYS.includes(key));
    expect(result.counts.rows_total).toBe(rowKeys.reduce((sum, key) => sum + result.counts[key]!, 0));
    expect(result.counts.attachment_files).toBe(0);
    expect(result.counts.attachment_bytes).toBe(0);
    expect(result.counts.db_bytes).toBeGreaterThan(0);
    expect(result.counts.estimated_bytes).toBe(result.counts.attachment_bytes + result.counts.db_bytes);

    const mode = t.db.prepare('SELECT db_mode, localized_at FROM workspace WHERE id = ?').get(ws) as { db_mode: string; localized_at: number | null };
    expect(mode.db_mode).toBe('localized');
    expect(mode.localized_at).toBeGreaterThan(0);
    // 中心已无该区 scoped 行（守恒式右端为 0）
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM issue WHERE workspace_id = ?').get(ws) as { n: number }).n).toBe(0);
    expect((t.db.prepare("SELECT COUNT(*) AS n FROM knowledge_page WHERE scope='workspace' AND workspace_id = ?").get(ws) as { n: number }).n).toBe(0);
  });

  it('幂等：再跑一次返回 already_localized，行数不变（验收 4）', async () => {
    mkdirSync(join(root, 'attachments'), { recursive: true });
    const first = await run();
    const targetCount = (t.db.prepare('SELECT COUNT(*) AS n FROM issue').get() as { n: number }).n;
    const second = await run();
    expect(second.state).toBe('already_localized');
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM issue').get() as { n: number }).n).toBe(targetCount);
    expect(second.target_db_path).toBe(first.target_db_path);
  });

  it('copy 阶段中断（模拟 kill）：状态停在 copy，带 overwrite 重跑能完成且行数一致（验收 5）', async () => {
    mkdirSync(join(root, 'attachments'), { recursive: true });
    await expect(run({}, {
      onStage: (stage: LocalizeStage) => {
        if (stage === 'copy') throw Object.assign(new Error('模拟 kill 在 copy 阶段'), { code: 'SIMULATED_KILL' });
      },
    })).rejects.toThrow(/模拟 kill/);

    const interrupted = readLocalizeState(wsPath);
    expect(interrupted).not.toBeNull();
    expect(interrupted?.stage).toBe('copy');
    // 未 finalize → 不带 overwrite 会被拦（不能当成已完成）
    await expect(run()).rejects.toMatchObject({ code: 'MIGRATION_BUSY' });

    const resumed = await run({ overwrite: true });
    expect(resumed.state).toBe('localized');
    expect(resumed.counts.issue).toBe(3);
    // 中心已清空该区，工作区库里有 3 张卡
    const target = getDbForWorkspace(
      { centerDb: t.db, instanceId: 'inst-test', port: 0, openWorkspaceDbs: true },
      { id: ws, path: wsPath, dbMode: 'localized' },
    );
    try {
      expect((target.db.prepare('SELECT COUNT(*) AS n FROM issue').get() as { n: number }).n).toBe(3);
      expect((target.decision.target)).toBe('workspace');
    } finally {
      target.db.close();
    }
  });

  it('同构校验：工作区库含中心库全部列（含 KB-PAGE-3 的 domain）', async () => {
    mkdirSync(join(root, 'attachments'), { recursive: true });
    const result = await run();
    const Database = (await import('better-sqlite3')).default;
    const target = new Database(result.target_db_path, { readonly: true });
    try {
      const cols = (target.prepare('PRAGMA table_info(knowledge_page)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain('domain');
      const meta = new Map((target.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
      expect(meta.get('localized')).toBe('1');
      expect(meta.get('workspace_id')).toBe(ws);
    } finally {
      target.close();
    }
  });

  it('CR2-1：决策三表 / 轮次账本 / 审批规则随区下沉，中心清空，回迁守恒', async () => {
    mkdirSync(join(root, 'attachments'), { recursive: true });
    const issue = createIssue(t.db, { workspace_id: ws, title: '带决策的卡' } as never);
    const pending = createPendingDecision(t.db, {
      workspace_id: ws,
      issue_id: issue.id,
      created_by: 'agent-1',
      question: '继续还是停止？',
      options: [
        { label: '继续', consequence: '继续执行' },
        { label: '停止', consequence: '停在检查点' },
      ],
      grace_seconds: 0,
    });
    answerPendingDecision(t.db, { decision_id: pending.decision.id, option_ord: 1, answered_by: 'user' });
    // 迁移门禁会拦「运行中的会话」，这里显式建已结束会话
    const session = createSession(t.db, { workspace_id: ws, cli: 'claude', status: '已结束' });
    const turnId = randomUUID();
    t.db
      .prepare(
        `INSERT INTO session_turn(id, session_id, seq, state, current_index, plan_json, awaiting_json, usage_json, started_at, ended_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(turnId, session.id, 1, 'done', 0, '[]', null, null, Date.now(), Date.now());
    t.db
      .prepare(
        `INSERT INTO session_step_ledger(id, session_id, turn_id, step_id, tool_name, tool_call_id, idempotency_key, status, retryable, writes_json, attempt, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(randomUUID(), session.id, turnId, 's1', 'Read', null, 'cr2-1-key', 'done', 0, '[]', 1, Date.now(), Date.now());
    t.db
      .prepare(
        `INSERT INTO approval_rule(id, workspace_id, issue_id, session_id, turn_id, tool_name, match_key, scope, created_at, created_by, revoked_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`,
      )
      .run(randomUUID(), ws, null, null, null, 'Bash', 'rm -rf build', 'workspace', Date.now(), 'user');

    const localize = await run();
    expect(localize.counts.issue_decision).toBe(1);
    expect(localize.counts.issue_decision_option).toBe(2);
    expect(localize.counts.issue_decision_answer).toBe(1);
    expect(localize.counts.session_turn).toBe(1);
    expect(localize.counts.session_step_ledger).toBe(1);
    expect(localize.counts.approval_rule).toBe(1);

    const count = (db: Db, table: string): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const moved = ['issue_decision', 'issue_decision_option', 'issue_decision_answer', 'session_turn', 'session_step_ledger', 'approval_rule'];
    // 中心清空：FK 级联会把选项/答案/账本一并带走，正是原缺陷
    for (const table of moved) expect(count(t.db, table)).toBe(0);

    const Database = (await import('better-sqlite3')).default;
    const target = new Database(localize.target_db_path, { readonly: true });
    try {
      for (const table of moved) expect(count(target as unknown as Db, table)).toBe(1 + (table.endsWith('option') ? 1 : 0));
    } finally {
      target.close();
    }

    // 回迁守恒：中心恢复同量
    await revertWorkspace(t.db, { workspaceId: ws }, { attachmentsDir: join(root, 'attachments') });
    for (const table of moved) expect(count(t.db, table)).toBe(1 + (table.endsWith('option') ? 1 : 0));
  });
});
