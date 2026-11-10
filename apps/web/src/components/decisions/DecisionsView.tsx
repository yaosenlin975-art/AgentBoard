/**
 * DEC-6 / DEC-V4-QUEUE：待决策处置队列（设计 v3 §3.7 方案 A + §4 队列排序）。
 *
 * 四段：宽限中（秒级倒计时 + 「立即回答」主按钮）/ 未回答 / 已超时（锁后 72h+）/ 最近已回答（24h）。
 * - 页头只保留标题 + 在途总数徽标；状态用筛选 tab（计数来自完整分组，不受当前 tab 影响）。
 * - 三种排序：紧急度（默认）/ 等待最久 / 任务优先级；rank 只在 grace/open/stale 连续编号，切 tab 后重排。
 * - 数据：`/api/decisions`（在途默认口径）+ `state=answered`；侧栏徽标复用同一 active 列表与分组（DEC-BADGE）。
 * - 深链：`navStore.focusDecision(id)` 选中并滚动到该条；宽限到期本地先移入「未回答」，
 *   再按 `grace_until` 定时失效重取，等 ticker 落锁后服务端状态转正。
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Workspace } from '@agentboard/shared';
import { api } from '../../api/client';
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
import { DecisionCard, type DecisionAnsweredPayload } from './DecisionCard';
import { DecisionsEmptyState } from './DecisionsEmptyState';
import { useDecisionLists, useUndoDecision } from './useDecisions';
import { setDecisionsScope, type DecisionsScope } from '../../lib/decisionsScope';
import { useDecisionsScope } from '../../state/useDecisionsScope';
import { ApiError } from '../../api/client';
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

/** P8：reduced motion 下不播放闪烁，只保留高亮边框 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** DEC-V4-UNDO：提交后的视觉移出时长（reduced motion 直接 0） */
const LEAVING_MS = 420;
/** 结果提示（已撤销 / 409 文案）自动收起时长 */
const UNDO_RESULT_TIMEOUT_MS = 8000;

interface UndoBarState {
  decisionId: string;
  issueTitle: string;
  /** answer 响应里的 `answer_revision`，撤销时作为 expected_revision */
  revision: number;
  by: string;
  /** 服务端 `undo_until`（毫秒）；倒计时唯一依据 */
  deadline: number;
  /** PERM-3：能力驱动的撤销入口开关 */
  canUndo: boolean;
  phase: 'ready' | 'pending' | 'failed' | 'done';
  tone: 'info' | 'error';
  message: string | null;
}

/** DEC-V4-UNDO：409 各自文案，不一律「操作失败」；retry 只在网络/5xx 时保留重试入口 */
function classifyUndoError(err: unknown): { message: string; retry: boolean } {
  if (err instanceof ApiError) {
    if (err.status === 401) return { message: '身份失效，请重新打开看板', retry: false };
    if (err.code === 'ROLE_FORBIDDEN' || err.code === 'WORKSPACE_FORBIDDEN') {
      return { message: '没有撤销该回答的权限', retry: false };
    }
    switch (err.code) {
      case 'UNDO_WINDOW_EXPIRED':
        return { message: '撤销窗口已过（回答后 6 秒内可撤销）', retry: false };
      case 'UNDO_CLAIMED_AFTER_LOCK':
        return { message: '卡已被重新领取，无法撤销', retry: false };
      case 'DECISION_REVISION_CONFLICT':
        return { message: `答案版本已变化，无法撤销：${err.message}`, retry: false };
      case 'UNDO_NOT_ANSWERED':
      case 'DECISION_WITHDRAWN':
      case 'UNDO_FORBIDDEN_ACTOR':
        return { message: err.message, retry: false };
      default:
        return { message: `撤销失败：${err.message}`, retry: err.status >= 500 };
    }
  }
  return { message: '撤销失败：网络异常，请重试', retry: true };
}

