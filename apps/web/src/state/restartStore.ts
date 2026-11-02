/**
 * 重启状态（SYSTEM-RESTART）：重启期间全局禁用写操作。
 * 用 overlay 遮住整个应用（pointer-events 捕获）是最小且可靠的「禁用写操作」实现：
 * 不需要在每个按钮上加 disabled，也不会漏掉某处新增的写入口。
 */
import { create } from 'zustand';

interface RestartState {
  restarting: boolean;
  setRestarting: (value: boolean) => void;
}

export const useRestartStore = create<RestartState>((set) => ({
  restarting: false,
  setRestarting: (value) => set({ restarting: value }),
}));
