/**
 * STORE-2（M2a）八阶段状态机：真搬一次（隔离临时库，不碰 8787）。
 *
 * 覆盖卡面验收：②verify 七项全过 ③already_localized 幂等 ④跑两次行数不变
 * ⑤copy 阶段中断后（模拟 kill）带 overwrite 重跑能完成且行数一致。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { createKnowledgePage } from '../src/db/repos/knowledge.js';
import { getDbForWorkspace, resetResolverState } from '../src/db/resolver.js';
import { localizeWorkspace } from '../src/services/workspaceLocalizeRun.js';
import { readLocalizeState, LOCALIZE_STAGES } from '../src/services/workspaceLocalize.js';

/** STORE-4e：真实迁移终态与 dry-run 统一的 counts 键集（同 workspaceLocalize.test.ts） */
const AGGREGATE_COUNT_KEYS = ['rows_total', 'attachment_files', 'attachment_bytes', 'db_bytes', 'estimated_bytes'];
const UNIFIED_COUNT_KEYS = [
  'workspace_status', 'issue', 'issue_comment', 'issue_dependency', 'issue_git_baseline', 'issue_draft_audit',
  'session', 'message', 'attachment', 'workspace_change_log',
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
});
