/**
 * DEC-6：待决策数据源（REST + WS 失效）。
 *
 * - 列表：在途（grace+open，默认口径）与已回答（answered，24h 内展示）两次查询；
 * - 侧栏徽标（DEC-BADGE）：复用同一个在途查询键 + `groupDecisions`，与列表 tab 计数恒等；
 * - WS：`decision.*` / `issue.stop_requested` 事件经 wsBus 触发失效重取。
 *   事件到查询键的映射刻意留在本模块（`api/ws.ts` 的穷尽 switch 属 DEC-3 文件集，不在本卡改动范围）。
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ServerWsEvent } from '@agentboard/shared';
import { ApiError, api } from '../../api/client';
import { useWsEvent } from '../../api/wsBus';
import type { DecisionsScope } from '../../lib/decisionsScope';
import { useDecisionClock } from './clock';
import { groupDecisions } from './countdown';
import type {
  DecisionDetailDto,
  DecisionListResponse,
  ExtendDecisionResponse,
  UndoDecisionResponse,
} from './types';

export const DECISION_LIST_LIMIT = 50;

/**
 * PERM-3：401 是会话级错误（身份没带上），重试只会放大错误、并让 banner 重复出现；
 * 其余错误保留一次重试。403 是业务结果，不重试。
 */
function retryUnlessUnauthorized(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status === 401) return false;
  if (error instanceof ApiError && error.status === 403) return false;
  return failureCount < 1;
}

export function decisionsListKey(
  workspaceId: string,
  scope: 'active' | 'answered' | `issue-${string}`,
  range: DecisionsScope = 'workspace',
) {
  // 范围进 key：切到「所有可访问工作区」时不能复用单区缓存
  return ['decisions', range === 'all' ? '*' : workspaceId, scope, range] as const;
}

export function decisionDetailKey(decisionId: string) {
  return ['decision', decisionId] as const;
}

/**
 * 在途列表（grace + open）的唯一查询定义：列表与侧栏徽标共用同一 queryKey，避免重复请求。
 * 当前工作区 → 单区；`scope=all` → 服务端 `scope=accessible`（只返回有成员关系的区）。
 * 权限过滤全部交给服务端，前端不拼全量请求、不在客户端过滤。
 */
function useActiveDecisionQuery(workspaceId: string | null, scope: DecisionsScope) {
  const all = scope === 'all';
  const activeUrl = all
    ? `/api/decisions?scope=accessible&limit=${DECISION_LIST_LIMIT}`
    : `/api/decisions?workspace_id=${encodeURIComponent(workspaceId ?? '')}&limit=${DECISION_LIST_LIMIT}`;
  return useQuery({
    queryKey: decisionsListKey(workspaceId ?? '', 'active', scope),
    queryFn: () => api.get<DecisionListResponse>(activeUrl),
    enabled: all || workspaceId !== null,
    retry: retryUnlessUnauthorized,
  });
}

/**
 * DEC-BADGE：侧栏「待决策」分项计数。
 * - `grace`：宽限中（与列表「宽限中」tab 同一分组判定）；
 * - `locked`：已过宽限、已落锁、agent 已停手（列表 `open` 分组，含锁后 ≥72h 的「已超时」子集）。
 * 不新增服务端口径：直接消费列表接口与 `groupDecisions`，两处数字构造上恒等。
 */
export function useDecisionLayerCounts(
  workspaceId: string | null,
  scope: DecisionsScope = 'workspace',
): { grace: number; locked: number } {
  const queryClient = useQueryClient();
  const { data } = useActiveDecisionQuery(workspaceId, scope);
  useDecisionInvalidation(queryClient);
  // 与列表同一秒级时钟：宽限到期时两侧同一帧把条目从 grace 移入 open
  const now = useDecisionClock();
  const groups = groupDecisions(data?.decisions ?? [], [], now);
  return { grace: groups.grace.length, locked: groups.open.length };
}

