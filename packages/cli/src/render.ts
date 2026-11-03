import type { Issue, IssueComment } from '@agentboard/shared';

/** 简单列对齐（不按 CJK 宽度修正，满足"简单对齐"要求） */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: readonly string[]): string =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0, ' ')).join('  ');
  return [fmt(headers), ...rows.map(fmt)].map((l) => `${l}\n`).join('');
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
    `claimed_at: ${issue.claimed_at ?? '-'}`,
    `session_id: ${issue.session_id ?? '-'}`,
    `created_at: ${issue.created_at}`,
    `updated_at: ${issue.updated_at}`,
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
      `${c.is_new ? '[新] ' : ''}- [${c.author}] ${c.content}`,
      ...(c.attachments ?? []).map((attachment) => `  图片（交付未验证）: ${attachment.file_name} (${attachment.mime_type}, ${attachment.size_bytes} bytes) ${attachment.url}`),
    ]),
  ];
}
