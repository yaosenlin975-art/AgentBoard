/**
 * DEC-V4-BLOCKS（P6）：决策卡统计行的「阻塞 N 个下游」入口 + 就地清单。
 *
 * 方向固定为「本卡 blocks 了谁」，与卡角标的「等 N 项」（谁挡住了我）措辞故意不复用。
 * 数据只在展开时按需拉 `GET /api/issues/:id/dependencies?depth=2` 的 `blocked[]`，
 * 不把下游明细塞进列表投影；占用者 / 原因 / 间接层全部取服务端 P1B 投影，前端不编造。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getIssueDependencies } from '../../api/endpoints';
import type { DependencyRef } from '../../lib/dependency';
import { isClosed, useWorkspaceStatuses } from '../../lib/workspaceStatuses';

/** 超过 6 张下游才出现筛选框（设计 §3.4） */
export const BLOCKED_FILTER_THRESHOLD = 6;
/** 列表内部滚动高度（设计 §3.4：max-height 268px） */
export const BLOCKED_LIST_MAX_HEIGHT = 268;

export function shortIssueCode(issueId: string): string {
  return issueId.slice(0, 8);
}

function statusChipClass(status: string, closed: boolean): string {
  if (status === '进行中') return 'border-accent text-accent';
  if (status === '待验收') return 'border-green-600 text-green-700 dark:text-green-400';
  if (closed) return 'border-hairline text-ink-3';
  return 'border-amber-500 text-amber-700 dark:text-amber-300';
}

function matches(item: DependencyRef, keyword: string): boolean {
  if (keyword === '') return true;
  const haystack = [
    item.issue_id,
    shortIssueCode(item.issue_id),
    item.title,
    item.claimed_by ?? '',
    item.blocked_reason ?? '',
  ];
  return haystack.some((value) => value.toLowerCase().includes(keyword));
}

function DownstreamRow({
  item,
  onOpenIssue,
  closed,
}: {
  item: DependencyRef;
  onOpenIssue: (issueId: string) => void;
  closed: boolean;
}) {
  return (
    <li
      data-testid={`blocked-downstream-row-${item.issue_id}`}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-x-2 gap-y-0.5 border-b border-hairline px-1.5 py-1 text-xs last:border-b-0"
    >
      <button
        type="button"
        data-testid={`blocked-downstream-id-${item.issue_id}`}
        title={`完整 UUID：${item.issue_id}（点击打开详情）`}
        onClick={() => onOpenIssue(item.issue_id)}
        className="shrink-0 rounded font-mono text-xs tabular-nums text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        {shortIssueCode(item.issue_id)}
      </button>
      <span className="min-w-0 truncate text-ink" title={item.title}>
        {item.title}
      </span>
      <span className={`shrink-0 rounded border px-1 text-[11px] ${statusChipClass(item.status, closed)}`}>{item.status}</span>
      <span
        data-testid={`blocked-downstream-owner-${item.issue_id}`}
        className="max-sm:hidden min-w-0 max-w-[6rem] shrink-0 truncate text-ink-3"
        title={item.claimed_by ?? '未派工'}
      >
        {item.claimed_by ?? '未派工'}
      </span>
      <button
        type="button"
        data-testid={`blocked-downstream-jump-${item.issue_id}`}
        aria-label={`打开下游卡 ${item.title}`}
        onClick={() => onOpenIssue(item.issue_id)}
        className="shrink-0 rounded border border-hairline px-1 text-[11px] text-ink-2 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        ↗
      </button>
      <span
        data-testid={`blocked-downstream-reason-${item.issue_id}`}
        className="col-span-full text-[11px] text-ink-3"
      >
        {item.depth === 2 && item.via !== null && <span className="mr-1">经 {shortIssueCode(item.via)} 转手 · </span>}
        {item.blocked_reason === null || item.blocked_reason === '' ? '未记录原因' : item.blocked_reason}
      </span>
    </li>
  );
}

export interface BlockedDownstreamProps {
  issueId: string;
  /** 决策所属工作区：依赖端点按工作区路由数据库 */
  workspaceId: string;
  /** 列表投影的直接下游数（按钮文案）；真实明细展开后再拉 */
  count: number;
  /** DEC-JUMP-WS：下游卡与决策同库，打开前先切到该工作区 */
  onOpenIssue: (issueId: string, issueWorkspaceId: string) => void;
}

