/**
 * DEC-6 / DEC-V4-QUEUE：待决策处置队列（设计 v3 §3.7 方案 A + §4 队列排序）。
 *
 * 四段：宽限中（秒级倒计时 + 「立即回答」主按钮）/ 未回答 / 已超时（锁后 72h+）/ 最近已回答（24h）。
 * - 页头只保留标题 + 在途总数徽标；状态用筛选 tab（计数来自完整分组，不受当前 tab 影响）。
 * - 三种排序：紧急度（默认）/ 等待最久 / 任务优先级；rank 只在 grace/open/stale 连续编号，切 tab 后重排。
 * - 数据：`/api/decisions`（在途默认口径）+ `state=answered`；徽标数来自 count 端点（SideBar）。
 * - 深链：`navStore.focusDecision(id)` 选中并滚动到该条；宽限到期本地先移入「未回答」，
 *   再按 `grace_until` 定时失效重取，等 ticker 落锁后服务端状态转正。
 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '../../state/appStore';
import { useNavStore } from '../../state/navStore';
import { usePanelStore } from '../../state/panelStore';
import { useDecisionClock } from './clock';
import {
  DECISION_SORTS,
  DECISION_SORT_LABELS,
  groupDecisions,
  type DecisionSort,
} from './countdown';
import { DecisionCard } from './DecisionCard';
import { useDecisionLists } from './useDecisions';
import type { DecisionListItemDto } from './types';

type DecisionFilter = 'all' | 'grace' | 'open' | 'stale' | 'answered';
type DecisionLayer = Exclude<DecisionFilter, 'all' | 'answered'>;

const FILTERS: ReadonlyArray<{ key: DecisionFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'grace', label: '宽限中' },
  { key: 'open', label: '待回答' },
  { key: 'stale', label: '已超时' },
  { key: 'answered', label: '已回答' },
];
const LAYERS: readonly DecisionLayer[] = ['grace', 'open', 'stale'];

export function DecisionsView() {
  const workspaceId = useAppStore((state) => state.workspaceId);
  const focus = useNavStore((state) => state.decisionFocus);
  const openDetail = usePanelStore((state) => state.openDetail);
  const queryClient = useQueryClient();
  const now = useDecisionClock();
  const { active, answered, loading } = useDecisionLists(workspaceId);
  const [filter, setFilter] = useState<DecisionFilter>('all');
  const [sort, setSort] = useState<DecisionSort>('urgency');
  // DEC-V4-INLINE：同一时刻只展开一条，展开后由详细卡替换 chip 行
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const groups = groupDecisions(active, answered, now, sort);
  const toggleExpanded = (decisionId: string) => {
    setExpandedId((current) => (current === decisionId ? null : decisionId));
  };

  // 宽限到期后补一次重取（服务端 ticker 落锁 → 状态转 open，`issue.changed` 也会刷新卡面）
  const nearestGraceUntil = groups.grace[0]?.grace_until ?? null;
  useEffect(() => {
    if (nearestGraceUntil === null) return;
    const delay = Math.max(400, nearestGraceUntil - Date.now() + 500);
    const timer = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ['decisions'] });
    }, delay);
    return () => clearTimeout(timer);
  }, [nearestGraceUntil, queryClient]);

  if (workspaceId === null) {
    return (
      <section data-testid="decisions-view" className="flex h-full items-center justify-center text-sm text-ink-3">
        请先选择工作空间
      </section>
    );
  }

  const total = groups.grace.length + groups.open.length + groups.stale.length;
  const tabCounts: Record<DecisionFilter, number> = {
    all: total + groups.answered.length,
    grace: groups.grace.length,
    open: groups.open.length,
    stale: groups.stale.length,
    answered: groups.answered.length,
  };
  const visibleLayers: readonly DecisionLayer[] = filter === 'all' ? LAYERS : filter === 'answered' ? [] : [filter];
  const rankMap = new Map<string, number>();
  let rank = 0;
  for (const layer of visibleLayers) {
    for (const item of groups[layer]) rankMap.set(item.id, ++rank);
  }

  return (
    <section data-testid="decisions-view" className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline px-3 py-2">
        <h1 className="text-sm font-semibold text-ink">待决策</h1>
        <span
          data-testid="decisions-total"
          title={`当前范围内共 ${total} 条`}
          className="rounded-full bg-surface-raised px-2 text-xs font-medium tabular-nums text-ink-2"
        >
          {total}
        </span>

        <div role="tablist" aria-label="按状态筛选" className="flex flex-wrap items-center gap-1">
          {FILTERS.map(({ key, label }) => {
            const selected = filter === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={selected}
                data-testid={`decisions-tab-${key}`}
                onClick={() => setFilter(key)}
                className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-xs transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                  selected ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2 hover:bg-surface-raised'
                }`}
              >
                {label}
                <span data-testid={`decisions-tab-count-${key}`} className="tabular-nums text-ink-3">
                  {tabCounts[key]}
                </span>
              </button>
            );
          })}
        </div>

        <label className="ml-auto flex items-center gap-1 text-xs text-ink-3">
          排序
          <select
            data-testid="decisions-sort"
            value={sort}
            onChange={(event) => setSort(event.target.value as DecisionSort)}
            className="rounded-md border border-hairline bg-surface-card px-1.5 py-0.5 text-xs text-ink-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            {DECISION_SORTS.map((key) => (
              <option key={key} value={key}>
                {DECISION_SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {loading && <p className="px-1 py-2 text-xs text-ink-3">加载中…</p>}
        {!loading && total === 0 && groups.answered.length === 0 && (
          <p data-testid="decisions-empty" className="px-1 py-3 text-xs text-ink-3">
            暂无待决策
          </p>
        )}

        {(filter === 'all' || filter === 'grace') && (
          <Group
            scope="grace"
            title="宽限中"
            empty="无"
            items={groups.grace}
            now={now}
            focus={focus}
            rankMap={rankMap}
            expandedId={expandedId}
            onToggle={toggleExpanded}
            onOpen={openDetail}
          />
        )}
        {(filter === 'all' || filter === 'open') && (
          <Group
            scope="open"
            title="未回答"
            empty="无"
            items={groups.open}
            now={now}
            focus={focus}
            rankMap={rankMap}
            expandedId={expandedId}
            onToggle={toggleExpanded}
            onOpen={openDetail}
          />
        )}
        {(filter === 'all' || filter === 'stale') && (
          <Group
            scope="stale"
            title="已超时"
            empty="无"
            items={groups.stale}
            now={now}
            focus={focus}
            rankMap={rankMap}
            expandedId={expandedId}
            onToggle={toggleExpanded}
            onOpen={openDetail}
          />
        )}
        {(filter === 'all' || filter === 'answered') && (
          <Group
            scope="answered"
            title="最近已回答"
            empty="无（保留 24 小时）"
            items={groups.answered}
            now={now}
            focus={focus}
            rankMap={rankMap}
            expandedId={expandedId}
            onToggle={toggleExpanded}
            onOpen={openDetail}
          />
        )}
      </div>
    </section>
  );
}

interface GroupProps {
  scope: 'grace' | 'open' | 'stale' | 'answered';
  title: string;
  empty: string;
  items: DecisionListItemDto[];
  now: number;
  focus: string | null;
  rankMap: ReadonlyMap<string, number>;
  expandedId: string | null;
  onToggle: (decisionId: string) => void;
  onOpen: (issueId: string) => void;
}

function Group({ scope, title, empty, items, now, focus, rankMap, expandedId, onToggle, onOpen }: GroupProps) {
  return (
    <div data-testid={`decisions-group-${scope}`} className="mb-4">
      <h2 className="flex items-baseline gap-2 px-1 pb-1 text-xs font-medium text-ink-2">
        <span>{title}</span>
        <span className="tabular-nums text-ink-3">{items.length}</span>
      </h2>
      {items.length === 0 ? (
        <p className="px-1 py-1 text-xs text-ink-3">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-1" role="list">
          {items.map((item) => (
            <DecisionCard
              key={item.id}
              item={item}
              now={now}
              rank={rankMap.get(item.id)}
              focused={focus === item.id}
              scope={scope}
              expanded={expandedId === item.id}
              onToggle={onToggle}
              onOpenIssue={onOpen}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
