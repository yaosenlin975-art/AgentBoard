/**
 * WS 事件进程内总线：App 级 connectWs(onEvent) 把每个 WsEvent 灌进来，
 * 需要原始事件（而非 react-query invalidation）的组件经 useWsEvent 订阅。
 * 聊天视图流式渲染（session.event / message.added）走此通道（Task 14）。
 */
import { useEffect, useRef } from 'react';
import type { WsEvent } from '@agentboard/shared';

type WsListener = (event: WsEvent) => void;

const listeners = new Set<WsListener>();

/** App 级 WS 回调调用；测试也可直接调用以模拟 WS 事件 */
export function emitWsEvent(event: WsEvent): void {
  for (const listener of listeners) listener(event);
}

/** 订阅 WS 事件；组件卸载自动退订。handler 引用不触发重订阅 */
export function subscribeWsEvents(listener: WsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React 订阅 hook：handler 用 ref 持有，闭包内读到的总是最新渲染的值 */
export function useWsEvent(handler: WsListener): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribeWsEvents((event) => ref.current(event)), []);
}
