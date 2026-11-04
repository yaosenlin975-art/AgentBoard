/**
 * DEP-2：`kb dep ls|add|rm` —— 任务依赖的 CLI 通道（设计 §9 / §17-B1 / §17-B2）。
 *
 * 退出码映射**只在本子命令内**（不改全局 `toExit`）：
 *   0 成功；2 `DEPENDENCY_CYCLE` / `DEPENDENCY_EXISTS` / `ISSUE_CLAIMED`；
 *   3 `CROSS_WORKSPACE_DEPENDENCY` / `DEPENDENCY_SELF` / `VALIDATION_ERROR`；
 *   4 仅 `dep rm` 的「依赖边不存在」；`NOT_FOUND` / `TASK_NOT_FOUND`（任务不存在）交回全局 `toExit`（1），
 *   与其它命令的「任务不存在」同码（CLI-02）。
 * 每个码自带中文文案，避免被全局包装成「已被占用（…）」。
 * workspace 解析照 `commands/claim.ts:17-21`：先读 issue 的 workspace_id 再上送（写通道强制 workspace_id）。
 */
import { CliHttpError, request } from '../api.js';
import type { Ctx } from '../io.js';
import { normalizeIssueIdArg, resolveIssueByRef } from '../issueRef.js';
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
  // CLI-02：任务不存在与「依赖边不存在」不再共用 4——任务不存在统一为 1（与 show/claim 一致），
  // 4 只保留给 dep rm 的「依赖边不存在」（在 depRemove 里单独映射）。
  NOT_FOUND: 1,
  TASK_NOT_FOUND: 1,
};

const MESSAGES: Record<string, string> = {
  DEPENDENCY_CYCLE: '该依赖会让任务成环，已拒绝',
  DEPENDENCY_PARENT_CYCLE: '子卡不能依赖其父/祖先卡：父卡要等子卡全完才 done，会形成流程死锁',
  DEPENDENCY_EXISTS: '该依赖已存在',
  ISSUE_CLAIMED: '任务已被占用：请先 kb release <issue-id> 再新增前置',
  CROSS_WORKSPACE_DEPENDENCY: '不支持跨工作区依赖（依赖边两端必须属于同一工作区）',
  DEPENDENCY_SELF: '不能依赖自身：被阻塞卡与前置卡是同一张',
  VALIDATION_ERROR: '参数不合法（缺少 workspace_id 或前置 id 为空）',
  // CLI-02：同一根因（任务不存在）统一一条文案，不再分「任务」/「依赖」
  NOT_FOUND: '任务不存在或不属于该工作区',
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

/** 读 issue 拿真实 id + workspace_id（写通道要求显式 workspace_id）；CLI-02：允许 ≥8 位前缀 */
async function issueTarget(ctx: Ctx, issueId: string): Promise<{ id: string; workspaceId: string }> {
  const issue = await resolveIssueByRef(ctx, issueId);
  return { id: issue.id, workspaceId: issue.workspace_id };
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
    const target = await issueTarget(ctx, issueId);
    const view = await request<DependencyView>(
      ctx.base, 'GET',
      `/api/issues/${encodeURIComponent(target.id)}/dependencies?workspace_id=${encodeURIComponent(target.workspaceId)}`,
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
    const target = await issueTarget(ctx, issueId);
    const blocker = await normalizeIssueIdArg(ctx, blockerId);
    const view = await request<DependencyView>(
      ctx.base, 'POST',
      `/api/issues/${encodeURIComponent(target.id)}/dependencies`,
      { workspace_id: target.workspaceId, blocker_issue_id: blocker, ...(relation === undefined ? {} : { relation }) },
    );
    if (ctx.json) {
      ctx.io.write(`${JSON.stringify(view, null, 2)}\n`);
      return 0;
    }
    ctx.io.write(`已建立依赖（${relation ?? 'blocks'}）：${target.id} ← ${blocker}\n`);
    ctx.io.write(`${dependencyLines(view).join('\n')}\n`);
    return 0;
  } catch (error) {
    return handleFailure(ctx, error);
  }
}

/** kb dep rm <issue-id> <blocker-id>：删边 */
export async function depRemove(ctx: Ctx, issueId: string, blockerId: string): Promise<number> {
  try {
    const target = await issueTarget(ctx, issueId);
    const blocker = await normalizeIssueIdArg(ctx, blockerId);
    try {
      await request<void>(
        ctx.base, 'DELETE',
        `/api/issues/${encodeURIComponent(target.id)}/dependencies/${encodeURIComponent(blocker)}?workspace_id=${encodeURIComponent(target.workspaceId)}`,
      );
    } catch (error) {
      // CLI-02：4 只留给「依赖边不存在」；任务不存在已在 issueTarget 阶段以 1 退出
      if (error instanceof CliHttpError && error.code === 'NOT_FOUND') {
        ctx.io.writeErr(`依赖边不存在：${target.id} ← ${blocker}\n`);
        return 4;
      }
      throw error;
    }
    if (ctx.json) {
      ctx.io.write(`${JSON.stringify({ removed: true, issue_id: target.id, blocker_issue_id: blocker }, null, 2)}\n`);
      return 0;
    }
    ctx.io.write(`已移除依赖：${target.id} ← ${blocker}\n`);
    return 0;
  } catch (error) {
    return handleFailure(ctx, error);
  }
}