export function BlockedDownstream({ issueId, workspaceId, count, onOpenIssue }: BlockedDownstreamProps) {
  const { byName } = useWorkspaceStatuses(workspaceId);
  const isItemClosed = (status: string): boolean => isClosed(status, byName.get(status)?.kind);
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [indirectOpen, setIndirectOpen] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['dependencies', issueId, 'downstream-depth2'],
    queryFn: () => getIssueDependencies(issueId, workspaceId, 2),
    enabled: open,
  });

  const blocked = data?.blocked ?? [];
  const direct = blocked.filter((item) => (item.depth ?? 1) === 1);
  const indirect = blocked.filter((item) => item.depth === 2);
  const trimmed = keyword.trim().toLowerCase();
  const visibleDirect = direct.filter((item) => matches(item, trimmed));
  const visibleIndirect = indirect.filter((item) => matches(item, trimmed));
  const needsFilter = direct.length > BLOCKED_FILTER_THRESHOLD;
  const noDownstream = !isLoading && error === null && direct.length === 0 && indirect.length === 0;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        data-testid={`decision-blocks-${issueId}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`self-start whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
          count > 0
            ? 'border-hairline text-ink-2 hover:bg-surface-raised'
            : 'border-hairline text-ink-3 hover:bg-surface-raised'
        }`}
      >
        {count > 0 ? `阻塞 ${count} 个下游` : '无下游阻塞'}
      </button>

      {open && (
        <div
          data-testid={`blocked-downstream-panel-${issueId}`}
          className="flex min-w-0 flex-col gap-1 rounded border border-hairline bg-surface-raised/40 p-1.5"
        >
          <div className="flex flex-col gap-0.5">
            <h4 className="text-xs font-medium text-ink">本卡 blocks 的下游</h4>
            <p className="text-[11px] text-ink-3">方向：这张卡 → 下游</p>
            <p className="text-[11px] text-ink-3">列的是「这张卡挡住了谁」，不是「谁挡住了这张卡」。</p>
          </div>

          {isLoading && <p className="px-1 py-1 text-[11px] text-ink-3">加载中…</p>}
          {error !== null && (
            <p data-testid={`blocked-downstream-error-${issueId}`} className="px-1 py-1 text-[11px] text-red-600 dark:text-red-400">
              下游清单加载失败，请稍后重试
            </p>
          )}
          {noDownstream && (
            <p data-testid={`blocked-downstream-empty-${issueId}`} className="px-1 py-1 text-[11px] text-ink-3">
              这张卡目前没有 blocks 任何下游：没有别的卡因为它被挡住。
            </p>
          )}

          {needsFilter && !isLoading && error === null && (
            <input
              type="search"
              data-testid={`blocked-downstream-filter-${issueId}`}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="筛选卡号 / 标题 / 占用者 / 原因"
              aria-label="筛选下游卡"
              className="w-full rounded border border-hairline bg-surface-card px-1.5 py-0.5 text-[11px] text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            />
          )}

          {visibleDirect.length > 0 && (
            <ul
              data-testid={`blocked-downstream-list-${issueId}`}
              role="list"
              style={{ maxHeight: BLOCKED_LIST_MAX_HEIGHT, overflowY: 'auto' }}
              className="flex flex-col"
            >
              {visibleDirect.map((item) => (
                <DownstreamRow key={`direct-${item.issue_id}`} item={item} onOpenIssue={(id) => onOpenIssue(id, workspaceId)} closed={isItemClosed(item.status)} />
              ))}
            </ul>
          )}

          {!isLoading && error === null && needsFilter && visibleDirect.length === 0 && !noDownstream && (
            <p className="px-1 py-1 text-[11px] text-ink-3">没有匹配的下游卡</p>
          )}

          {indirect.length > 0 && (
            <div className="flex flex-col gap-1">
              <button
                type="button"
                data-testid={`blocked-downstream-indirect-toggle-${issueId}`}
                aria-expanded={indirectOpen}
                onClick={() => setIndirectOpen((value) => !value)}
                className="self-start whitespace-nowrap rounded border border-hairline px-1.5 py-0.5 text-[11px] text-ink-2 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              >
                间接下游 {indirect.length} 张（经 1 层转手）
              </button>
              {indirectOpen && (
                <ul
                  data-testid={`blocked-downstream-indirect-${issueId}`}
                  role="list"
                  style={{ maxHeight: BLOCKED_LIST_MAX_HEIGHT, overflowY: 'auto' }}
                  className="flex flex-col"
                >
                  {visibleIndirect.map((item) => (
                    <DownstreamRow key={`indirect-${item.issue_id}`} item={item} onOpenIssue={(id) => onOpenIssue(id, workspaceId)} closed={isItemClosed(item.status)} />
                  ))}
                </ul>
              )}
            </div>
          )}

          <p className="border-t border-hairline pt-1 text-[10.5px] leading-snug text-ink-3">
            关系来自 <code>GET /api/issues/:id/dependencies</code> 的 <code>blocked[]</code>；占用者 / 原因来自服务端投影。
          </p>
        </div>
      )}
    </div>
  );
}
