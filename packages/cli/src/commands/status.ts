/**
 * STATUS-2：`kb status ls|add|rm` —— 工作区状态字典的 CLI 通道（设计 §3.2 / D3）。
 *
 * - `ls <workspace>`：列出该工作区状态（名字 / kind / 排序 / 是否内置）。
 * - `add <workspace> <name> [--kind open|started|review|done|deprecated] [--sort-order N]`。
 * - `rm <workspace> <name|id> --migrate-to <name>`：删除自定义状态；**必须**带 `--migrate-to`，
 *   服务端同事务把该状态下的卡迁到目标再删（未带 → 400 MIGRATION_TARGET_REQUIRED）。
 * workspace 支持 id 或名称（与 `kb list-tasks --workspace` 同款解析）。
 * 退出码沿用全局约定（409 → 2、其余失败 → 1），每条错误文案由服务端给出且可解释。
 */
import type { WorkspaceStatus } from '@agentboard/shared';
import { CommanderError } from 'commander';
import { CliHttpError, request } from '../api.js';
import type { Ctx } from '../io.js';
import { table } from '../render.js';
import { resolveWorkspaceId } from '../workspace.js';

/**
 * 409 的状态字典冲突（重名 / 内置不可删）自带可解释文案，原样透出并退出 2；
 * 否则会被全局 toExit 包装成「已被占用（内置状态不可删除：待规划）」，语义错位。
 */
const rethrowStatusConflict = (ctx: Ctx, error: unknown): never => {
  if (error instanceof CliHttpError && error.status === 409 && error.code.startsWith('WORKSPACE_STATUS')) {
    ctx.io.writeErr(`${error.message}\n`);
    throw new CommanderError(2, 'agentboard.status', '');
  }
  throw error;
};

export interface StatusRow {
  id: string;
  workspace_id: string;
  name: string;
  kind: WorkspaceStatus;
  sort_order: number;
  is_builtin: number;
}

export interface AddStatusArgs { kind?: string; sortOrder?: number }
export interface RemoveStatusArgs { migrateTo?: string }

const kindLines = (rows: readonly StatusRow[]): string[] => {
  if (rows.length === 0) return ['（该工作区还没有状态）'];
  const body = table(
    ['排序', '状态名', 'kind', '来源', 'id'],
    rows.map(row => [String(row.sort_order), row.name, String(row.kind), row.is_builtin === 1 ? '内置' : '自定义', row.id]),
  ).trimEnd().split('\n');
  return body;
};

/** kb status ls <workspace> */
export async function statusList(ctx: Ctx, workspace: string): Promise<void> {
  const workspaceId = await resolveWorkspaceId(ctx.base, workspace);
  const rows = await request<StatusRow[]>(ctx.base, 'GET', `/api/workspaces/${encodeURIComponent(workspaceId)}/statuses`);
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  ctx.io.write(`工作区 ${workspaceId} 的状态（${rows.length} 个）：\n`);
  ctx.io.write(`${kindLines(rows).join('\n')}\n`);
}

/** kb status add <workspace> <name> [--kind ...] [--sort-order N] */
export async function statusAdd(ctx: Ctx, workspace: string, name: string, args: AddStatusArgs = {}): Promise<void> {
  const workspaceId = await resolveWorkspaceId(ctx.base, workspace);
  const body: Record<string, unknown> = { workspace_id: workspaceId, name, kind: args.kind ?? 'open' };
  if (args.sortOrder !== undefined) body.sort_order = args.sortOrder;
  const created = await request<StatusRow>(ctx.base, 'POST', `/api/workspaces/${encodeURIComponent(workspaceId)}/statuses`, body)
    .catch(error => rethrowStatusConflict(ctx, error));
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(created, null, 2)}\n`);
    return;
  }
  ctx.io.write(`已新增状态：${created.name}（kind=${created.kind}，排序 ${created.sort_order}，id ${created.id}）\n`);
}

/** kb status rm <workspace> <name|id> --migrate-to <name> */
export async function statusRemove(ctx: Ctx, workspace: string, status: string, args: RemoveStatusArgs = {}): Promise<void> {
  const workspaceId = await resolveWorkspaceId(ctx.base, workspace);
  const rows = await request<StatusRow[]>(ctx.base, 'GET', `/api/workspaces/${encodeURIComponent(workspaceId)}/statuses`);
  const target = rows.find(row => row.id === status) ?? rows.find(row => row.name === status);
  if (!target) {
    ctx.io.writeErr(`状态不存在：${status}（可用：${rows.map(row => row.name).join(' / ')}）\n`);
    throw new Error(`状态不存在：${status}`);
  }
  const query = new URLSearchParams();
  if (args.migrateTo !== undefined) query.set('migrate_to', args.migrateTo);
  const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
  const result = await request<{ removed: StatusRow; migrate_to: string; migrated_issue_count: number }>(
    ctx.base, 'DELETE', `/api/workspaces/${encodeURIComponent(workspaceId)}/statuses/${encodeURIComponent(target.id)}${suffix}`,
  ).catch(error => rethrowStatusConflict(ctx, error));
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  ctx.io.write(`已删除状态：${result.removed.name}；${result.migrated_issue_count} 张卡迁移到 ${result.migrate_to}\n`);
}
