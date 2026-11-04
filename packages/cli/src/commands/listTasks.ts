import type { Issue, IssueTreeItem, IssueTreePage, Workspace } from '@agentboard/shared';
import { request } from '../api.js';
import type { Ctx } from '../io.js';
import { table } from '../render.js';
import { matchCurrentWorkspace, matchWorkspace } from '../workspace.js';

export interface ListTasksArgs {
  /** 工作空间 id 或名称；缺省按 cwd 解析 */
  workspace?: string;
  /** 聚合全部工作空间（与 workspace 互斥） */
  all?: boolean;
  /** 按状态过滤：本工作区已定义的任意状态（内置五状态 + 自定义状态） */
  status?: string;
  /** 以展开的层级视图列出全部任务 */
  tree?: boolean;
  /** --json 时是否连 description 正文一起输出（默认裁剪，避免把大量上下文灌给 agent） */
  full?: boolean;
}

interface VisibleTreeItem extends IssueTreeItem {
  tree_depth: number;
  tree_context: boolean;
}

interface WorkspaceStatusRow { name: string }

/**
 * CLI-LIST-GUARD：`--status` 必须是工作区已定义的状态。
 *
 * - 指定了 workspace → 校验该工作区的状态字典；
 * - 未指定（聚合模式）→ 任一工作区有该状态即放行（保持既有聚合语义）。
 * 非法值直接抛错（退出码非 0）并列出可用状态，不再静默返回「（无任务）」。
 */
async function requireKnownStatus(ctx: Ctx, target: Workspace[], status: string): Promise<void> {
  const dictionaries = await Promise.all(
    target.map(space => request<WorkspaceStatusRow[]>(ctx.base, 'GET', `/api/workspaces/${encodeURIComponent(space.id)}/statuses`)),
  );
  const available = [...new Set(dictionaries.flat().map(row => row.name))];
  if (available.includes(status)) return;
  const where = target.length === 1 ? `工作区 ${target[0]!.name}` : `全部 ${target.length} 个工作区`;
  throw new Error(`未知状态：${status}（${where} 可用状态：${available.length > 0 ? available.join(' / ') : '（无）'}）`);
}

/**
 * `--json` 默认裁剪 `description`（只留元数据，并标记 `description_omitted: true`）；
 * 需要正文时显式 `--full`。表格模式本来就不输出正文。
 */
function projectForJson(issues: readonly Issue[], full: boolean): Array<Record<string, unknown>> {
  if (full) return issues as unknown as Array<Record<string, unknown>>;
  return issues.map(issue => {
    const { description, description_truncated, next_description_offset_chars, ...rest } = issue as Issue & {
      description_truncated?: boolean; next_description_offset_chars?: number | null;
    };
    void description; void description_truncated; void next_description_offset_chars;
    return { ...rest, description_omitted: true };
  });
}

async function readChildren(ctx: Ctx, workspaceId: string, parentId: string | null): Promise<IssueTreeItem[]> {
  const items: IssueTreeItem[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ workspace: workspaceId, limit: '100' });
    if (parentId !== null) query.set('parent_issue_id', parentId);
    if (cursor !== undefined) query.set('cursor', cursor);
    const page = await request<IssueTreePage>(ctx.base, 'GET', `/api/issues/tree?${query.toString()}`);
    items.push(...page.items);
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return items;
}

