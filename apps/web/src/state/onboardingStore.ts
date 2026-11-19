/**
 * 新手引导状态（G2）。
 *
 * 只存瞬时状态：`active` / `stepIndex`；是否「已完成过」落在 localStorage，
 * 键 `ab.onboarding.v1`（值为 `'done'`）。不持久化 store 本身 —— 刷新后重新按 localStorage 判定。
 *
 * `stepIndex` 的语义是**有效步骤数组里的下标**：目标元素不存在的步骤在渲染时被过滤掉
 * （见 `OnboardingTour`），所以这里不关心 selector 是否命中，也就不需要 DOM 依赖。
 */
import { create } from 'zustand';

export const ONBOARDING_STORAGE_KEY = 'ab.onboarding.v1';
export const ONBOARDING_DONE = 'done';
/** 启动延迟：等看板数据渲染完，否则高亮框会定位到空元素 */
export const ONBOARDING_START_DELAY_MS = 800;

export interface OnboardingState {
  active: boolean;
  stepIndex: number;
  /** 开始/重播；已在播放中时重置回合 */
  start: () => void;
  next: () => void;
  prev: () => void;
  /** 走完最后一步或跳过：写 localStorage 并隐藏 */
  finish: () => void;
}

/** localStorage 读写集中在这里，测试可 mock 也可直接读写 jsdom 的 storage */
export function hasCompletedOnboarding(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(ONBOARDING_STORAGE_KEY) === ONBOARDING_DONE;
  } catch {
    // 隐私模式/被禁用时 localStorage 抛错：当作「已完成」，宁可不打扰用户
    return true;
  }
}

export function markOnboardingDone(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, ONBOARDING_DONE);
  } catch {
    /* 写不进去就只影响下次是否自动播放，不影响当前会话 */
  }
}

export function resetOnboarding(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(ONBOARDING_STORAGE_KEY);
  } catch {
    /* 同上 */
  }
}

export const useOnboardingStore = create<OnboardingState>((set) => ({
  active: false,
  stepIndex: 0,
  start: () => set({ active: true, stepIndex: 0 }),
  next: () => set((state) => ({ stepIndex: state.stepIndex + 1 })),
  prev: () => set((state) => ({ stepIndex: Math.max(0, state.stepIndex - 1) })),
  finish: () => {
    markOnboardingDone();
    set({ active: false, stepIndex: 0 });
  },
}));

/** 测试用复位（不碰 localStorage，调用方自行决定是否清键） */
export function resetOnboardingState(): void {
  useOnboardingStore.setState({ active: false, stepIndex: 0 });
}
