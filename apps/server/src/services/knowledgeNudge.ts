/**
 * KB-WRITE-NUDGE：`kb done` / MCP `complete_task` 的软提醒。
 *
 * 判定「本任务写过知识」= 以下任一成立（都查现有表，无迁移）：
 * 1. 该 workspace 内存在 slug 以 `handoff-<issue-id>` 开头的页（active/archived）；
 * 2. 本次占用期间（`updated_at >= claimed_at`）由 `agent:<claimed_by>` 更新过的页。
 *
 * `claimed_at` 取**最后一次** claim 的时间（`claimIssue` 每次 claim 都覆盖写），
 * 所以上一轮写过、本轮重领后不会再压掉提示。
 */
import type { KnowledgeHint, Issue } from '@agentboard/shared';
import type { Db } from '../db/connection.js';

const TITLE_MAX = 40;

export function buildKnowledgeHint(db: Db, issue: Issue): KnowledgeHint | null {
  if (!issue.claimed_by || issue.claimed_at === null) return null;
  const suggestedSlug = `handoff-${issue.id}`;
  const hit = db.prepare(`SELECT 1 AS hit FROM knowledge_page
    WHERE scope='workspace' AND workspace_id=? AND status IN ('active','archived')
      AND (slug LIKE ? OR (updated_by=? AND updated_at>=?))
    LIMIT 1`).get(
    issue.workspace_id,
    `${suggestedSlug}%`,
    `agent:${issue.claimed_by}`,
    issue.claimed_at,
  ) as { hit: number } | undefined;
  if (hit) return null;
  const title = issue.title.length > TITLE_MAX ? `${issue.title.slice(0, TITLE_MAX)}…` : issue.title;
  return {
    suggested_slug: suggestedSlug,
    scope: 'workspace',
    message: `本任务还没有写知识页。建议：kb knowledge create --scope workspace --workspace ${issue.workspace_id} `
      + `--slug ${suggestedSlug} --title "${title}"（正文用 --stdin 传入：目标、关键决策与取舍、验证方式与结果、未验证项）`,
  };
}
