/**
 * G2：新手引导的启动/过滤逻辑。
 *
 * - `useOnboardingAutoStart`：首次展示前延迟 800ms 启动；
 *   StrictMode 下 effect 双跑也只留一个定时器（cleanup 清掉前一个）。
 * - `resolveVisibleSteps`：把目标元素不存在的步骤过滤掉（第 3 步只在看板视图存在）。
 */
import { useEffect } from 'react';
import {
  ONBOARDING_START_DELAY_MS,
  hasSeenOnboarding,
  useOnboardingStore,
} from '../../state/onboardingStore';
import { ONBOARDING_STEPS, stepTarget, type OnboardingStep } from './steps';

export function useOnboardingAutoStart(delayMs: number = ONBOARDING_START_DELAY_MS): void {
  const start = useOnboardingStore((state) => state.start);
  useEffect(() => {
    if (hasSeenOnboarding()) return;
    const timer = window.setTimeout(() => {
      // 期间用户可能已手动重播过，别重置到第 1 步
      if (!useOnboardingStore.getState().active && !hasSeenOnboarding()) start();
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, start]);
}

/** 当前文档里目标存在的步骤；目标缺失的步骤在这一层被跳过 */
export function resolveVisibleSteps(): OnboardingStep[] {
  return ONBOARDING_STEPS.filter((step) => stepTarget(step) !== null);
}

/** 把下标夹在有效范围内（步骤表在播放期间可能变短） */
export function clampStepIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}
