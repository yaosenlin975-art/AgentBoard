import type { Db } from '../connection.js';

/**
 * P3-A：专家团（teams / team_members）。
 *
 * 纯追加两表，幂等（`CREATE TABLE/INDEX IF NOT EXISTS`），不重建 session / message。
 * - teams 落中心库（与 personas、workspace 注册表同层），`workspace_id` 标明归属；
 *   成员 session 行仍由 sessionManager 落「工作区当前库」，本表只存 id 引用。
 * - `turns`：该成员已派活的轮次计数，`max_turns_per_member` 的成本护栏按它判定；
 *   `usage_json`：累计 { turns, tokens, tool_calls } 快照（成员行冗余存一份，便于列表直读）。
 * - 两个唯一索引：一个 lead 会话最多带一个团（`ux_teams_lead_session`）、
 *   一个成员会话最多属于一个团（`ux_team_members_session`）；会话被复用进第二个团由服务端 409。
 */
export function migrateTeams(db: Db): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  lead_session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  max_turns_per_member INTEGER NOT NULL DEFAULT 20,
  budget_tokens INTEGER NOT NULL DEFAULT 200000,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ux_teams_lead_session ON teams(lead_session_id);
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  usage_json TEXT NOT NULL DEFAULT '{}',
  turns INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, session_id));
CREATE UNIQUE INDEX IF NOT EXISTS ux_team_members_session ON team_members(session_id);
`);
}
