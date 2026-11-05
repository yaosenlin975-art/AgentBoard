/**
 * DETAIL-D4：详情底部吸底操作条（设计 §1.3 / §1.5，未决 10 的落地口径）。
 *
 * 布局口径：作为 DetailPanel 的最后一个 flex 子项（`shrink-0`），而不是绝对定位覆盖层——
 * 这样「贴面板底边」在贴列锚定与整宽抽屉两种高度下都成立，且滚动区不会被条遮住（卡面要求 7）。
 *
 * 未决 10 取舍（卡面第 8 条）：
 * - 主按钮随状态变化，永远只有 1 个主操作 + 待验收时的 1 个次要操作；
 * - 危险 / 低频操作（强制释放、复制 ID、删除）全部进 ⋯ 溢出菜单，不提升为主按钮、不做全屏模态；
 * - 危险动作仍在菜单内做行内二次确认（沿用 ConfirmInline），确认后才发请求。
 * - 「会话进行中」禁用按钮已删除：占用状态由 D2 的负责人 chip 表达（设计 §2.2 第 6 条）。
 */
import { useEffect, useRef, useState } from 'react';
import type { Issue } from '@agentboard/shared';
import { openBlockerCount, type DependencyRef } from '../../lib/dependency';
import { ConfirmInline } from '../ui/ConfirmInline';

const MENU_ITEM =
  'flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-ink-2 transition-colors hover:bg-accent-soft hover:text-accent';

export interface ActionBarProps {
  issue: Issue;
  /** 未占用且状态∈{待规划,进行中} */
  dispatchable: boolean;
  claimed: boolean;
  /** 存在未关闭的子孙任务 → 不能「通过验收并关闭」 */
  closeBlocked: boolean;
  directChildCount: number;
  actionError: string | null;
  claimBlocked: boolean;
  /** 未解除前置清单（claim 拦截面板用） */
  blockers: DependencyRef[];
  /** 依赖清单是否已加载（未加载时显示「正在加载」） */
  dependenciesLoaded: boolean;
  statusPending: boolean;
  releasePending: boolean;
  donePending: boolean;
  deletePending: boolean;
  onDispatch: () => void;
  onAcceptClose: () => void;
  onReopenRunning: () => void;
  onReopenClosed: () => void;
  onRelease: () => void;
  onDone: () => void;
  onDelete: () => void;
  onDismissClaimBlocked: () => void;
}

