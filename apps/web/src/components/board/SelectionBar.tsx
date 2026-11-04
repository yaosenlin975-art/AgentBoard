/**
 * 两段式选择条（BORROW-1.1）：第一段选范围（整个看板 / 某一列），第二段在范围内勾卡。
 * 批量操作复用现有 PATCH /api/issues/:id（逐张），不新增服务端契约。
 */
import { useEffect, useState } from 'react';
import type { SelectionScope } from '../../lib/selection';
import { scopeLabel } from '../../lib/selection';

export function SelectionBar({
  columns,
  scope,
  scopeCount,
  selectedCount,
  statusNames,
  busy,
  onPickScope,
  onSelectAll,
  onClearSelection,
  onBatchStatus,
  onClose,
}: {
  columns: readonly string[];
  scope: SelectionScope | null;
  scopeCount: number;
  selectedCount: number;
  statusNames: readonly string[];
  busy: boolean;
  onPickScope: (scope: SelectionScope) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onBatchStatus: (status: string) => void;
  onClose: () => void;
}) {
  const [batchStatus, setBatchStatus] = useState<string>('');

  useEffect(() => {
    setBatchStatus('');
  }, [scope]);

  return (
    <div
      data-testid="selection-bar"
      className="flex flex-wrap items-center gap-2 border-b border-hairline bg-surface-raised px-3 py-2 text-xs text-ink-2"
    >
      <span className="font-medium text-ink">批量选择</span>
      {scope === null ? (
        <>
          <span data-testid="selection-stage" className="text-ink-3">第 1 步：选择范围</span>
          <button
            type="button"
            data-testid="selection-scope-board"
            onClick={() => onPickScope({ kind: 'board' })}
            className="rounded border border-hairline px-2 py-0.5 hover:bg-surface-card"
          >
            整个看板
          </button>
          {columns.map((status) => (
            <button
              key={status}
              type="button"
              data-testid={`selection-scope-column-${status}`}
              onClick={() => onPickScope({ kind: 'column', status })}
              className="rounded border border-hairline px-2 py-0.5 hover:bg-surface-card"
            >
              {status}
            </button>
          ))}
        </>
      ) : (
        <>
          <span data-testid="selection-stage" className="text-ink-3">
            第 2 步：在范围内选卡 · {scopeLabel(scope)}
          </span>
          <span data-testid="selection-count" className="tabular-nums text-ink">
            已选 {selectedCount} / {scopeCount}
          </span>
          <button
            type="button"
            data-testid="selection-select-all"
            onClick={onSelectAll}
            className="rounded border border-hairline px-2 py-0.5 hover:bg-surface-card"
          >
            {selectedCount === scopeCount && scopeCount > 0 ? '取消全选' : '全选范围'}
          </button>
          <button
            type="button"
            data-testid="selection-clear"
            onClick={onClearSelection}
            disabled={selectedCount === 0}
            className="rounded border border-hairline px-2 py-0.5 hover:bg-surface-card disabled:opacity-40"
          >
            清空
          </button>
          <select
            aria-label="批量移动到状态"
            data-testid="selection-batch-status"
            value={batchStatus}
            onChange={(event) => setBatchStatus(event.target.value)}
            className="rounded border border-hairline bg-surface-card px-2 py-0.5"
          >
            <option value="">移动到状态…</option>
            {statusNames.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
          <button
            type="button"
            data-testid="selection-batch-apply"
            disabled={busy || selectedCount === 0 || batchStatus === ''}
            onClick={() => onBatchStatus(batchStatus)}
            className="rounded border border-accent bg-accent-soft px-2 py-0.5 font-medium text-accent disabled:opacity-40"
          >
            {busy ? '处理中…' : '应用'}
          </button>
        </>
      )}
      <button
        type="button"
        data-testid="selection-close"
        onClick={onClose}
        className="ml-auto rounded px-2 py-0.5 text-ink-3 hover:bg-surface-card"
      >
        退出选择
      </button>
    </div>
  );
}