async function readWorkspaceTree(ctx: Ctx, workspaceId: string, status?: string): Promise<VisibleTreeItem[]> {
  const childrenByParent = new Map<string | null, IssueTreeItem[]>();
  const issueById = new Map<string, IssueTreeItem>();
  const queue: Array<string | null> = [null];
  const seen = new Set<string>();
  for (let index = 0; index < queue.length; index += 1) {
    const parentId = queue[index]!;
    const children = await readChildren(ctx, workspaceId, parentId);
    childrenByParent.set(parentId, children);
    for (const child of children) {
      if (seen.has(child.id)) throw new Error('任务树返回了重复节点，请检查 parent_issue_id 完整性');
      seen.add(child.id);
      issueById.set(child.id, child);
      queue.push(child.id);
    }
  }

  const visibleIds = new Set<string>();
  for (const children of childrenByParent.values()) {
    for (const issue of children) {
      if (status === undefined || issue.status === status) {
        visibleIds.add(issue.id);
        let ancestorId = issue.parent_issue_id;
        while (ancestorId !== null) {
          visibleIds.add(ancestorId);
          const ancestor = issueById.get(ancestorId);
          if (!ancestor) break;
          ancestorId = ancestor.parent_issue_id;
        }
      }
    }
  }

  const output: VisibleTreeItem[] = [];
  const roots = childrenByParent.get(null) ?? [];
  const stack = roots.slice().reverse().map((issue) => ({ issue, depth: 0 }));
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!visibleIds.has(current.issue.id)) continue;
    output.push({ ...current.issue, tree_depth: current.depth, tree_context: status !== undefined && current.issue.status !== status });
    const children = childrenByParent.get(current.issue.id) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ issue: children[index]!, depth: current.depth + 1 });
    }
  }
  return output;
}

export async function listTasks(ctx: Ctx, args: ListTasksArgs): Promise<void> {
  if (args.all === true && args.workspace !== undefined) {
    throw new Error('--all 与 --workspace 不能同时使用');
  }
  // CLI-UX：--full 只影响 --json 输出；表格模式本来就没有 description，别静默无效
  if (args.full === true && ctx.json !== true) {
    ctx.io.writeErr('提示：--full 只对 --json 输出生效（表格模式本来就不含 description），本次已忽略\n');
  }
  const spaces = await request<Workspace[]>(ctx.base, 'GET', '/api/workspaces');
  const selected = args.all === true
    ? spaces
    : [args.workspace === undefined ? matchCurrentWorkspace(spaces) : matchWorkspace(spaces, args.workspace)];
  if (args.tree) {
    if (args.status !== undefined) await requireKnownStatus(ctx, selected, args.status);
    const visible = (await Promise.all(selected.map((space) => readWorkspaceTree(ctx, space.id, args.status))))
      .flat()
      .map((issue) => ({ ...issue, workspace_id: issue.workspace_id }));
    if (ctx.json) {
      ctx.io.write(`${JSON.stringify(projectForJson(visible, args.full === true), null, 2)}\n`);
      return;
    }
    if (visible.length === 0) {
      ctx.io.write('（无任务）\n');
      return;
    }
    ctx.io.write(table(
      ['层级', 'id', '状态', '优先级', 'labels', '占用者', '评论', 'parent_issue_id', '标题'],
      visible.map((issue) => [
        issue.tree_context ? '路径' : String(issue.tree_depth), issue.id, issue.status, issue.priority,
        issue.labels.length > 0 ? issue.labels.join(',') : '-', issue.claimed_by ?? '-', String(issue.comment_count),
        issue.parent_issue_id ?? '-', `${'  '.repeat(issue.tree_depth)}${issue.tree_depth > 0 ? '↳ ' : ''}${issue.title}`,
      ]),
    ));
    return;
  }
  if (args.status !== undefined) {
    await requireKnownStatus(ctx, selected, args.status);
  }
  const issues = (await Promise.all(
    selected.map(space => request<Issue[]>(ctx.base, 'GET', '/api/issues?workspace=' + encodeURIComponent(space.id))),
  )).flat();
  const filtered = args.status ? issues.filter((i) => i.status === args.status) : issues;
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(projectForJson(filtered, args.full === true), null, 2)}\n`);
    return;
  }
  if (filtered.length === 0) {
    ctx.io.write('（无任务）\n');
    return;
  }
  ctx.io.write(
    table(
      ['id', '状态', '优先级', 'labels', '占用者', '评论', 'parent_issue_id', '标题'],
      filtered.map((i) => [
        i.id,
        i.status,
        i.priority,
        i.labels.length > 0 ? i.labels.join(',') : '-',
        i.claimed_by ?? '-',
        String(i.comment_count),
        i.parent_issue_id ?? '-',
        i.title,
      ]),
    ),
  );
}