/** 列表：在途 + 已回答（各自独立查询键；侧栏徽标只复用其中的在途查询） */
export function useDecisionLists(workspaceId: string | null, scope: DecisionsScope = 'workspace') {
  const queryClient = useQueryClient();
  const all = scope === 'all';
  const answeredUrl = all
    ? `/api/decisions?scope=accessible&state=answered&limit=${DECISION_LIST_LIMIT}`
    : `/api/decisions?workspace_id=${encodeURIComponent(workspaceId ?? '')}&state=answered&limit=${DECISION_LIST_LIMIT}`;
  const active = useActiveDecisionQuery(workspaceId, scope);
  const answered = useQuery({
    queryKey: decisionsListKey(workspaceId ?? '', 'answered', scope),
    queryFn: () => api.get<DecisionListResponse>(answeredUrl),
    enabled: all || workspaceId !== null,
    retry: retryUnlessUnauthorized,
  });
  useDecisionInvalidation(queryClient);
  return {
    active: active.data?.decisions ?? [],
    answered: answered.data?.decisions ?? [],
    counts: active.data?.counts ?? null,
    loading: active.isLoading || answered.isLoading,
    /** 列表级错误（401 身份失效 / 403 无权工作区），由视图分区展示 */
    error: (active.error ?? answered.error) as unknown,
  };
}

/**
 * 某张卡当前的决策（在途优先，否则最近一条已回答）+ 详情（选项 / 全部答案 revision / checkpoint）。
 * 详情面板用：一张卡同时最多一条在途决策，所以「最新一条」即当前要展示的决策。
 */
export function useIssueDecision(workspaceId: string | null, issueId: string | null) {
  const queryClient = useQueryClient();
  const filter = `issue_id=${encodeURIComponent(issueId ?? '')}&limit=1`;
  const active = useQuery({
    queryKey: decisionsListKey(workspaceId ?? '', `issue-${issueId ?? ''}`),
    queryFn: () =>
      api.get<DecisionListResponse>(
        `/api/decisions?workspace_id=${encodeURIComponent(workspaceId ?? '')}&${filter}`,
      ),
    enabled: workspaceId !== null && issueId !== null,
  });
  const answered = useQuery({
    queryKey: ['decisions', workspaceId ?? '', `answered-issue-${issueId ?? ''}`],
    queryFn: () =>
      api.get<DecisionListResponse>(
        `/api/decisions?workspace_id=${encodeURIComponent(workspaceId ?? '')}&${filter}&state=answered`,
      ),
    enabled: workspaceId !== null && issueId !== null,
  });
  const latest = active.data?.decisions[0] ?? answered.data?.decisions[0] ?? null;
  const detail = useQuery({
    queryKey: decisionDetailKey(latest?.id ?? ''),
    queryFn: () => api.get<{ decision: DecisionDetailDto }>(`/api/decisions/${encodeURIComponent(latest!.id)}`),
    enabled: latest !== null,
  });
  useDecisionInvalidation(queryClient);
  return {
    summary: latest,
    detail: detail.data?.decision ?? null,
    loading: active.isLoading || answered.isLoading,
  };
}

/** 单条决策详情（就地作答卡展开态 / 已回答卡当前答案）：选项、全量答案 revision、checkpoint */
export function useDecisionDetail(decisionId: string | null): DecisionDetailDto | null {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: decisionDetailKey(decisionId ?? ''),
    queryFn: () => api.get<{ decision: DecisionDetailDto }>(`/api/decisions/${encodeURIComponent(decisionId!)}`),
    enabled: decisionId !== null,
    retry: retryUnlessUnauthorized,
  });
  useDecisionInvalidation(queryClient);
  return query.data?.decision ?? null;
}

export interface AnswerDecisionInput {
  decisionId: string;
  /** 预置选项与自定义答案二选一（服务端同样只接受其一） */
  optionId?: string;
  /** DEC-V4-CUSTOM：自定义答案原文（≤120 字，UI 硬截断 + 提交兜底校验） */
  answerText?: string;
  /** 修订必传：当前 `answer_revision`（服务端 CAS，旧版本 → 409 DECISION_REVISION_CONFLICT） */
  expectedRevision?: number;
}

/**
 * DEC-V4-INLINE（P3）：就地作答 / 改答案。
 * 与卡详情 `DecisionSection` 同一口径：`POST /api/decisions/:id/answer`，修订带 `expected_revision`。
 *
 * DEC-V4-UNDO：**不再在 onSuccess 立即失效列表**——提交后卡片要先走 420ms leaving 反馈，
 * 视图在 leaving 结束后统一 invalidate（见 `DecisionsView` 的 `onAnswered`）；否则列表先刷新、
 * 卡片直接跳组，leaving 覆盖层根本没机会出现。答案版本仍以服务端为准，不做乐观改列表。
 */
