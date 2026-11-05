/**
 * DETAIL-D7：附件路径索引（详情折叠区内容）。
 *
 * - 数据：GET /api/issues/{id}/attachments（该卡全部 attached 附件，评论/会话关联去重、新附件在前）；
 *   v1 单页拉满 limit=100（服务端契约单页上限即 100），不做滚动加载；
 * - 每条展示 文件名 + 完整路径（固定 URL /api/workspaces/{ws}/attachments/{id}）；v1 只做「复制路径」，
 *   不做内联预览；
 * - 「打开所在位置」置灰占位：需服务端 reveal 能力（未落地），不给可点死的假按钮。
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type IssueAttachmentListPage } from '../../api/client';

/** 复制文本：clipboard API 失败（非安全上下文/权限拒绝/不存在）时回退 execCommand */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      return document.execCommand('copy');
    } finally {
      document.body.removeChild(textarea);
    }
  }
}

export function AttachmentsSection({ issueId }: { issueId: string }) {
  const { data } = useQuery({
    queryKey: ['issue-attachments', issueId],
    queryFn: () => api.get<IssueAttachmentListPage>(`/api/issues/${issueId}/attachments?limit=100`),
  });
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
  }, []);

  const copy = async (id: string, path: string): Promise<void> => {
    if (!(await copyText(path))) return;
    setCopiedId(id);
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopiedId(null), 1500);
  };

  const items = data?.items ?? [];
  if (items.length === 0) {
    return (
      <p data-testid="detail-attachments-empty" className="text-[11px] text-ink-3">
        暂无附件；描述或评论里上传的图片/文件会按路径列在这里。
      </p>
    );
  }

  return (
    <ul data-testid="detail-attachments" className="space-y-1.5">
      {items.map((item) => (
        <li key={item.id} data-testid={`detail-attachment-${item.id}`} className="flex items-start justify-between gap-2">
          <div className="min-w-0 text-[11.5px] leading-snug">
            <div className="truncate text-ink">{item.file_name}</div>
            <div className="truncate text-[10.5px] text-ink-3">{item.url}</div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              data-testid={`detail-attachment-copy-${item.id}`}
              onClick={() => { void copy(item.id, item.url); }}
              className="rounded border border-hairline px-1.5 py-0.5 text-[10.5px] text-ink-2 transition-colors hover:bg-accent-soft hover:text-accent"
            >
              {copiedId === item.id ? '已复制' : '复制路径'}
            </button>
            <button
              type="button"
              disabled
              title="需服务端 reveal 能力"
              data-testid={`detail-attachment-reveal-${item.id}`}
              className="cursor-not-allowed rounded border border-hairline px-1.5 py-0.5 text-[10.5px] text-ink-3 opacity-50"
            >
              打开所在位置
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
