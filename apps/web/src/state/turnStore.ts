/**
 * CHAT-VIS1 / CHAT-AWAIT2：轮次观测的前端只读投影 store（计划条 + 成本脚注 + 阻塞态的唯一数据入口）。
 *
 * - 数据来源：WS `session.plan` / `session.usage` / `session.turn` / `session.approval_request`，
 *   以及会话详情 `GET /api/sessions/:id` 回传的 `turns`（刷新恢复用，CHAT-AWAIT2）；
 * - **只读**：没有写路径、没有 HTTP 端点、不与执行器双写（改计划/重跑步骤归 CHAT-RETRY2）；
 *   阻塞态的判定与超时只信服务端字段/事件，前端不本地推进状态、不本地判超时；
 * - 与 streamingStore 同构：模块级单例 + 全局 `subscribeWsEvents`，ChatPanel 未挂载也在收快照；
 * - 降级：`plan` 为空数组（CLI 不声明计划）→ 没有观测条目 → 前端隐藏计划条。
 */
import { create } from 'zustand';
import type {
  SessionApprovalRequestEvent,
  SessionTurn,
  SessionTurnEvent,
  SessionTurnState,
  TurnAwaitingInfo,
  TurnPlanStep,
  TurnUsage,
} from '@agentboard/shared';
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

export const useTurnStore = create<TurnStoreState>()((set) => ({
  turns: new Map(),
  activeTurnBySession: new Map(),
  applyPlan: (e) =>
    set((s) => {
      const prev = s.turns.get(e.turn_id);
      // 步骤状态只由服务端快照覆盖（前端不本地推进），usage/轮次状态保留上一次的值直到对应的服务端事件到达
      const next = new Map(s.turns);
      next.set(e.turn_id, {
        turn_id: e.turn_id,
        session_id: e.session_id,
        plan: e.plan.map((step) => ({ ...step })),
        current_index: e.current_index,
        usage: prev?.usage ?? null,
        state: prev?.state ?? null,
        awaiting: prev?.awaiting ?? null,
      });
      const active = new Map(s.activeTurnBySession);
      active.set(e.session_id, e.turn_id);
      return { turns: next, activeTurnBySession: active };
    }),
  applyUsage: (e) =>
    set((s) => {
      const prev = s.turns.get(e.turn_id);
      const next = new Map(s.turns);
      next.set(e.turn_id, {
        turn_id: e.turn_id,
        session_id: e.session_id,
        plan: prev?.plan ?? [],
        current_index: prev?.current_index ?? -1,
        usage: e.usage,
        state: prev?.state ?? null,
        awaiting: prev?.awaiting ?? null,
      });
      const active = new Map(s.activeTurnBySession);
      active.set(e.session_id, e.turn_id);
      return { turns: next, activeTurnBySession: active };
    }),
  applyTurnEvent: (e) =>
    set((s) => {
      const prev = s.turns.get(e.turn_id);
      const next = new Map(s.turns);
      next.set(e.turn_id, {
        turn_id: e.turn_id,
        session_id: e.session_id,
        plan: prev?.plan ?? [],
        current_index: prev?.current_index ?? -1,
        usage: prev?.usage ?? null,
        state: e.state,
        awaiting: e.awaiting ?? null,
      });
      const active = new Map(s.activeTurnBySession);
      active.set(e.session_id, e.turn_id);
      return { turns: next, activeTurnBySession: active };
    }),
  applyApprovalRequest: (e) =>
    set((s) => {
      const prev = s.turns.get(e.turn_id);
      // 同一 request_id 重复广播不重算进入时刻（幂等）
      if (prev?.awaiting?.approval?.request_id === e.request_id) return s;
      const at = prev?.awaiting?.at ?? Date.now();
      const next = new Map(s.turns);
      next.set(e.turn_id, {
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
      });
      const active = new Map(s.activeTurnBySession);
      active.set(e.session_id, e.turn_id);
      return { turns: next, activeTurnBySession: active };
    }),
  hydrateTurns: (sessionId, turns) =>
    set((s) => {
      if (turns.length === 0) return s;
      const next = new Map(s.turns);
      for (const turn of turns) next.set(turn.id, fromSessionTurn(turn));
      const activeTurn = pickActiveTurn(turns);
      const active = new Map(s.activeTurnBySession);
      if (activeTurn !== null) active.set(sessionId, activeTurn.id);
      return { turns: next, activeTurnBySession: active };
    }),
  forgetSession: (sessionId) =>
    set((s) => {
      const turns = new Map(s.turns);
      for (const [turnId, obs] of turns) if (obs.session_id === sessionId) turns.delete(turnId);
      const active = new Map(s.activeTurnBySession);
      const changed = active.delete(sessionId) || turns.size !== s.turns.size;
      return changed ? { turns, activeTurnBySession: active } : s;
    }),
  reset: () => set({ turns: new Map(), activeTurnBySession: new Map() }),
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
 * 本会话全部轮次观测（一次订阅，避免在消息流里按轮次循环调 hook）。
 * 返回的 Map 引用只在观测变化时更换，与消息流共渲染。
 */
export function useSessionTurns(): Map<string, TurnObservation> {
  return useTurnStore((s) => s.turns);
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
