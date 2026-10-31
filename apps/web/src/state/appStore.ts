import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type WsStatus = 'connecting' | 'open' | 'closed';

interface AppState {
  /** 当前选中工作空间（持久 localStorage） */
  workspaceId: string | null;
  selectWorkspace: (id: string | null) => void;
  wsStatus: WsStatus;
  setWsStatus: (status: WsStatus) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      workspaceId: null,
      selectWorkspace: (id) => set({ workspaceId: id }),
      wsStatus: 'connecting',
      setWsStatus: (wsStatus) => set({ wsStatus }),
    }),
    {
      name: 'agentboard.selected-workspace',
      partialize: (state) => ({ workspaceId: state.workspaceId }),
    },
  ),
);
