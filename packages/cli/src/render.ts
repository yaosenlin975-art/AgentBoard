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
 * 评论列表（含作者），按返回序（服务端 ts 升序）；is_new 为真时行首加 [新] 前缀（kb show 经 consume 标注的待读留言）。
 *
 * CLI-CRASH：形参放宽为 unknown 并先做数组归一——错误分支/分页响应（`{items}`）/异常体都可能不是数组，
 * 直接 `.flatMap` 会抛 `TypeError: value.flatMap is not a function`，把真正的错误信息淹掉。
 */
export function commentLines(raw: unknown): string[] {
  const comments = (Array.isArray(raw) ? raw : []) as ReadonlyArray<IssueComment & { is_new?: boolean }>;
  if (comments.length === 0) return ['评论（0）:（无）'];
  return [
    `评论（${comments.length}）:`,
    ...comments.flatMap((c) => [
      // CLI-11：评论行补时间（与全局文本时间同格式）
      `${c.is_new ? '[新] ' : ''}- ${formatDateTime(c.ts)} [${c.author}] ${c.content}`,
      ...(c.attachments ?? []).map((attachment) => `  图片（交付未验证）: ${attachment.file_name} (${attachment.mime_type}, ${attachment.size_bytes} bytes) ${attachment.url}`),
    ]),
  ];
}
