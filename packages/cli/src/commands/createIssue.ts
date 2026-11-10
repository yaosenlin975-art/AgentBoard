import { randomUUID } from 'node:crypto';
import type { Issue, Workspace } from '@agentboard/shared';
import { request, requestWithMeta, verifyIssueStoredText } from '../api.js';
import type { Ctx } from '../io.js';
import { normalizeIssueIdArg } from '../issueRef.js';
import { matchWorkspace, resolveWorkspaceWithHint } from '../workspace.js';

/**
 * 标签解析（TAG-HYGIENE）：逗号（半角/全角）与**任意空白**都当分隔符，逐段 trim、丢空、去重。
 * 约定：标签不含空格 —— 想表达「跨平台 文档」这种短语，请用两个标签 `跨平台,文档`。
 * 兼容：旧用法 `-l a,b` 行为不变；新用法 `-l "调研 跨平台 文档"` 会拆成三个标签（此前会被当成一个带空格的标签）。
 */
export function parseLabels(raw: string): string[] {
  const parts = raw
    .split(/[,，\s]+/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return [...new Set(parts)];
}

/** CARD-FACE：服务端同口径的空描述判定（CLI 只做提前提示，服务端仍是唯一权威）。 */
export function isBlankDescription(text: string | undefined): boolean {
  if (text === undefined) return true;
  const stripped = text
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*(目标|范围|验收|验收标准|边界)\s*[:：]?\s*$/gm, '')
    .replace(/^\s*[-*+]\s*$/gm, '')
    .trim();
  return stripped === '';
}

/** CREATE-STATUS：建卡允许的初始状态（不开放进行中 / 已关闭） */
export const CREATE_STATUSES = ['待规划', '待验收'] as const;
export type CreateStatus = (typeof CREATE_STATUSES)[number];

export interface CreateIssueArgs {
  /** 工作空间 id 或名称（先解析为 id）；缺省按 cwd 解析 */
  workspace?: string;
  /** 标题（与 titleStdin 二选一；含引号/选项样式的标题会被本地拒绝） */
  title?: string;
  /** KB-CLI-1：标题走 stdin（PowerShell 引号吞参的绕行通道） */
  titleStdin?: boolean;
  description?: string;
  /** CARD-FACE：跳过空描述校验（批量建卡 / 纯父卡），回执会提示已跳过 */
  allowEmpty?: boolean;
  /** CREATE-STATUS：初始状态，仅「待规划」「待验收」；待验收必须同时填验收标准 */
  status?: string;
  /** 低|中|高（非法值由服务端 400） */
  priority?: string;
  /** 逗号拆分 */
  labels?: string;
  parentIssueId?: string;
  /** `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm`（DUE-DATE） */
  due?: string;
  requestId?: string;
}

interface CreateIssueBody {
  workspace_id: string;
  title: string;
  description?: string;
  priority?: string;
  labels?: string[];
  parent_issue_id?: string;
  due_date?: string;
  due_time?: string;
  /** CARD-FACE：跳过服务端空描述校验 */
  allow_empty?: boolean;
  /** CREATE-STATUS：初始状态（待规划 / 待验收） */
  status?: string;
}

/**
 * `--due` 解析（DUE-DATE）：接受 `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm`；其余格式直接报错，
 * 不发请求（服务端也会 400，但本地先挡能给出更直白的提示）。返回的两字段可独立为 null 的语义由调用方决定。
 */
export function parseDue(value: string): { due_date: string; due_time?: string } {
  const trimmed = value.trim();
  const withTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(trimmed);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  const match = withTime ?? dateOnly;
  if (match === null) throw new Error(`--due 需为 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm，收到「${value}」`);
  const [, year, month, day, hour, minute] = match;
  const stamp = new Date(Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0));
  if (
    stamp.getFullYear() !== Number(year) ||
    stamp.getMonth() !== Number(month) - 1 ||
    stamp.getDate() !== Number(day) ||
    (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59))
  ) {
    throw new Error(`--due 不是有效日期时间：「${value}」`);
  }
  return withTime === null ? { due_date: trimmed } : { due_date: `${year}-${month}-${day}`, due_time: `${hour}:${minute}` };
}

/**
 * KB-CLI-1：标题本地校验（全部不发请求）。
 * 1) 引号/选项样式拒绝——PowerShell 引号吞参会静默写错数据（审查 01 P0）；
 * 2) 200 字上限。
 */
