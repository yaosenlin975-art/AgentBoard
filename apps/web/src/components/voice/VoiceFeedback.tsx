/**
 * VOICE-UI-3：输入框语音提示 + 录音音波动画。
 *
 * - `VoiceHint`：STT 开启且模型可用时，聚焦可语音输入的控件后显示轻量提示「长按可语音输入」。
 *   形态选择：**浮层小字 + aria-describedby**（不用 placeholder 追加）—— placeholder 一旦追加，
 *   用户输入后 placeholder 消失、提示也跟着消失，且会改变原 placeholder 语义；浮层用 `position: fixed`
 *   贴在被聚焦控件的正下方，不占文档流、不改输入框高度、不遮内容，并让读屏通过 `aria-describedby` 关联。
 * - `VoiceMicWave`：录音中按实时电平驱动一组竖条（高度 = 电平 × 基准高），**只在 recording 期间跑 rAF**，
 *   松手（active=false）立刻 cancelAnimationFrame 并清空；`prefers-reduced-motion: reduce` 时不做连续动画，
 *   只按电平分成 3 档离散变化。
 */
import { useEffect, useRef, useState } from 'react';

/** 竖条数量与基准高度（px） */
export const WAVE_BARS = 5;
const BAR_BASE = 6;
const BAR_MAX = 20;

/** 可语音输入的控件选择器（与 useLongPressVoice 的判定保持一致） */
const ELIGIBLE = 'input:not([type]), input[type="text"], input[type="search"], textarea, [contenteditable="true"], [contenteditable=""]';

export function isVoiceEligibleElement(el: Element | null): el is HTMLElement {
  if (el === null) return false;
  if (!(el instanceof HTMLElement)) return false;
  if (el.matches('input')) {
    const type = el.getAttribute('type');
    return type === null || type === 'text' || type === 'search';
  }
  return el.matches('textarea, [contenteditable="true"], [contenteditable=""]');
}

/** 当前是否偏好减少动态效果（测试可注入） */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 提示与锚点底边的间距（px） */
const HINT_GAP = 4;

/**
 * 锚点可视性的硬判据：任何一条不成立就**不显示**，而不是留在原地。
 * 顺序有讲究——先排除「没有有效盒子」的情况（CHAT-MICPOP-2 的根因：零尺寸矩形的
 * `left/bottom` 都是 0，直接参与计算会把提示画到 `(0, 4)`，也就是钉在视口左上角）。
 */
function resolveHintPosition(el: HTMLElement): { x: number; y: number } | null {
  if (!el.isConnected) return null;
  const rect = el.getBoundingClientRect();
  // 1) 没有布局盒（display:none / 折叠中 / 尚未布局）：算不出锚点，必须隐藏
  if (rect.width <= 0 || rect.height <= 0) return null;
  // 2) 完全移出可视区（任何一边）
  if (rect.bottom <= 0 || rect.top >= window.innerHeight) return null;
  if (rect.right <= 0 || rect.left >= window.innerWidth) return null;
  // 3) 被某个裁剪祖先（滚动容器/overflow:hidden）完全裁掉
  if (isFullyClipped(el, rect)) return null;
  return { x: Math.round(rect.left), y: Math.round(rect.bottom + HINT_GAP) };
}

/**
 * 锚点是否被某个「裁剪祖先」完全裁掉。
 * 只判「完全不可见」：部分可见时仍贴合显示，避免把提示做成时有时无。
 * `clientWidth/clientHeight` 为 0 的容器（含 jsdom 这种无布局环境）跳过判定。
 */
function isFullyClipped(el: HTMLElement, rect: DOMRect): boolean {
  let node = el.parentElement;
  while (node !== null && node !== document.body && node !== document.documentElement) {
    const style = window.getComputedStyle(node);
    const clipsX = style.overflowX !== 'visible';
    const clipsY = style.overflowY !== 'visible';
    if ((clipsX || clipsY) && node.clientWidth > 0 && node.clientHeight > 0) {
      const box = node.getBoundingClientRect();
      const left = box.left + node.clientLeft;
      const top = box.top + node.clientTop;
      const visibleX = !clipsX || (rect.left < left + node.clientWidth && rect.right > left);
      const visibleY = !clipsY || (rect.top < top + node.clientHeight && rect.bottom > top);
      if (!visibleX || !visibleY) return true;
    }
    node = node.parentElement;
  }
  return false;
}

/**
 * 聚焦提示：贴在被聚焦控件正下方的一条小字（fixed 定位，不占流）。
 * `enabled=false` 时完全不挂监听（STT 关闭/无可用模型）。
 *
 * 跟随锚点（CHAT-MICPOP / CHAT-MICPOP-2）：
 * - 保存锚点控件而不是一次性坐标，在 `scroll`（在 document 上以 capture 监听，实测 Chromium
 *   会把内部滚动容器的事件投递给 document 的捕获阶段，`window` 也会收到）/ `resize` /
 *   `ResizeObserver` 的真实事件里重算，不用 setInterval 轮询（不引入计时器漂移）。
 * - 坐标与可见性必须一起重算：只重算位置会把「无效/被裁掉的锚点」也算成有效坐标。
 * - 层级固定 `z-[35]`：高于面板内浮层（z-20/30），低于抽屉与浮层容器（z-40）和 Modal（z-50），
 *   打开抽屉/弹窗时提示会被盖住，而不是压在最上面。
 * - 位置更新是即时的、不引入过渡动画，因此 `prefers-reduced-motion` 下与常规行为一致，无需额外分支。
 */
