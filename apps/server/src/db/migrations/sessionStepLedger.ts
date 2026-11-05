import type { Db } from '../connection.js';

/**
 * CHAT-RETRY1（契约 #15）：单步重试的步骤台账。
 *
 * 口径：
 * - 一行 = 某一轮某一个步骤的一次可查询记录（`turn_id + step_id` 定位）；
 * - `idempotency_key` 由 `turn_id + step_id + tool_call_id` 派生（当前适配器事件不带 tool_call_id，
 *   退化为 `turn:step:no-tool-call`）；唯一索引保证同一键只有一行，重复重试不会产生第二条记录；
 * - `retryable` 只在「失败且没有任何已成功写入」时为 1——部分成功（写 2 个文件、第 3 个失败）
 *   一律判不可重试，避免重试重复写已落盘的文件；
 * - `writes_json` 记录该步已成功写入的目标，当前执行器未产出时为空数组。
 *
 * 幂等：`CREATE TABLE/INDEX IF NOT EXISTS`，可重复执行；本表只增不改结构，无回填。
 */
export function migrateSessionStepLedger(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_step_ledger (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES session_turn(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_call_id TEXT,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running','done','failed')),
      retryable INTEGER NOT NULL DEFAULT 0,
      writes_json TEXT NOT NULL DEFAULT '[]',
      attempt INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_step_ledger_key ON session_step_ledger(idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_session_step_ledger_turn ON session_step_ledger(turn_id, step_id);
  `);
}
