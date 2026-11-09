import type { Issue, IssueComment } from '@agentboard/shared';

/** CLI-09：终端显示宽度——CJK/全角记 2，其余记 1（简化 East Asian Width：≥0x2E80 的码点一律按宽处理） */
export function displayWidth(value: string): number {
  let width = 0;
  for (const ch of value) width += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1;
  return width;
}

/** 列对齐按显示宽度修正（CJK 记 2），中文与 36 位 id 混排仍对齐 */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))));
  const fmt = (cells: readonly string[]): string =>
    cells.map((c, i) => {
      const value = c ?? '';
      return `${value}${' '.repeat(Math.max(0, (widths[i] ?? 0) - displayWidth(value)))}`;
    }).join('  ');
  return [fmt(headers), ...rows.map(fmt)].map((l) => `${l}\n`).join('');
}

/** CLI-11：文本时间统一 YYYY-MM-DD HH:mm:ss（本地时区；自 changelog TIME 提升为公共实现） */
export function formatDateTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Issue 完整字段逐行（同样对非对象输入做兜底，避免错误分支渲染再抛一层） */
export function issueLines(input: Issue | null | undefined): string[] {
  if (!input || typeof input !== 'object') return ['id: （无）'];
  const issue = input;
  return [
    `id: ${issue.id}`,
    `workspace_id: ${issue.workspace_id}`,
    `标题: ${issue.title}`,
    `描述: ${issue.description === '' ? '（空）' : issue.description}`,
    `状态: ${issue.status}`,
    `父任务: ${issue.parent_issue_id ?? '（根任务）'}`,
    `优先级: ${issue.priority}`,
    `标签: ${issue.labels.length > 0 ? issue.labels.join(', ') : '（无）'}`,
    `截止: ${issue.due_date === null || issue.due_date === undefined ? '（未设置）' : `${issue.due_date}${issue.due_time === null || issue.due_time === undefined ? '' : ` ${issue.due_time}`}`}`,
    `sort_order: ${issue.sort_order}`,
    `占用者: ${issue.claimed_by ?? '（未占用）'}`,
    `claimed_at: ${typeof issue.claimed_at === 'number' ? formatDateTime(issue.claimed_at) : '-'}`,
    `session_id: ${issue.session_id ?? '-'}`,
    `created_at: ${formatDateTime(issue.created_at)}`,
    `updated_at: ${formatDateTime(issue.updated_at)}`,
  ];
}

/**
 * OPT-04：`kb show` / `kb claim` 默认只渲染最近 5 条评论（未读优先），`--comments all` 恢复全量。
 */
export const COMMENT_DEFAULT_LIMIT = 5;

/**
 * OPT-04：单条评论的渲染窗口（按码位）。与 `GET /api/issues/:id/comments/:commentId` 的
 * `content_offset_chars` 窗口口径一致，截断时给出续读参数，不新增服务端字段。
 */
export const COMMENT_PREVIEW_CHARS = 500;

/** OPT-04：解析 `--comments <n|all>`；未给返回 undefined（调用方用默认值），非法值直接报参数错误 */
export function parseCommentLimit(raw: string | undefined): number | 'all' | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === 'all') return 'all';
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`--comments 取值必须是正整数或 all（当前 ${raw}）`);
  return limit;
}

export interface CommentSelection<T> {
  /** 按原时间序输出的评论 */
  visible: T[];
  /** 未渲染的条数 */
  hidden: number;
  total: number;
}

/**
 * OPT-04：默认只保留最近 limit 条；有未读（is_new）时未读优先占位，其余名额用最近的已读补满。
 * `all` 或总数不超限时原样返回（保证 `--comments all` 与改造前逐字一致）。
 * `is_new` 只在 `--mark-read` 的 consume 响应里出现，故按可选字段探测，不要求调用方传扩展类型。
 */
export function selectRecentComments<T>(comments: readonly T[], limit: number | 'all'): CommentSelection<T> {
  const total = comments.length;
  if (limit === 'all' || total <= limit) return { visible: [...comments], hidden: 0, total };
  const isNew = (comment: T): boolean => (comment as { is_new?: unknown }).is_new === true;
  const keep = new Set<T>();
  const unread = comments.filter(isNew);
  for (const comment of unread.slice(-limit)) keep.add(comment);
  if (keep.size < limit) {
    const read = comments.filter((comment) => !isNew(comment));
    for (const comment of read.slice(-(limit - keep.size))) keep.add(comment);
  }
  return { visible: comments.filter((c) => keep.has(c)), hidden: total - keep.size, total };
}

interface CommentRenderOptions {
  /** 评论所属任务 id：截断提示里拼续读接口路径 */
  issueId?: string;
  /** 单条渲染窗口（码位）；undefined = 不截断（旧行为） */
  previewChars?: number;
  /** 全量条数；给出且大于本次渲染条数时表头显示 n/total */
  totalComments?: number;
}

/** OPT-04：单条评论正文按窗口截断，尾行标注全文长度与续读参数 */
function commentContent(content: string, options: CommentRenderOptions, commentId: string): string {
  if (options.previewChars === undefined) return content;
  const chars = Array.from(content);
  if (chars.length <= options.previewChars) return content;
  const continuation = options.issueId === undefined
    ? `续读参数 content_offset_chars=${options.previewChars}`
    : `续读：GET /api/issues/${options.issueId}/comments/${commentId}?content_offset_chars=${options.previewChars}`;
  return `${chars.slice(0, options.previewChars).join('')}…（已截断，全文 ${chars.length} 字符；${continuation}）`;
}

/**
 * 评论列表（含作者），按返回序（服务端 ts 升序）；is_new 为真时行首加 [新] 前缀（kb show 经 consume 标注的待读留言）。
 *
 * CLI-CRASH：形参放宽为 unknown 并先做数组归一——错误分支/分页响应（`{items}`）/异常体都可能不是数组，
 * 直接 `.flatMap` 会抛 `TypeError: value.flatMap is not a function`，把真正的错误信息淹掉。
 *
 * OPT-04：options 全缺省时与改造前逐字一致（不截断、表头只给条数）。
 */
export function commentLines(raw: unknown, options: CommentRenderOptions = {}): string[] {
  const comments = (Array.isArray(raw) ? raw : []) as ReadonlyArray<IssueComment & { is_new?: boolean }>;
  if (comments.length === 0) return ['评论（0）:（无）'];
  const total = options.totalComments !== undefined && options.totalComments > comments.length
    ? `/${options.totalComments}`
    : '';
  return [
    `评论（${comments.length}${total}）:`,
    ...comments.flatMap((c) => [
      // CLI-11：评论行补时间（与全局文本时间同格式）
      `${c.is_new ? '[新] ' : ''}- ${formatDateTime(c.ts)} [${c.author}] ${commentContent(c.content, options, c.id)}`,
      ...(c.attachments ?? []).map((attachment) => `  图片（交付未验证）: ${attachment.file_name} (${attachment.mime_type}, ${attachment.size_bytes} bytes) ${attachment.url}`),
    ]),
  ];
}