export function VoiceHint({ enabled }: { enabled: boolean }) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const hintIdRef = useRef(`voice-hint-${Math.random().toString(36).slice(2, 8)}`);
  const describedRef = useRef<HTMLElement | null>(null);
  const anchorElRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled) {
      anchorElRef.current = null;
      setAnchor(null);
      return undefined;
    }
    let observer: ResizeObserver | null = null;
    const detach = (): void => {
      const previous = describedRef.current;
      if (previous !== null && previous.isConnected) previous.removeAttribute('aria-describedby');
      describedRef.current = null;
    };
    /** 按锚点控件当前矩形重算坐标与可见性；无效锚点一律隐藏，避免提示悬空错位 */
    const syncAnchor = (): void => {
      const el = anchorElRef.current;
      if (el === null) return;
      const next = resolveHintPosition(el);
      setAnchor((previous) => {
        if (next === null) return null;
        if (previous !== null && previous.x === next.x && previous.y === next.y) return previous;
        return next;
      });
    };
    /** 锚点可能切换（从一个输入框换到另一个），RO 观察对象随之切换 */
    const observeAnchor = (el: HTMLElement): void => {
      if (typeof ResizeObserver !== 'function') return;
      observer?.disconnect();
      observer = new ResizeObserver(() => { syncAnchor(); });
      observer.observe(el);
    };
    const onFocusIn = (event: FocusEvent): void => {
      const el = event.target instanceof Element ? event.target : null;
      if (!isVoiceEligibleElement(el)) return;
      anchorElRef.current = el;
      syncAnchor();
      observeAnchor(el);
      detach();
      el.setAttribute('aria-describedby', hintIdRef.current);
      describedRef.current = el;
    };
    const onFocusOut = (): void => {
      anchorElRef.current = null;
      observer?.disconnect();
      setAnchor(null);
      detach();
    };
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    // capture 阶段：任意滚动容器的滚动都能命中，不只是 window
    document.addEventListener('scroll', syncAnchor, true);
    window.addEventListener('resize', syncAnchor);
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('scroll', syncAnchor, true);
      window.removeEventListener('resize', syncAnchor);
      observer?.disconnect();
      observer = null;
      detach();
    };
  }, [enabled]);

  if (!enabled || anchor === null) return null;
  return (
    <div
      id={hintIdRef.current}
      data-testid="voice-hint"
      role="note"
      style={{ left: anchor.x, top: anchor.y }}
      className="pointer-events-none fixed z-[35] rounded bg-surface-card px-1.5 py-0.5 text-[11px] text-ink-3 shadow-sm ring-1 ring-hairline"
    >
      长按可语音输入
    </div>
  );
}

/**
 * 录音音波：active 期间用 rAF 逐帧读取电平并直接写 DOM（不触发 React 重渲染）。
 * 每帧计数写到 `window.__voiceWaveFrames` 供真机取证（松手后不再增长）。
 */
export function VoiceMicWave({ active, getLevel }: { active: boolean; getLevel: () => number }) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const frameRef = useRef<number | null>(null);
  const reduce = prefersReducedMotion();

  useEffect(() => {
    if (!active) {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      return undefined;
    }
    const w = window as unknown as { __voiceWaveFrames?: number };
    w.__voiceWaveFrames = 0;

    const paint = (level: number): void => {
      const clamped = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
      const heights = Array.from({ length: WAVE_BARS }, (_, index) => {
        // 中间高两侧低的固定权重，避免每帧随机
        const weight = 1 - Math.abs(index - (WAVE_BARS - 1) / 2) / ((WAVE_BARS - 1) / 2);
        const value = reduce ? Math.round(clamped * 3) / 3 : clamped; // reduce：3 档离散
        return Math.round(BAR_BASE + (BAR_MAX - BAR_BASE) * value * (0.45 + 0.55 * weight));
      });
      barsRef.current.forEach((bar, index) => {
        if (bar !== null) bar.style.height = `${heights[index]}px`;
      });
    };

    if (reduce) {
      // 减少动态效果：不跑 rAF，只在电平档位变化时更新一次
      let lastStep = -1;
      const timer = setInterval(() => {
        const step = Math.round(Math.max(0, Math.min(1, getLevel())) * 3);
        if (step === lastStep) return;
        lastStep = step;
        paint(step / 3);
      }, 200);
      return () => clearInterval(timer);
    }

    const loop = (): void => {
      paint(getLevel());
      w.__voiceWaveFrames = (w.__voiceWaveFrames ?? 0) + 1;
      frameRef.current = requestAnimationFrame(loop);
    };
    frameRef.current = requestAnimationFrame(loop);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [active, getLevel, reduce]);

  if (!active) return null;
  return (
    <span data-testid="voice-wave" aria-hidden="true" className="flex h-5 items-end gap-0.5">
      {Array.from({ length: WAVE_BARS }, (_, index) => (
        <span
          key={index}
          ref={(node) => { barsRef.current[index] = node; }}
          data-testid={`voice-wave-bar-${index}`}
          className="w-1 rounded-full bg-accent transition-[height] duration-100 motion-reduce:transition-none"
          style={{ height: BAR_BASE }}
        />
      ))}
    </span>
  );
}