export function useAnswerDecision() {
  return useMutation({
    mutationFn: (input: AnswerDecisionInput) =>
      api.post<{ decision: DecisionDetailDto }>(`/api/decisions/${encodeURIComponent(input.decisionId)}/answer`, {
        ...(input.optionId === undefined ? {} : { option_id: input.optionId }),
        ...(input.answerText === undefined ? {} : { answer_text: input.answerText }),
        source: 'web',
        ...(input.expectedRevision === undefined ? {} : { expected_revision: input.expectedRevision }),
      }),
  });
}

export interface WithdrawDecisionInput {
  decisionId: string;
  /** 服务端必填（≥1 字符）；Web 端固定写一句可读原因 */
  reason: string;
  by?: string;
}

/**
 * PERM-3：`POST /api/decisions/:id/withdraw`（服务端要求 owner）。
 * 入口可见性由 `capabilities.can_withdraw` 决定；这里只负责落服务端真相并失效列表。
 */
export function useWithdrawDecision() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: WithdrawDecisionInput) =>
      api.post<{ decision: DecisionDetailDto }>(`/api/decisions/${encodeURIComponent(input.decisionId)}/withdraw`, {
        reason: input.reason,
        by: input.by ?? 'user',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['decisions'] });
      void queryClient.invalidateQueries({ queryKey: ['decisions-count'] });
      void queryClient.invalidateQueries({ queryKey: ['decision'] });
      void queryClient.invalidateQueries({ queryKey: ['issue'] });
      void queryClient.invalidateQueries({ queryKey: ['issues'] });
    },
  });
}

export interface UndoDecisionInput {
  decisionId: string;
  /** 必传：提交回答时服务端返回的 `answer_revision`（服务端 CAS，旧版本 → 409） */
  expectedRevision: number;
  /** 撤销人；web 端无人值守回答的 `answered_by` 是 `user`（服务端要求与答案行或提问者一致） */
  by?: string;
}

/**
 * DEC-V4-UNDO：`POST /api/decisions/:id/undo` 服务端真回滚。
 * 成功（含 `already_undone` 幂等重放）后失效列表 / 徽标 / 详情 / 卡面；失败分支由视图按
 * `ApiError.code` 分类展示（409 各自文案），这里不吞错。
 */
export function useUndoDecision() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UndoDecisionInput) =>
      api.post<UndoDecisionResponse>(`/api/decisions/${encodeURIComponent(input.decisionId)}/undo`, {
        by: input.by ?? 'user',
        expected_revision: input.expectedRevision,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['decisions'] });
      void queryClient.invalidateQueries({ queryKey: ['decisions-count'] });
      void queryClient.invalidateQueries({ queryKey: ['decision'] });
      void queryClient.invalidateQueries({ queryKey: ['issue'] });
      void queryClient.invalidateQueries({ queryKey: ['issues'] });
    },
  });
}

export interface ExtendDecisionInput {
  decisionId: string;
  /** 每次延长的秒数；Web 固定 60（服务端允许 1–300，累计上限 300 且总宽限 ≤600） */
  seconds?: number;
}

/**
 * DEC-V4-EXTEND：`POST /api/decisions/:id/extend` 延长宽限。
 * 卡片的本地 +60s / 闪 chip / toast 由组件按响应处理；这里只负责落服务端真相（列表 + 详情失效）。
 */
export function useExtendDecision() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ExtendDecisionInput) =>
      api.post<ExtendDecisionResponse>(`/api/decisions/${encodeURIComponent(input.decisionId)}/extend`, {
        seconds: input.seconds ?? 60,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['decisions'] });
      void queryClient.invalidateQueries({ queryKey: ['decision'] });
    },
  });
}

const DECISION_EVENT_TYPES = new Set<ServerWsEvent['type']>([
  'decision.grace_started',
  'decision.answered',
  'decision.expired',
  'decision.revised',
  'decision.withdrawn',
  'decision.extended',
  'decision.undone',
  'issue.stop_requested',
]);

/** 订阅决策事件 → 失效列表 / 徽标 / 详情 / 卡面（卡面走既有 issue.changed，服务端已广播） */
export function useDecisionInvalidation(queryClient: QueryClient): void {
  useWsEvent((event) => {
    if (!DECISION_EVENT_TYPES.has(event.type)) return;
    void queryClient.invalidateQueries({ queryKey: ['decisions'] });
    void queryClient.invalidateQueries({ queryKey: ['decisions-count'] });
    void queryClient.invalidateQueries({ queryKey: ['decision'] });
  });
}
