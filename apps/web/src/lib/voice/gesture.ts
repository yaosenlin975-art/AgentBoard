/**
 * 长按手势状态机（VOICE-3）：纯函数，不碰 DOM，便于单测与变异验证。
 *
 * 规则（设计 §长按手势）：
 * - pointerdown 进入 pending，起 400ms 计时；
 * - pending 期间位移 > 6px → canceled（让原生文字选择接管）；
 * - pending 期间 pointerup/pointercancel → canceled，不录音；
 * - 计时到点（400ms）→ recording（此时才 getUserMedia）；
 * - recording 期间 pointerup/pointercancel/Escape → stop。
 */
import { LONG_PRESS_MS, MOVE_CANCEL_PX } from './contract';

export type GesturePhase = 'idle' | 'pending' | 'recording' | 'canceled';

export interface GestureState {
  phase: GesturePhase;
  /** 起点（clientX/clientY），用于位移判定 */
  origin: { x: number; y: number } | null;
  /** pending 的计时起点（ms） */
  startedAt: number | null;
}

export const IDLE_GESTURE: GestureState = { phase: 'idle', origin: null, startedAt: null };

export function gestureDown(x: number, y: number, now: number): GestureState {
  return { phase: 'pending', origin: { x, y }, startedAt: now };
}

export interface GestureTransition {
  state: GestureState;
  /** true = 该开始录音（getUserMedia）；只在 pending → recording 的那一次为 true */
  startRecording: boolean;
  /** true = 该结束录音（若开着） */
  stopRecording: boolean;
}

const same = (s: GestureState, next: GestureState, extra: Partial<GestureTransition> = {}): GestureTransition => ({
  state: next,
  startRecording: false,
  stopRecording: false,
  ...extra,
});

/** 位移是否已超过阈值（>6px 视为文字选择） */
export function movedTooFar(origin: { x: number; y: number }, x: number, y: number): boolean {
  return Math.hypot(x - origin.x, y - origin.y) > MOVE_CANCEL_PX;
}

export function gestureMove(state: GestureState, x: number, y: number): GestureTransition {
  if (state.phase !== 'pending' || state.origin === null) return same(state, state);
  if (!movedTooFar(state.origin, x, y)) return same(state, state);
  return same(state, IDLE_GESTURE);
}

/** 计时到点：pending 且仍满足 → 进入 recording */
export function gestureTick(state: GestureState, now: number): GestureTransition {
  if (state.phase !== 'pending' || state.startedAt === null) return same(state, state);
  if (now - state.startedAt < LONG_PRESS_MS) return same(state, state);
  return same({ ...state, phase: 'recording' }, { ...state, phase: 'recording', origin: state.origin }, { startRecording: true });
}

/** 松手 / pointercancel / Escape */
export function gestureEnd(state: GestureState): GestureTransition {
  if (state.phase === 'recording') {
    return { state: IDLE_GESTURE, startRecording: false, stopRecording: true };
  }
  if (state.phase === 'pending') {
    return { state: IDLE_GESTURE, startRecording: false, stopRecording: false };
  }
  return { state: IDLE_GESTURE, startRecording: false, stopRecording: false };
}
