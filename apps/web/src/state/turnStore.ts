/**
 * CHAT-VIS1：轮次观测的前端只读投影 store（计划条 + 成本脚注的唯一数据入口）。
 *
 * - 数据只有两个来源：WS `session.plan`（变更即推）与 WS `session.usage`（250ms 合并节流）；
 * - **只读**：没有写路径、没有 HTTP 端点、不与执行器双写（改计划/重跑步骤归 CHAT-RETRY2 / CHAT-AWAIT2）；
 * - 与 streamingStore 同构：模块级单例 + 全局 `subscribeWsEvents`，ChatPanel 未挂载也在收快照；
 * - 降级：`plan` 为空数组（CLI 不声明计划）或从未收到 `session.plan` → 没有观测条目 → 前端隐藏计划条，
 *   与「历史会话无 turn 行」同一口径；历史轮次的 plan 只存在于库内，本卡不回拉。
 */
import { create } from 'zustand';
import type { TurnPlanStep, TurnUsage } from '@agentboard/shared';
import { subscribeWsEvents } from '../api/wsBus';

/** 一轮的观测快照（`session.plan` + `session.usage` 的合并视图） */
export interface TurnObservation {
  turn_id: string;
  session_id: string;
  plan: TurnPlanStep[];
  current_index: number;
  usage: TurnUsage | null;
}

interface TurnStoreState {
  /** turn_id → 快照（按会话的消息里的 turn_id 反查，天然不会跨会话串条） */
  turns: Map<string, TurnObservation>;
  /** session_id → 最近一次收到观测的 turn_id（成本脚注读这一条） */
  activeTurnBySession: Map<string, string>;
  applyPlan: (e: { session_id: string; turn_id: string; plan: TurnPlanStep[]; current_index: number }) => void;
  applyUsage: (e: { session_id: string; turn_id: string; usage: TurnUsage }) => void;
  forgetSession: (sessionId: string) => void;
  reset: () => void;
}

export const useTurnStore = create<TurnStoreState>()((set) => ({
  turns: new Map(),
  activeTurnBySession: new Map(),
  applyPlan: (e) =>
    set((s) => {
      const prev = s.turns.get(e.turn_id);
      // 步骤状态只由服务端快照覆盖（前端不本地推进），usage 保留上一次的值直到 session.usage 到达
      const next = new Map(s.turns);
      next.set(e.turn_id, {
        turn_id: e.turn_id,
        session_id: e.session_id,
        plan: e.plan.map((step) => ({ ...step })),
        current_index: e.current_index,
        usage: prev?.usage ?? null,
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
      });
      const active = new Map(s.activeTurnBySession);
      active.set(e.session_id, e.turn_id);
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

const { applyPlan, applyUsage, forgetSession } = useTurnStore.getState();

subscribeWsEvents((event) => {
  if (event.type === 'session.plan') applyPlan(event);
  else if (event.type === 'session.usage') applyUsage(event);
  else if (event.type === 'session.deleted') forgetSession(event.session_id);
});

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

/** 当前会话最近一轮的用量（成本脚注；未开始轮次 → null → 显示 0） */
export function useSessionUsage(sessionId: string | null | undefined): TurnUsage | null {
  return useTurnStore((s) => {
    if (!sessionId) return null;
    const turnId = s.activeTurnBySession.get(sessionId);
    return turnId ? (s.turns.get(turnId)?.usage ?? null) : null;
  });
}
