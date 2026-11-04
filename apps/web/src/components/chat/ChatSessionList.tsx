/**
 * 聊天整屏视图 · 左会话列表（S3，设计稿 `Docs/designs/chat/2026-11-04-nav-sidebar-chat-view.md` §5）。
 *
 * 口径：
 * - 250px 固定宽，顶部「+ 新建会话」；下拉会话切换器（SessionSwitcher）由本列表取代；
 * - 分组：逐工作空间发 `GET /api/sessions?workspace=…`（跨工作空间），任务会话落到各自
 *   工作空间组，`issue_id === null` 的自由会话汇总到末尾「无任务会话」组；
 * - 条目 = 标题 + 未读红徽标 + 运行中橙点，不显示摘要行（避免 N+1 请求）；
 *   标题口径：任务会话取关联 issue 标题（`['issue', id]` 与详情/聊天头部共用缓存），
 *   自由会话显示 `cli·model`；
 * - 进入聊天视图默认选中当前会话（无则最近一条），选择写 panelStore（`openChat` 清未读）；
 * - 删除沿用原切换器的行内二次确认；服务端拒绝（409 运行中/占用）原文就地展示。
 *
 * 与面板的关系：本组件只负责「显示 + 选 + 删」，消息流仍在 ChatPanel（S3 不改消息渲染）。
 */
import { useEffect, useRef, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Issue, Session, Workspace } from '@agentboard/shared';
import { api } from '../../api/client';
import { usePanelStore } from '../../state/panelStore';
import { clearStream } from '../../state/streamingStore';

/** 「无任务会话」分组键（不与工作空间 id 冲突） */
const FREE_GROUP = 'free';

interface SessionGroup {
  key: string;
  label: string;
  sessions: Session[];
}

/** 最近创建在前（进入视图默认选中最近一条的依据） */
function byCreatedDesc(a: Session, b: Session): number {
  return b.created_at - a.created_at || a.id.localeCompare(b.id);
}

