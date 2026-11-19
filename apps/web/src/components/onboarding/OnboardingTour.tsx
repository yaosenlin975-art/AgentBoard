/**
 * G2：首次进入的新手引导（遮罩 + 挖洞高亮 + 分步气泡）。
 *
 * 实现要点：
 * - 遮罩与「挖洞」是**同一个元素**：高亮框用 `box-shadow: 0 0 0 9999px rgba(0,0,0,.55)` 铺满全屏，
 *   不拼四块，避免接缝。
 * - 定位只用 `getBoundingClientRect()` + `position: fixed`，不引入 Popper/floating-ui。
 * - 遮罩 `pointer-events: auto` 吞掉底层点击（不关闭、不前进，防误触）；只有气泡里的按钮可点。
 * - `target` 不存在时该步在渲染前被过滤（第 3 步只在看板视图有），不会崩。
 * - resize 与捕获阶段 scroll 都会重算位置（正文/侧栏各自滚动时也能跟住）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ONBOARDING_START_DELAY_MS,
  useOnboardingStore,
} from '../../state/onboardingStore';
import { stepTarget } from './steps';
import { clampStepIndex, resolveVisibleSteps, useOnboardingAutoStart } from './useOnboarding';

/** 高亮框相对目标元素的外扩（px），让描边不贴着元素边缘 */
const HIGHLIGHT_PAD = 4;
const BUBBLE_WIDTH = 320;
const BUBBLE_GAP = 10;
const VIEWPORT_MARGIN = 12;

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface BubblePosition {
  top: number;
  left: number;
}

const TABBABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])';

