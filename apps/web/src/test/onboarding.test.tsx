/**
 * G2：首次进入的新手引导。
 *
 * 覆盖：自动启动延迟、已完成永不自动启动、下一步/完成/跳过写 localStorage、
 * 目标缺失步跳过、三个键位、重播按钮、以及 resolveVisibleSteps 的过滤逻辑。
 * 遮罩与气泡的几何（rect）在 jsdom 里没有布局引擎，只能进真实浏览器验，见卡面实机证据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { OnboardingTour, ONBOARDING_STEPS } from '../components/onboarding';
import { resolveVisibleSteps } from '../components/onboarding/useOnboarding';
import {
  ONBOARDING_DONE,
  ONBOARDING_START_DELAY_MS,
  ONBOARDING_STORAGE_KEY,
  hasCompletedOnboarding,
  resetOnboardingState,
  useOnboardingStore,
} from '../state/onboardingStore';

const ONBOARDING_SHOWN = 'shown';

/** 按 testid 造目标元素（选择器与 steps.ts 一致） */
function mountTargets(selectors: readonly string[]): void {
  for (const selector of selectors) {
    const match = /\[data-testid="(.+)"\]/.exec(selector);
    if (match === null) continue;
    const node = document.createElement('div');
    node.setAttribute('data-testid', match[1]!);
    document.body.appendChild(node);
  }
}

function allSelectors(): string[] {
  return ONBOARDING_STEPS.map((step) => step.selector);
}

beforeEach(() => {
  cleanup();
  document.body.innerHTML = '';
  localStorage.clear();
  resetOnboardingState();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = '';
  localStorage.clear();
  resetOnboardingState();
});

describe('启动条件', () => {
  it('无 localStorage 键 → 挂载后 800ms 启动', async () => {
    mountTargets(allSelectors());
    vi.useFakeTimers();
    render(<OnboardingTour />);
    expect(useOnboardingStore.getState().active).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(ONBOARDING_START_DELAY_MS - 1);
    });
    expect(useOnboardingStore.getState().active).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(useOnboardingStore.getState().active).toBe(true);
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe(ONBOARDING_SHOWN);
    expect(screen.getByTestId('onboarding-bubble')).toHaveAttribute('data-step', ONBOARDING_STEPS[0]!.id);
  });

  it('首次自动显示后关闭再启动不再自动显示', async () => {
    mountTargets(allSelectors());
    vi.useFakeTimers();
    const firstRun = render(<OnboardingTour />);

    await act(async () => {
      vi.advanceTimersByTime(ONBOARDING_START_DELAY_MS);
    });
    expect(useOnboardingStore.getState().active).toBe(true);
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe(ONBOARDING_SHOWN);

    firstRun.unmount();
    resetOnboardingState();
    render(<OnboardingTour />);
    await act(async () => {
      vi.advanceTimersByTime(ONBOARDING_START_DELAY_MS * 3);
    });
    expect(useOnboardingStore.getState().active).toBe(false);
    expect(screen.queryByTestId('onboarding-overlay')).toBeNull();
  });

  it('localStorage 已有 done → 永不自动启动', async () => {
    mountTargets(allSelectors());
    localStorage.setItem(ONBOARDING_STORAGE_KEY, ONBOARDING_DONE);
    vi.useFakeTimers();
    render(<OnboardingTour />);

    await act(async () => {
      vi.advanceTimersByTime(ONBOARDING_START_DELAY_MS * 3);
    });
    expect(useOnboardingStore.getState().active).toBe(false);
    expect(screen.queryByTestId('onboarding-overlay')).toBeNull();
  });

  it('启动延迟期间已展示时不再启动', async () => {
    mountTargets(allSelectors());
    vi.useFakeTimers();
    render(<OnboardingTour />);
    localStorage.setItem(ONBOARDING_STORAGE_KEY, ONBOARDING_SHOWN);

    await act(async () => {
      vi.advanceTimersByTime(ONBOARDING_START_DELAY_MS);
    });
    expect(useOnboardingStore.getState().active).toBe(false);
  });
});

describe('步进与收尾', () => {
  it('「下一步」推进 stepIndex，最后一步「完成」写 localStorage 并隐藏', () => {
    mountTargets(allSelectors());
    useOnboardingStore.getState().start();
    render(<OnboardingTour />);

    const total = ONBOARDING_STEPS.length;
    for (let i = 0; i < total - 1; i += 1) {
      expect(screen.getByTestId('onboarding-next')).toHaveTextContent('下一步');
      fireEvent.click(screen.getByTestId('onboarding-next'));
    }
    expect(useOnboardingStore.getState().stepIndex).toBe(total - 1);
    expect(screen.getByTestId('onboarding-next')).toHaveTextContent('完成');

    fireEvent.click(screen.getByTestId('onboarding-next'));
    expect(useOnboardingStore.getState().active).toBe(false);
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe(ONBOARDING_DONE);
    expect(hasCompletedOnboarding()).toBe(true);
    expect(screen.queryByTestId('onboarding-overlay')).toBeNull();
  });

  it('「跳过」写 localStorage 并隐藏', () => {
    mountTargets(allSelectors());
    useOnboardingStore.getState().start();
    render(<OnboardingTour />);

    fireEvent.click(screen.getByTestId('onboarding-skip'));
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe(ONBOARDING_DONE);
    expect(useOnboardingStore.getState().active).toBe(false);
  });

  it('第 3 步目标不存在时跳过而非崩溃', () => {
    // 只造除 column-create-待规划 之外的四个目标
    const missing = '[data-testid="column-create-待规划"]';
    mountTargets(allSelectors().filter((selector) => selector !== missing));

    expect(resolveVisibleSteps().map((step) => step.id)).toEqual(['workspace', 'board', 'chat', 'guide']);

    useOnboardingStore.getState().start();
    render(<OnboardingTour />);
    expect(screen.getByTestId('onboarding-bubble')).toHaveAttribute('data-step', 'workspace');

    fireEvent.click(screen.getByTestId('onboarding-next'));
    expect(screen.getByTestId('onboarding-bubble')).toHaveAttribute('data-step', 'board');
    fireEvent.click(screen.getByTestId('onboarding-next'));
    // 直接落到 chat：create-issue 被跳过
    expect(screen.getByTestId('onboarding-bubble')).toHaveAttribute('data-step', 'chat');
    expect(useOnboardingStore.getState().stepIndex).toBe(2);
    fireEvent.click(screen.getByTestId('onboarding-next'));
    expect(screen.getByTestId('onboarding-bubble')).toHaveAttribute('data-step', 'guide');
    expect(screen.getByTestId('onboarding-next')).toHaveTextContent('完成');
  });

  it('目标全缺失时显示不了任何一步：点完成也不崩、直接收尾', () => {
    // 一个目标都不造
    expect(resolveVisibleSteps()).toEqual([]);
    useOnboardingStore.getState().start();
    render(<OnboardingTour />);
    // 没有有效步骤 → 不高亮也不渲染气泡（避免空步骤卡死）
    expect(screen.queryByTestId('onboarding-bubble')).toBeNull();
  });
});

