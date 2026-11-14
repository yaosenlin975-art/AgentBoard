/**
 * STORE-6：工作区行集的单一事实源。
 *
 * 原先定义在 workspaceLocalizeRun.ts，STORE-6 的「中心库模式工作区快照」也要用同一份
 * 「该工作区 scoped 行」SQL（否则中心库快照与迁移/状态统计的行集可能悄悄分叉）。
 * 抽到独立模块避免 workspaceSnapshot ↔ workspaceLocalizeRun 的循环依赖；
 * workspaceLocalizeRun 仍原样 re-export，既有导入路径不变。
 *
 * 顺序即外键序（先父后子），copy / revert / 快照 / status 共用。
 *
 * P2-01（方向 B AG1）：knowledge_page / knowledge_revision / knowledge_link / knowledge_attachment
 * 四表**整体退出迁移管线**（copy / revert / 守恒计数 / 快照落后统计）——知识页权威数据已迁
 * Docs/*.md，SQLite 只读保留旧库行（不 DROP、不删、不搬）：前向迁移不再从中心库带走它们，
 * revert 也不回写（两侧副本原地保留，export-legacy（P2-02）负责显式导出）。
 * 每条查询声明 `tables` 依赖；依赖表缺任一即整条跳过（count 按 0 行计）——旧库（有表）行为不变，
 * 新库（无表）不因「表不存在」报错（§7.7：搬库不因知识表缺席而失败）。
 */
import type { Db } from '../db/connection.js';

export const LOCALIZE_COPY_ORDER = [
  'workspace_status',
  'issue',
  'issue_decision',
  'issue_decision_option',
  'issue_decision_answer',
  'issue_comment',
  'issue_dependency',
  'issue_git_baseline',
  'issue_draft_audit',
  'session',
  'session_turn',
  'session_step_ledger',
  'message',
  'attachment',
  'approval_rule',
  'workspace_change_log',
] as const;

export interface WorkspaceTableQuery {
  table: (typeof LOCALIZE_COPY_ORDER)[number];
  sql: string;
  /** 该查询依赖的表（含 JOIN）；任一缺表即整条跳过（P2-01 缺表容忍） */
  tables: readonly string[];
}

