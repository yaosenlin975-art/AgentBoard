/**
 * 会话切换器（设计 §7.5）：下拉按"任务会话 / 自由会话"分组；
 * 徽标：运行中（绿点动效）/ 有新消息（本地未读计数）/ 失败（红点）；
 * 当前会话标"当前"。选项点击回调父级执行 openChat（内部顺带清未读）。
 * 删除：每项右侧删除入口，点击进入行内二次确认（确认/取消），确认后由父级执行持久删除；
 * 服务端拒绝（如运行中/占用任务）时错误由父级展示，菜单不关闭；成功后才收起菜单。
 */
import { useState } from 'react';
import type { Session } from '@agentboard/shared';

function StatusBadges({ session, unreadCount }: { session: Session; unreadCount: number }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      {session.status === '运行中' && (
        <span data-testid={`option-running-${session.id}`} title="运行中" className="flex items-center gap-0.5 text-[10px] text-green-600 dark:text-green-400">
          <span className="animate-pulse" aria-hidden>
            ●
          </span>
          运行中
        </span>
      )}
      {session.status === '失败' && (
        <span data-testid={`option-failed-${session.id}`} title="失败" className="flex items-center gap-0.5 text-[10px] text-red-600 dark:text-red-400">
          <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden />
          失败
        </span>
      )}
      {unreadCount > 0 && (
        <span
          data-testid={`unread-${session.id}`}
          title={`${unreadCount} 条新消息`}
          className="rounded-full bg-blue-600 px-1.5 text-[10px] font-medium leading-4 text-white"
        >
          {unreadCount}
        </span>
      )}
    </span>
  );
}

function SessionItem({
  session,
  active,
  unreadCount,
  onSelect,
  onClose,
  onDelete,
}: {
  session: Session;
  active: boolean;
  unreadCount: number;
  onSelect: (session: Session) => void;
  onClose: () => void;
  onDelete: (session: Session) => Promise<void>;
}) {
  // 行内二次确认：confirming 时替换为「确认删除 / 取消」，避免误删；提交中禁用防重复
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  return (
    <div
      data-testid={`session-row-${session.id}`}
      className={`flex w-full items-center gap-1 px-2.5 py-1.5 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
        active ? 'bg-blue-50 dark:bg-blue-950/40' : ''
      }`}
    >
      <button
        type="button"
        data-testid={`session-option-${session.id}`}
        onClick={() => {
          onSelect(session);
          onClose();
        }}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <span className="truncate">
          {session.cli}
          {session.model !== null ? ` · ${session.model}` : ''}
        </span>
        <StatusBadges session={session} unreadCount={unreadCount} />
        {active && <span className="shrink-0 text-[10px] text-blue-600 dark:text-blue-400">当前</span>}
      </button>
      {confirming ? (
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            data-testid={`session-delete-confirm-${session.id}`}
            disabled={deleting}
            onClick={() => {
              setDeleting(true);
              void onDelete(session).finally(() => {
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
            className="rounded px-1 text-[10px] text-neutral-500 hover:underline disabled:opacity-40 dark:text-neutral-400"
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
          className="shrink-0 rounded px-1 text-[10px] text-neutral-400 hover:text-red-600 dark:text-neutral-500 dark:hover:text-red-400"
        >
          ✕
        </button>
      )}
    </div>
  );
}

export function SessionSwitcher({
  sessions,
  currentSession,
  unread,
  onSelect,
  onDelete,
}: {
  sessions: Session[];
  currentSession: Session | null;
  unread: Record<string, number>;
  onSelect: (session: Session) => void;
  onDelete: (session: Session) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const taskSessions = sessions.filter((s) => s.issue_id !== null);
  const freeSessions = sessions.filter((s) => s.issue_id === null);
  const label = currentSession
    ? `${currentSession.cli} · ${currentSession.model ?? '默认模型'}`
    : '选择会话';

  return (
    <div className="relative min-w-0 flex-1">
      <button
        type="button"
        data-testid="session-switcher"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-1 rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
      >
        <span className="truncate">{label}</span>
        {currentSession?.status === '运行中' && (
          <span data-testid="switcher-running" className="animate-pulse text-green-600 dark:text-green-400" aria-hidden>
            ●
          </span>
        )}
        <span className="ml-auto shrink-0 text-neutral-400" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <>
          <div data-testid="session-menu-backdrop" className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            data-testid="session-menu"
            role="listbox"
            aria-label="会话列表"
            className="absolute left-0 top-full z-40 mt-1 max-h-72 w-72 max-w-full overflow-y-auto rounded border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
          >
            {sessions.length === 0 && (
              <p data-testid="session-menu-empty" className="px-3 py-2 text-xs text-neutral-400 dark:text-neutral-500">
                暂无会话
              </p>
            )}
            {taskSessions.length > 0 && (
              <>
                <p className="px-2.5 pt-1 pb-0.5 text-[10px] text-neutral-400 dark:text-neutral-600">任务会话</p>
                {taskSessions.map((s) => (
                  <SessionItem
                    key={s.id}
                    session={s}
                    active={s.id === currentSession?.id}
                    unreadCount={unread[s.id] ?? 0}
                    onSelect={onSelect}
                    onClose={() => setOpen(false)}
                    onDelete={onDelete}
                  />
                ))}
              </>
            )}
            {freeSessions.length > 0 && (
              <>
                <p className="px-2.5 pt-1 pb-0.5 text-[10px] text-neutral-400 dark:text-neutral-600">自由会话</p>
                {freeSessions.map((s) => (
                  <SessionItem
                    key={s.id}
                    session={s}
                    active={s.id === currentSession?.id}
                    unreadCount={unread[s.id] ?? 0}
                    onSelect={onSelect}
                    onClose={() => setOpen(false)}
                    onDelete={onDelete}
                  />
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