export function DecisionsView() {
  const workspaceId = useAppStore((state) => state.workspaceId);
  const focus = useNavStore((state) => state.decisionFocus);
  const setView = useNavStore((state) => state.setView);
  const focusIssue = useNavStore((state) => state.focusIssue);
  const selectWorkspace = useAppStore((state) => state.selectWorkspace);
  const openDetail = usePanelStore((state) => state.openDetail);
  const queryClient = useQueryClient();
  const now = useDecisionClock();
  // P5：范围独立持久化（与知识库范围 / 形态 / 主题的键互不干扰）；非法值已在读取时回落
  // DEC-BADGE：改为共享快照，侧栏徽标与列表同源（同一存储键 / 同一 queryKey）
  const scope = useDecisionsScope();
  const { active, answered, loading, error } = useDecisionLists(workspaceId, scope);
  // 范围下拉计数（设计「所有工作区（3 个）」）；与 App 侧同源 queryKey，共享缓存不额外发请求
  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.get<Workspace[]>('/api/workspaces'),
  });
  const allScopeLabel =
    workspaces === undefined || workspaces.length === 0
      ? '所有工作区'
      : `所有工作区（${workspaces.length} 个）`;
  const [filter, setFilter] = useState<DecisionFilter>('all');
  const [sort, setSort] = useState<DecisionSort>('urgency');
  // DEC-V4-INLINE：同一时刻只展开一条，展开后由详细卡替换 chip 行
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // P8：深链定位 —— decisionFocus 只消费一次；selectedId 保留高亮边框，flashId 驱动 720ms ×2 闪烁
  const consumeFocus = useNavStore((state) => state.focusDecision);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [focusToast, setFocusToast] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const flashTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  // DEC-V4-UNDO：leaving（420ms 视觉移出）+ 唯一一条撤销条
  const [leavingId, setLeavingId] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoBarState | null>(null);
  const leavingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoResultTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoMutation = useUndoDecision();
  const clearFlashTimers = () => {
    for (const timer of flashTimers.current) clearTimeout(timer);
    flashTimers.current = [];
  };

  /** 撤销 / 移出结束后统一失效：列表、tab 计数、侧栏徽标、卡面 `[待决策]` */
  const invalidateDecisionState = () => {
    void queryClient.invalidateQueries({ queryKey: ['decisions'] });
    void queryClient.invalidateQueries({ queryKey: ['decisions-count'] });
    void queryClient.invalidateQueries({ queryKey: ['decision'] });
    void queryClient.invalidateQueries({ queryKey: ['issue'] });
    void queryClient.invalidateQueries({ queryKey: ['issues'] });
  };

  /**
   * DEC-V4-UNDO：提交成功 → 立即出现撤销条（答案已在服务端），卡片先留在原地 420ms 再移入已回答。
   * reduced motion 下跳过 leaving，直接失效刷新。
   */
  const handleAnswered = (payload: DecisionAnsweredPayload) => {
    // 同时最多 1 条：新提交替换旧条，旧回答保持有效（不自动撤销）
    setUndo({ ...payload, phase: 'ready', tone: 'info', message: null });
    if (undoResultTimer.current !== null) {
      clearTimeout(undoResultTimer.current);
      undoResultTimer.current = null;
    }
    if (leavingTimer.current !== null) clearTimeout(leavingTimer.current);
    if (prefersReducedMotion()) {
      setLeavingId(null);
      invalidateDecisionState();
      return;
    }
    setLeavingId(payload.decisionId);
    leavingTimer.current = setTimeout(() => {
      leavingTimer.current = null;
      setLeavingId(null);
      invalidateDecisionState();
    }, LEAVING_MS);
  };

  /** 点「撤销」/「重试撤销」：body 带 expected_revision，窗口判定全部交给服务端 */
  const handleUndo = () => {
    if (undo === null || undo.phase === 'pending') return;
    const { decisionId, revision, by } = undo;
    setUndo((prev) => (prev === null ? prev : { ...prev, phase: 'pending', tone: 'info', message: null }));
    undoMutation.mutate(
      { decisionId, expectedRevision: revision, by },
      {
        onSuccess: () => {
          setUndo((prev) =>
            prev === null ? prev : { ...prev, phase: 'done', tone: 'info', message: '已撤销' },
          );
        },
        onError: (err) => {
          const { message, retry } = classifyUndoError(err);
          // 过期 / 冲突 / 已撤销都以服务端为准：刷新列表，不猜本地状态
          invalidateDecisionState();
          setUndo((prev) =>
            prev === null ? prev : { ...prev, phase: retry ? 'failed' : 'done', tone: 'error', message },
          );
        },
      },
    );
  };
  const changeScope = (next: DecisionsScope) => {
    setDecisionsScope(next);
    // 换范围等价于换列表上下文：收起展开卡，避免跨区确认态残留
    setExpandedId(null);
  };
  /**
   * DEC-JUMP-WS：待决策 → 看板卡详情。
   * 跨工作区决策（「所有工作区」范围）必须先把主工作区切到决策所属工作区，否则看板里根本没有这张卡；
   * 再切到看板并让 Board 清筛选 + 滚动定位，最后打开详情浮窗（高亮即选中态）。
   */
  const openIssueInBoard = (issueId: string, issueWorkspaceId: string) => {
    if (issueWorkspaceId !== workspaceId) selectWorkspace(issueWorkspaceId);
    focusIssue(issueId);
    openDetail(issueId);
  };
  const groups = groupDecisions(active, answered, now, sort);
  // DEC-SIBLING：同一 issue 的决策聚合（在途 + 24h 已回答）。
  // 复用本页已拉取的列表一次算出，不新增接口、不按卡再发请求（DESIGN-NOTES §10「前端本地聚合」）。
  const siblingsByIssue = new Map<string, DecisionListItemDto[]>();
  for (const entry of [...active, ...answered]) {
    const bucket = siblingsByIssue.get(entry.issue_id);
    if (bucket === undefined) siblingsByIssue.set(entry.issue_id, [entry]);
    else bucket.push(entry);
  }
  const toggleExpanded = (decisionId: string) => {
    setExpandedId((current) => (current === decisionId ? null : decisionId));
  };
  const allItems = [...groups.grace, ...groups.open, ...groups.stale, ...groups.answered];
  const allItemsRef = useRef(allItems);
  allItemsRef.current = allItems;

  /**
   * P8：消费 decisionFocus（看板卡面 / 详情底部按钮 / 通知 toast 的统一切入点）。
   * - 定位并展开目标条，滚到可视区，闪烁 720ms ×2 后保留高亮边框；
   * - 目标不存在（已撤回 / 已过期被清理 / 跨区不可见）→ 回列表顶部 + toast，绝不显示空白；
   * - 消费后立即清空 decisionFocus，切走再回来不会重放。
   */
  useEffect(() => {
    if (focus === null || loading) return;
    const target = allItemsRef.current.find((item) => item.id === focus) ?? null;
    setFilter('all');
    setExpandedId(target?.id ?? null);
    setSelectedId(target?.id ?? null);
    setFlashId(null);
    clearFlashTimers();
    usePanelStore.getState().clearView();
    consumeFocus(null);
    if (target === null) {
      setFocusToast('该决策已不存在或不在当前范围');
      if (listRef.current !== null) listRef.current.scrollTop = 0;
      return;
    }
    setFocusToast(null);
    requestAnimationFrame(() => {
      const node = document.querySelector<HTMLElement>(`[data-testid="decision-item-${focus}"]`);
      node?.scrollIntoView?.({ block: 'center' });
    });
    if (prefersReducedMotion()) return;
    setFlashId(focus);
    flashTimers.current.push(setTimeout(() => setFlashId(null), 720));
    flashTimers.current.push(setTimeout(() => setFlashId(focus), 1440));
    flashTimers.current.push(setTimeout(() => setFlashId(null), 2160));
  }, [focus, loading, consumeFocus]);

  // 卸载时清掉未走完的闪烁 / leaving 定时器
  useEffect(
    () => () => {
      clearFlashTimers();
      if (leavingTimer.current !== null) clearTimeout(leavingTimer.current);
      if (undoResultTimer.current !== null) clearTimeout(undoResultTimer.current);
    },
    [],
  );

  // 撤销结果（已撤销 / 409 文案）自动收起；网络失败保留「重试撤销」，不自动消失
  useEffect(() => {
    if (undo === null || undo.phase !== 'done') return;
    undoResultTimer.current = setTimeout(() => {
      undoResultTimer.current = null;
      setUndo(null);
    }, UNDO_RESULT_TIMEOUT_MS);
    return () => {
      if (undoResultTimer.current !== null) {
        clearTimeout(undoResultTimer.current);
        undoResultTimer.current = null;
      }
    };
  }, [undo]);

  // 目标缺失的提示自动消失（不阻塞继续操作列表）
  useEffect(() => {
    if (focusToast === null) return;
    const timer = setTimeout(() => setFocusToast(null), 5000);
    return () => clearTimeout(timer);
  }, [focusToast]);

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
  // 撤销倒计时以服务端 undo_until 为准；剩余秒数直接用当前时刻算，避免后台/节流标签页里
  // useDecisionClock 的 now 停跳把窗口算大（会显示「看起来还在窗口内」而服务端已 409）。
  const undoRemaining = undo === null ? 0 : Math.max(0, Math.ceil((undo.deadline - Date.now()) / 1000));
  // PERM-3：401 是会话级错误（身份没带上），用顶部 banner 统一承接；
  // 列表查询已对 401 关闭重试，banner 只出一次，不逐卡弹「没权限」。
  const sessionExpired = error instanceof ApiError && error.status === 401;
  const hasAnyData = total + groups.answered.length > 0;
  // P7：无在途 + （无已回答或停在「全部」）才展示真空态；停在「已回答」tab 时仍走正常列表
  const showEmptyState = total === 0 && (groups.answered.length === 0 || filter === 'all');
  // P7：有数据但当前 tab 过滤后为空 → 只给「该筛选下没有条目 + 清除筛选」，不展示真空态机制说明
  const visibleCount =
    filter === 'all' ? total + groups.answered.length : filter === 'answered' ? groups.answered.length : groups[filter].length;
  const filterEmpty = hasAnyData && !showEmptyState && filter !== 'all' && visibleCount === 0;
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
        {/* TOPBAR-02：页头不再重复「待决策 + 计数徽标」，与顶栏去面包屑保持同一口径；
            当前视图与总数由左栏入口高亮 + 下方 tab 分项计数承担。 */}
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

        <div data-testid="decisions-controls" className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <label className="flex items-center gap-1 text-xs text-ink-3 max-sm:min-w-0">
            排序
            <select
              data-testid="decisions-sort"
              value={sort}
              onChange={(event) => setSort(event.target.value as DecisionSort)}
              className="h-8 rounded-lg border border-hairline bg-surface-card px-2.5 text-[12.5px] text-ink-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent max-sm:min-w-0"
            >
              {DECISION_SORTS.map((key) => (
                <option key={key} value={key}>
                  {DECISION_SORT_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1 text-xs text-ink-3 max-sm:min-w-0">
            范围
            <select
              data-testid="decisions-scope"
              value={scope}
              onChange={(event) => changeScope(event.target.value as DecisionsScope)}
              className="h-8 rounded-lg border border-hairline bg-surface-card px-2.5 text-[12.5px] text-ink-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent max-sm:min-w-0"
            >
              <option value="workspace">当前工作区</option>
              <option value="all">{allScopeLabel}</option>
            </select>
          </label>
        </div>
      </header>

      {sessionExpired && (
        <div
          data-testid="decisions-session-expired"
          role="alert"
          className="mx-2 mt-2 flex flex-wrap items-center gap-2 rounded border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
        >
          <span>身份失效，请重新打开看板</span>
          <button
            type="button"
            data-testid="decisions-session-reopen"
            onClick={() => window.location.reload()}
            className="rounded-md border border-red-300 px-2 py-0.5 font-medium hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent dark:border-red-700 dark:hover:bg-red-900"
          >
            重新打开看板
          </button>
        </div>
      )}

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {focusToast !== null && (
          <div
            data-testid="decisions-focus-toast"
            role="status"
            className="mb-2 rounded border border-hairline bg-surface-raised px-2 py-1 text-xs text-ink-2"
          >
            {focusToast}
          </div>
        )}
        {error !== null && !sessionExpired && <DecisionsError error={error} />}
        {error === null && loading && <p className="px-1 py-2 text-xs text-ink-3">加载中…</p>}
        {error === null && !loading && showEmptyState && (
          <DecisionsEmptyState
            scope={scope}
            answered={groups.answered}
            onOpenIssue={openIssueInBoard}
            onGoBoard={() => setView('board')}
          />
        )}
        {error === null && !loading && filterEmpty && (
          <div data-testid="decisions-filter-empty" className="flex flex-col items-start gap-1.5 px-1 py-3 text-xs text-ink-3">
            <p>该筛选下没有条目</p>
            <button
              type="button"
              data-testid="decisions-filter-clear"
              onClick={() => setFilter('all')}
              className="whitespace-nowrap rounded-md border border-hairline px-2 py-1 text-xs text-ink-2 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              清除筛选
            </button>
          </div>
        )}

        {error === null && !loading && hasAnyData && !showEmptyState && !filterEmpty && (
          <>
            {(filter === 'all' || filter === 'grace') && (
          <Group
            scope="grace"
            title="宽限中"
            empty="无"
            items={groups.grace}
            now={now}
            selectedId={selectedId}
            flashId={flashId}
            rankMap={rankMap}
            expandedId={expandedId}
            homeWorkspaceId={workspaceId}
            resetSignal={`${filter}:${scope}`}
            leavingId={leavingId}
            onToggle={toggleExpanded}
            onOpen={openIssueInBoard}
            siblingsByIssue={siblingsByIssue}
            onJumpDecision={consumeFocus}
            onAnswered={handleAnswered}
          />
        )}
        {(filter === 'all' || filter === 'open') && (
          <Group
            scope="open"
            title="未回答"
            empty="无"
            items={groups.open}
            now={now}
            selectedId={selectedId}
            flashId={flashId}
            rankMap={rankMap}
            expandedId={expandedId}
            homeWorkspaceId={workspaceId}
            resetSignal={`${filter}:${scope}`}
            leavingId={leavingId}
            onToggle={toggleExpanded}
            onOpen={openIssueInBoard}
            siblingsByIssue={siblingsByIssue}
            onJumpDecision={consumeFocus}
            onAnswered={handleAnswered}
          />
        )}
        {(filter === 'all' || filter === 'stale') && (
          <Group
            scope="stale"
            title="已超时"
            empty="无"
            items={groups.stale}
            now={now}
            selectedId={selectedId}
            flashId={flashId}
            rankMap={rankMap}
            expandedId={expandedId}
            homeWorkspaceId={workspaceId}
            resetSignal={`${filter}:${scope}`}
            leavingId={leavingId}
            onToggle={toggleExpanded}
            onOpen={openIssueInBoard}
            siblingsByIssue={siblingsByIssue}
            onJumpDecision={consumeFocus}
            onAnswered={handleAnswered}
          />
        )}
        {(filter === 'all' || filter === 'answered') && (
          <Group
            scope="answered"
            title="最近已回答"
            empty="无（保留 24 小时）"
            items={groups.answered}
            now={now}
            selectedId={selectedId}
            flashId={flashId}
            rankMap={rankMap}
            expandedId={expandedId}
            homeWorkspaceId={workspaceId}
            resetSignal={`${filter}:${scope}`}
            leavingId={leavingId}
            onToggle={toggleExpanded}
            onOpen={openIssueInBoard}
            siblingsByIssue={siblingsByIssue}
            onJumpDecision={consumeFocus}
            onAnswered={handleAnswered}
          />
        )}
          </>
        )}
      </div>

      {/* DEC-V4-UNDO：同时最多 1 条；倒计时读服务端 undo_until */}
      {undo !== null && (
        <div
          data-testid="decision-undo-bar"
          data-phase={undo.phase}
          data-decision-id={undo.decisionId}
          role="status"
          aria-live="polite"
          className="fixed bottom-4 left-1/2 z-20 flex max-w-[92vw] -translate-x-1/2 items-center gap-2 rounded-md border border-hairline bg-surface-card px-3 py-1.5 text-xs shadow-lg"
        >
          <span className="min-w-0 truncate text-ink-3" title={undo.issueTitle}>
            {undo.issueTitle}
          </span>
          {undo.phase === 'done' || undo.phase === 'failed' ? (
            <>
              <span
                data-testid="decision-undo-result"
                className={
                  undo.tone === 'error' ? 'text-red-600 dark:text-red-400' : 'font-medium text-ink-2'
                }
              >
                {undo.message}
              </span>
              {undo.phase === 'failed' && (
                <button
                  type="button"
                  data-testid="decision-undo-retry"
                  onClick={handleUndo}
                  className="whitespace-nowrap rounded border border-hairline px-2 py-0.5 text-xs text-ink-2 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                >
                  重试撤销
                </button>
              )}
            </>
          ) : !undo.canUndo ? (
            // PERM-3：can_undo=false 时不给撤销入口，但答案已落库，如实展示
            <span data-testid="decision-undo-forbidden" className="text-ink-3">
              已作答（无撤销权限）
            </span>
          ) : undoRemaining > 0 ? (
            <>
              <span data-testid="decision-undo-countdown" className="tabular-nums text-ink-2">
                已记录 · {undoRemaining} 秒内可撤销
              </span>
              <button
                type="button"
                data-testid="decision-undo"
                disabled={undo.phase === 'pending'}
                onClick={handleUndo}
                className="whitespace-nowrap rounded border border-hairline px-2 py-0.5 text-xs font-medium text-ink-2 hover:bg-surface-raised disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              >
                {undo.phase === 'pending' ? '撤销中…' : '撤销'}
              </button>
            </>
          ) : (
            <span data-testid="decision-undo-expired" className="text-ink-3">
              已作答
            </span>
          )}
        </div>
      )}
    </section>
  );
}

/** P5/PERM-3：列表级错误分区展示，不把 401 / 403 一律显示成「加载失败」；401 由顶部 banner 统一承担 */
function DecisionsError({ error }: { error: unknown }) {
  const apiError = error instanceof ApiError ? error : null;
  if (apiError?.code === 'WORKSPACE_FORBIDDEN') {
    return (
      <p data-testid="decisions-error-forbidden" className="px-1 py-3 text-xs text-ink-3">
        无权查看该范围：当前身份没有任何可访问的工作区
      </p>
    );
  }
  if (apiError?.code === 'ROLE_FORBIDDEN') {
    return (
      <p data-testid="decisions-error-role" className="px-1 py-3 text-xs text-ink-3">
        当前角色无权查看这些决策
      </p>
    );
  }
  return (
    <p data-testid="decisions-error-generic" className="px-1 py-3 text-xs text-red-600 dark:text-red-400">
      加载失败：{apiError?.message ?? (error instanceof Error ? error.message : '请稍后重试')}
    </p>
  );
}

interface GroupProps {
  scope: 'grace' | 'open' | 'stale' | 'answered';
  title: string;
  empty: string;
  items: DecisionListItemDto[];
  now: number;
  selectedId: string | null;
  flashId: string | null;
  rankMap: ReadonlyMap<string, number>;
  expandedId: string | null;
  homeWorkspaceId: string;
  resetSignal: string;
  /** DEC-V4-UNDO：正在 420ms 视觉移出的那条 */
  leavingId: string | null;
  /** DEC-SIBLING：issue_id → 同卡全部决策（含自身），卡片内排除自身后展示 */
  siblingsByIssue: ReadonlyMap<string, DecisionListItemDto[]>;
  onToggle: (decisionId: string) => void;
  /** DEC-JUMP-WS：打开任务卡前先切到它所属的工作区 */
  onOpen: (issueId: string, issueWorkspaceId: string) => void;
  /** 同卡决策互跳（复用 focusDecision） */
  onJumpDecision: (decisionId: string) => void;
  onAnswered: (payload: DecisionAnsweredPayload) => void;
}

function Group({
  scope,
  title,
  empty,
  items,
  now,
  selectedId,
  flashId,
  rankMap,
  expandedId,
  homeWorkspaceId,
  resetSignal,
  leavingId,
  siblingsByIssue,
  onToggle,
  onOpen,
  onJumpDecision,
  onAnswered,
}: GroupProps) {
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
          {items.map((item) => {
            const siblings = (siblingsByIssue.get(item.issue_id) ?? [])
              .filter((entry) => entry.id !== item.id)
              .sort((a, b) => b.created_at - a.created_at);
            return (
              <DecisionCard
                key={item.id}
                item={item}
                now={now}
                rank={rankMap.get(item.id)}
                focused={selectedId === item.id}
                flash={flashId === item.id}
                leaving={leavingId === item.id}
                scope={scope}
                expanded={expandedId === item.id}
                siblings={siblings}
                homeWorkspaceId={homeWorkspaceId}
                resetSignal={resetSignal}
                onToggle={onToggle}
                onOpenIssue={onOpen}
                onJumpDecision={onJumpDecision}
                onAnswered={onAnswered}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}