export const WORKSPACE_TABLE_QUERIES: readonly WorkspaceTableQuery[] = [
  { table: 'workspace_status', sql: 'SELECT * FROM workspace_status WHERE workspace_id = ?', tables: ['workspace_status'] },
  { table: 'issue', sql: 'SELECT * FROM issue WHERE workspace_id = ?', tables: ['issue'] },
  // CR2-1：决策三表随区下沉 —— 否则 switch 时 issue 级联删除会把已回答决策与选项/答案一并抹掉，
  // 且 claim / PATCH 的决策锁判定读工作区库永远看不到中心库的在途决策（锁被绕过）。
  { table: 'issue_decision', sql: 'SELECT * FROM issue_decision WHERE workspace_id = ?', tables: ['issue_decision'] },
  { table: 'issue_decision_option', sql: 'SELECT o.* FROM issue_decision_option o JOIN issue_decision d ON d.id = o.decision_id WHERE d.workspace_id = ?', tables: ['issue_decision_option', 'issue_decision'] },
  { table: 'issue_decision_answer', sql: 'SELECT a.* FROM issue_decision_answer a JOIN issue_decision d ON d.id = a.decision_id WHERE d.workspace_id = ?', tables: ['issue_decision_answer', 'issue_decision'] },
  { table: 'issue_comment', sql: 'SELECT c.* FROM issue_comment c JOIN issue i ON i.id = c.issue_id WHERE i.workspace_id = ?', tables: ['issue_comment', 'issue'] },
  { table: 'issue_dependency', sql: 'SELECT d.* FROM issue_dependency d JOIN issue i ON i.id = d.blocked_issue_id WHERE i.workspace_id = ?', tables: ['issue_dependency', 'issue'] },
  { table: 'issue_git_baseline', sql: 'SELECT b.* FROM issue_git_baseline b JOIN issue i ON i.id = b.issue_id WHERE i.workspace_id = ?', tables: ['issue_git_baseline', 'issue'] },
  { table: 'issue_draft_audit', sql: 'SELECT * FROM issue_draft_audit WHERE workspace_id = ?', tables: ['issue_draft_audit'] },
  { table: 'session', sql: 'SELECT * FROM session WHERE workspace_id = ?', tables: ['session'] },
  // CR2-1：轮次与步骤账本随会话下沉（session 删除会级联带走，不下沉即丢历史）
  { table: 'session_turn', sql: 'SELECT t.* FROM session_turn t JOIN session s ON s.id = t.session_id WHERE s.workspace_id = ?', tables: ['session_turn', 'session'] },
  { table: 'session_step_ledger', sql: 'SELECT l.* FROM session_step_ledger l JOIN session s ON s.id = l.session_id WHERE s.workspace_id = ?', tables: ['session_step_ledger', 'session'] },
  { table: 'message', sql: 'SELECT m.* FROM message m JOIN session s ON s.id = m.session_id WHERE s.workspace_id = ?', tables: ['message', 'session'] },
  { table: 'attachment', sql: 'SELECT * FROM attachment WHERE workspace_id = ?', tables: ['attachment'] },
  // CR2-1：审批规则按 workspace_id 收口（原按 issue_id 删会漏掉 workspace 级规则：issue_id 为 NULL）
  { table: 'approval_rule', sql: 'SELECT * FROM approval_rule WHERE workspace_id = ?', tables: ['approval_rule'] },
  { table: 'workspace_change_log', sql: 'SELECT * FROM workspace_change_log WHERE origin_workspace_id = ?', tables: ['workspace_change_log'] },
  // P2-01：knowledge_page/revision/link/attachment 已退出迁移管线（见文件头）——旧库行原地只读保留
];

/** 表是否存在（缺表容忍的判定点；只读 PRAGMA 查询，无副作用） */
export function tableExists(db: Db, table: string): boolean {
  return db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
}

/** 该库上可执行的行集查询（依赖表齐全；P2-01 缺表容忍的唯一入口） */
export function availableTableQueries(db: Db): WorkspaceTableQuery[] {
  return WORKSPACE_TABLE_QUERIES.filter(query => query.tables.every(table => tableExists(db, table)));
}

/** 按表统计某库中该工作区 scoped 行数（copy 守恒校验 / status 快照落后 / revert 守恒共用）；
 * 缺表按 0 行计（与 copy 跳过同口径，两边守恒比较不因知识表缺席而失配） */
export function countScopedRowsByTable(db: Db, workspaceId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const query of WORKSPACE_TABLE_QUERIES) {
    if (!query.tables.every(table => tableExists(db, table))) {
      counts[query.table] = 0;
      continue;
    }
    counts[query.table] = Number((db.prepare(`SELECT COUNT(*) AS n FROM (${query.sql})`).get(workspaceId) as { n: number }).n);
  }
  return counts;
}

/**
 * STORE-3a：revert 的「分叉行数」口径——中心库中会阻止 revert 的行数。
 * 排除 workspace_status：状态字典是可派生数据，已下沉后任何中心侧写卡都会重建 5 条默认
 * 字典行（openWorkspaceDbs=false 过渡期写落中心库），把可派生行当分叉会让 revert 永久被拒。
 * status 的 localized 态快照落后同用此口径，两处判定保持一致。
 */
export function centerRevertBlockingRows(db: Db, workspaceId: string): number {
  const counts = countScopedRowsByTable(db, workspaceId);
  return WORKSPACE_TABLE_QUERIES.reduce((sum, query) => sum + (query.table === 'workspace_status' ? 0 : (counts[query.table] ?? 0)), 0);
}