export function ActionBar({
  issue,
  dispatchable,
  claimed,
  closeBlocked,
  directChildCount,
  actionError,
  claimBlocked,
  blockers,
  dependenciesLoaded,
  statusPending,
  releasePending,
  donePending,
  deletePending,
  onDispatch,
  onAcceptClose,
  onReopenRunning,
  onReopenClosed,
  onRelease,
  onDone,
  onDelete,
  onDismissClaimBlocked,
}: ActionBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState<'release' | 'delete' | null>(null);
  const [copied, setCopied] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLElement>(null);

  // 切换卡片时收起菜单与确认区，避免把上一张卡的确认态带到新卡
  useEffect(() => {
    setMenuOpen(false);
    setConfirming(null);
    setCopied(false);
  }, [issue.id]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // 先关菜单：吞掉这次 Esc，避免同一按键继续冒泡把整个右侧面板关掉（PANEL-FLOAT）
      event.preventDefault();
      event.stopPropagation();
      setConfirming(null);
      setMenuOpen(false);
      moreRef.current?.focus();
    };
    const onMouseDown = (event: MouseEvent): void => {
      if (rootRef.current === null) return;
      if (event.target instanceof Node && rootRef.current.contains(event.target)) return;
      setConfirming(null);
      setMenuOpen(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const toggleMenu = (): void => {
    setConfirming(null);
    setMenuOpen((open) => !open);
  };

  const copyId = (): void => {
    void navigator.clipboard?.writeText(issue.id).catch(() => undefined);
    setCopied(true);
  };

  const openBlocker = openBlockerCount(issue);
  const blockerList = blockers.filter((blocker) => !blocker.resolved);

  /** 主操作按状态唯一化：待验收 > 已关闭 > 可派发 > 占用中 */
  const primary =
    issue.status === '待验收' ? (
      <button
        type="button"
        data-testid="accept-close-btn"
        onClick={onAcceptClose}
        disabled={statusPending || closeBlocked}
        title={closeBlocked ? '存在未关闭的子孙任务，需先全部关闭' : undefined}
        className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        通过验收并关闭
      </button>
    ) : issue.status === '已关闭' ? (
      <button
        type="button"
        data-testid="reopen-btn"
        onClick={onReopenClosed}
        disabled={statusPending}
        className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
      >
        重新打开
      </button>
    ) : dispatchable ? (
      <button
        type="button"
        data-testid="dispatch-btn"
        onClick={onDispatch}
        className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink hover:opacity-90"
      >
        派发任务
      </button>
    ) : (
      <button
        type="button"
        data-testid="done-btn"
        onClick={onDone}
        disabled={donePending}
        className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
      >
        标记待验收
      </button>
    );

  return (
    <footer
      ref={rootRef}
      data-testid="detail-action-bar"
      aria-label="任务操作"
      className="detail-action-bar shrink-0 border-t border-hairline bg-surface-card"
    >
      {actionError !== null && (
        <p
          role="alert"
          data-testid="detail-action-error"
          className="px-3 pt-2 text-xs text-red-600 dark:text-red-400"
        >
          {actionError}
        </p>
      )}
      {claimBlocked && (
        <div
          data-testid="claim-blocked-panel"
          className="mx-3 mt-2 rounded border border-hairline bg-surface-raised p-2 text-xs text-ink-2"
        >
          <p className="font-medium">存在 {openBlocker} 项未解除的前置任务，已拦住本次领取（派发）：</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {blockerList.map((blocker) => (
              <li key={blocker.issue_id} data-testid={`claim-blocked-${blocker.issue_id}`}>
                {blocker.title}（{blocker.status}）
              </li>
            ))}
          </ul>
          {!dependenciesLoaded && (
            <p data-testid="claim-blocked-loading" className="mt-1">正在加载前置清单…</p>
          )}
          <button
            type="button"
            data-testid="claim-blocked-dismiss"
            onClick={onDismissClaimBlocked}
            className="mt-2 rounded border border-hairline px-2 py-0.5 text-xs text-ink-2 transition-colors hover:bg-accent-soft"
          >
            知道了
          </button>
        </div>
      )}

      <div className="flex items-center gap-1.5 px-3 py-2">
        <div className="ab-primary-slot">
          {/* F-01：待验收时主按钮之外给一个次要出口（退回进行中） */}
          {issue.status === '待验收' && (
            <button
              type="button"
              data-testid="reopen-running-btn"
              onClick={onReopenRunning}
              disabled={statusPending}
              className="rounded border border-hairline px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-accent-soft disabled:opacity-40"
            >
              退回进行中
            </button>
          )}
          {primary}
        </div>

        <div className="relative shrink-0">
          <button
            ref={moreRef}
            type="button"
            data-testid="actionbar-more"
            aria-label="更多操作"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={toggleMenu}
            className="rounded border border-hairline px-2 py-1 text-sm leading-5 text-ink-2 transition-colors hover:bg-accent-soft hover:text-accent"
          >
            ⋯
          </button>
          {menuOpen && (
            <div
              data-testid="actionbar-menu"
              role="menu"
              aria-label="更多操作"
              className="ab-more-menu absolute bottom-full right-0 z-20 mb-1 min-w-[168px] rounded-md border border-hairline bg-surface-card p-1 shadow-xl"
            >
              {claimed && confirming !== 'release' && (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="release-btn"
                  onClick={() => setConfirming('release')}
                  disabled={releasePending}
                  className={MENU_ITEM}
                >
                  强制释放
                </button>
              )}
              {claimed && confirming === 'release' && (
                <div className="flex flex-wrap items-center gap-1.5 p-1">
                  <ConfirmInline
                    message="强制释放会立即断开当前会话的占用，任务回到可领取状态；执行中的会话不会自动结束。"
                    confirmLabel="确认释放"
                    messageTestId="release-confirm-text"
                    confirmTestId="release-confirm"
                    cancelTestId="release-cancel"
                    busy={releasePending}
                    onConfirm={() => {
                      setConfirming(null);
                      setMenuOpen(false);
                      onRelease();
                    }}
                    onCancel={() => setConfirming(null)}
                  />
                </div>
              )}
              <button type="button" role="menuitem" data-testid="copy-id-btn" onClick={copyId} className={MENU_ITEM}>
                {copied ? '已复制' : '复制任务 ID'}
              </button>
              {!claimed && confirming !== 'delete' && (
                <>
                  <div className="my-1 h-px bg-hairline" />
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="delete-btn"
                    onClick={() => setConfirming('delete')}
                    className={`${MENU_ITEM} text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40 dark:hover:text-red-300`}
                  >
                    删除任务
                  </button>
                </>
              )}
              {!claimed && confirming === 'delete' && (
                <div className="flex flex-wrap items-center gap-1.5 p-1">
                  <ConfirmInline
                    message={
                      directChildCount > 0
                        ? `该任务有 ${directChildCount} 个直接子任务；先移动或删除子任务后才能删除此任务`
                        : '确认删除？关联会话与消息将一并删除'
                    }
                    confirmLabel="确认删除"
                    messageTestId="delete-confirm-text"
                    confirmTestId="delete-confirm"
                    cancelTestId="delete-cancel"
                    busy={deletePending}
                    disabled={directChildCount > 0}
                    onConfirm={onDelete}
                    onCancel={() => setConfirming(null)}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </footer>
  );
}
