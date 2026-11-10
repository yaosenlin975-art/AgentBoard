/**
 * CHAT-APP2：三档确认弹窗（`awaiting_approval` 的唯一交互出口）。
 *
 * - 数据只来自 turnStore 的服务端投影（`session.turn` / 会话详情 `turns`），
 *   刷新后由同一恢复路径重新挂载，不在本地保存审批请求；
 * - 三档：`once`（默认）/ `task`（需会话绑定任务）/ `workspace`（首版仅只读工具）；
 *   不可用档位保持可见但置灰，并用 tooltip + 可见说明给出原因，不渲染「点了会 403」的按钮；
 * - 键盘：方向键切档、Esc = 拒绝、Tab 在弹窗内循环、打开时焦点落在当前档位；
 * - allow / deny 只提交决策，不触发重试或整轮重发（单步重试归 CHAT-RETRY2）。
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation } from '@tanstack/react-query';
import type { ApprovalScope, SessionTurn, TurnApprovalInfo } from '@agentboard/shared';
import { api } from '../../api/client';
import { applyServerTurn } from '../../state/turnStore';
import { approvalFailureText } from '../../lib/turnView';

/** 与服务端 `APPROVAL_READ_ONLY_TOOLS` 同口径；最终判定仍由服务端 403 兜底 */
const READ_ONLY_TOOLS = ['read', 'grep', 'list'];

const TIER_ORDER: ApprovalScope[] = ['once', 'task', 'workspace'];

const TIER_LABEL: Record<ApprovalScope, string> = {
  once: '仅本次',
  task: '本任务',
  workspace: '本工作区',
};

const TIER_HINT: Record<ApprovalScope, string> = {
  once: '只批准这一次调用，不生成规则。',
  task: '任务结束前，同类调用自动放行。',
  workspace: '本工作区内的同类只读调用自动放行。',
};

export function isReadOnlyApprovalTool(tool: string): boolean {
  return READ_ONLY_TOOLS.includes(tool.trim().toLowerCase());
}

/** 各档不可用原因（null = 可选）；「写类工具 + 工作区」与「未绑定任务 + 本任务」都由服务端兜底拒绝 */
export function approvalTierDisabledReason(
  scope: ApprovalScope,
  tool: string,
  hasTaskBinding: boolean,
): string | null {
  if (scope === 'task' && !hasTaskBinding) return '当前会话未绑定任务，本任务档不可用';
  if (scope === 'workspace' && !isReadOnlyApprovalTool(tool)) {
    return '写类工具暂不支持工作区档：需先提供撤销入口';
  }
  return null;
}

/** dialog 内可 Tab 到达的元素（与 Modal 同口径） */
const TABBABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])';

