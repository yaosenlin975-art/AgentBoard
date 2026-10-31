/**
 * 聊天视图（设计 §7.5 / §5.5，Task 14）：
 * - 顶部工具条：会话切换器（分组下拉+徽标）+ 新建会话 + 当前 CLI/模型（可修改，下一轮生效）
 *   + 停止（运行中显示，POST stop）；
 * - 消息流：初次 GET /api/sessions/:id/messages 全量，此后 WS message.added 追加
 *   （会话切换/发送后经 ?after=<最后 ts> 增量补齐）；
 * - 流式渲染：WS session.event（text delta）追加本地 streaming buffer，end 清排队计数，
 *   最终 assistant 消息经 message.added 落定并清 buffer；
 * - 输入框：Enter 发送 / Shift+Enter 换行；运行中入队（queued:true）本地计数"排队中 N 条"。
 * sessionId 取 panelStore（localStorage 持久，刷新后 chatSession 缺失时按 GET /api/sessions/:id 恢复）；
 * 无则显示会话选择引导空态。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Message, Session } from '@agentboard/shared';
import { api } from '../../api/client';
import { useWsEvent } from '../../api/wsBus';
import { useAppStore } from '../../state/appStore';
import { usePanelStore } from '../../state/panelStore';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { ModelSelector } from './ModelSelector';
import { NewSessionDialog } from './NewSessionDialog';
import { SessionSwitcher } from './SessionSwitcher';

export function ChatPanel() {
  const sessionId = usePanelStore((s) => s.sessionId);
  const storedSession = usePanelStore((s) => s.chatSession);
  const unread = usePanelStore((s) => s.unread);
  const markUnread = usePanelStore((s) => s.markUnread);
  const openChat = usePanelStore((s) => s.openChat);
  const clearSession = usePanelStore((s) => s.clearSession);
  const appWorkspaceId = useAppStore((s) => s.workspaceId);
  const queryClient = useQueryClient();

  const [liveSession, setLiveSession] = useState<Session | null>(null);
  const [fetchedSession, setFetchedSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState('');
  const [queuedCount, setQueuedCount] = useState(0);
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // WS session.changed 覆盖打开时携带的会话对象（状态/模型变更）；切会话同步清按 id 拉取的兜底
  useEffect(() => {
    setLiveSession(null);
    setFetchedSession(null);
  }, [sessionId]);
  const session =
    liveSession ??
    (storedSession !== null && storedSession.id === sessionId ? storedSession : null) ??
    (fetchedSession !== null && fetchedSession.id === sessionId ? fetchedSession : null);

  const workspaceId = session?.workspace_id ?? appWorkspaceId;
  const { data: sessions } = useQuery({
    queryKey: ['sessions', workspaceId],
    queryFn: () => api.get<Session[]>(`/api/sessions?workspace=${encodeURIComponent(workspaceId ?? '')}`),
    enabled: workspaceId !== null,
  });

  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // 切会话：重置本地态并全量拉取
  useEffect(() => {
    setMessages([]);
    setStreaming('');
    setQueuedCount(0);
    setLoaded(false);
    setLoadError(null);
    if (sessionId === null) return;
    let cancelled = false;
    api
      .get<Message[]>(`/api/sessions/${sessionId}/messages`)
      .then((list) => {
        if (cancelled) return;
        setMessages(list);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : '消息加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // 刷新恢复兜底：live/stored 均无时按 sessionId 拉取会话；不存在（已删除）→ 清空选择回空态
  const storedMatches = storedSession !== null && storedSession.id === sessionId;
  useEffect(() => {
    if (sessionId === null || liveSession !== null || storedMatches) return;
    let cancelled = false;
    api
      .get<Session>(`/api/sessions/${sessionId}`)
      .then((s) => {
        if (!cancelled) setFetchedSession(s);
      })
      .catch(() => {
        if (!cancelled) clearSession();
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, liveSession, storedMatches, clearSession]);

  /** 追加/去重合并；assistant 落定即清流式 buffer */
  const mergeMessages = useCallback((incoming: Message[]) => {
    if (incoming.length === 0) return;
    setMessages((prev) => {
      const byId = new Map(prev.map((m) => [m.id, m]));
      for (const m of incoming) byId.set(m.id, m);
      return [...byId.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    });
    if (incoming.some((m) => m.role === 'assistant')) setStreaming('');
  }, []);

  /** 增量补齐：after= 最后一条 ts（WS 断连 / 发送后兜底） */
  const catchUp = useCallback(
    async (sid: string) => {
      const lastTs = messagesRef.current.reduce((mx, m) => Math.max(mx, m.ts), 0);
      try {
        const fresh = await api.get<Message[]>(`/api/sessions/${sid}/messages?after=${lastTs}`);
        if (sessionIdRef.current === sid) mergeMessages(fresh);
      } catch {
        // 补齐失败不阻塞：WS 正常时事件仍会推送
      }
    },
    [mergeMessages],
  );

  useWsEvent((event) => {
    // 未读计数：非当前聊天会话的新消息（切换器徽标）
    if (event.type === 'message.added' && event.message.session_id !== sessionIdRef.current) {
      markUnread(event.message.session_id);
    }
    const sid = sessionIdRef.current;
    if (sid === null) return;
    if (event.type === 'message.added' && event.message.session_id === sid) {
      mergeMessages([event.message]);
    } else if (event.type === 'session.event' && event.session_id === sid) {
      if (event.event.type === 'text' && typeof event.event.delta === 'string') {
        setStreaming((prev) => prev + event.event.delta);
      } else if (event.event.type === 'end') {
        setQueuedCount(0); // 本轮 end：排队消息已合并为下一轮
      }
    } else if (event.type === 'session.changed' && event.session.id === sid) {
      setLiveSession(event.session);
    }
  });

  const handleSend = useCallback(
    async (text: string): Promise<void> => {
      const sid = sessionId;
      if (sid === null) return;
      const res = await api.post<{ queued: boolean }>(`/api/sessions/${sid}/messages`, { text });
      if (res.queued) setQueuedCount((c) => c + 1);
      await catchUp(sid);
    },
    [sessionId, catchUp],
  );

  const stop = useMutation({
    mutationFn: () => {
      if (sessionId === null) return Promise.reject(new Error('未选择会话'));
      return api.post<Session>(`/api/sessions/${sessionId}/stop`);
    },
    onSuccess: (updated) => {
      setLiveSession(updated);
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : '停止失败'),
  });

  const selectSession = useCallback(
    (s: Session) => {
      openChat(s.id, s);
    },
    [openChat],
  );

  if (sessionId === null || session === null) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="chat-panel">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-neutral-200 px-2 py-1.5 dark:border-neutral-800">
          <SessionSwitcher sessions={sessions ?? []} currentSession={null} unread={unread} onSelect={selectSession} />
          <button
            type="button"
            data-testid="new-session-btn"
            onClick={() => setNewDialogOpen(true)}
            title="新建会话"
            className="shrink-0 rounded px-1.5 py-1 text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
          >
            ＋ 新建会话
          </button>
        </div>
        <div
          data-testid="chat-empty"
          className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
        >
          {sessionId === null ? (
            <>
              <p className="text-sm text-neutral-400 dark:text-neutral-500">
                选择一个会话开始对话，或新建自由会话
              </p>
              {sessions !== undefined && sessions.length === 0 && (
                <p className="text-xs text-neutral-400 dark:text-neutral-500">
                  会话归属创建时所选的工作空间，可切换左侧工作空间查找
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-neutral-400 dark:text-neutral-500">会话加载中…</p>
          )}
          <button
            type="button"
            data-testid="empty-new-session-btn"
            onClick={() => setNewDialogOpen(true)}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            ＋ 新建会话
          </button>
        </div>
        {newDialogOpen && (
          <NewSessionDialog defaultWorkspaceId={workspaceId} onClose={() => setNewDialogOpen(false)} />
        )}
      </div>
    );
  }

  const running = session.status === '运行中';

  return (
    <div data-testid="chat-panel" className="flex h-full min-h-0 flex-col">
      {/* 顶部工具条 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-neutral-200 px-2 py-1.5 dark:border-neutral-800">
        <SessionSwitcher sessions={sessions ?? []} currentSession={session} unread={unread} onSelect={selectSession} />
        <button
          type="button"
          data-testid="new-session-btn"
          onClick={() => setNewDialogOpen(true)}
          title="新建会话"
          className="shrink-0 rounded px-1.5 py-1 text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
        >
          ＋ 新建
        </button>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <ModelSelector session={session} onUpdated={setLiveSession} />
          {running && (
            <button
              type="button"
              data-testid="stop-btn"
              onClick={() => stop.mutate()}
              disabled={stop.isPending}
              title="停止当前轮次（排队消息保留）"
              className="shrink-0 rounded border border-red-300 px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              停止
            </button>
          )}
        </span>
      </div>
      {actionError !== null && (
        <p data-testid="chat-action-error" role="alert" className="px-3 pt-1 text-xs text-red-600 dark:text-red-400">
          {actionError}
        </p>
      )}

      {loadError !== null ? (
        <p data-testid="chat-load-error" className="p-4 text-sm text-red-600 dark:text-red-400">
          {loadError}
        </p>
      ) : (
        <MessageList messages={messages} streaming={streaming} running={running} />
      )}

      <Composer disabled={false} running={running} queuedCount={queuedCount} onSend={handleSend} />

      {newDialogOpen && (
        <NewSessionDialog defaultWorkspaceId={workspaceId} onClose={() => setNewDialogOpen(false)} />
      )}
    </div>
  );
}
