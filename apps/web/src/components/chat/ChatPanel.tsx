/**
 * 聊天视图（设计 §7.5 / §5.5，Task 14）：
 * - 顶部工具条：会话切换器（分组下拉+徽标）+ 新建会话 + 当前 CLI/模型（可修改，下一轮生效）
 *   + 停止（运行中显示，POST stop）+ 标记待验收（任务会话占用中且未结束时显示，POST done）；
 * - 消息流：初次 GET /api/sessions/:id/messages 全量，此后 WS message.added 追加
 *   （会话切换/发送后经 ?after=<最后 ts> 增量补齐）；
 * - 流式渲染：WS session.event（text delta）由 streamingStore 全局层按会话累积
 *   （模块级单例，切会话/收起面板不丢，非当前会话同样收流），assistant 消息经
 *   message.added 落定即清该会话 buffer；本组件经 useStream(sessionId) 渲染当前会话内容。
 * - 运行时态：入队乐观 +1，队列长度/等待槽位以 WS session.runtime 与 sessions 字段
 *   （queued_count/waiting_slot）校正；排队中可展开只读队列内容（GET /sessions/:id/queue）；
 * - 输入框：Enter 发送 / Shift+Enter 换行；运行中入队显示"排队中 N 条"。
 * sessionId 取 panelStore（localStorage 持久，刷新后 chatSession 缺失时按 GET /api/sessions/:id 恢复）；
 * 无则显示会话选择引导空态。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Issue, Message, Session, Workspace } from '@agentboard/shared';
import { api } from '../../api/client';
import { useWsEvent } from '../../api/wsBus';
import { useAppStore } from '../../state/appStore';
import { usePanelStore } from '../../state/panelStore';
import { useNavStore } from '../../state/navStore';
import { clearStream, useStream } from '../../state/streamingStore';
// 未读计数全局收集器：模块加载即订阅 wsBus（本组件未挂载期间同样计数，markUnread 不在此处，防双计）
import '../../state/unreadCollector';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { ModelSelector } from './ModelSelector';

export function ChatPanel({ onNewSession }: { onNewSession?: () => void } = {}) {
  const sessionId = usePanelStore((s) => s.sessionId);
  const storedSession = usePanelStore((s) => s.chatSession);
  const clearSession = usePanelStore((s) => s.clearSession);
  const removeSession = usePanelStore((s) => s.removeSession);
  const appWorkspaceId = useAppStore((s) => s.workspaceId);
  const queryClient = useQueryClient();

  const [liveSession, setLiveSession] = useState<Session | null>(null);
  const [fetchedSession, setFetchedSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 流式内容读全局 store：切会话即读对应累积，面板收起/组件卸载不丢
  const streaming = useStream(sessionId);
  const [queuedCount, setQueuedCount] = useState(0);
  const [waitingSlot, setWaitingSlot] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // AUDIT-SRV：错误卡片的「切换模型」入口——递增即让 ModelSelector 打开弹窗（弹窗开合仍归它自己）
  const [modelOpenSignal, setModelOpenSignal] = useState(0);
  // AUDIT-3：头部「修改」收进 ⋯ 菜单；点菜单外任意处收起
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  useEffect(() => {
    if (!headerMenuOpen) return;
    const close = (): void => setHeaderMenuOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [headerMenuOpen]);

  // WS session.changed 覆盖打开时携带的会话对象（状态/模型变更）；切会话同步清按 id 拉取的兜底
  useEffect(() => {
    setLiveSession(null);
    setFetchedSession(null);
  }, [sessionId]);
  // 持久化/按 id 拉取的快照（打开时的会话对象）
  const snapshotSession =
    (storedSession !== null && storedSession.id === sessionId ? storedSession : null) ??
    (fetchedSession !== null && fetchedSession.id === sessionId ? fetchedSession : null);
  const workspaceId = liveSession?.workspace_id ?? snapshotSession?.workspace_id ?? appWorkspaceId;
  const { data: sessions } = useQuery({
    queryKey: ['sessions', workspaceId],
    queryFn: () => api.get<Session[]>(`/api/sessions?workspace=${encodeURIComponent(workspaceId ?? '')}`),
    enabled: workspaceId !== null,
  });
  // 会话对象优先级：WS session.changed（最新）→ sessions 列表（服务端权威快照）→ 持久化/按 id 拉取的快照。
  // 持久化 chatSession 是打开时的快照，后续状态变更不回写；刷新后必须以服务端列表校正，
  // 否则打开时处于「运行中」的会话在轮次结束后刷新仍显示运行三点与停止按钮（假忙）。
  const listedSession = sessions?.find((x) => x.id === sessionId) ?? null;
  const session = liveSession ?? listedSession ?? snapshotSession;
  // 当前会话所属工作空间名称：与 TopBar/WorkspaceList 共用 ['workspaces'] 缓存（不额外请求）。
  // 名称按 workspaceId 实时推导、不落本地 state，切会话/切工作空间不残留旧值；
  // workspaceId 为空 → 「未选择工作空间」；列表里查不到（空间已删除/不可用）→ 「工作空间不可用」。
  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.get<Workspace[]>('/api/workspaces'),
  });
  const workspaceLabel =
    workspaceId === null
      ? '未选择工作空间'
      : workspaces === undefined
        ? null
        : (workspaces.find((w) => w.id === workspaceId)?.name ?? '工作空间不可用');
  // 头部工作空间徽标（加载中不渲染，避免闪现错误名称）
  const workspaceBadge =
    workspaceLabel === null ? null : (
      <span
        data-testid="chat-workspace-label"
        title="当前会话所属工作空间"
        className="max-w-[9rem] shrink-0 truncate rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
      >
        {workspaceLabel}
      </span>
    );

  // 关联任务（DetailPanel 同款 ['issue', id] query）：占用态决定「标记待验收」显隐（issue_id 空→不拉取）
  const issueId = session?.issue_id ?? null;
  const { data: linkedIssue } = useQuery({
    queryKey: ['issue', issueId],
    queryFn: () => api.get<Issue>(`/api/issues/${issueId}`),
    enabled: issueId !== null,
  });

  // 运行时态以服务端为准：sessions 列表（含 queued_count/waiting_slot）每次拉取/重取即校正本地计数
  useEffect(() => {
    const s = sessions?.find((x) => x.id === sessionId);
    if (s === undefined) return;
    if (s.queued_count !== undefined) setQueuedCount(s.queued_count);
    if (s.waiting_slot !== undefined) setWaitingSlot(s.waiting_slot);
  }, [sessions, sessionId]);

  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // 切会话：重置本地态并全量拉取（运行时计数由服务端字段/ runtime 事件回填；流式内容留 store，切回即恢复）
  useEffect(() => {
    setMessages([]);
    setQueuedCount(0);
    setWaitingSlot(false);
    setQueueOpen(false);
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

  /** 追加/去重合并；assistant 落定即清该会话流式 buffer（store 全局层同步会清，此处按消息归属兜底幂等） */
  const mergeMessages = useCallback((incoming: Message[]) => {
    if (incoming.length === 0) return;
    setMessages((prev) => {
      const byId = new Map(prev.map((m) => [m.id, m]));
      for (const m of incoming) byId.set(m.id, m);
      return [...byId.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    });
    for (const m of incoming) {
      if (m.role === 'assistant') clearStream(m.session_id);
    }
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

  // 停止后队列查看（只读，不做编辑）：入口在 queuedCount>0 时展示，打开即拉当前内存排队文本
  const queueQuery = useQuery({
    queryKey: ['session-queue', sessionId],
    queryFn: () => api.get<{ texts: string[] }>(`/api/sessions/${sessionId}/queue`),
    enabled: queueOpen && sessionId !== null,
  });
  useEffect(() => {
    if (queueOpen) void queryClient.invalidateQueries({ queryKey: ['session-queue', sessionId] });
  }, [queueOpen, sessionId, queryClient]);

  // text delta 累积与 assistant 落定清空由 streamingStore 全局层处理（含非当前会话），此处不再消费 session.event；
  // 未读计数由 unreadCollector 全局层统计（本组件未挂载期间同样计数），此处不再 markUnread
  useWsEvent((event) => {
    const sid = sessionIdRef.current;
    if (sid === null) return;
    if (event.type === 'message.added' && event.message.session_id === sid) {
      mergeMessages([event.message]);
    } else if (event.type === 'session.runtime' && event.session_id === sid) {
      // 轮 end 不本地清零：排队计数等服务端 session.runtime（合并后 queued_count=0）校正
      setQueuedCount(event.queued_count);
      setWaitingSlot(event.waiting_slot);
    } else if (event.type === 'session.changed' && event.session.id === sid) {
      setLiveSession(event.session);
    } else if (event.type === 'session.deleted' && event.session_id === sid) {
      // 当前打开的会话被删：清选中与未读回空态（切换器列表由 ['sessions'] 失效刷新剔除）
      removeSession(sid);
    }
  });

  const handleSend = useCallback(
    async (text: string, attachmentIds: string[]): Promise<void> => {
      const sid = sessionId;
      if (sid === null) return;
      // CHAT-IMG-DELIVERY：无附件时不带键（保持既有请求体）；有附件时服务端绑定 session_attachment 并以图片字节投递
      const res = await api.post<{ queued: boolean }>(`/api/sessions/${sid}/messages`, {
        text,
        ...(attachmentIds.length > 0 ? { attachment_ids: attachmentIds } : {}),
      });
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

  // 标记待验收：等价 DetailPanel markDone（agent_id='user' 调 done，服务端释放占用）；
  // 成功后占用释放 → ['issue', id] 失效重取 → 按钮自然消失；看板卡片经 WS issue.changed 失效刷新
  const markDone = useMutation({
    mutationFn: () => {
      if (issueId === null) return Promise.reject(new Error('会话未关联任务'));
      return api.post<Issue>(`/api/issues/${issueId}/done`, { agent_id: 'user' });
    },
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['issue', updated.id] });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setActionError(null);
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : '标记待验收失败'),
  });

  if (sessionId === null || session === null) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="chat-panel">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-hairline px-3 py-1.5">
          {workspaceBadge}
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
            onClick={() => onNewSession?.()}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            ＋ 新建会话
          </button>
        </div>
      </div>
    );
  }

  // 头部标题口径（设计 §5）：任务会话取 issue 标题（与左列表同源缓存），自由会话显示 cli·model
  const sessionTitle =
    session.issue_id !== null
      ? (linkedIssue?.title ?? `#${session.issue_id.slice(0, 8)}`)
      : `${session.cli}${session.model !== null ? ` · ${session.model}` : ''}`;
  const running = session.status === '运行中';
  // 标记待验收显隐：issue 关联非空 + 任务占用中 + 会话未结束/失败（无 issue 数据时 linkedIssue 为空 → 不渲染）
  const issueClaimed = linkedIssue?.claimed_by != null;
  const canMarkDone =
    session.issue_id !== null && issueClaimed && session.status !== '已结束' && session.status !== '失败';

  return (
    <div data-testid="chat-panel" className="flex h-full min-h-0 flex-col">
      {/* 头部（设计 §5 / AUDIT-3）：第一行只留一处会话标题；第二行是任务归属 · 工作空间 · 模型副标题 */}
      <div className="flex shrink-0 flex-col border-b border-hairline">
        <div className="flex min-w-0 items-center gap-1.5 px-3 pt-1.5">
          <span
            data-testid="chat-session-title"
            title={sessionTitle}
            className="min-w-0 truncate text-sm font-medium text-ink"
          >
            {sessionTitle}
          </span>
          <span className="relative ml-auto flex shrink-0 items-center gap-1">
            {waitingSlot && (
              <span
                data-testid="waiting-slot-badge"
                title="并发槽位已满，轮次排队等待空闲槽位"
                className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
              >
                等待槽位
              </span>
            )}
            {canMarkDone && (
              <button
                type="button"
                data-testid="chat-done-btn"
                onClick={() => markDone.mutate()}
                disabled={markDone.isPending}
                title="将关联任务标记为待验收并释放占用"
                className="shrink-0 rounded border border-accent bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent hover:opacity-90 disabled:opacity-40"
              >
                标记待验收
              </button>
            )}
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
            <button
              type="button"
              data-testid="chat-header-menu-btn"
              aria-label="会话操作"
              aria-haspopup="menu"
              aria-expanded={headerMenuOpen}
              onClick={(e) => {
                e.stopPropagation();
                setHeaderMenuOpen((v) => !v);
              }}
              className="flex size-6 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-surface-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              ⋯
            </button>
            {headerMenuOpen && (
              <div
                role="menu"
                data-testid="chat-header-menu"
                className="absolute right-0 top-full z-20 mt-1 w-28 rounded-md border border-hairline bg-surface-card p-0.5 shadow"
              >
                <button
                  type="button"
                  role="menuitem"
                  data-testid="edit-model-btn"
                  onClick={() => setModelOpenSignal((n) => n + 1)}
                  className="w-full rounded px-2 py-1 text-left text-xs text-ink-2 hover:bg-surface-raised hover:text-ink"
                >
                  修改模型
                </button>
              </div>
            )}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 px-3 pb-1.5 text-[10px] text-ink-3">
          {session.issue_id !== null && (
            <span data-testid="chat-issue-ref" title={`任务 ${session.issue_id}`} className="shrink-0">
              #{session.issue_id.slice(0, 8)}
            </span>
          )}
          {workspaceBadge}
          <ModelSelector session={session} onUpdated={setLiveSession} openSignal={modelOpenSignal} showEditButton={false} />
        </div>
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
        <MessageList
          messages={messages}
          streaming={streaming}
          running={running}
          onRetry={(text) => void handleSend(text, [])}
          onOpenModel={() => setModelOpenSignal((n) => n + 1)}
          onOpenUsage={() => useNavStore.getState().openDrawer('accounts')}
        />
      )}

      {queuedCount > 0 && (
        <div
          data-testid="queue-panel"
          className="shrink-0 border-t border-neutral-200 px-3 py-1 text-xs dark:border-neutral-800"
        >
          <button
            type="button"
            data-testid="queue-toggle"
            onClick={() => setQueueOpen((v) => !v)}
            className="text-accent hover:underline"
          >
            {queueOpen ? '收起队列' : `查看队列（${queuedCount} 条）`}
          </button>
          {queueOpen && (
            <ul data-testid="queue-list" className="mt-1 max-h-32 space-y-1 overflow-y-auto">
              {(queueQuery.data?.texts ?? []).map((t, i) => (
                <li
                  key={i}
                  className="rounded bg-neutral-100 px-2 py-1 whitespace-pre-wrap dark:bg-neutral-800/60"
                >
                  {t}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Composer disabled={false} running={running} queuedCount={queuedCount} workspaceId={workspaceId} onSend={handleSend} />
    </div>
  );
}
