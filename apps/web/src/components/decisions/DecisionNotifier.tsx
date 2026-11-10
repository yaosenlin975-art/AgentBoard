/**
 * DEC-7：应用内常驻提示（通知失败时的可靠通道，设计 v3 §3.4）。
 *
 * 三件套里本组件负责后两件：
 * - 主区顶部「有 N 条待决策」汇总条（点击进待决策视图）；
 * - 右下角常驻 toast：不自动消失，直到决策被回答（WS 失效重取后从列表消失）或手动「忽略」；
 * - 系统通知权限入口（Web 档必须用户手势，Tauri 档可直接申请）。
 *
 * 系统通知本身在 `notify.ts`；本组件只负责在 `decision.grace_started` 事件上触发一次。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useWsEvent } from '../../api/wsBus';
import { useAppStore } from '../../state/appStore';
import { useNavStore } from '../../state/navStore';
import type { DecisionDetailDto } from './types';
import { useDecisionClock } from './clock';
import { formatCountdown } from './countdown';
import { useDecisionLists } from './useDecisions';
import {
  describeDecisionForNotification,
  isNotificationGranted,
  notificationChannel,
  notifyDecision,
  requestNotificationPermission,
} from './notify';

const MAX_TOASTS = 3;

export function DecisionNotifier() {
  const workspaceId = useAppStore((state) => state.workspaceId);
  const view = useNavStore((state) => state.view);
  const focusDecision = useNavStore((state) => state.focusDecision);
  const { active } = useDecisionLists(workspaceId);
  const now = useDecisionClock();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [granted, setGranted] = useState<boolean | null>(null);
  const notified = useRef(new Set<string>());
  const channel = notificationChannel();

  useEffect(() => {
    let alive = true;
    void isNotificationGranted().then((value) => {
      if (alive) setGranted(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 新决策进入宽限：发一次系统通知（同一条决策只发一次，宽松失败不重试）
  useWsEvent((event) => {
    if (event.type !== 'decision.grace_started') return;
    const decisionId = event.decision_id;
    if (notified.current.has(decisionId)) return;
    notified.current.add(decisionId);
    void describeDecisionForNotification(decisionId, async (id) => {
      const response = await api.get<{ decision: DecisionDetailDto }>(`/api/decisions/${encodeURIComponent(id)}`);
      return response.decision;
    }).then(({ title, body }) =>
      notifyDecision({
        title,
        body,
        decisionId,
        onOpen: () => focusDecision(decisionId),
      }),
    );
  });

  const askPermission = useCallback(async () => {
    setGranted(await requestNotificationPermission());
  }, []);

  if (workspaceId === null || active.length === 0) return null;

  const pending = active.filter((item) => !dismissed.has(item.id));
  const visibleToasts = pending.slice(0, MAX_TOASTS);

  return (
    <>
      {/* 顶部汇总条：常驻、任何视图可见（待决策视图内不重复占位） */}
      {view !== 'decisions' && (
        <div
          data-testid="decisions-summary-bar"
          className="flex flex-wrap items-center gap-2 border-b border-accent/40 bg-accent-soft px-3 py-1.5 text-xs text-accent"
        >
          <span className="min-w-0 truncate">
            有 <span className="font-semibold tabular-nums">{pending.length}</span> 条待决策
          </span>
          {granted === false && channel !== 'inapp' && (
            <button
              type="button"
              data-testid="decisions-notify-permission"
              onClick={() => void askPermission()}
              className="shrink-0 whitespace-nowrap rounded border border-accent/50 px-1.5 py-0.5 transition-colors duration-150 motion-reduce:transition-none hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              开启系统通知
            </button>
          )}
          <button
            type="button"
            data-testid="decisions-summary-open"
            onClick={() => useNavStore.getState().setView('decisions')}
            className="ml-auto shrink-0 whitespace-nowrap rounded bg-accent px-2 py-0.5 font-medium text-accent-ink transition-colors duration-150 motion-reduce:transition-none hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            查看
          </button>
        </div>
      )}

      {/* 右下角常驻 toast：不自动消失；忽略只影响本会话 */}
      {view !== 'decisions' && visibleToasts.length > 0 && (
        <div
          data-testid="decisions-toasts"
          className="pointer-events-none fixed bottom-3 right-3 z-50 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2"
        >
          {visibleToasts.map((item) => {
            const remaining =
              item.state === 'grace' && item.grace_until > now
                ? Math.max(0, Math.ceil((item.grace_until - now) / 1000))
                : null;
            return (
              <div
                key={item.id}
                data-testid={`decision-toast-${item.id}`}
                className="pointer-events-auto rounded-md border border-accent/50 bg-surface-card p-2 shadow-lg"
              >
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 rounded bg-accent-soft px-1.5 text-xs font-medium text-accent">
                    {remaining !== null ? `剩 ${formatCountdown(remaining)}` : '待回答'}
                  </span>
                  <span className="truncate text-xs text-ink-3">{item.issue_title}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-ink">{item.question}</p>
                <div className="mt-1.5 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    data-testid={`decision-toast-dismiss-${item.id}`}
                    onClick={() => setDismissed((prev) => new Set(prev).add(item.id))}
                    className="rounded px-2 py-0.5 text-xs text-ink-3 transition-colors duration-150 motion-reduce:transition-none hover:bg-surface-raised"
                  >
                    忽略
                  </button>
                  <button
                    type="button"
                    data-testid={`decision-toast-open-${item.id}`}
                    onClick={() => focusDecision(item.id)}
                    className="rounded bg-accent px-2 py-0.5 text-xs font-medium text-accent-ink transition-colors duration-150 motion-reduce:transition-none hover:opacity-90"
                  >
                    立即回答
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
