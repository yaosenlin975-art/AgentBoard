/**
 * DEP-2：`kb dep ls|add|rm` —— 任务依赖的 CLI 通道（设计 §9 / §17-B1 / §17-B2）。
 *
 * 退出码映射**只在本子命令内**（不改全局 `toExit`）：
 *   0 成功；2 `DEPENDENCY_CYCLE` / `DEPENDENCY_EXISTS` / `ISSUE_CLAIMED`；
 *   3 `CROSS_WORKSPACE_DEPENDENCY` / `DEPENDENCY_SELF` / `VALIDATION_ERROR`；
 *   4 `NOT_FOUND` / `TASK_NOT_FOUND`；未映射的码交回全局 `toExit`（退出码 1）。
 * 每个码自带中文文案，避免被全局包装成「已被占用（…）」。
 * workspace 解析照 `commands/claim.ts:17-21`：先读 issue 的 workspace_id 再上送（写通道强制 workspace_id）。
 */
import type { Issue } from '@agentboard/shared';
import { CliHttpError, request } from '../api.js';
import type { Ctx } from '../io.js';
import { table } from '../render.js';

export interface DependencyRef { issue_id: string; title: string; status: string; resolved: boolean; relation?: string }
export interface DependencyView { blockers: DependencyRef[]; blocked: DependencyRef[]; related?: DependencyRef[]; duplicate?: DependencyRef[] }

/** BORROW-2.2：--type 白名单（与服务端 addRelation 同口径） */
export const DEP_TYPES: readonly string[] = ['blocks', 'related', 'duplicate'];

const EXIT_CODES: Record<string, number> = {
  DEPENDENCY_CYCLE: 2,
  // DEP-GUARD：子卡依赖父/祖先卡（流程死锁）——与成环同为 409 语义冲突，退出码对齐
  DEPENDENCY_PARENT_CYCLE: 2,
  DEPENDENCY_EXISTS: 2,
  ISSUE_CLAIMED: 2,
  CROSS_WORKSPACE_DEPENDENCY: 3,
  DEPENDENCY_SELF: 3,
  VALIDATION_ERROR: 3,
  NOT_FOUND: 4,
  TASK_NOT_FOUND: 4,
};

const MESSAGES: Record<string, string> = {
  DEPENDENCY_CYCLE: '该依赖会让任务成环，已拒绝',
  DEPENDENCY_PARENT_CYCLE: '子卡不能依赖其父/祖先卡：父卡要等子卡全完才 done，会形成流程死锁',
  DEPENDENCY_EXISTS: '该依赖已存在',
  ISSUE_CLAIMED: '任务已被占用，请先释放占用（release）再新增前置',
  CROSS_WORKSPACE_DEPENDENCY: '不支持跨工作区依赖',
  DEPENDENCY_SELF: '不能依赖自身：被阻塞卡与前置卡是同一张',
  VALIDATION_ERROR: '参数不合法（缺少 workspace_id 或前置 id 为空）',
  NOT_FOUND: '任务或依赖不存在',
  TASK_NOT_FOUND: '任务不存在或不属于该工作区',
};

/** 依赖错误码 → 退出码；未映射返回 undefined（交回全局 toExit） */
export function depExitCode(code: string): number | undefined {
  return EXIT_CODES[code];
}

/** 依赖错误码 → 中文文案；未映射返回 undefined（用服务端原文） */
export function depErrorMessage(code: string): string | undefined {
  return MESSAGES[code];
}

/** 统一失败处理：已映射的依赖错误就地打印并返回退出码，其余原样抛出交全局 toExit */
function handleFailure(ctx: Ctx, error: unknown): number {
  const code = error instanceof CliHttpError ? error.code : undefined;
  const exitCode = code === undefined ? undefined : depExitCode(code);
  if (code === undefined || exitCode === undefined) throw error;
  ctx.io.writeErr(`${depErrorMessage(code) ?? (error as CliHttpError).message}\n`);
  return exitCode;
}

/** 读 issue 拿 workspace_id（写通道要求显式 workspace_id） */
async function issueWorkspaceId(ctx: Ctx, issueId: string): Promise<string> {
  const issue = await request<Issue>(ctx.base, 'GET', `/api/issues/${encodeURIComponent(issueId)}`);
  return issue.workspace_id;
}

