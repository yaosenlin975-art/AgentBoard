import type { Db } from '../connection.js';
import { ensureColumn } from './column.js';

/**
 * DEC-1：待决策区数据模型（issue_decision / issue_decision_option / issue_decision_answer）。
 *
 * 口径（设计 v3 §4.1/§4.1.1/§4.2）：
 * - 「锁」的唯一真相 = `issue_decision.state='open'` 的行；`grace` 行只是宽限计时，不构成锁。
 * - `ux_decision_active` 部分唯一索引保证一卡同时最多一条 grace/open；并发提问只可能一条成功。
 * - 宽限默认 **180 秒**，合法区间 **0–600**；`grace_seconds=0` 是合法值（立即落锁分支，不是「未配置」），
 *   CHECK 只写在新库建表 DDL，存量库由服务层校验（SQLite ADD COLUMN 带 CHECK 的兼容性不稳）。
 * - `workspace.decision_grace_seconds` 纯 ADD COLUMN，不重建表：新库直接写进 schema DDL，
 *   存量库由 ensureColumn 幂等补齐；NULL 读取时按 180 兜底。
 *
 * 幂等依据：`CREATE TABLE/INDEX IF NOT EXISTS` + ensureColumn（先查 PRAGMA 再 ALTER），可重复执行。
 * 回滚（三张表只服务本功能，删除不波及其它表）：
 *   DROP TABLE IF EXISTS issue_decision_answer;
 *   DROP TABLE IF EXISTS issue_decision_option;
 *   DROP TABLE IF EXISTS issue_decision;
 *   ALTER TABLE workspace DROP COLUMN decision_grace_seconds;
 */
export function migratePendingDecision(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_decision (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
      issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      context_md TEXT NOT NULL DEFAULT '',
      trigger TEXT NOT NULL DEFAULT 'blocked'
        CHECK (trigger IN ('blocked','scope_change','irreversible','missing_input')),
      state TEXT NOT NULL DEFAULT 'grace'
        CHECK (state IN ('grace','open','answered','withdrawn')),
      created_by TEXT NOT NULL,
      created_session_id TEXT,
      created_turn_id TEXT,
      created_fence INTEGER,
      grace_seconds INTEGER NOT NULL DEFAULT 180 CHECK (grace_seconds BETWEEN 0 AND 600),
      grace_until INTEGER NOT NULL,
      locked_at INTEGER,
      stop_requested_at INTEGER,
      stop_ack_at INTEGER,
      checkpoint_json TEXT,
      current_answer_id TEXT,
      answer_revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      answered_at INTEGER,
      withdrawn_at INTEGER,
      withdrawn_by TEXT,
      withdrawn_reason TEXT,
      expires_at INTEGER,
      on_expire TEXT NOT NULL DEFAULT 'stay_locked'
        CHECK (on_expire IN ('stay_locked','unlock_default')),
      stale_level INTEGER NOT NULL DEFAULT 0,
      last_notified_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS issue_decision_option (
      id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL REFERENCES issue_decision(id) ON DELETE CASCADE,
      ord INTEGER NOT NULL,
      label TEXT NOT NULL,
      consequence TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS issue_decision_answer (
      id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL REFERENCES issue_decision(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      option_id TEXT REFERENCES issue_decision_option(id) ON DELETE SET NULL,
      answer_text TEXT,
      answered_by TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS ux_decision_active
      ON issue_decision(issue_id) WHERE state IN ('grace', 'open');
    CREATE INDEX IF NOT EXISTS ix_decision_ws_state
      ON issue_decision(workspace_id, state, created_at);
    CREATE INDEX IF NOT EXISTS ix_decision_issue
      ON issue_decision(issue_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_decision_option_ord
      ON issue_decision_option(decision_id, ord);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_decision_answer_rev
      ON issue_decision_answer(decision_id, revision);
  `);
  // 存量库：workspace 纯加列（新库已由 schema DDL 建出，这里为幂等 no-op）
  ensureColumn(
    db,
    'workspace',
    'decision_grace_seconds',
    'decision_grace_seconds INTEGER NOT NULL DEFAULT 180',
  );
}
