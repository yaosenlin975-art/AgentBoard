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

/**
 * KB-SRVMSG N-04：主题 slug——标题词段（字母/数字连续段）连字拼接 + 当天日期。
 * 合法（符合 createKnowledgePage 的 slug 规则）且非一次性；同一主题多日多页由日期区分。
 */
function themeSlug(title: string): string {
  const words = (title.match(/[\p{L}\p{N}]+/gu) ?? []).join('-').slice(0, 40).replace(/^-+|-+$/g, '');
  const base = words !== '' ? words : 'task';
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `${base}-${day}`;
}

export function buildKnowledgeHint(db: Db, issue: Issue): KnowledgeHint | null {
  if (!issue.claimed_by || issue.claimed_at === null) return null;
  // 检测口径兼容两种写法：旧 handoff-<issue-id> 前缀页，或本次占用期间由占用者更新过的任意页（主题 slug 场景）
  const suggestedSlug = themeSlug(issue.title);
  const hit = db.prepare(`SELECT 1 AS hit FROM knowledge_page
    WHERE scope='workspace' AND workspace_id=? AND status IN ('active','archived')
      AND (slug LIKE ? OR slug LIKE ? OR (updated_by=? AND updated_at>=?))
    LIMIT 1`).get(
    issue.workspace_id,
    `${suggestedSlug}%`,
    `handoff-${issue.id}%`,
    `agent:${issue.claimed_by}`,
    issue.claimed_at,
  ) as { hit: number } | undefined;
  if (hit) return null;
  // 展示用标题去引号（照抄不破命令）
  const title = (issue.title.length > TITLE_MAX ? `${issue.title.slice(0, TITLE_MAX)}…` : issue.title)
    .replace(/["'“”‘’]/g, '');
  return {
    suggested_slug: suggestedSlug,
    scope: 'workspace',
    // N-04：带 --category（不落 legacy）与来源/证据要求，照抄即可执行
    message: `本任务还没有写知识页。建议：kb knowledge create --scope workspace --workspace ${issue.workspace_id} `
      + `--slug ${suggestedSlug} --title "${title}" --category solved --domain knowledge `
      + `--sources-file sources.json --evidence-file evidence.json --stdin`
      + `（sources/evidence 各 ≥1 条；最小示例 sources.json `
      + `[{"source_id":"s1","source_type":"file","locator":"apps/server/src/services/decision.ts","captured_at":1730000000000,"content_hash":"<64 位 sha256>"}]，`
      + `evidence.json [{"source_id":"s1","locator":"apps/server/src/services/decision.ts:326-334"}]；`
      + `正文用 --stdin 传入：目标、关键决策与取舍、验证方式与结果、未验证项）`
      + `；另需写变更日志：kb changelog create --title "…" --type 修复（正文走 --stdin）`,
  };
}
