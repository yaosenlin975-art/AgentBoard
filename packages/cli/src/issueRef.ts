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

async function listAllIssues(ctx: Ctx): Promise<Issue[]> {
  const spaces = await request<Workspace[]>(ctx.base, 'GET', '/api/workspaces');
  const lists = await Promise.all(
    spaces.map(space => request<Issue[]>(ctx.base, 'GET', `/api/issues?workspace=${encodeURIComponent(space.id)}`)),
  );
  return lists.flat();
}

/** 短 id（前 8 位）：回执与候选提示统一用它，避免整段 UUID 刷屏 */
export function shortIssueId(id: string): string {
  return id.slice(0, 8);
}

/** 编辑距离（Levenshtein）；长度差超过上限直接判超限，避免全表大矩阵 */
function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    let rowMin = curr[0]!;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      rowMin = Math.min(rowMin, curr[j]!);
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

/** 只对「像 id 的引用」做纠错扫描：非十六进制/非连字符引用（如测试桩的 iss1）原样报错，不扫全表 */
const ID_LIKE_REF = /^[0-9a-f-]+$/i;

/**
 * 404 纠错：唯一「同前缀」或「编辑距离 ≤2」的候选才提示，多候选不猜。
 * CLI-RECEIPT：`任务不存在；你是不是想写 <短id> <标题>`。
 */
function notFoundErrorFrom(issues: Issue[] | null, ref: string, message = '任务不存在'): CliHttpError {
  const raw = ref.trim().toLowerCase();
  if (issues === null || !ID_LIKE_REF.test(raw)) return new CliHttpError(404, 'NOT_FOUND', message);
  const merged = new Map<string, Issue>();
  if (raw.length >= 4) {
    for (const issue of issues) if (issue.id.toLowerCase().startsWith(raw)) merged.set(issue.id, issue);
  }
  for (const issue of issues) {
    const id = issue.id.toLowerCase();
    // 短前缀按同长度片段比（整段 UUID 与 8 位前缀长度差 28，直接比永远不命中）
    const scope = raw.length < id.length ? id.slice(0, raw.length) : id;
    if (editDistance(scope, raw) <= 2) merged.set(issue.id, issue);
  }
  const hit = merged.size === 1 ? [...merged.values()][0]! : null;
  if (hit === null) return new CliHttpError(404, 'NOT_FOUND', message);
  return new CliHttpError(404, 'NOT_FOUND', `${message}；你是不是想写 ${shortIssueId(hit.id)} ${hit.title}`);
}

export async function notFoundWithSuggestion(ctx: Ctx, ref: string, message = '任务不存在'): Promise<CliHttpError> {
  if (!ID_LIKE_REF.test(ref.trim())) return new CliHttpError(404, 'NOT_FOUND', message);
  let issues: Issue[] | null = null;
  try {
    issues = await listAllIssues(ctx);
  } catch {
    // 纠错只是锦上添花：扫描失败保持原文案，不掩盖真实 404
    issues = null;
  }
  return notFoundErrorFrom(issues, ref, message);
}

/** 404 时补候选提示（comment/update 的写请求走这里）；非 404 原样抛出 */
export async function withNotFoundSuggestion<T>(ctx: Ctx, ref: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CliHttpError && error.status === 404) {
      throw await notFoundWithSuggestion(ctx, ref, error.message);
    }
    throw error;
  }
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
  const issues = await listAllIssues(ctx);
  const candidates = issues.filter(issue => issue.id.toLowerCase().startsWith(raw.toLowerCase()));
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    throw new AmbiguousIssueRefError(raw, candidates.map(({ id, workspace_id, title, status }) => ({ id, workspace_id, title, status })));
  }
  throw notFoundErrorFrom(issues, raw);
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
