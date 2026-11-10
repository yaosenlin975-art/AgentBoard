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
const DEFAULT_THEME_SLUG = 'agentboard-pitfalls';

/**
 * N-05 / SK-06：建议 slug 用**稳定的主题页名**，与 using-agentboard / kb-curator 的主题页口径一致；
 * 不再拼「标题+日期」（日期后缀会让同一主题每天长出新页，revise 永远命中不了）。
 * 标签 → 主题页映射（N3-07 补齐 cli）；坑/缺陷/规则与未知标签统一落 agentboard-pitfalls。
 */
const THEME_RULES: ReadonlyArray<{ slug: string; tags: readonly string[] }> = [
  { slug: 'agentboard-server-data', tags: ['server', '服务端', '后端'] },
  { slug: 'agentboard-frontend-ux', tags: ['web', 'ui', '前端'] },
  { slug: 'agentboard-cli-ux', tags: ['cli', '命令行'] },
  { slug: 'agentboard-testing-gates', tags: ['test', '测试'] },
  { slug: DEFAULT_THEME_SLUG, tags: ['缺陷', '坑', '规则'] },
];

function themeSlug(labels: readonly string[]): string {
  const normalized = labels.map(label => label.trim().toLowerCase());
  const hit = THEME_RULES.find(rule => rule.tags.some(tag => normalized.includes(tag)));
  return hit?.slug ?? DEFAULT_THEME_SLUG;
}

export function buildKnowledgeHint(db: Db, issue: Issue): KnowledgeHint | null {
  if (!issue.claimed_by || issue.claimed_at === null) return null;
  // 检测口径兼容两种写法：旧 handoff-<issue-id> 前缀页，或本次占用期间由占用者更新过的任意页（主题 slug 场景）
  const suggestedSlug = themeSlug(issue.labels);
  const hit = db.prepare(`SELECT 1 AS hit FROM knowledge_page
    WHERE scope='workspace' AND workspace_id=? AND status IN ('active','archived')
      AND (slug LIKE ? OR (updated_by=? AND updated_at>=?))
    LIMIT 1`).get(
    issue.workspace_id,
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
    message: `本任务还没有写知识页。建议：先 kb knowledge list --scope workspace 找同主题页——有则 `
      + `kb knowledge revise <页 id> --expected-revision <当前 revision> 追加；无则用下面的 slug 新建：`
      + `kb knowledge create --scope workspace --workspace ${issue.workspace_id} `
      + `--slug ${suggestedSlug} --title "${title}" --category solved --domain knowledge `
      + `--sources-file sources.json --evidence-file evidence.json --stdin`
      + `（sources/evidence 各 ≥1 条；最小示例 sources.json `
      + `[{"source_id":"s1","source_type":"file","locator":"apps/server/src/services/decision.ts","captured_at":1730000000000,"content_hash":"<64 位 sha256>"}]，`
      + `evidence.json [{"source_id":"s1","locator":"apps/server/src/services/decision.ts:326-334"}]；`
      + `正文用 --stdin 传入：目标、关键决策与取舍、验证方式与结果、未验证项）`
      + `；另需写变更日志：kb changelog create --title "…" --type 修复（正文走 --stdin）`,
  };
}
