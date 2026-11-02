import type { Issue, IssueTreeItem, IssueTreePage, Workspace } from '@agentboard/shared';
import { request } from '../api.js';
import type { Ctx } from '../io.js';
import { table } from '../render.js';
import { matchWorkspace } from '../workspace.js';

export interface ListTasksArgs {
  /** 工作空间 id 或名称；缺省聚合全部工作空间 */
  workspace?: string;
  /** 按状态过滤：待规划|进行中|待验收|已关闭 */
  status?: string;
  /** 以展开的层级视图列出全部任务 */
  tree?: boolean;
}

interface VisibleTreeItem extends IssueTreeItem {
  tree_depth: number;
  tree_context: boolean;
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
  const spaces = await request<Workspace[]>(ctx.base, 'GET', '/api/workspaces');
  if (args.tree) {
    const selected = args.workspace ? [matchWorkspace(spaces, args.workspace)] : spaces;
    const visible = (await Promise.all(selected.map((space) => readWorkspaceTree(ctx, space.id, args.status))))
      .flat()
      .map((issue) => ({ ...issue, workspace_id: issue.workspace_id }));
    if (ctx.json) {
      ctx.io.write(`${JSON.stringify(visible, null, 2)}\n`);
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
  let issues: Issue[];
  if (args.workspace) {
    const ws = matchWorkspace(spaces, args.workspace);
    issues = await request<Issue[]>(
      ctx.base,
      'GET',
      `/api/issues?workspace=${encodeURIComponent(ws.id)}`,
    );
  } else {
    issues = (
      await Promise.all(
        spaces.map((s) =>
          request<Issue[]>(ctx.base, 'GET', `/api/issues?workspace=${encodeURIComponent(s.id)}`),
        ),
      )
    ).flat();
  }
  const filtered = args.status ? issues.filter((i) => i.status === args.status) : issues;
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(filtered, null, 2)}\n`);
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