/** 未读徽标：红底，>99 收口为 99+（左栏聊天入口同一口径） */
function unreadLabel(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export function ChatSessionList({ onNewSession }: { onNewSession: () => void }) {
  const sessionId = usePanelStore((s) => s.sessionId);
  const unread = usePanelStore((s) => s.unread);
  const openChat = usePanelStore((s) => s.openChat);
  const removeSession = usePanelStore((s) => s.removeSession);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.get<Workspace[]>('/api/workspaces'),
  });
  const wsList = workspaces ?? [];

  // 逐工作空间拉会话：queryKey 与 ChatPanel 的 ['sessions', workspaceId] 同键，缓存共享，
  // 既有 `invalidateQueries({ queryKey: ['sessions'] })` 前缀失效会一并刷新本列表。
  const sessionQueries = useQueries({
    queries: wsList.map((w) => ({
      queryKey: ['sessions', w.id],
      queryFn: () => api.get<Session[]>(`/api/sessions?workspace=${encodeURIComponent(w.id)}`),
    })),
  });
  const sessions = sessionQueries.flatMap((q) => q.data ?? []);
  const loading = workspaces === undefined || sessionQueries.some((q) => q.isLoading);

  // 任务会话标题：按去重后的 issue id 批量复用 ['issue', id] 缓存（详情浮窗/聊天头部同键）
  const issueIds = Array.from(
    new Set(sessions.filter((s) => s.issue_id !== null).map((s) => s.issue_id as string)),
  );
  const issueQueries = useQueries({
    queries: issueIds.map((id) => ({
      queryKey: ['issue', id],
      queryFn: () => api.get<Issue>(`/api/issues/${id}`),
    })),
  });
  const issueTitles = new Map<string, string>();
  issueIds.forEach((id, i) => {
    const title = issueQueries[i]?.data?.title;
    if (title !== undefined) issueTitles.set(id, title);
  });

  // 进入聊天视图默认选中：本列表挂载后首次拿到会话时，无选中会话就取最近一条。
  // 只做一次（autoSelected）：之后用户删光当前会话也不自动跳到别的会话，空态归 ChatPanel 处理；
  // 切走再切回聊天不重置选择（panelStore.sessionId 保留）。
  const autoSelected = useRef(false);
  const hasSessions = sessions.length > 0;
  useEffect(() => {
    if (autoSelected.current || !hasSessions) return;
    autoSelected.current = true;
    if (sessionId !== null) return;
    const recent = [...sessions].sort(byCreatedDesc)[0]!;
    openChat(recent.id, recent);
  }, [sessionId, hasSessions, sessions, openChat]);

  const groups: SessionGroup[] = wsList
    .map((w) => ({
      key: w.id,
      label: w.name,
      sessions: sessions.filter((s) => s.workspace_id === w.id && s.issue_id !== null).sort(byCreatedDesc),
    }))
    .filter((g) => g.sessions.length > 0);
  const freeSessions = sessions.filter((s) => s.issue_id === null).sort(byCreatedDesc);
  if (freeSessions.length > 0) groups.push({ key: FREE_GROUP, label: '无任务会话', sessions: freeSessions });

  const handleSelect = (session: Session): void => {
    setError(null);
    openChat(session.id, session);
  };

  // 持久删除：成功 → 清流式缓冲 + 清选中/未读（当前会话回空态）+ 列表失效；
  // 失败（服务端 409：运行中/占用任务）→ 原文就地展示，选中与列表保持不变
  const handleDelete = async (session: Session): Promise<void> => {
    try {
      await api.del<void>(`/api/sessions/${encodeURIComponent(session.id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除会话失败');
      return;
    }
    clearStream(session.id);
    removeSession(session.id);
    setError(null);
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    queryClient.removeQueries({ queryKey: ['session-queue', session.id] });
  };

  return (
    <div
      data-testid="chat-session-list"
      aria-label="会话列表"
      className="flex w-[250px] shrink-0 flex-col border-r border-hairline bg-surface-card"
    >
      <div className="shrink-0 border-b border-hairline p-2">
        <button
          type="button"
          data-testid="new-session-btn"
          onClick={onNewSession}
          title="新建会话"
          className="h-8 w-full rounded-md border border-hairline bg-surface-card px-2 text-left text-xs text-ink transition-colors hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          ＋ 新建会话
        </button>
      </div>

      {error !== null && (
        <p data-testid="chat-session-error" role="alert" className="px-2 py-1 text-[11px] text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {loading && groups.length === 0 ? (
          <p data-testid="chat-session-list-loading" className="px-2.5 py-2 text-xs text-ink-3">
            会话加载中…
          </p>
        ) : groups.length === 0 ? (
          <p data-testid="chat-session-list-empty" className="px-2.5 py-2 text-xs text-ink-3">
            暂无会话
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.key} data-testid={`chat-session-group-${group.key}`}>
              <p className="px-2.5 pt-1 pb-0.5 text-[10px] text-ink-3">{group.label}</p>
              <ul role="list">
                {group.sessions.map((session) => {
                  const active = session.id === sessionId;
                  const count = unread[session.id] ?? 0;
                  const title =
                    session.issue_id !== null
                      ? (issueTitles.get(session.issue_id) ?? `#${session.issue_id.slice(0, 8)}`)
                      : `${session.cli}${session.model !== null ? ` · ${session.model}` : ''}`;
                  return (
                    <SessionRow
                      key={session.id}
                      session={session}
                      title={title}
                      active={active}
                      unreadCount={count}
                      onSelect={() => handleSelect(session)}
                      onDelete={() => handleDelete(session)}
                    />
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function SessionRow({
  session,
  title,
  active,
  unreadCount,
  onSelect,
  onDelete,
}: {
  session: Session;
  title: string;
  active: boolean;
  unreadCount: number;
  onSelect: () => void;
  onDelete: () => Promise<void>;
}) {
  // 行内二次确认：confirming 时替换为「确认删除 / 取消」，避免误删；提交中禁用防重复
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  return (
    <li
      data-testid={`session-row-${session.id}`}
      className={`group flex items-center gap-1 pr-1 ${active ? 'bg-accent-soft' : 'hover:bg-surface-raised'}`}
    >
      <button
        type="button"
        data-testid={`session-option-${session.id}`}
        aria-current={active ? 'true' : undefined}
        onClick={onSelect}
        className={`flex min-w-0 flex-1 items-center gap-1 px-2.5 py-1.5 text-left text-xs ${
          active ? 'font-medium text-accent' : 'text-ink-2'
        }`}
      >
        <span className="truncate" title={title}>
          {title}
        </span>
        {session.status === '运行中' && (
          <span
            data-testid={`option-running-${session.id}`}
            title="运行中"
            aria-label="运行中"
            className="size-1.5 shrink-0 rounded-full bg-amber-500"
          />
        )}
        {session.status === '失败' && (
          <span
            data-testid={`option-failed-${session.id}`}
            title="失败"
            aria-label="失败"
            className="size-1.5 shrink-0 rounded-full bg-red-500"
          />
        )}
        {unreadCount > 0 && (
          <span
            data-testid={`unread-${session.id}`}
            title={`${unreadCount} 条新消息`}
            className="ml-auto shrink-0 rounded-full bg-red-600 px-1.5 text-[10px] font-medium leading-4 text-white"
          >
            {unreadLabel(unreadCount)}
          </span>
        )}
      </button>
      {confirming ? (
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            data-testid={`session-delete-confirm-${session.id}`}
            disabled={deleting}
            onClick={() => {
              setDeleting(true);
              void onDelete().finally(() => {
                setDeleting(false);
                setConfirming(false);
              });
            }}
            className="rounded border border-red-400 px-1 text-[10px] text-red-600 disabled:opacity-40 dark:border-red-700 dark:text-red-400"
          >
            确认删除
          </button>
          <button
            type="button"
            data-testid={`session-delete-cancel-${session.id}`}
            disabled={deleting}
            onClick={() => setConfirming(false)}
            className="rounded px-1 text-[10px] text-ink-3 hover:underline disabled:opacity-40"
          >
            取消
          </button>
        </span>
      ) : (
        <button
          type="button"
          data-testid={`session-delete-${session.id}`}
          aria-label="删除会话"
          title="删除会话"
          onClick={() => setConfirming(true)}
          className="shrink-0 rounded px-1 text-[10px] text-ink-3 opacity-0 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:text-red-400"
        >
          ✕
        </button>
      )}
    </li>
  );
}
