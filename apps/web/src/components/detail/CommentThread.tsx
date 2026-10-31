/**
 * 评论区（§7.4）：issue_comment 扁平时间线（作者徽标 user=蓝 / agent:*=紫 / system=灰，
 * markdown 渲染）+ 输入框发送。发送按钮旁按占用状态提示"将唤醒 <agent>"或"仅留言"；
 * 响应返回后按 woke 展示实际结果一行。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import type { Issue, IssueComment } from '@agentboard/shared';
import { api } from '../../api/client';
import { Badge } from '../ui/Badge';

/** 'agent:codex' → 'codex' */
function authorCli(author: string): string {
  return author.startsWith('agent:') ? author.slice('agent:'.length) : author;
}

function AuthorBadge({ author }: { author: string }) {
  if (author === 'user') {
    return (
      <Badge tone="blue" title="用户">
        user
      </Badge>
    );
  }
  if (author.startsWith('agent:')) {
    return (
      <Badge tone="purple" title={author}>
        {authorCli(author)}
      </Badge>
    );
  }
  return (
    <Badge tone="gray" title="系统">
      system
    </Badge>
  );
}

const inputCls =
  'w-full rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-800';

export function CommentThread({ issue }: { issue: Issue }) {
  const queryClient = useQueryClient();
  const [content, setContent] = useState('');
  const [wokeResult, setWokeResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: comments } = useQuery({
    queryKey: ['comments', issue.id],
    queryFn: () => api.get<IssueComment[]>(`/api/issues/${issue.id}/comments`),
  });

  const claimedBy = issue.claimed_by;
  const hint = claimedBy !== null ? `将唤醒 ${authorCli(claimedBy)}` : '仅留言';

  const send = useMutation({
    mutationFn: (text: string) =>
      api.post<{ comment: IssueComment; woke: boolean }>(`/api/issues/${issue.id}/comments`, {
        content: text,
      }),
    onSuccess: (res) => {
      setContent('');
      setWokeResult(res.woke ? `已唤醒 ${authorCli(claimedBy ?? '')}` : '未唤醒，仅留言');
      void queryClient.invalidateQueries({ queryKey: ['comments', issue.id] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : '发送失败'),
  });

  const submit = (): void => {
    const text = content.trim();
    if (text === '' || send.isPending) return;
    setError(null);
    setWokeResult(null);
    send.mutate(text);
  };

  return (
    <section data-testid="detail-comments" aria-label="评论区" className="space-y-2">
      <h3 className="text-sm font-semibold">评论</h3>
      <ol className="space-y-2">
        {(comments ?? []).map((c) => (
          <li
            key={c.id}
            data-testid={`comment-${c.id}`}
            className="rounded border border-neutral-200 px-2.5 py-2 text-sm dark:border-neutral-800"
          >
            <div className="mb-1 flex items-center gap-2">
              <span data-testid={`comment-author-${c.id}`}>
                <AuthorBadge author={c.author} />
              </span>
              <span className="text-xs text-neutral-400 dark:text-neutral-500">
                {new Date(c.ts).toLocaleString()}
              </span>
            </div>
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <Markdown>{c.content}</Markdown>
            </div>
          </li>
        ))}
        {(comments ?? []).length === 0 && (
          <li data-testid="comments-empty" className="text-xs text-neutral-400 dark:text-neutral-600">
            暂无评论
          </li>
        )}
      </ol>

      <div className="space-y-1">
        <textarea
          data-testid="comment-input"
          aria-label="评论内容"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={2}
          placeholder="追加评论（markdown）"
          className={inputCls}
        />
        <div className="flex items-center justify-end gap-2">
          {error !== null && (
            <span role="alert" className="text-xs text-red-600 dark:text-red-400">
              {error}
            </span>
          )}
          {wokeResult !== null && (
            <span data-testid="comment-woke-result" className="text-xs text-neutral-500 dark:text-neutral-400">
              {wokeResult}
            </span>
          )}
          <span data-testid="comment-hint" className="text-xs text-neutral-500 dark:text-neutral-400">
            {hint}
          </span>
          <button
            type="button"
            data-testid="comment-send"
            onClick={submit}
            disabled={content.trim() === '' || send.isPending}
            className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            发送
          </button>
        </div>
      </div>
    </section>
  );
}