const dependencyLines = (view: DependencyView): string[] => {
  const rows = (items: readonly DependencyRef[]) => items.map(item => [
    item.status,
    item.resolved ? '已解除' : '未解除',
    item.issue_id,
    item.title,
  ]);
  const lines: string[] = [];
  lines.push(`前置（blockers，${view.blockers.length} 个）${view.blockers.length === 0 ? '：（无）' : ''}`);
  if (view.blockers.length > 0) lines.push(...table(['状态', '解除', 'id', '标题'], rows(view.blockers)).trimEnd().split('\n'));
  lines.push(`被阻塞者（blocked，${view.blocked.length} 个）${view.blocked.length === 0 ? '：（无）' : ''}`);
  if (view.blocked.length > 0) lines.push(...table(['状态', '解除', 'id', '标题'], rows(view.blocked)).trimEnd().split('\n'));
  // BORROW-2.2：标注边分组（服务端空集省略字段，旧输出零变化）
  for (const [group, label] of [['related', '关联（related，不阻塞领取）'], ['duplicate', '重复（duplicate，不阻塞领取）']] as const) {
    const items = view[group];
    if (items === undefined) continue;
    lines.push(`${label}：${items.length} 个`);
    if (items.length > 0) lines.push(...table(['状态', '解除', 'id', '标题'], rows(items)).trimEnd().split('\n'));
  }
  return lines;
};

/** kb dep ls <issue-id>：列出 blockers 与被阻塞者（含状态与解除标记） */
export async function depLs(ctx: Ctx, issueId: string): Promise<number> {
  try {
    const workspaceId = await issueWorkspaceId(ctx, issueId);
    const view = await request<DependencyView>(
      ctx.base, 'GET',
      `/api/issues/${encodeURIComponent(issueId)}/dependencies?workspace_id=${encodeURIComponent(workspaceId)}`,
    );
    if (ctx.json) {
      ctx.io.write(`${JSON.stringify(view, null, 2)}\n`);
      return 0;
    }
    ctx.io.write(`${dependencyLines(view).join('\n')}\n`);
    return 0;
  } catch (error) {
    return handleFailure(ctx, error);
  }
}

/** kb dep add <issue-id> <blocker-id>：建边（blocker 完成后被阻塞卡才可 claim） */
export async function depAdd(ctx: Ctx, issueId: string, blockerId: string, opts: { type?: string } = {}): Promise<number> {
  // BORROW-2.2：--type 校验（白名单外中文报错，不发起请求）；缺省 blocks（服务端同口径）
  let relation: string | undefined;
  if (opts.type !== undefined) {
    if (!DEP_TYPES.includes(opts.type)) {
      ctx.io.writeErr(`--type 取值不合法：${JSON.stringify(opts.type)}。可用类型：${DEP_TYPES.join(' / ')}` + "\n");
      return 3;
    }
    relation = opts.type;
  }
  try {
    const workspaceId = await issueWorkspaceId(ctx, issueId);
    const view = await request<DependencyView>(
      ctx.base, 'POST',
      `/api/issues/${encodeURIComponent(issueId)}/dependencies`,
      { workspace_id: workspaceId, blocker_issue_id: blockerId, ...(relation === undefined ? {} : { relation }) },
    );
    if (ctx.json) {
      ctx.io.write(`${JSON.stringify(view, null, 2)}\n`);
      return 0;
    }
    ctx.io.write(`已建立依赖（${relation ?? 'blocks'}）：${issueId} ← ${blockerId}\n`);
    ctx.io.write(`${dependencyLines(view).join('\n')}\n`);
    return 0;
  } catch (error) {
    return handleFailure(ctx, error);
  }
}

/** kb dep rm <issue-id> <blocker-id>：删边 */
export async function depRemove(ctx: Ctx, issueId: string, blockerId: string): Promise<number> {
  try {
    const workspaceId = await issueWorkspaceId(ctx, issueId);
    await request<void>(
      ctx.base, 'DELETE',
      `/api/issues/${encodeURIComponent(issueId)}/dependencies/${encodeURIComponent(blockerId)}?workspace_id=${encodeURIComponent(workspaceId)}`,
    );
    if (ctx.json) {
      ctx.io.write(`${JSON.stringify({ removed: true, issue_id: issueId, blocker_issue_id: blockerId }, null, 2)}\n`);
      return 0;
    }
    ctx.io.write(`已移除依赖：${issueId} ← ${blockerId}\n`);
    return 0;
  } catch (error) {
    return handleFailure(ctx, error);
  }
}
