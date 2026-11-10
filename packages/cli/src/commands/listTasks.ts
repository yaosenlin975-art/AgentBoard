import type { Issue, IssueTreeItem, Workspace } from '@agentboard/shared';
import { CliHttpError, request } from '../api.js';
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
  /** OPT-01：保留改造前口径（整区全状态全占用），关闭缺省收敛 */
  allStatus?: boolean;
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
 * 跨工作区聚合（`--all`）时由 `prefetchStatuses` 走 `GET /api/statuses?workspace_ids=…` 一次取全
 * （KB-CLI-4）；聚合端点不可用（旧服务端）时自动退回逐区懒加载。
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
 * KB-CLI-4（CLI-20）：多工作区一次性预热状态字典缓存。
 * `GET /api/statuses?workspace_ids=a,b,c` 一次取回全部字典，`--all` 因此只发 1 次请求；
 * 单工作区路径不预热（省一次往返，缓存按需懒加载）。
 */
async function prefetchStatuses(ctx: Ctx, workspaceIds: string[]): Promise<void> {
  const missing = workspaceIds.filter(id => !statusDictCache.has(id));
  if (missing.length === 0) return;
  try {
    const res = await request<{ items: Array<{ workspace_id: string; statuses: WorkspaceStatusRow[] }> }>(
      ctx.base, 'GET', `/api/statuses?workspace_ids=${encodeURIComponent(missing.join(','))}`,
    );
    for (const item of res.items) statusDictCache.set(item.workspace_id, Promise.resolve(item.statuses));
  } catch {
    // 聚合端点不可用（旧服务端 / 4xx）时静默退回逐区懒加载，不改变输出
  }
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
async function readWorkspaceTree(ctx: Ctx, workspaceId: string, status: string | undefined, withFields: boolean): Promise<VisibleTreeItem[]> {
  const issues = await readWorkspaceIssues(ctx, workspaceId, withFields);
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

/**
 * PERF-4c：list-tasks 展示所需字段（不含 `description`）。
 * 表格模式本就不输出正文，`--json` 非 `--full` 也会由 `projectForJson` 摘除正文；
 * 只有 `--json --full` 才走无 `fields` 的全量请求。
 * 顺序与服务端 `rowToIssue` 的键序一致（去掉 description），保证 `--json` 输出逐行不变。
 */
const LIST_TASK_FIELDS = [
  'id', 'workspace_id', 'title', 'priority', 'labels', 'status', 'sort_order',
  'claimed_by', 'claimed_at', 'session_id', 'parent_issue_id', 'due_date', 'due_time',
  'comment_count', 'dependency_violation', 'decision_locked', 'open_decision_id',
  'decision_grace_until', 'decision_waiting_seconds',
  'blocked_by_count', 'blocked_by_open_count', 'resolved',
  'created_at', 'updated_at', 'children_total', 'children_closed',
].join(',');

/** 旧服务端 / 回滚开关（400 或 404）命中一次后，本次进程内不再尝试 `fields=` */
let issueFieldsUnsupported = false;

/** 单测复位回落标志（同一进程连跑多个用例时互不影响） */
export function resetIssueFieldsFallback(): void {
  issueFieldsUnsupported = false;
  blockedKindUnsupported = false;
}

/**
 * OPT-01 / ARCH-02：缺省收敛口径——未完成（kind ∈ open/started/review/blocked）且无主（claimed_by IS NULL）。
 * `blocked` 属于未完成语义（阻塞卡仍需展示给人处理），因此默认列表包含 kind=blocked 的自定义状态卡。
 * 过滤在服务端 SQL 里做（`GET /api/issues?kinds=…&unclaimed=1`），CLI 不拉全量后本地筛。
 */
const LEGACY_CONVERGED_FILTER = '&kinds=open,started,review&unclaimed=1';
const DEFAULT_CONVERGED_FILTER = '&kinds=open,started,review,blocked&unclaimed=1';

/**
 * ARCH-02：旧服务端不认 `kind=blocked`（会 400），命中一次后本进程内回落到改造前的收敛集合。
 */
let blockedKindUnsupported = false;

/**
 * 整区读取：默认带 `fields=` 裁剪；服务端不认（400，旧版/回滚开关）或路由不存在（404）时
 * 静默回落全量请求一次，输出口径不变；其它错误照常抛出。
 * `filterQuery` 为 OPT-01 的缺省收敛参数，回落请求同样携带；旧服务端不认 `kind=blocked` 时
 * 由 `readWorkspaceIssues` 整体回落到 `LEGACY_CONVERGED_FILTER`（ARCH-02）。
 */
async function fetchWorkspaceIssues(ctx: Ctx, workspaceId: string, withFields: boolean, filterQuery: string): Promise<Issue[]> {
  const path = '/api/issues?workspace=' + encodeURIComponent(workspaceId) + filterQuery;
  if (!withFields || issueFieldsUnsupported) return request<Issue[]>(ctx.base, 'GET', path);
  try {
    return await request<Issue[]>(ctx.base, 'GET', `${path}&fields=${LIST_TASK_FIELDS}`);
  } catch (err) {
    if (!(err instanceof CliHttpError) || (err.status !== 400 && err.status !== 404)) throw err;
    issueFieldsUnsupported = true;
    return request<Issue[]>(ctx.base, 'GET', path);
  }
}

async function readWorkspaceIssues(ctx: Ctx, workspaceId: string, withFields: boolean, filterQuery = ''): Promise<Issue[]> {
  const effective = blockedKindUnsupported && filterQuery !== '' ? LEGACY_CONVERGED_FILTER : filterQuery;
  try {
    return await fetchWorkspaceIssues(ctx, workspaceId, withFields, effective);
  } catch (err) {
    // ARCH-02：旧服务端不认 kind=blocked → 退回改造前的收敛集合，本次进程内不再尝试
    if (effective === filterQuery && filterQuery.includes('blocked') && err instanceof CliHttpError && err.status === 400) {
      blockedKindUnsupported = true;
      return fetchWorkspaceIssues(ctx, workspaceId, withFields, LEGACY_CONVERGED_FILTER);
    }
    throw err;
  }
}

export async function listTasks(ctx: Ctx, args: ListTasksArgs): Promise<void> {
  if (args.all === true && args.workspace !== undefined) {
    throw new Error('--all 与 --workspace 不能同时使用');
  }
  // OPT-07：--full 同时作用于表格（恢复 labels/决策/评论/parent_issue_id 等列）与 --json（带 description 正文）
  // OPT-01：缺省收敛为「当前工作区 · 未完成 · 无主」；`--status` 显式覆盖，`--tree` 保留整树上下文，
  // 需要改造前的整区全状态口径时用 `--all-status`。
  const converged = args.allStatus !== true && args.status === undefined && args.tree !== true;
  const spaces = await request<Workspace[]>(ctx.base, 'GET', '/api/workspaces');
  const selected = args.all === true
    ? spaces
    : [args.workspace === undefined ? matchCurrentWorkspace(spaces) : matchWorkspace(spaces, args.workspace)];
  // B1：收敛提示必须排在工作区解析之后——解析失败时先打这句会盖住真正的错误
  if (converged) ctx.io.writeErr('默认已收敛为未完成无主卡，全量用 --all-status\n');
  // KB-CLI-4：多工作区（--all）先一次性预热状态字典，避免每区一次 GET /statuses
  if (selected.length > 1) await prefetchStatuses(ctx, selected.map(space => space.id));
  if (args.tree) {
    if (args.status !== undefined) await requireKnownStatus(ctx, selected, args.status);
    // PERF-4c：只有 `--json --full` 需要正文；其余场景带 fields= 裁剪（回落见 readWorkspaceIssues）
    const withFields = !(ctx.json === true && args.full === true);
    const visible = (await Promise.all(selected.map((space) => readWorkspaceTree(ctx, space.id, args.status, withFields))))
      .flat();
    if (ctx.json) {
      writeListJson(ctx, projectForJson(visible, args.full === true));
      return;
    }
    if (visible.length === 0) {
      ctx.io.write('（无任务）\n');
      return;
    }
    // OPT-07：默认只保留 层级/id/状态/优先级/占用者/标题；其余列走 --full（层级前缀规则不变）
    if (args.full === true) {
      ctx.io.write(table(
        ['层级', 'id', '状态', '优先级', 'labels', '占用者', '决策', '评论', 'parent_issue_id', '标题'],
        visible.map((issue) => [
          issue.tree_context ? '路径' : String(issue.tree_depth), issue.id.slice(0, 8), issue.status, issue.priority, // CLI-09：id 列短 ID
          issue.labels.length > 0 ? issue.labels.join(',') : '-', issue.claimed_by ?? '-', decisionMark(issue), String(issue.comment_count),
          issue.parent_issue_id?.slice(0, 8) ?? '-', // CLI-09
          issue.title, // CLI-TREE-TITLE：树表格标题列与 --json 的 title 逐字一致（层级已由「层级」列表达）
        ]),
      ));
    } else {
      ctx.io.write(table(
        ['层级', 'id', '状态', '优先级', '占用者', '标题'],
        visible.map((issue) => [
          issue.tree_context ? '路径' : String(issue.tree_depth), issue.id.slice(0, 8), issue.status, issue.priority,
          issue.claimed_by ?? '-',
          issue.title,
        ]),
      ));
    }
    return;
  }
  if (args.status !== undefined) {
    await requireKnownStatus(ctx, selected, args.status);
  }
  const flatWithFields = !(ctx.json === true && args.full === true);
  const filterQuery = converged ? DEFAULT_CONVERGED_FILTER : '';
  const issues = (await Promise.all(
    selected.map(space => readWorkspaceIssues(ctx, space.id, flatWithFields, filterQuery)),
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
  // OPT-07：扁平表格默认 5 列；--full 恢复改造前的完整列
  if (args.full === true) {
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
    return;
  }
  ctx.io.write(
    table(
      ['id', '状态', '优先级', '占用者', '标题'],
      filtered.map((i) => [
        i.id.slice(0, 8),
        i.status,
        i.priority,
        i.claimed_by ?? '-',
        titleWithChildProgress(i),
      ]),
    ),
  );
}
