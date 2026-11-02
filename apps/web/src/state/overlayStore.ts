/**
 * 浮窗开关状态（PANEL-FLOAT）。
 * 左浮窗＝工作空间列表（由 TopBar「工作空间」按钮开合）；右浮窗＝任务详情/聊天（由任务卡/聊天入口开合）。
 * 两个浮窗最多同时开一个：互斥在 store 内保证，不依赖各组件自觉。
 * 不持久化：浮窗是瞬时 UI，刷新后回到「都关闭」。
 */
import { create } from 'zustand';

export interface OverlayState {
  left: boolean;
  right: boolean;
  openLeft: () => void;
  openRight: () => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  closeLeft: () => void;
  closeRight: () => void;
  closeAll: () => void;
}

export const useOverlayStore = create<OverlayState>((set) => ({
  left: false,
  right: false,
  openLeft: () => set({ left: true, right: false }),
  openRight: () => set({ right: true, left: false }),
  toggleLeft: () => set((state) => (state.left ? { left: false } : { left: true, right: false })),
  toggleRight: () => set((state) => (state.right ? { right: false } : { right: true, left: false })),
  closeLeft: () => set({ left: false }),
  closeRight: () => set({ right: false }),
  closeAll: () => set({ left: false, right: false }),
}));

/** 测试与切换工作区时的复位 */
export function resetOverlays(): void {
  useOverlayStore.setState({ left: false, right: false });
}
