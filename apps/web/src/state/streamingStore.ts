/**
 * 跨会话/跨卸载的流式内容缓存（设计 §5.5「运行中会话后台收流不丢」，issue cc97a886）：
 * - Map<sessionId, string> 累积各会话 WS text delta；assistant message.added 落定即清对应会话；
 * - 模块级单例（zustand），ChatPanel 卸载/面板收起/切视图不丢失；
 * - 收流挂在 wsBus 全局层（模块加载即 subscribeWsEvents，非组件生命周期），与当前选中会话无关，
 *   非当前会话的 delta 同样累积；ChatPanel 不再各自累积，避免双计。
 */
import { create } from 'zustand';
import { subscribeWsEvents } from '../api/wsBus';

interface StreamingState {
  /** 会话 id → 当前累积的流式文本（assistant 落定即清） */
  streams: Map<string, string>;
  appendDelta: (sessionId: string, delta: string) => void;
  clearStream: (sessionId: string) => void;
}

export const useStreamingStore = create<StreamingState>()((set) => ({
  streams: new Map(),
  appendDelta: (sessionId, delta) =>
    set((s) => {
      const next = new Map(s.streams);
      next.set(sessionId, (next.get(sessionId) ?? '') + delta);
      return { streams: next };
    }),
  clearStream: (sessionId) =>
    set((s) => {
      if (s.streams.get(sessionId) === undefined) return s;
      const next = new Map(s.streams);
      next.delete(sessionId);
      return { streams: next };
    }),
}));

/** 全局动作（zustand action 引用稳定，模块加载即捕获） */
export const appendDelta = useStreamingStore.getState().appendDelta;
export const clearStream = useStreamingStore.getState().clearStream;

/** 读取指定会话当前累积流式文本（非 hook，供非渲染上下文使用） */
export function getStream(sessionId: string): string {
  return useStreamingStore.getState().streams.get(sessionId) ?? '';
}

/** 订阅指定会话的当前累积流式文本；仅该会话内容变化时重渲染 */
export function useStream(sessionId: string | null): string {
  return useStreamingStore((s) => (sessionId === null ? '' : (s.streams.get(sessionId) ?? '')));
}

// 全局层收流：session.event text delta → appendDelta；assistant message.added → clearStream；
// session.deleted（会话被持久删除）→ clearStream，避免已删会话的流式内容残留
subscribeWsEvents((event) => {
  if (event.type === 'session.event') {
    if (event.event.type === 'text' && typeof event.event.delta === 'string') {
      appendDelta(event.session_id, event.event.delta);
    }
  } else if (event.type === 'message.added' && event.message.role === 'assistant') {
    clearStream(event.message.session_id);
  } else if (event.type === 'session.deleted') {
    clearStream(event.session_id);
  }
});
