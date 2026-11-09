/**
 * OPT-10：`kb next` —— 当前工作区「可派卡」组合视图。
 *
 * 一次返回可派卡及其派活所需字段（状态、占用、前置是否解除、父卡、后继、同标签相邻卡），
 * 替代 list-tasks + 逐卡 show + 逐卡 dep ls 三轮。不自动 claim、不改 list-tasks 语义、不加缓存。
 */
import type { Issue } from '@agentboard/shared';
import { request } from '../api.js';
import { writeListJson } from '../json.js';
import type { Ctx } from '../io.js';
import { resolveWorkspaceWithHint } from '../workspace.js';
import { table } from '../render.js';
import type { DependencyRef, DependencyView } from './dep.js';

/** 缺省最多返回 5 张，避免一次把整区倒给 agent */
export const NEXT_DEFAULT_LIMIT = 5;

export interface NextArgs {
  /** 工作区 id / 名称 / ≥8 位唯一前缀；缺省按 cwd 解析 */
  workspace?: string;
  /** 最多返回几张（≥1） */
  limit?: number;
}

export interface NextItem {
  id: string;
  title: string;
  status: string;
  priority: string;
  parent_issue_id: string | null;
  labels: string[];
  /** 本卡的前置（可派卡这里必然全部已解除，保留完整状态供核对） */
  blockers: DependencyRef[];
  /** 被本卡阻塞的后继 */
  blocks: DependencyRef[];
  /** 同标签相邻卡（未关闭，最多 5 张） */
  siblings_by_label: string[];
}

const isUnclosed = (issue: Issue): boolean => issue.status !== '已关闭';

/** 同标签相邻卡：共享至少一个标签的未关闭卡，按服务端顺序取前 5 张 */
function siblingsByLabel(issue: Issue, all: Issue[]): string[] {
  if (issue.labels.length === 0) return [];
  return all
    .filter(other => other.id !== issue.id && isUnclosed(other) && other.labels.some(label => issue.labels.includes(label)))
    .slice(0, 5)
    .map(other => other.id);
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
  const candidates = all.filter(issue => issue.status === '待规划' && (issue.claimed_by === null || issue.claimed_by === undefined || issue.claimed_by === ''));

  // 逐卡取依赖：只有候选卡需要，一次并行；前置未全部解除的卡不进入可派列表
  const views = await Promise.all(candidates.map(issue => request<DependencyView>(
    ctx.base, 'GET',
    `/api/issues/${encodeURIComponent(issue.id)}/dependencies?workspace_id=${encodeURIComponent(workspaceId)}`,
  )));

  const items: NextItem[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const issue = candidates[index]!;
    const view = views[index]!;
    if (view.blockers.some(blocker => !blocker.resolved)) continue;
    items.push({
      id: issue.id,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      parent_issue_id: issue.parent_issue_id,
      labels: issue.labels,
      blockers: view.blockers,
      blocks: view.blocked,
      siblings_by_label: siblingsByLabel(issue, all),
    });
  }

  const visible = items.slice(0, limit);
  if (ctx.json) {
    writeListJson(ctx, visible);
    return 0;
  }
  if (visible.length === 0) {
    ctx.io.write('（无可派卡）\n');
    return 0;
  }
  ctx.io.write(`可派卡 ${items.length} 张（显示 ${visible.length} 张；条件：待规划 · 无占用 · 前置全部解除）\n`);
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