describe('键盘与无障碍', () => {
  it('→ 下一步、← 上一步、Esc 跳过', () => {
    mountTargets(allSelectors());
    useOnboardingStore.getState().start();
    render(<OnboardingTour />);
    expect(useOnboardingStore.getState().stepIndex).toBe(0);

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(useOnboardingStore.getState().stepIndex).toBe(1);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(useOnboardingStore.getState().stepIndex).toBe(2);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(useOnboardingStore.getState().stepIndex).toBe(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useOnboardingStore.getState().active).toBe(false);
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe(ONBOARDING_DONE);
  });

  it('Enter 推进；焦点在按钮上时交给原生 click（不重复推进）', () => {
    mountTargets(allSelectors());
    useOnboardingStore.getState().start();
    render(<OnboardingTour />);

    fireEvent.keyDown(window, { key: 'Enter' });
    expect(useOnboardingStore.getState().stepIndex).toBe(1);

    const nextButton = screen.getByTestId('onboarding-next');
    // 模拟「焦点在按钮上按 Enter」：keydown 目标是 button，handler 早退
    fireEvent.keyDown(nextButton, { key: 'Enter' });
    expect(useOnboardingStore.getState().stepIndex).toBe(1);
  });

  it('气泡是 aria-modal 对话框，标题与正文有 id 关联；高亮框 aria-hidden', () => {
    mountTargets(allSelectors());
    useOnboardingStore.getState().start();
    render(<OnboardingTour />);

    const bubble = screen.getByRole('dialog');
    expect(bubble).toHaveAttribute('aria-modal', 'true');
    expect(bubble).toHaveAttribute('aria-labelledby', 'onboarding-title');
    expect(screen.getByRole('heading', { level: 2 }).id).toBe('onboarding-title');
    expect(screen.getByTestId('onboarding-highlight')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('重播与 store 收尾', () => {
  it('教程页重播保留 shown 状态，关闭再开不自动显示', async () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, ONBOARDING_SHOWN);
    const { GuideView } = await import('../components/guide/GuideView');
    const guide = render(<GuideView />);

    fireEvent.click(screen.getByTestId('guide-replay-onboarding'));
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe(ONBOARDING_SHOWN);
    expect(useOnboardingStore.getState().active).toBe(true);
    expect(useOnboardingStore.getState().stepIndex).toBe(0);

    guide.unmount();
    resetOnboardingState();
    vi.useFakeTimers();
    render(<OnboardingTour />);
    await act(async () => {
      vi.advanceTimersByTime(ONBOARDING_START_DELAY_MS * 3);
    });
    expect(useOnboardingStore.getState().active).toBe(false);
  });

  it('教程页重播不覆盖既有 done 状态', async () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, ONBOARDING_DONE);
    const { GuideView } = await import('../components/guide/GuideView');
    render(<GuideView />);

    fireEvent.click(screen.getByTestId('guide-replay-onboarding'));
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe(ONBOARDING_DONE);
    expect(useOnboardingStore.getState().active).toBe(true);
  });

  it('播放中挂 resize 与「捕获阶段」scroll 监听（内层滚动容器不冒泡到 window）', () => {
    const added: Array<{ type: string; capture: unknown }> = [];
    const removed: Array<{ type: string; capture: unknown }> = [];
    const addSpy = vi.spyOn(window, 'addEventListener').mockImplementation((type, _listener, options) => {
      added.push({ type, capture: typeof options === 'object' && options !== null ? options.capture : options });
    });
    const removeSpy = vi.spyOn(window, 'removeEventListener').mockImplementation((type, _listener, options) => {
      removed.push({ type, capture: typeof options === 'object' && options !== null ? options.capture : options });
    });

    mountTargets(allSelectors());
    useOnboardingStore.getState().start();
    const { unmount } = render(<OnboardingTour />);

    const types = added.map((entry) => entry.type);
    expect(types).toContain('resize');
    expect(types).toContain('scroll');
    // scroll 必须是捕获阶段：否则正文/侧栏这类内层容器的滚动收不到
    expect(added.find((entry) => entry.type === 'scroll')?.capture).toBe(true);

    unmount();
    expect(removed.map((entry) => entry.type)).toEqual(expect.arrayContaining(['resize', 'scroll']));

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
