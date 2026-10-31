/**
 * 关联会话列表（§7.4）：该 issue 的全部历史会话，状态徽标（运行中带动效 / 已结束 / 失败），
 * 当前占用会话高亮"当前"；点击切聊天视图。
 */
import type { Session, SessionStatus } from '@agentboard/shared';
import { Badge } from '../ui/Badge';

const STATUS_TONE: Record<SessionStatus, 'green' | 'neutral' | 'red'> = {
  运行中: 'green',
  已结束: 'neutral',
  失败: 'red',
};

export function SessionList({
  sessions,
  currentSessionId,
  onSelect,
}: {
  sessions: Session[];
  currentSessionId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  return (
    <section data-testid="detail-sessions" aria-label="关联会话" className="space-y-2">
      <h3 className="text-sm font-semibold">关联会话</h3>
      {sessions.length === 0 ? (
        <p data-testid="sessions-empty" className="text-xs text-neutral-400 dark:text-neutral-600">
          暂无关联会话
        </p>
      ) : (
        <ul className="space-y-1.5">
          {sessions.map((s) => {
            const isCurrent = s.id === currentSessionId;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  data-testid={`session-item-${s.id}`}
                  onClick={() => onSelect(s.id)}
                  title="打开聊天视图"
                  className={`flex w-full items-center gap-2 rounded border px-2.5 py-1.5 text-left text-sm transition-colors ${
                    isCurrent
                      ? 'border-blue-400 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/40'
                      : 'border-neutral-200 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700'
                  }`}
                >
                  <span className="font-medium">{s.cli}</span>
                  {s.model !== null && (
                    <span className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                      {s.model}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-1.5">
                    {isCurrent && (
                      <span
                        data-testid={`session-current-${s.id}`}
                        className="rounded-full bg-blue-600 px-1.5 py-0.5 text-xs font-medium text-white"
                      >
                        当前
                      </span>
                    )}
                    <Badge tone={STATUS_TONE[s.status]} title={`会话状态：${s.status}`}>
                      {s.status}
                      {s.status === '运行中' && (
                        <span data-testid={`session-running-${s.id}`} className="animate-pulse" aria-hidden>
                          ●
                        </span>
                      )}
                    </Badge>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
