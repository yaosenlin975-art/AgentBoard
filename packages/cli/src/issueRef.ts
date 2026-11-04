/**
 * CLI-02：任务引用解析（完整 UUID 直取；≥8 位十六进制前缀唯一命中；多命中给候选）。
 *
 * 服务端 `/api/issues/:id` 只接受精确 id，短前缀解析只能在 CLI 侧完成：
 * 命中前缀时扫一遍全部工作区的任务列表（仅在用户给前缀时才发生，完整 id 仍是单次请求）。
 * 非十六进制的引用（例如测试桩里的 `iss1`）原样透传，保持旧的精确路径行为。
 */
import type { Issue, Workspace } from '@agentboard/shared';
import { CliHttpError, request } from './api.js';
import type { Ctx } from './io.js';

/** CLI-02：前缀最少位数（与知识页 resolve 口径一致） */
export const MIN_ISSUE_PREFIX = 8;

export interface IssueRefCandidate {
  id: string;
  workspace_id: string;
  title: string;
  status: string;
}

/** 前缀多命中：不猜第一条，把候选交给调用方（退出码 2，与「不存在」的 1 区分） */
export class AmbiguousIssueRefError extends Error {
  readonly code = 'AMBIGUOUS_ISSUE_REF';
  constructor(readonly ref: string, readonly candidates: IssueRefCandidate[]) {
    super(
      `任务 id 前缀「${ref}」命中 ${candidates.length} 张卡，请改用更长前缀或完整 id：\n` +
      candidates.map(c => `  - ${c.id} [${c.status}] ${c.title}（workspace: ${c.workspace_id}）`).join('\n'),
    );
    this.name = 'AmbiguousIssueRefError';
  }
}

/** 1–35 位纯十六进制（带连字符的完整 UUID 不含在内 → 走精确请求） */
const HEX_REF = /^[0-9a-f]{1,35}$/i;

export function isShortIssueRef(ref: string): boolean {
  return HEX_REF.test(ref.trim());
}

/** 解析目标：id 一律用服务端真实 id；前缀命中时顺带带回完整 Issue，省一次 GET */
export interface ResolvedIssueRef {
  id: string;
  issue?: Issue;
}

async function findPrefixCandidates(ctx: Ctx, prefix: string): Promise<Issue[]> {
  const spaces = await request<Workspace[]>(ctx.base, 'GET', '/api/workspaces');
  const lists = await Promise.all(
    spaces.map(space => request<Issue[]>(ctx.base, 'GET', `/api/issues?workspace=${encodeURIComponent(space.id)}`)),
  );
  return lists.flat().filter(issue => issue.id.toLowerCase().startsWith(prefix));
}

/** 前缀 → 唯一 Issue；<8 位本地拒绝（不发请求）；多命中抛 AmbiguousIssueRefError；无命中按 404 文案 */
export async function resolveIssueByRef(ctx: Ctx, ref: string): Promise<Issue> {
  const raw = ref.trim();
  if (!isShortIssueRef(raw)) {
    return request<Issue>(ctx.base, 'GET', `/api/issues/${encodeURIComponent(raw)}`);
  }
  if (raw.length < MIN_ISSUE_PREFIX) {
    throw new Error(`任务 id 前缀至少 ${MIN_ISSUE_PREFIX} 位（当前 ${raw.length} 位）：请给完整 UUID 或 ≥${MIN_ISSUE_PREFIX} 位前缀`);
  }
  const candidates = await findPrefixCandidates(ctx, raw.toLowerCase());
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    throw new AmbiguousIssueRefError(raw, candidates.map(({ id, workspace_id, title, status }) => ({ id, workspace_id, title, status })));
  }
  throw new CliHttpError(404, 'NOT_FOUND', '任务不存在');
}

/** 统一入口：完整 id / 非十六进制引用零成本透传；短前缀解析成真实 id */
export async function normalizeIssueRef(ctx: Ctx, ref: string): Promise<ResolvedIssueRef> {
  if (!isShortIssueRef(ref)) return { id: ref.trim() };
  const issue = await resolveIssueByRef(ctx, ref);
  return { id: issue.id, issue };
}

/** `--parent` / `dep add` 的 blocker 这类只收 id 的子参数：前缀先解析成真实 id */
export async function normalizeIssueIdArg(ctx: Ctx, ref: string): Promise<string> {
  return (await normalizeIssueRef(ctx, ref)).id;
}
