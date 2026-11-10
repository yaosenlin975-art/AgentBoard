import type { Db } from '../connection.js';
import { ensureColumn } from './column.js';

/**
 * P3-C：专家包导入（WorkBuddy 包格式兼容）落库所需的增量列。
 *
 * - `teams.source`：`runtime`（P3-A 运行期团，默认）| `import`（专家包导入的团队模板）。
 *   模板没有真实会话，`lead_session_id` 存 `import:<team-id>` 占位（保留 NOT NULL 与唯一索引不动）。
 * - `teams.package_path`：导入来源目录（仅 import 行有值，供溯源与重复导入提示）。
 * - `team_members.persona_id`：模板成员指向导入生成的 persona（运行期成员仍以 session.persona_id 为准）。
 *
 * 纯 `ALTER TABLE ADD COLUMN`（ensureColumn 先查 PRAGMA），**不重建 teams**：
 * team_members 以 ON DELETE CASCADE 引用 teams，重建会级联清空成员行。
 */
export function migrateExpertPackage(db: Db): void {
  ensureColumn(db, 'teams', 'source', "source TEXT NOT NULL DEFAULT 'runtime'");
  ensureColumn(db, 'teams', 'package_path', 'package_path TEXT');
  ensureColumn(db, 'team_members', 'persona_id', 'persona_id TEXT');
}