export function OnboardingTour({ startDelayMs = ONBOARDING_START_DELAY_MS }: { startDelayMs?: number }) {
  useOnboardingAutoStart(startDelayMs);

  const active = useOnboardingStore((state) => state.active);
  const rawIndex = useOnboardingStore((state) => state.stepIndex);
  const next = useOnboardingStore((state) => state.next);
  const prev = useOnboardingStore((state) => state.prev);
  const finish = useOnboardingStore((state) => state.finish);

  // 位置重算的触发器：resize / 捕获阶段 scroll / 步进都会 bump
  const [tick, setTick] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [bubble, setBubble] = useState<BubblePosition | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);

  // 每次渲染重算：目标可能在异步视图切换后出现/消失
  const steps = resolveVisibleSteps();
  const stepIndex = clampStepIndex(rawIndex, steps.length);
  const step = steps[stepIndex];
  const isLast = steps.length > 0 && stepIndex === steps.length - 1;

  useEffect(() => {
    if (!active) return;
    const bump = (): void => setTick((value) => value + 1);
    window.addEventListener('resize', bump);
    // 捕获阶段：内层滚动容器（正文、侧栏）的 scroll 不冒泡到 window
    window.addEventListener('scroll', bump, true);
    return () => {
      window.removeEventListener('resize', bump);
      window.removeEventListener('scroll', bump, true);
    };
  }, [active]);

  // 目标矩形：步进 / 重算 tick / 播放状态变化时更新
  useLayoutEffect(() => {
    if (!active || step === undefined) {
      setBox(null);
      return;
    }
    const target = stepTarget(step);
    if (target === null) {
      setBox(null);
      return;
    }
    const rect = target.getBoundingClientRect();
    setBox({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
  }, [active, step, tick]);

  // 气泡落位：优先在目标下方，放不下就上方，水平夹在视口内
  useLayoutEffect(() => {
    const node = bubbleRef.current;
    if (box === null || node === null) return;
    const height = node.offsetHeight;
    let top = box.top + box.height + HIGHLIGHT_PAD + BUBBLE_GAP;
    if (top + height > window.innerHeight - VIEWPORT_MARGIN) {
      const above = box.top - HIGHLIGHT_PAD - BUBBLE_GAP - height;
      top = above >= VIEWPORT_MARGIN ? above : Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
    }
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - BUBBLE_WIDTH - VIEWPORT_MARGIN);
    const left = Math.min(Math.max(VIEWPORT_MARGIN, box.left), maxLeft);
    setBubble({ top, left });
  }, [box, tick]);

  const goNext = useCallback(() => {
    if (steps.length === 0 || stepIndex >= steps.length - 1) {
      finish();
      return;
    }
    next();
  }, [stepIndex, steps.length, next, finish]);

  const goPrev = useCallback(() => {
    if (stepIndex === 0) return;
    prev();
  }, [stepIndex, prev]);

  // 键盘：Esc 跳过、→/Enter 下一步、← 上一步；Tab 锁在气泡内
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish();
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        goNext();
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goPrev();
        return;
      }
      if (event.key === 'Enter') {
        // 焦点在按钮上时交给原生 click，避免同一次按键推进两步
        if (event.target instanceof HTMLElement && event.target.tagName === 'BUTTON') return;
        event.preventDefault();
        goNext();
        return;
      }
      if (event.key !== 'Tab') return;
      const root = bubbleRef.current;
      if (root === null) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR));
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement;
      if (!(current instanceof HTMLElement) || !root.contains(current)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, goNext, goPrev, finish]);

  // 步进后把焦点放进气泡，键盘用户不至于留在底层元素上
  useEffect(() => {
    if (!active || box === null) return;
    bubbleRef.current?.focus();
  }, [active, box, stepIndex]);

  if (!active || box === null || step === undefined) return null;

  return (
    <div className="fixed inset-0 z-[100]" data-testid="onboarding-overlay">
      {/* 遮罩 + 挖洞：一个元素，box-shadow 铺满其余区域 */}
      <div
        aria-hidden="true"
        data-testid="onboarding-highlight"
        className="pointer-events-none fixed rounded-md transition-[top,left,width,height] duration-150 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"
        style={{
          top: box.top - HIGHLIGHT_PAD,
          left: box.left - HIGHLIGHT_PAD,
          width: box.width + HIGHLIGHT_PAD * 2,
          height: box.height + HIGHLIGHT_PAD * 2,
          boxShadow: '0 0 0 9999px rgba(0,0,0,.55)',
        }}
      />
      <div
        ref={bubbleRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        aria-describedby="onboarding-body"
        tabIndex={-1}
        data-testid="onboarding-bubble"
        data-step={step.id}
        className="fixed z-[101] rounded-lg border border-hairline bg-surface-card p-4 text-ink shadow-xl outline-none"
        style={{
          top: bubble?.top ?? box.top + box.height + HIGHLIGHT_PAD + BUBBLE_GAP,
          left: bubble?.left ?? box.left,
          width: BUBBLE_WIDTH,
        }}
      >
        <p className="text-xs tabular-nums text-ink-3">
          {stepIndex + 1} / {steps.length}
        </p>
        <h2 id="onboarding-title" className="mt-1 text-sm font-semibold text-ink">
          {step.title}
        </h2>
        <p id="onboarding-body" className="mt-1 text-sm leading-6 text-ink-2">
          {step.body}
        </p>
        <div className="mt-3 flex items-center justify-between">
          <button
            type="button"
            data-testid="onboarding-skip"
            onClick={finish}
            className="rounded px-1.5 py-1 text-xs text-ink-3 transition-colors duration-150 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent motion-reduce:transition-none"
          >
            跳过
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="onboarding-prev"
              onClick={goPrev}
              disabled={stepIndex === 0}
              className="rounded border border-hairline px-2.5 py-1 text-xs text-ink transition-colors duration-150 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
            >
              上一步
            </button>
            <button
              type="button"
              data-testid="onboarding-next"
              onClick={goNext}
              className="rounded border border-accent bg-accent px-2.5 py-1 text-xs font-medium text-accent-ink transition-colors duration-150 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent motion-reduce:transition-none"
            >
              {isLast ? '完成' : '下一步'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