export const ISSUE_TITLE_MAX = 200;
export function assertIssueTitle(title: string): void {
  if (title.length > ISSUE_TITLE_MAX) {
    throw new Error(`标题超长：${title.length} 字符，上限 ${ISSUE_TITLE_MAX}。请精简标题，长内容放描述（-d）`);
  }
  if (/[\"'“”‘’]/.test(title)) {
    throw new Error(`标题含引号（" ' “ ” 等），PowerShell 可能吞参静默写错数据；请改用 --title-stdin 通道，或修正引号后重试`);
  }
  if (/^-{1,2}[A-Za-z]/.test(title)) {
    throw new Error(`标题以「-」开头疑似命令选项被吞参（收到「${title.slice(0, 20)}…」）；请用 --title-stdin 或给标题加引号`);
  }
}

export async function createIssue(ctx: Ctx, args: CreateIssueArgs): Promise<void> {
  // KB-CLI-1：标题双通道互斥校验
  if (args.titleStdin === true && args.title !== undefined) {
    throw new Error('--title-stdin 与位置参数 <title> 互斥，请二选一');
  }
  // OPT-02：只给一个位置参数且它不匹配任何工作区时，按「当前工作区 + 该参数为标题」处理
  if (args.workspace !== undefined && args.title === undefined && args.titleStdin !== true) {
    let spaces: Workspace[] | undefined;
    try {
      spaces = await request<Workspace[]>(ctx.base, 'GET', '/api/workspaces');
    } catch {
      // 探测失败时不下「当标题」结论，保持原有缺标题报错
    }
    if (spaces !== undefined && spaces.length > 0) {
      let matchesWorkspace = true;
      try {
        matchWorkspace(spaces, args.workspace);
      } catch {
        matchesWorkspace = false;
      }
      if (!matchesWorkspace) {
        ctx.io.writeErr(`提示：位置参数「${args.workspace}」不匹配任何工作区，已按「当前工作区 + 该参数为标题」处理（跨区请用 --workspace <id|名>）\n`);
        args = { ...args, title: args.workspace, workspace: undefined };
      }
    }
  }
  let title: string;
  if (args.titleStdin === true) {
    const raw = await ctx.io.readStdin();
    title = raw.replace(/\r?\n$/, '');
    if (title.trim() === '') {
      throw new Error('--title-stdin 读到的标题为空；PowerShell：Get-Content title.txt -Raw | kb create-issue <workspace> --title-stdin');
    }
  } else {
    if (args.title === undefined || args.title.trim() === '') {
      throw new Error('缺少标题：传位置参数 <title>，或改用 --title-stdin（PowerShell 引号吞参时）');
    }
    title = args.title;
  }
  assertIssueTitle(title);
  // CREATE-STATUS：只放「待规划」「待验收」；待验收即使加 --allow-empty 也必须写验收标准
  if (args.status !== undefined && !CREATE_STATUSES.includes(args.status as CreateStatus)) {
    throw new Error(`--status 仅支持「待规划」和「待验收」，收到: ${args.status}`);
  }
  if (args.status === '待验收' && isBlankDescription(args.description)) {
    throw new Error('初始状态为「待验收」时必须同时填写验收标准：请用 -d 写清验收口径');
  }
  // CARD-FACE：空描述默认拒绝；--allow-empty 是唯一逃生口（批量建卡 / 纯父卡）
  const skipFaceCheck = args.allowEmpty === true;
  if (!skipFaceCheck && isBlankDescription(args.description)) {
    throw new Error('描述不能为空：请用 -d 写清正文与验收标准（最小模板：目标 / 范围 / 验收 / 边界）；批量建卡或纯父卡可加 --allow-empty 跳过空面校验');
  }
  const workspaceId = await resolveWorkspaceWithHint(ctx.base, args.workspace, text => ctx.io.writeErr(text));
  const body: CreateIssueBody = { workspace_id: workspaceId, title };
  if (args.description !== undefined) body.description = args.description;
  if (skipFaceCheck) body.allow_empty = true;
  if (args.status !== undefined) body.status = args.status;
  if (args.priority !== undefined) body.priority = args.priority;
  if (args.labels !== undefined) {
    body.labels = parseLabels(args.labels);
  }
  if (args.parentIssueId !== undefined) body.parent_issue_id = await normalizeIssueIdArg(ctx, args.parentIssueId);
  if (args.due !== undefined) {
    const due = parseDue(args.due);
    body.due_date = due.due_date;
    if (due.due_time !== undefined) body.due_time = due.due_time;
  }
  // KB-CLI-1：幂等重放回显——文本标「（幂等重放）」，JSON 增 replayed 字段
  const { data: issue, replayed } = await requestWithMeta<Issue>(ctx.base, 'POST', '/api/issues', body, args.requestId ?? randomUUID());
  // MOJI-GUARD：回读实际落库文本，中文被替换成 ? 时不再静默通过
  await verifyIssueStoredText(ctx.base, issue.id, { title, description: args.description });
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify({ ...issue, replayed }, null, 2)}\n`);
    return;
  }
  const dueLine = issue.due_date === null || issue.due_date === undefined
    ? '截止: （未设置）'
    : `截止: ${issue.due_date}${issue.due_time === null || issue.due_time === undefined ? '' : ` ${issue.due_time}`}`;
  const skipLine = skipFaceCheck ? '已跳过空面校验（--allow-empty）\n' : '';
  // CLI-05：回显标签/优先级/父卡——标签会被空白和逗号自动拆分，建完当场核对
  const labelLine = issue.labels.length === 0 ? '标签: （无）' : `标签: ${issue.labels.join(', ')}`;
  const parentLine = issue.parent_issue_id === null || issue.parent_issue_id === undefined
    ? '父卡: （根任务）'
    : `父卡: ${issue.parent_issue_id}`;
  ctx.io.write(`${skipLine}${replayed ? '（幂等重放）' : ''}已创建任务: ${issue.id} ${issue.title}\n状态: ${issue.status}\n优先级: ${issue.priority}\n${labelLine}\n${parentLine}\n${dueLine}\n`);
}
