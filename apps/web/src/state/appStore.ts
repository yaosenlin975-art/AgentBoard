import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type WsStatus = 'connecting' | 'open' | 'closed';

/** 未选中标签时的空选择（稳定引用，避免 zustand 选择器每次返回新数组） */
export const NO_SELECTED_LABELS: readonly string[] = [];

interface AppState {
  /** 当前选中工作空间（持久 localStorage） */
  workspaceId: string | null;
  selectWorkspace: (id: string | null) => void;
  wsStatus: WsStatus;
  setWsStatus: (status: WsStatus) => void;
  /** 标签筛选选择，按工作空间隔离：切换工作空间不串台；空数组 = 显示全部 */
  selectedLabelsByWorkspace: Record<string, readonly string[]>;
  /** 多选 OR 语义：命中任一选中标签即显示；再次点击取消 */
  toggleLabel: (workspaceId: string, label: string) => void;
  clearLabels: (workspaceId: string) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      workspaceId: null,
      selectWorkspace: (id) => set({ workspaceId: id }),
      wsStatus: 'connecting',
      setWsStatus: (wsStatus) => set({ wsStatus }),
      selectedLabelsByWorkspace: {},
      toggleLabel: (workspaceId, label) =>
        set((state) => {
          const current = state.selectedLabelsByWorkspace[workspaceId] ?? [];
          const next = current.includes(label)
            ? current.filter((item) => item !== label)
            : [...current, label];
          return { selectedLabelsByWorkspace: { ...state.selectedLabelsByWorkspace, [workspaceId]: next } };
        }),
      clearLabels: (workspaceId) =>
        set((state) => ({
          selectedLabelsByWorkspace: { ...state.selectedLabelsByWorkspace, [workspaceId]: [] },
        })),
    }),
    {
      name: 'agentboard.selected-workspace',
      partialize: (state) => ({ workspaceId: state.workspaceId }),
    },
  ),
);
