/**
 * CHAT-VIS1 / CHAT-AWAIT2：轮次观测的前端只读投影 store（计划条 + 成本脚注 + 阻塞态的唯一数据入口）。
 *
 * - 数据来源：WS `session.plan` / `session.usage` / `session.turn` / `session.approval_request`，
 *   以及会话详情 `GET /api/sessions/:id` 回传的 `turns`（刷新恢复用，CHAT-AWAIT2）；
 * - **store 本身只读**：不本地推进状态、不与执行器双写；阻塞态的判定与超时只信服务端字段/事件；
 *   唯一写路径是 CHAT-RETRY2 的 `useRetryFailedStep`（只调服务端单步重试端点，再把返回的整轮回填）；
 * - 与 streamingStore 同构：模块级单例 + 全局 `subscribeWsEvents`，ChatPanel 未挂载也在收快照；
 * - 降级：`plan` 为空数组（CLI 不声明计划）→ 没有观测条目 → 前端隐藏计划条。
 */
import { create } from 'zustand';
import { useMutation } from '@tanstack/react-query';
import type {
  SessionApprovalRequestEvent,
  SessionStepRetryResult,
  SessionTurn,
  SessionTurnEvent,
  SessionTurnState,
  TurnAwaitingInfo,
  TurnPlanStep,
  TurnUsage,
} from '@agentboard/shared';
import { api } from '../api/client';
import { subscribeWsEvents } from '../api/wsBus';

/** 一轮的观测快照（`session.plan` + `session.usage` + `session.turn` 的合并视图） */
export interface TurnObservation {
  turn_id: string;
  session_id: string;
  plan: TurnPlanStep[];
  current_index: number;
  usage: TurnUsage | null;
  /** 轮次状态（仅来自服务端事件/详情；null = 尚未观测到） */
  state: SessionTurnState | null;
  /** 阻塞态详情（仅来自服务端事件/详情；null = 未阻塞） */
  awaiting: TurnAwaitingInfo | null;
}

interface TurnStoreState {
  /** turn_id → 快照（按会话的消息里的 turn_id 反查，天然不会跨会话串条） */
  turns: Map<string, TurnObservation>;
  /**
   * session_id → 该会话的 turn_id 快照索引。
   * 更新时只换目标会话的内层 Map，其它会话的引用保持不变 → MessageList 按会话订阅时
   * 不会被无关会话的 plan/usage 事件带着重渲（CR2-5）。
   */
  turnsBySession: Map<string, Map<string, TurnObservation>>;
  /** session_id → 最近一次收到观测的 turn_id（成本脚注/阻塞卡片读这一条） */
  activeTurnBySession: Map<string, string>;
  applyPlan: (e: { session_id: string; turn_id: string; plan: TurnPlanStep[]; current_index: number }) => void;
  applyUsage: (e: { session_id: string; turn_id: string; usage: TurnUsage }) => void;
  applyTurnEvent: (e: SessionTurnEvent) => void;
  applyApprovalRequest: (e: SessionApprovalRequestEvent) => void;
  /** 用服务端详情/决策响应回填整轮（刷新恢复与决策后即时对齐） */
  hydrateTurns: (sessionId: string, turns: SessionTurn[]) => void;
  forgetSession: (sessionId: string) => void;
  reset: () => void;
}

function fromSessionTurn(turn: SessionTurn): TurnObservation {
  return {
    turn_id: turn.id,
    session_id: turn.session_id,
    plan: turn.plan_json ?? [],
    current_index: turn.current_index,
    usage: turn.usage_json,
    state: turn.state,
    awaiting: turn.awaiting_json,
  };
}

/** 同一会话的多轮里挑「当前应展示」的一轮：优先仍在阻塞的轮，其次 seq 最大的一轮 */
function pickActiveTurn(turns: SessionTurn[]): SessionTurn | null {
  if (turns.length === 0) return null;
  const blocked = turns.find(
    (t) => t.state === 'awaiting_input' || t.state === 'awaiting_approval',
  );
  if (blocked !== undefined) return blocked;
  return turns.reduce((latest, t) => (t.seq > latest.seq ? t : latest), turns[0]!);
}

/** `useSessionTurns` 无该会话观测时的稳定空值（避免每次选择器返回新 Map 触发重渲） */
const EMPTY_SESSION_TURNS: Map<string, TurnObservation> = new Map();

