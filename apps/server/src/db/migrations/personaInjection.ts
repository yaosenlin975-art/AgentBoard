import type { Db } from '../connection.js';
import { ensureColumn } from './column.js';

/**
 * P1-C：会话 persona 注入。
 *
 * `personas`：persona 定义表（纯追加新表，幂等；id 用 randomUUID，source 限 builtin/user/import，
 * 合法性由仓储/路由层保证，不设 CHECK——与 session.cli 同口径）。
 *
 * session 四列（纯 `ALTER TABLE ADD COLUMN`，ensureColumn 先查 PRAGMA）——**不重建 session 表**：
 * message / session_turn / session_event 都有 FK 指向 session，SQLite 重建有级联清空风险。
 * - persona_id：指向 personas.id（无 FK 约束；persona 行被删时会话侧按缺失处理，不起轮报错）
 * - tool_policy / skill_policy：JSON 字符串列（对象形状见 api/schemas.ts）
 * - persona_injection：'auto' | 'flag' | 'file' | 'off'；NULL 视为 'auto'
 *
 * 幂等：连跑两次结果一致，新库与存量库收敛到同一结构。
 */
export function migratePersonaInjection(db: Db): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  body_md TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user',
  package_path TEXT,
  created_at INTEGER NOT NULL);
`);
  ensureColumn(db, 'session', 'persona_id', 'persona_id TEXT');
  ensureColumn(db, 'session', 'tool_policy', 'tool_policy TEXT');
  ensureColumn(db, 'session', 'skill_policy', 'skill_policy TEXT');
  ensureColumn(db, 'session', 'persona_injection', 'persona_injection TEXT');
}
