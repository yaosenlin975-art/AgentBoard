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
import { request } from '../api.js';
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

/** kb next：可派卡 = 待规划 且 无占用 且 前置全部解除 */
export async function next(ctx: Ctx, args: NextArgs = {}): Promise<number> {
  const limit = args.limit ?? NEXT_DEFAULT_LIMIT;
  const workspaceId = await resolveWorkspaceWithHint(ctx.base, args.workspace, ctx.io.writeErr);
  const all = await request<Issue[]>(ctx.base, 'GET', `/api/issues?workspace=${encodeURIComponent(workspaceId)}`);
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
  ctx.io.write(`可派卡 ${total} 张（显示 ${visible.length} 张；条件：待规划 · 无占用 · 前置全部解除）\n`);
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
