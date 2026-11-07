import type { Db } from '../db/connection.js';
import { tryParseLabels } from '../db/repos/issue.js';

export interface InvalidLabelRow {
  id: string;
  workspace_id: string;
}

export interface LabelIntegrityReport {
  scanned: number;
  invalid: InvalidLabelRow[];
}

/**
 * CR-5 启动期数据体检：只读扫描 `issue.labels` 不是合法 JSON 字符串数组的行。
 * 读取侧已由 parseLabelsOrEmpty 兜底（按 [] 渲染），这里只报数，不改写任何数据。
 */
export function inspectIssueLabels(db: Db): LabelIntegrityReport {
  const rows = db
    .prepare('SELECT id, workspace_id, labels FROM issue')
    .all() as Array<{ id: string; workspace_id: string; labels: string | null }>;
  const invalid = rows
    .filter(row => tryParseLabels(row.labels) === null)
    .map(row => ({ id: row.id, workspace_id: row.workspace_id }));
  return { scanned: rows.length, invalid };
}
