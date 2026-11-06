import type { Issue, IssueTreeItem, Workspace } from '@agentboard/shared';
import { request } from '../api.js';
import { writeListJson } from '../json.js';
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

interface WorkspaceStatusRow { name: string; kind: string }

/** 内置五状态：每个工作区恒在（Docs/api.md 的 workspace statuses 段，`is_builtin=1`） */
const BUILTIN_STATUSES: ReadonlySet<string> = new Set(['待规划', '进行中', '待验收', '已关闭', '已废弃']);

/** 整区只用内置状态时的「关闭类」口径 */
const BUILTIN_CLOSED_STATUSES: ReadonlySet<string> = new Set(['已关闭', '已废弃']);

/**
 * CLI-20：状态字典进程内缓存——一条 kb 命令里同一工作区最多取一次，`--status` 校验与任务树的
 * 关闭态判定共用同一份缓存，不再各取一遍。
 * 跨工作区聚合（`--all`）时每个工作区仍各一次：服务端没有「全部工作区状态字典」聚合接口
 * （实测 `GET /api/statuses` → 404），自定义状态归属谁只能逐区确认。
 */
const statusDictCache = new Map<string, Promise<WorkspaceStatusRow[]>>();

function readStatuses(ctx: Ctx, workspaceId: string): Promise<WorkspaceStatusRow[]> {
  const cached = statusDictCache.get(workspaceId);
  if (cached !== undefined) return cached;
  const pending = request<WorkspaceStatusRow[]>(
    ctx.base, 'GET', `/api/workspaces/${encodeURIComponent(workspaceId)}/statuses`,
  );
  statusDictCache.set(workspaceId, pending);
  pending.catch(() => statusDictCache.delete(workspaceId)); // 失败不留缓存，后续调用仍可重试
  return pending;
}

/**
 * CLI-LIST-GUARD：`--status` 必须是工作区已定义的状态。
 *
 * - 内置五状态恒在 → 直接放行，0 次字典请求（KB-CLI-4 / CLI-20）；
 * - 指定了 workspace → 校验该工作区的状态字典；
 * - 未指定（聚合模式）→ 任一工作区有该状态即放行（保持既有聚合语义）。
 * 非法值直接抛错（退出码非 0）并列出可用状态，不再静默返回「（无任务）」。
 */
async function requireKnownStatus(ctx: Ctx, target: Workspace[], status: string): Promise<void> {
  if (BUILTIN_STATUSES.has(status)) return;
  const dictionaries = await Promise.all(target.map(space => readStatuses(ctx, space.id)));
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

/**
 * 关闭类状态名：整区状态全属内置五状态时按内置口径返回（免取字典）；一旦出现自定义状态，
 * 才读该工作区字典并按 `kind`（done / deprecated）判定，与父卡汇总的关闭口径一致。
 */
async function closedStatusNames(
  ctx: Ctx, workspaceId: string, statusesInUse: ReadonlySet<string>,
): Promise<ReadonlySet<string>> {
  for (const status of statusesInUse) {
    if (BUILTIN_STATUSES.has(status)) continue;
    const dictionary = await readStatuses(ctx, workspaceId);
    return new Set(dictionary.filter(row => row.kind === 'done' || row.kind === 'deprecated').map(row => row.name));
  }
  return BUILTIN_CLOSED_STATUSES;
}

interface TreeCounts {
  child_count: number;
  descendant_count: number;
  descendants_closed_count: number;
}

/**
 * KB-CLI-4（CLI-19）：任务树本地组装——一次 `GET /api/issues?workspace=` 取回整区数据，在内存里按
 * `parent_issue_id` 分组、算 `child_count` / `descendant_count` / `descendants_closed_count`、再前序
 * 遍历输出；取代旧实现对每个父节点各发一次 `/api/issues/tree`（实测 525 卡 → 530 次请求）。
 *
 * 「输出与逐父接口逐行一致」依赖三条已实测口径（525 节点全量比对，0 处不一致）：
 * - `GET /api/issues` 按 `sort_order,created_at,id` 升序返回，与逐父树查询同排序口径，因此
 *   「保持数组顺序分组」得到的兄弟顺序就是旧实现的兄弟顺序；
 * - `parent_issue_id` 指向已删除节点的孤儿不会被遍历到（与旧 BFS 一样既不输出、也不进可见集）；
 * - 输出键序 = 整区字段序（`description` 由 projectForJson 摘除）+ 三个计数 + `tree_depth` / `tree_context`。
 */
async function readWorkspaceTree(ctx: Ctx, workspaceId: string, status?: string): Promise<VisibleTreeItem[]> {
  const issues = await request<Issue[]>(ctx.base, 'GET', '/api/issues?workspace=' + encodeURIComponent(workspaceId));
  const issueById = new Map<string, Issue>();
  const childrenByParent = new Map<string | null, Issue[]>();
  const statusesInUse = new Set<string>();
  for (const issue of issues) {
    if (issueById.has(issue.id)) throw new Error('任务树返回了重复节点，请检查 parent_issue_id 完整性');
    issueById.set(issue.id, issue);
    statusesInUse.add(issue.status);
    const siblings = childrenByParent.get(issue.parent_issue_id);
    if (siblings === undefined) childrenByParent.set(issue.parent_issue_id, [issue]);
    else siblings.push(issue);
  }

  const closed = await closedStatusNames(ctx, workspaceId, statusesInUse);
  const countSubtree = (parentId: string): TreeCounts => {
    const children = childrenByParent.get(parentId) ?? [];
    let descendant_count = 0;
    let descendants_closed_count = 0;
    const walk = [...children];
    while (walk.length > 0) {
      const node = walk.pop()!;
      descendant_count += 1;
      if (closed.has(node.status)) descendants_closed_count += 1;
      walk.push(...(childrenByParent.get(node.id) ?? []));
    }
    return { child_count: children.length, descendant_count, descendants_closed_count };
  };

  const visibleIds = new Set<string>();
  for (const issue of issues) {
    if (status !== undefined && issue.status !== status) continue;
    visibleIds.add(issue.id);
    let ancestorId = issue.parent_issue_id;
    while (ancestorId !== null && !visibleIds.has(ancestorId)) { // 已收录即停：脏数据成环也不会死循环
      visibleIds.add(ancestorId);
      const ancestor = issueById.get(ancestorId);
      if (ancestor === undefined) break;
      ancestorId = ancestor.parent_issue_id;
    }
  }

  const output: VisibleTreeItem[] = [];
  const roots = childrenByParent.get(null) ?? [];
  const stack = roots.slice().reverse().map((issue) => ({ issue, depth: 0 }));
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!visibleIds.has(current.issue.id)) continue;
    output.push({
      ...current.issue,
      ...countSubtree(current.issue.id),
      tree_depth: current.depth,
      tree_context: status !== undefined && current.issue.status !== status,
    });
    const children = childrenByParent.get(current.issue.id) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ issue: children[index]!, depth: current.depth + 1 });
    }
  }
  return output;
}