export function ApprovalDialog({
  sessionId,
  turnId,
  approval,
  hasTaskBinding,
}: {
  sessionId: string;
  turnId: string;
  approval: TurnApprovalInfo;
  /** 会话是否绑定任务：决定「本任务」档是否可选 */
  hasTaskBinding: boolean;
}) {
  const [selected, setSelected] = useState<ApprovalScope>('once');
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const tierRefs = useRef<Partial<Record<ApprovalScope, HTMLInputElement | null>>>({});

  const decide = useMutation({
    mutationFn: (input: { decision: 'allow' | 'deny'; scope: ApprovalScope }) =>
      api.post<{ turn: SessionTurn }>(
        `/api/sessions/${sessionId}/turns/${turnId}/approvals/${approval.request_id}`,
        input,
      ),
    onSuccess: (res) => {
      setError(null);
      // 决策响应里的整轮立即回填：running → 弹窗随之卸载；deny → stopped（ChatPanel 展示停止提示）
      applyServerTurn(res.turn);
    },
    onError: (e) => setError(approvalFailureText(e)),
  });

  // 键盘监听写在 window 上：焦点万一被鼠标带走仍能响应 Esc / 方向键 / Tab 循环
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const pendingRef = useRef(decide.isPending);
  pendingRef.current = decide.isPending;
  const decideRef = useRef(decide);
  decideRef.current = decide;
  const disabledReasonRef = useRef<Record<ApprovalScope, string | null>>({
    once: null,
    task: null,
    workspace: null,
  });
  disabledReasonRef.current = {
    once: approvalTierDisabledReason('once', approval.tool, hasTaskBinding),
    task: approvalTierDisabledReason('task', approval.tool, hasTaskBinding),
    workspace: approvalTierDisabledReason('workspace', approval.tool, hasTaskBinding),
  };

  // 打开时焦点落在当前档位（默认「仅本次」）
  useEffect(() => {
    tierRefs.current.once?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (pendingRef.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        decideRef.current.mutate({ decision: 'deny', scope: 'once' });
        return;
      }
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        const enabled = TIER_ORDER.filter((scope) => disabledReasonRef.current[scope] === null);
        if (enabled.length === 0) return;
        const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
        const current = enabled.indexOf(selectedRef.current);
        const next = enabled[(current + delta + enabled.length) % enabled.length]!;
        setSelected(next);
        tierRefs.current[next]?.focus();
        return;
      }
      if (event.key !== 'Tab') return;
      const root = dialogRef.current;
      if (root === null) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR));
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !root.contains(active)) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const reasonFor = (scope: ApprovalScope): string | null =>
    approvalTierDisabledReason(scope, approval.tool, hasTaskBinding);

  const overlay = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="approval-dialog-overlay"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-dialog-title"
        data-testid="approval-dialog"
        className="w-full max-w-lg rounded-lg border border-hairline bg-surface-card p-5 text-ink shadow-xl"
      >
        <h2 id="approval-dialog-title" className="text-base font-semibold">
          工具调用需要确认
        </h2>
        <dl className="mt-3 space-y-1 text-xs" data-testid="approval-details">
          <div className="flex gap-2">
            <dt className="w-10 shrink-0 text-ink-3">工具</dt>
            <dd data-testid="approval-tool" className="min-w-0 break-all font-medium">
              {approval.tool}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-10 shrink-0 text-ink-3">目标</dt>
            <dd data-testid="approval-target" className="min-w-0 break-all text-ink-2">
              {approval.target}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-10 shrink-0 text-ink-3">风险</dt>
            <dd data-testid="approval-risk" className="min-w-0 break-all text-ink-2">
              {approval.risk}
            </dd>
          </div>
        </dl>
        <p data-testid="approval-irreversible" className="mt-2 text-xs text-red-600 dark:text-red-400">
          批准后该调用会立即执行，无法撤销；请核对工具与目标。
        </p>

        <div role="radiogroup" aria-label="审批生效范围" className="mt-3 space-y-1.5">
          {TIER_ORDER.map((scope) => {
            const reason = reasonFor(scope);
            const disabled = reason !== null;
            return (
              <label
                key={scope}
                title={reason ?? TIER_HINT[scope]}
                data-testid={`approval-tier-${scope}`}
                className={`flex cursor-pointer items-start gap-2 rounded border px-2.5 py-1.5 text-xs ${
                  selected === scope ? 'border-accent bg-accent-soft' : 'border-hairline'
                } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
              >
                <input
                  ref={(el) => {
                    tierRefs.current[scope] = el;
                  }}
                  type="radio"
                  name="approval-scope"
                  data-testid={`approval-tier-input-${scope}`}
                  value={scope}
                  checked={selected === scope}
                  disabled={disabled}
                  onChange={() => setSelected(scope)}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block font-medium">{TIER_LABEL[scope]}</span>
                  <span
                    data-testid={`approval-tier-hint-${scope}`}
                    className={disabled ? 'block text-red-600 dark:text-red-400' : 'block text-ink-3'}
                  >
                    {reason ?? TIER_HINT[scope]}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        <p className="mt-2 text-[10px] text-ink-3">
          规则档可在会话头「⋯ → 审批规则」中撤销；Esc 等同于拒绝，方向键切换档位。
        </p>

        {error !== null && (
          <p data-testid="approval-error" role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            data-testid="approval-deny"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ decision: 'deny', scope: 'once' })}
            className="rounded border border-red-300 px-3 py-1 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            拒绝
          </button>
          <button
            type="button"
            data-testid="approval-allow"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ decision: 'allow', scope: selected })}
            className="rounded bg-accent px-3 py-1 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
          >
            {decide.isPending ? '提交中…' : `允许（${TIER_LABEL[selected]}）`}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