/** 写入一条观测：平表 + 会话索引同步更新，只换目标会话的内层 Map 引用 */
function putTurn(
  s: Pick<TurnStoreState, 'turns' | 'turnsBySession'>,
  obs: TurnObservation,
): Pick<TurnStoreState, 'turns' | 'turnsBySession'> {
  const turns = new Map(s.turns);
  turns.set(obs.turn_id, obs);
  const sessionTurns = new Map(s.turnsBySession.get(obs.session_id) ?? []);
  sessionTurns.set(obs.turn_id, obs);
  const turnsBySession = new Map(s.turnsBySession);
  turnsBySession.set(obs.session_id, sessionTurns);
  return { turns, turnsBySession };
}

export const useTurnStore = create<TurnStoreState>()((set) => ({
  turns: new Map(),
  turnsBySession: new Map(),
  activeTurnBySession: new Map(),
  applyPlan: (e) =>
    set((s) => {
      const prev = s.turns.get(e.turn_id);
      // 步骤状态只由服务端快照覆盖（前端不本地推进），usage/轮次状态保留上一次的值直到对应的服务端事件到达
      const obs: TurnObservation = {
        turn_id: e.turn_id,
        session_id: e.session_id,
        plan: e.plan.map((step) => ({ ...step })),
        current_index: e.current_index,
        usage: prev?.usage ?? null,
        state: prev?.state ?? null,
        awaiting: prev?.awaiting ?? null,
      };
      const active = new Map(s.activeTurnBySession);
      active.set(e.session_id, e.turn_id);
      return { ...putTurn(s, obs), activeTurnBySession: active };
    }),
  applyUsage: (e) =>
    set((s) => {
      const prev = s.turns.get(e.turn_id);
      const obs: TurnObservation = {
        turn_id: e.turn_id,
        session_id: e.session_id,
        plan: prev?.plan ?? [],
        current_index: prev?.current_index ?? -1,
        usage: e.usage,
        state: prev?.state ?? null,
        awaiting: prev?.awaiting ?? null,
      };
      const active = new Map(s.activeTurnBySession);
      active.set(e.session_id, e.turn_id);
      return { ...putTurn(s, obs), activeTurnBySession: active };
    }),
  applyTurnEvent: (e) =>
    set((s) => {
      const prev = s.turns.get(e.turn_id);
      const obs: TurnObservation = {
        turn_id: e.turn_id,
        session_id: e.session_id,
        plan: prev?.plan ?? [],
        current_index: prev?.current_index ?? -1,
        usage: prev?.usage ?? null,
        state: e.state,
        awaiting: e.awaiting ?? null,
      };
      const active = new Map(s.activeTurnBySession);
      active.set(e.session_id, e.turn_id);
      return { ...putTurn(s, obs), activeTurnBySession: active };
    }),
  applyApprovalRequest: (e) =>
    set((s) => {
      const prev = s.turns.get(e.turn_id);
      // 同一 request_id 重复广播不重算进入时刻（幂等）
      if (prev?.awaiting?.approval?.request_id === e.request_id) return s;
      const at = prev?.awaiting?.at ?? Date.now();
      const obs: TurnObservation = {
        turn_id: e.turn_id,
        session_id: e.session_id,
        plan: prev?.plan ?? [],
        current_index: prev?.current_index ?? -1,
        usage: prev?.usage ?? null,
        state: 'awaiting_approval',
        awaiting: {
          reason: 'approval_required',
          message: `${e.tool} 请求确认：${e.target}`,
          at,
          approval: {
            request_id: e.request_id,
            tool: e.tool,
            target: e.target,
            risk: e.risk,
            match_key: '',
          },
        },
      };
      const active = new Map(s.activeTurnBySession);
      active.set(e.session_id, e.turn_id);
      return { ...putTurn(s, obs), activeTurnBySession: active };
    }),
  hydrateTurns: (sessionId, turns) =>
    set((s) => {
      if (turns.length === 0) return s;
      const merged = new Map(s.turns);
      const sessionTurns = new Map(s.turnsBySession.get(sessionId) ?? []);
      for (const turn of turns) {
        const obs = fromSessionTurn(turn);
        merged.set(obs.turn_id, obs);
        sessionTurns.set(obs.turn_id, obs);
      }
      const turnsBySession = new Map(s.turnsBySession);
      turnsBySession.set(sessionId, sessionTurns);
      const activeTurn = pickActiveTurn(turns);
      const active = new Map(s.activeTurnBySession);
      if (activeTurn !== null) active.set(sessionId, activeTurn.id);
      return { turns: merged, turnsBySession, activeTurnBySession: active };
    }),
  forgetSession: (sessionId) =>
    set((s) => {
      const turns = new Map(s.turns);
      for (const [turnId, obs] of turns) if (obs.session_id === sessionId) turns.delete(turnId);
      const turnsBySession = new Map(s.turnsBySession);
      const hadSession = turnsBySession.delete(sessionId);
      const active = new Map(s.activeTurnBySession);
      const changed = active.delete(sessionId) || hadSession || turns.size !== s.turns.size;
      return changed ? { turns, turnsBySession, activeTurnBySession: active } : s;
    }),
  reset: () => set({ turns: new Map(), turnsBySession: new Map(), activeTurnBySession: new Map() }),
}));