/**
 * CHILD-PROGRESS：父卡标题后追加 `[已关闭子卡数/子卡总数]`。
 * 字段由服务端 GET /api/issues 与详情投影；无子卡或缺字段时原样返回标题（不改变既有输出）。
 */
function titleWithChildProgress(issue: Issue): string {
  const raw = issue as Issue & { children_total?: unknown; children_closed?: unknown };
  const total = typeof raw.children_total === 'number' ? raw.children_total : 0;
  if (total <= 0) return issue.title;
  const closed = typeof raw.children_closed === 'number' ? raw.children_closed : 0;
  return `${issue.title} [${closed}/${total}]`;
}

/** DEC-4：占用者列后的 [待决策] 标记（grace 与 open 都算在途决策） */
function decisionMark(issue: Issue): string {
  return issue.decision_locked === true || issue.decision_grace_until != null ? '[待决策]' : '-';
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
      .flat();
    if (ctx.json) {
      writeListJson(ctx, projectForJson(visible, args.full === true));
      return;
    }
    if (visible.length === 0) {
      ctx.io.write('（无任务）\n');
      return;
    }
    ctx.io.write(table(
      ['层级', 'id', '状态', '优先级', 'labels', '占用者', '决策', '评论', 'parent_issue_id', '标题'],
      visible.map((issue) => [
        issue.tree_context ? '路径' : String(issue.tree_depth), issue.id.slice(0, 8), issue.status, issue.priority, // CLI-09：id 列短 ID
        issue.labels.length > 0 ? issue.labels.join(',') : '-', issue.claimed_by ?? '-', decisionMark(issue), String(issue.comment_count),
        issue.parent_issue_id?.slice(0, 8) ?? '-', // CLI-09 `${'  '.repeat(issue.tree_depth)}${issue.tree_depth > 0 ? '↳ ' : ''}${issue.title}`,
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
    writeListJson(ctx, projectForJson(filtered, args.full === true));
    return;
  }
  if (filtered.length === 0) {
    ctx.io.write('（无任务）\n');
    return;
  }
  ctx.io.write(
    table(
      ['id', '状态', '优先级', 'labels', '占用者', '决策', '评论', 'parent_issue_id', '标题'],
      filtered.map((i) => [
        i.id.slice(0, 8), // CLI-09：id 列短 ID
        i.status,
        i.priority,
        i.labels.length > 0 ? i.labels.join(',') : '-',
        i.claimed_by ?? '-',
        decisionMark(i),
        String(i.comment_count),
        i.parent_issue_id?.slice(0, 8) ?? '-', // CLI-09
        titleWithChildProgress(i),
      ]),
    ),
  );
}
