/**
 * OPT-10：`kb next` —— 当前工作区「可派卡」组合视图。
 *
 * 一次返回可派卡及其派活所需字段（状态、占用、前置是否解除、父卡、后继、同标签相邻卡），
 * 替代 list-tasks + 逐卡 show + 逐卡 dep ls 三轮。不自动 claim、不改 list-tasks 语义、不加缓存。
 * ARCH-01：筛选/依赖/排序口径抽到 `@agentboard/shared` 的 boardViews，与 MCP `next_tasks` 共用。
 */
import {
  NEXT_DEFAULT_LIMIT,
  buildNextItems,
  nextCandidates,
  type DependencyRef,
  type DependencyView,
  type Issue,
  type NextItem,
} from '@agentboard/shared';
import { CliHttpError, request } from '../api.js';
import { writeListJson } from '../json.js';
import type { Ctx } from '../io.js';
import { resolveWorkspaceWithHint } from '../workspace.js';
import { table } from '../render.js';

export { NEXT_DEFAULT_LIMIT, type NextItem } from '@agentboard/shared';

export interface NextArgs {
  /** 工作区 id / 名称 / ≥8 位唯一前缀；缺省按 cwd 解析 */
  workspace?: string;
  /** 最多返回几张（≥1） */
  limit?: number;
}

const NEXT_FIELDS = 'id,title,status,priority,parent_issue_id,labels,claimed_by';
const NEXT_KINDS = 'open,started,review,blocked,deprecated';
const NEXT_KIND_SET = new Set(NEXT_KINDS.split(','));

function rejectsProjection(error: unknown): boolean {
  return error instanceof CliHttpError && (error.status === 400 || error.status === 404);
}

async function readNextIssues(ctx: Ctx, workspaceId: string): Promise<Issue[]> {
  const encodedWorkspace = encodeURIComponent(workspaceId);
  const path = `/api/issues?workspace=${encodedWorkspace}`;
  const projectedPath = `${path}&fields=${NEXT_FIELDS}`;
  try {
    const statuses = await request<Array<{ name: string; kind: string }>>(
      ctx.base, 'GET', `/api/workspaces/${encodedWorkspace}/statuses`,
    );
    // 同标签关联按状态名排除「已关闭」。自定义 done 仍可能参与关联。
    if (Array.isArray(statuses)
      && statuses.some(status => status.name === '已关闭' && status.kind === 'done')
      && statuses.every(status => status.name === '已关闭' || NEXT_KIND_SET.has(status.kind))) {
      return await request<Issue[]>(ctx.base, 'GET', `${projectedPath}&kinds=${NEXT_KINDS}`);
    }
  } catch (error) {
    if (!rejectsProjection(error)) throw error;
  }
  try {
    return await request<Issue[]>(ctx.base, 'GET', projectedPath);
  } catch (error) {
    if (!rejectsProjection(error)) throw error;
    return request<Issue[]>(ctx.base, 'GET', path);
  }
}

function itemLines(item: NextItem, index: number): string[] {
  const short = (id: string | null): string => (id === null ? '（无）' : id.slice(0, 8));
  const refs = (refs: DependencyRef[]): string => refs.length === 0
    ? '（无）'
    : refs.map(ref => `${ref.issue_id.slice(0, 8)}(${ref.status}${ref.resolved ? '' : '·未解除'})`).join(' ');
  return [
    `【${index + 1}】${item.id.slice(0, 8)}  ${item.title}`,
    `  状态: ${item.status} · 优先级: ${item.priority} · 占用: （未占用）`,
    `  父卡: ${short(item.parent_issue_id)}`,
    `  前置: ${refs(item.blockers)}`,
    `  后继: ${refs(item.blocks)}`,
    `  同标签: ${item.siblings_by_label.length === 0 ? '（无）' : item.siblings_by_label.map(id => id.slice(0, 8)).join(' ')}`,
  ];
}

/** kb next：列出前置已解除的无主进行中及待规划卡。 */
export async function next(ctx: Ctx, args: NextArgs = {}): Promise<number> {
  const limit = args.limit ?? NEXT_DEFAULT_LIMIT;
  const workspaceId = await resolveWorkspaceWithHint(ctx.base, args.workspace, ctx.io.writeErr);
  const all = await readNextIssues(ctx, workspaceId);
  const candidates = nextCandidates(all);

  // 逐卡取依赖：只有候选卡需要，一次并行；前置未全部解除的卡不进入可派列表
  const views = await Promise.all(candidates.map(issue => request<DependencyView>(
    ctx.base, 'GET',
    `/api/issues/${encodeURIComponent(issue.id)}/dependencies?workspace_id=${encodeURIComponent(workspaceId)}`,
  )));

  const { items: visible, total } = buildNextItems(all, candidates, views, limit);
  if (ctx.json) {
    writeListJson(ctx, visible);
    return 0;
  }
  if (visible.length === 0) {
    ctx.io.write('（无可派卡）\n');
    return 0;
  }
  const resumable = visible.filter(item => item.status === '进行中').length;
  ctx.io.write(`可派卡 ${total} 张（显示 ${visible.length} 张；条件：待规划 或 进行中 · 无占用 · 前置全部解除；其中续做 ${resumable} 张、新开 ${visible.length - resumable} 张）\n`);
  ctx.io.write(`${table(
    ['id', '优先级', '父卡', '前置', '标题'],
    visible.map(item => [
      item.id.slice(0, 8),
      item.priority,
      item.parent_issue_id?.slice(0, 8) ?? '-',
      item.blockers.length === 0 ? '-' : item.blockers.map(ref => ref.issue_id.slice(0, 8)).join(','),
      item.title,
    ]),
  ).trimEnd()}\n`);
  ctx.io.write('\n');
  visible.forEach((item, index) => ctx.io.write(`${itemLines(item, index).join('\n')}\n`));
  return 0;
}
