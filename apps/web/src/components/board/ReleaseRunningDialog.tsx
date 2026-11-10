/**
 * REL-2：「进行中」列头救火键的预览弹窗。
 *
 * 流程（与卡面验收一致）：
 * 1. 打开即调用 REL-1 的 `POST /api/workspaces/:id/release-running` 且 `dry_run: true`，
 *    用服务端下发的 released / skipped 作为唯一真源（不在前端自己猜租约）。
 * 2. 安全区（released = 无主或租约已过期）默认勾选；新鲜租约（LEASE_ACTIVE）默认不勾、可显式勾；
 *    有主但无租约（UNDETERMINED）只做提示，不进清单。
 * 3. 主按钮文案「退回 N 张到待规划」，N 随勾选实时变化；mode=all 必须显式勾选确认才可点。
 * 4. 成功后把服务端返回的 issue 就地在写进 ['issues', workspaceId] 缓存（不等 WS 帧），
 *    并回调 onReleased 让看板提供「仅看本次退回」入口。
 *
 * 预览清单列：短 id（8 位）｜title｜占用者｜静默分钟（按 claimed_at 计）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Issue } from '@agentboard/shared';
import { api } from '../../api/client';
import { Modal } from '../ui/Modal';

interface ReleaseRunningResult {
  released: Issue[];
  skipped: Array<{ id: string; reason: string }>;
}

const BODY = 'space-y-3 text-sm';

function shortId(id: string): string {
  return id.slice(0, 8);
}

function silentMinutes(issue: Issue, now: number): string {
  if (issue.claimed_by === null || issue.claimed_at === null) return '—';
  return String(Math.max(0, Math.round((now - issue.claimed_at) / 60000)));
}

export function ReleaseRunningDialog({
  open,
  workspaceId,
  issues,
  onClose,
  onReleased,
}: {
  open: boolean;
  workspaceId: string;
  /** 当前看板里的任务（用于补全 skipped 行的标题/占用者；缺失时退化为短 id） */
  issues: Issue[];
  onClose: () => void;
  onReleased: (released: Issue[]) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReleaseRunningResult | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [mode, setMode] = useState<'expired' | 'all'>('expired');
  const [confirmAll, setConfirmAll] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const now = Date.now();

  const byId = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues]);

  const loadPreview = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.post<ReleaseRunningResult>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/release-running`,
        { mode: 'expired', dry_run: true },
      );
      setPreview(result);
      setSelected(new Set(result.released.map((issue) => issue.id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : '预检失败');
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  // 每次打开都重新预检（上一轮退回后列表已经变了）
  useEffect(() => {
    if (!open) return;
    setMode('expired');
    setConfirmAll(false);
    void loadPreview();
  }, [open, loadPreview]);

  const leaseActiveIds = useMemo(
    () => (preview?.skipped ?? []).filter((s) => s.reason === 'LEASE_ACTIVE').map((s) => s.id),
    [preview],
  );
  const undeterminedIds = useMemo(
    () => (preview?.skipped ?? []).filter((s) => s.reason === 'UNDETERMINED').map((s) => s.id),
    [preview],
  );

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const count = mode === 'all' ? issues.filter((i) => i.status === '进行中').length : selected.size;
  const submitDisabled = submitting || count === 0 || (mode === 'all' && !confirmAll);

  const submit = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      const body =
        mode === 'all'
          ? { mode: 'all' }
          : { mode: 'expired', issue_ids: [...selected] };
      const result = await api.post<ReleaseRunningResult>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/release-running`,
        body,
      );
      onReleased(result.released);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '退回失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  const row = (id: string, checked: boolean, manuallyPickable: boolean) => {
    const issue = byId.get(id);
    return (
      <li key={id} data-testid={`release-row-${id}`} className="flex items-start gap-2 border-t border-hairline py-1.5">
        <input
          type="checkbox"
          aria-label={`选择任务 ${id}`}
          checked={checked}
          onChange={() => toggle(id)}
          className="mt-0.5"
          data-testid={`release-check-${id}`}
        />
        <span className="shrink-0 font-mono text-xs text-ink-3">{shortId(id)}</span>
        <span className="min-w-0 flex-1 truncate" title={issue?.title ?? id}>{issue?.title ?? '（不在当前列表）'}</span>
        <span className="shrink-0 text-xs text-ink-3" title="占用者">{issue?.claimed_by ?? '无主'}</span>
        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-ink-3" title="静默分钟">
          {issue === undefined ? '—' : silentMinutes(issue, now)}
        </span>
        {manuallyPickable && <span className="shrink-0 text-xs text-accent" title="租约未过期，勾选后仍强制退回">租约生效</span>}
      </li>
    );
  };

  return (
    <Modal open={open} title="退回运行中任务" onClose={onClose}>
      <div className={BODY} data-testid="release-running-dialog">
        {loading && <p className="text-ink-3" data-testid="release-loading">正在预检…</p>}
        {error !== null && (
          <p className="text-red-600 dark:text-red-400" data-testid="release-error">{error}</p>
        )}
        {!loading && preview !== null && (
          <div className="space-y-2">
            <p className="text-ink-3" data-testid="release-summary">
              安全退回 {preview.released.length} 张；租约生效 {leaseActiveIds.length} 张（默认不勾选）
              {undeterminedIds.length > 0 && `；无法判定 ${undeterminedIds.length} 张（不参与退回）`}
            </p>
            {preview.released.length === 0 && leaseActiveIds.length === 0 && (
              <p className="text-ink-3" data-testid="release-empty">没有可退回的任务。</p>
            )}
            <ul className="max-h-64 overflow-y-auto" data-testid="release-list">
              {preview.released.map((issue) => row(issue.id, selected.has(issue.id), false))}
              {leaseActiveIds.map((id) => row(id, selected.has(id), true))}
            </ul>
            <label className="flex items-center gap-2 text-xs text-ink-2">
              <input
                type="radio"
                name="release-mode"
                checked={mode === 'expired'}
                onChange={() => setMode('expired')}
                data-testid="release-mode-expired"
              />
              仅退回过期 / 无主（mode=expired）
            </label>
            <label className="flex items-center gap-2 text-xs text-ink-2">
              <input
                type="radio"
                name="release-mode"
                checked={mode === 'all'}
                onChange={() => setMode('all')}
                data-testid="release-mode-all"
              />
              全部退回（mode=all，含租约生效与无法判定的卡）
            </label>
            {mode === 'all' && (
              <label className="flex items-center gap-2 rounded border border-hairline px-2 py-1 text-xs text-ink-2" data-testid="release-confirm-all">
                <input
                  type="checkbox"
                  checked={confirmAll}
                  onChange={(e) => setConfirmAll(e.target.checked)}
                  data-testid="release-confirm-all-check"
                />
                我确认本区所有执行会话已中断
              </label>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-hairline px-3 py-1 text-sm text-ink-2 hover:bg-surface-raised"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="release-submit"
            disabled={submitDisabled}
            onClick={() => void submit()}
            className="rounded bg-accent px-3 py-1 text-sm font-medium text-accent-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? '退回中…' : `退回 ${count} 张到待规划`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
