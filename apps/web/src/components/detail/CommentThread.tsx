/** 评论时间线与图片附件草稿；图片交付未验证时，服务端会保留评论为待读。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MarkdownView } from '../../lib/markdown';
import type { AttachmentMetadata, Issue, IssueComment } from '@agentboard/shared';
import { api, type AttachmentUploadResult } from '../../api/client';
import { Badge } from '../ui/Badge';

const MAX_ATTACHMENTS = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MIME_BY_EXTENSION: Record<string, AttachmentUploadResult['mime_type']> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

interface PendingAttachment {
  localId: number;
  file: File;
  mimeType: AttachmentUploadResult['mime_type'];
  previewUrl: string;
  status: 'uploading' | 'ready' | 'error';
  attachmentId?: string;
  error?: string;
}

function authorCli(author: string): string {
  return author.startsWith('agent:') ? author.slice('agent:'.length) : author;
}

function AuthorBadge({ author }: { author: string }) {
  if (author === 'user') return <Badge tone="blue" title="用户">user</Badge>;
  if (author.startsWith('agent:')) return <Badge tone="purple" title={author}>{authorCli(author)}</Badge>;
  return <Badge tone="gray" title="系统">system</Badge>;
}

function getImageMimeType(file: File): AttachmentUploadResult['mime_type'] | null {
  if (file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp') return file.type;
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  return extension ? MIME_BY_EXTENSION[extension] ?? null : null;
}

function fileSize(size: number): string {
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function renderAttachment(attachment: AttachmentMetadata, key: string) {
  const deliveryLabel = attachment.delivery_state === 'pending'
    ? '图片等待投递'
    : attachment.delivery_state === 'sending'
      ? '图片正在投递'
      : attachment.delivery_state === 'unknown'
        ? '图片投递结果未知，保持未读，请手动重试'
        : attachment.delivery_state === 'delivered'
          ? '图片输入投递回执已确认'
          : null;
  return (
    <figure key={key} className="m-0 max-w-full" data-testid={`comment-attachment-${attachment.id}`}>
      <img
        src={attachment.url}
        alt={attachment.file_name}
        className="max-h-64 max-w-full rounded border border-neutral-200 object-contain dark:border-neutral-700"
      />
      <figcaption className="mt-1 break-all text-xs text-neutral-500 dark:text-neutral-400">
        {attachment.file_name} · {fileSize(attachment.size_bytes)}
      </figcaption>
      {deliveryLabel && (
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400" data-testid={`attachment-delivery-${attachment.id}`}>
          {deliveryLabel}
        </p>
      )}
    </figure>
  );
}

const inputCls =
  'w-full rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-800';

export function CommentThread({ issue }: { issue: Issue }) {
  const queryClient = useQueryClient();
  const [content, setContent] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [wokeResult, setWokeResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nextLocalId = useRef(0);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  attachmentsRef.current = attachments;

  useEffect(() => () => {
    for (const item of attachmentsRef.current) URL.revokeObjectURL(item.previewUrl);
  }, []);

  const { data: comments } = useQuery({
    queryKey: ['comments', issue.id],
    queryFn: () => api.get<IssueComment[]>(`/api/issues/${issue.id}/comments`),
  });

  /**
   * 展示顺序：时间倒序（最新在最上）。只作用于渲染，不改接口与写入顺序。
   * 同一时间戳（ts 相同）保持服务端返回顺序作为 tie-break，避免倒序后同批评论互相换位。
   */
  const orderedComments = useMemo(() => {
    const list = comments ?? [];
    return list
      .map((comment, index) => ({ comment, index }))
      .sort((a, b) => (b.comment.ts - a.comment.ts) || (a.index - b.index))
      .map((entry) => entry.comment);
  }, [comments]);

  const claimedBy = issue.claimed_by;
  const hint =
    claimedBy === null
      ? '仅留言'
      : issue.session_id !== null
        ? `将唤醒 ${authorCli(claimedBy)}`
        : '留言待 agent 下次读取';

  const send = useMutation({
    mutationFn: (input: { text: string; attachmentIds: string[] }) =>
      api.post<{ comment: IssueComment; woke: boolean; warning?: string }>(`/api/issues/${issue.id}/comments`, {
        content: input.text,
        ...(input.attachmentIds.length > 0
          ? { workspace_id: issue.workspace_id, attachment_ids: input.attachmentIds }
          : {}),
      }),
    onSuccess: (res) => {
      for (const item of attachmentsRef.current) URL.revokeObjectURL(item.previewUrl);
      attachmentsRef.current = [];
      setAttachments([]);
      setContent('');
      if (res.warning === 'IMAGE_DELIVERY_UNVERIFIED') {
        setWokeResult('图片已保存，投递能力未验证，评论保持待读');
      } else {
        setWokeResult(res.woke ? `已唤醒 ${authorCli(claimedBy ?? '')}` : '未唤醒，仅留言');
      }
      void queryClient.invalidateQueries({ queryKey: ['comments', issue.id] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : '发送失败'),
  });

  const patchAttachment = (localId: number, patch: Partial<PendingAttachment>): void => {
    setAttachments((current) => {
      const next = current.map((item) => item.localId === localId ? { ...item, ...patch } : item);
      attachmentsRef.current = next;
      return next;
    });
  };

  const upload = (item: PendingAttachment): void => {
    patchAttachment(item.localId, { status: 'uploading', error: undefined });
    void api.uploadAttachment(issue.workspace_id, item.file, item.mimeType).then((result) => {
      patchAttachment(item.localId, { status: 'ready', attachmentId: result.id, error: undefined });
    }).catch((e: unknown) => {
      patchAttachment(item.localId, {
        status: 'error',
        error: e instanceof Error ? e.message : '上传失败',
      });
    });
  };

  const addFiles = (files: FileList | File[]): void => {
    const accepted: PendingAttachment[] = [];
    let remaining = MAX_ATTACHMENTS - attachmentsRef.current.length;
    let rejection: string | null = null;
    for (const file of Array.from(files)) {
      if (file.size > MAX_IMAGE_BYTES) {
        rejection = '单张图片不能超过 10 MiB';
        continue;
      }
      const mimeType = getImageMimeType(file);
      if (!mimeType) {
        rejection = '仅支持 PNG、JPEG 和 WebP 图片';
        continue;
      }
      if (remaining <= 0) {
        rejection = '每条评论最多添加 5 张图片';
        continue;
      }
      accepted.push({
        localId: ++nextLocalId.current,
        file,
        mimeType,
        previewUrl: URL.createObjectURL(file),
        status: 'uploading',
      });
      remaining--;
    }
    if (accepted.length > 0) {
      const next = [...attachmentsRef.current, ...accepted];
      attachmentsRef.current = next;
      setAttachments(next);
      for (const item of accepted) upload(item);
    }
    setError(rejection);
  };

  const removeAttachment = (item: PendingAttachment): void => {
    URL.revokeObjectURL(item.previewUrl);
    const next = attachmentsRef.current.filter((candidate) => candidate.localId !== item.localId);
    attachmentsRef.current = next;
    setAttachments(next);
  };

  const submit = (): void => {
    const text = content.trim();
    if ((text === '' && attachments.length === 0) || send.isPending) return;
    if (attachments.some((item) => item.status !== 'ready' || !item.attachmentId)) return;
    setError(null);
    setWokeResult(null);
    send.mutate({ text, attachmentIds: attachments.map((item) => item.attachmentId!) });
  };

  const uploadPending = attachments.some((item) => item.status === 'uploading');
  const uploadFailed = attachments.some((item) => item.status === 'error');
  const canSend = (content.trim() !== '' || attachments.length > 0) && !uploadPending && !uploadFailed && !send.isPending;

  return (
    <section data-testid="detail-comments" aria-label="评论区" className="space-y-2">
      <h3 className="text-sm font-semibold">评论</h3>
      <ol className="space-y-2">
        {orderedComments.map((c) => (
          <li
            key={c.id}
            data-testid={`comment-${c.id}`}
            className="rounded border border-neutral-200 px-2.5 py-2 text-sm dark:border-neutral-800"
          >
            <div className="mb-1 flex items-center gap-2">
              <span data-testid={`comment-author-${c.id}`}><AuthorBadge author={c.author} /></span>
              <span className="text-xs text-neutral-400 dark:text-neutral-500">
                {new Date(c.ts).toLocaleString()}
              </span>
            </div>
            {c.content !== '' && <MarkdownView compact>{c.content}</MarkdownView>}
            {c.attachments && c.attachments.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-3">
                {c.attachments.map((attachment) => renderAttachment(attachment, attachment.id))}
              </div>
            )}
          </li>
        ))}
        {orderedComments.length === 0 && (
          <li data-testid="comments-empty" className="text-xs text-neutral-400 dark:text-neutral-600">暂无评论</li>
        )}
      </ol>

      <div
        data-testid="comment-dropzone"
        aria-label="评论内容与图片附件"
        className="space-y-2 rounded"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          const files = event.dataTransfer.files;
          if (files.length === 0) return;
          event.preventDefault();
          addFiles(files);
        }}
      >
        <textarea
          data-testid="comment-input"
          aria-label="评论内容"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onPaste={(event) => {
            const pasted = Array.from(event.clipboardData.items)
              .filter((item) => item.kind === 'file')
              .map((item) => item.getAsFile())
              .filter((file): file is File => file !== null);
            if (pasted.length > 0) {
              event.preventDefault();
              addFiles(pasted);
            }
          }}
          rows={2}
          placeholder="追加评论（markdown）"
          className={inputCls}
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            data-testid="comment-image-input"
            aria-label="选择图片"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => {
              if (event.currentTarget.files) addFiles(event.currentTarget.files);
              event.currentTarget.value = '';
            }}
          />
          <button
            type="button"
            data-testid="comment-image-picker"
            onClick={() => fileInputRef.current?.click()}
            className="rounded border border-neutral-300 px-2.5 py-1.5 text-xs dark:border-neutral-700"
          >
            添加图片
          </button>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            支持 PNG、JPEG、WebP；单张不超过 10 MiB，每条评论最多 5 张。也可粘贴或拖入。
          </span>
        </div>

        {attachments.length > 0 && (
          <ul aria-label="待发送图片" className="flex flex-wrap gap-3">
            {attachments.map((item) => (
              <li key={item.localId} className="w-28 max-w-full rounded border border-neutral-200 p-2 dark:border-neutral-700">
                <img src={item.previewUrl} alt={item.file.name} className="h-20 w-full rounded object-cover" />
                <p className="mt-1 truncate text-xs" title={item.file.name}>{item.file.name}</p>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {item.status === 'uploading' ? '上传中…' : item.status === 'ready' ? '已上传' : '上传失败'}
                </p>
                {item.error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{item.error}</p>}
                <div className="mt-1 flex flex-wrap gap-1">
                  {item.status === 'error' && (
                    <button type="button" aria-label={`重试上传 ${item.file.name}`} onClick={() => upload(item)} className="text-xs text-blue-700 underline dark:text-blue-300">
                      重试
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`移除图片 ${item.file.name}`}
                    disabled={item.status === 'uploading'}
                    onClick={() => removeAttachment(item)}
                    className="text-xs text-neutral-600 underline disabled:opacity-40 dark:text-neutral-300"
                  >
                    移除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {error !== null && <span role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</span>}
          {wokeResult !== null && (
            <span data-testid="comment-woke-result" className="text-xs text-neutral-500 dark:text-neutral-400">{wokeResult}</span>
          )}
          <span data-testid="comment-hint" className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</span>
          <button
            type="button"
            data-testid="comment-send"
            onClick={submit}
            disabled={!canSend}
            className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            发送
          </button>
        </div>
      </div>
    </section>
  );
}


