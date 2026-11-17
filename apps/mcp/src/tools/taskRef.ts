/**
 * C5：`task_id` 前缀解析。
 *
 * 背景：MCP 工具的 `task_id` 描述长期声称「8+ 位唯一前缀也接受」，但实现只是
 * `encodeURIComponent(task_id)` 直接拼进 `/issues/:id` —— 服务端不接受前缀。
 * 而 CLI（`packages/cli/src/issueRef.ts`）在**客户端**做前缀解析：≥8 位、唯一命中才用、
 * 多命中报歧义、零命中 404。本模块把同一口径搬到 MCP 层（服务端零改动）。
 *
 * 拉列表只取 `id` 与标题等定位字段，不拉正文（与 CLI 的 PREFIX_FIELDS 同思路）。
 */
import type { Issue, PageResult } from '@agentboard/shared';
import { McpError } from '../config.js';
import type { AgentBoardApiClient } from '../apiClient.js';

/** 与 CLI `MIN_ISSUE_PREFIX` 同口径 */
export const MIN_TASK_PREFIX = 8;
/** 完整 UUID 长度（含 4 个连字符）；带连字符的完整 id 不匹配 HEX_REF，直接透传 */
const FULL_UUID_LENGTH = 36;
/**
 * 只有「1-35 位纯十六进制」才当短前缀（与 CLI `issueRef.ts:35` 的 `HEX_REF` 完全一致）。
 * 非十六进制引用（如 `iss1`、`knowledge:p1`）一律零成本透传 —— 它们是服务端的合法标识形态，
 * 不走列表扫描。
 */
const HEX_REF = /^[0-9a-f]{1,35}$/i;
/** 只为前缀匹配而拉的最小字段集 */
const PREFIX_FIELDS = 'id,title,status,workspace_id';
const PAGE_LIMIT = 100;

async function listAllIssueIds(api: AgentBoardApiClient, workspaceId: string): Promise<Array<Pick<Issue, 'id' | 'title' | 'status' | 'workspace_id'>>> {
  const out: Array<Pick<Issue, 'id' | 'title' | 'status' | 'workspace_id'>> = [];
  let offset = 0;
  for (;;) {
    const page = await api.get<PageResult<Issue>>('/issues', {
      workspace: workspaceId,
      fields: PREFIX_FIELDS,
      limit: PAGE_LIMIT,
      offset,
    });
    for (const item of page.items) out.push({ id: item.id, title: item.title, status: item.status, workspace_id: item.workspace_id });
    if (page.next_offset === null || page.items.length === 0) break;
    offset = page.next_offset;
  }
  return out;
}

/**
 * `ref` → 真实任务 id。
 * - 非十六进制引用（`iss1` 之类）：**零成本透传**，与 CLI 同口径
 * - 完整 UUID：零成本透传（不发列表请求）
 * - 1-35 位纯十六进制：≥8 位才解析；唯一命中返回真实 id；多命中抛明确歧义；零命中 404
 */
export async function resolveTaskId(
  api: AgentBoardApiClient,
  workspaceId: string,
  ref: string,
): Promise<string> {
  const raw = ref.trim();
  if (!HEX_REF.test(raw)) return raw;
  if (raw.length >= FULL_UUID_LENGTH) return raw;
  if (raw.length < MIN_TASK_PREFIX) {
    throw new McpError(
      'INVALID_ARGUMENT',
      `task_id prefix too short: got ${raw.length} chars, need at least ${MIN_TASK_PREFIX}. `
      + 'Pass the full 36-char UUID or a hex prefix of 8+ characters.',
    );
  }
  const issues = await listAllIssueIds(api, workspaceId);
  const lowered = raw.toLowerCase();
  const hits = issues.filter(issue => issue.id.toLowerCase().startsWith(lowered));
  if (hits.length === 1) return hits[0]!.id;
  if (hits.length > 1) {
    const listed = hits.slice(0, 10).map(issue => `${issue.id} · ${issue.status} · ${issue.title}`);
    const more = hits.length > listed.length ? ` (and ${hits.length - listed.length} more)` : '';
    throw new McpError(
      'INVALID_ARGUMENT',
      `task_id prefix "${raw}" is ambiguous: ${hits.length} tasks match${more}. Candidates: ${listed.join(' | ')}. `
      + 'Pass a longer prefix or the full UUID.',
    );
  }
  throw new McpError('TASK_NOT_FOUND', `No task in this workspace has an id starting with "${raw}".`);
}