const { applyPlan, applyUsage, applyTurnEvent, applyApprovalRequest, forgetSession } =
  useTurnStore.getState();

subscribeWsEvents((event) => {
  if (event.type === 'session.plan') applyPlan(event);
  else if (event.type === 'session.usage') applyUsage(event);
  else if (event.type === 'session.turn') applyTurnEvent(event);
  else if (event.type === 'session.approval_request') applyApprovalRequest(event);
  else if (event.type === 'session.deleted') forgetSession(event.session_id);
});

/** 刷新恢复：用会话详情里的 turns 回填（模块级稳定函数，便于在 effect 依赖里引用） */
export function hydrateSessionTurns(sessionId: string, turns: SessionTurn[]): void {
  useTurnStore.getState().hydrateTurns(sessionId, turns);
}

/** 决策/回答响应里的整轮回填（不等 WS 也不丢状态） */
export function applyServerTurn(turn: SessionTurn): void {
  useTurnStore.getState().hydrateTurns(turn.session_id, [turn]);
}

/** 指定轮次的观测快照（无观测 → null → 调用方隐藏计划条） */
export function useTurnObservation(turnId: string | null | undefined): TurnObservation | null {
  return useTurnStore((s) => (turnId ? (s.turns.get(turnId) ?? null) : null));
}

/**
 * 指定会话的轮次观测（一次订阅，避免在消息流里按轮次循环调 hook）。
 * CR2-5：按会话细粒度订阅——其它会话的 plan/usage 事件只换它自己的内层 Map，
 * 本会话的 Map 引用保持不变，消息列表不会跟着无关会话重渲。
 */
export function useSessionTurns(sessionId: string | null | undefined): Map<string, TurnObservation> {
  return useTurnStore((s) =>
    sessionId ? (s.turnsBySession.get(sessionId) ?? EMPTY_SESSION_TURNS) : EMPTY_SESSION_TURNS,
  );
}

/** 当前会话最近一轮观测（阻塞卡片/成本脚注读这一条；无观测 → null） */
export function useActiveTurn(sessionId: string | null | undefined): TurnObservation | null {
  return useTurnStore((s) => {
    if (!sessionId) return null;
    const turnId = s.activeTurnBySession.get(sessionId);
    return turnId ? (s.turns.get(turnId) ?? null) : null;
  });
}

/** 当前会话最近一轮的用量（成本脚注；未开始轮次 → null → 显示 0） */
export function useSessionUsage(sessionId: string | null | undefined): TurnUsage | null {
  return useTurnStore((s) => {
    if (!sessionId) return null;
    const turnId = s.activeTurnBySession.get(sessionId);
    return turnId ? (s.turns.get(turnId)?.usage ?? null) : null;
  });
}

/**
 * CHAT-RETRY2：单步重试的唯一请求路径。
 *
 * - 只发 `POST /api/sessions/:id/turns/:turnId/steps/:stepId/retry`，**不带**整轮重发的
 *   `POST /messages`；幂等键由服务端按 `turn_id:step_id:tool_call_id` 判定，前端不造键；
 * - 成功只把服务端返回的整轮回填（步骤 `failed → done/failed` 以服务端为准），
 *   不新增消息、不本地推进状态（所以不会出现第二张 diff 卡）；
 * - 409 / 403 等失败**不改** store，由调用方按 `retryFailureText` 展示可读原因。
 */
export function useRetryFailedStep(sessionId: string | null) {
  return useMutation({
    mutationFn: (input: { turnId: string; stepId: string }) => {
      if (sessionId === null) return Promise.reject(new Error('未选择会话'));
      return api.post<SessionStepRetryResult>(
        `/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(input.turnId)}/steps/${encodeURIComponent(input.stepId)}/retry`,
        {},
      );
    },
    onSuccess: (result) => applyServerTurn(result.turn),
  });
}

