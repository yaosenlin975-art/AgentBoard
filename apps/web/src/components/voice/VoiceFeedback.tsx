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

/**
 * 聚焦提示：贴在被聚焦控件正下方的一条小字（fixed 定位，不占流）。
 * `enabled=false` 时完全不挂监听（STT 关闭/无可用模型）。
 */
export function VoiceHint({ enabled }: { enabled: boolean }) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const hintIdRef = useRef(`voice-hint-${Math.random().toString(36).slice(2, 8)}`);
  const describedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled) {
      setAnchor(null);
      return undefined;
    }
    const detach = (): void => {
      const previous = describedRef.current;
      if (previous !== null && previous.isConnected) previous.removeAttribute('aria-describedby');
      describedRef.current = null;
    };
    const onFocusIn = (event: FocusEvent): void => {
      const el = event.target instanceof Element ? event.target : null;
      if (!isVoiceEligibleElement(el)) return;
      const rect = el.getBoundingClientRect();
      setAnchor({ x: Math.round(rect.left), y: Math.round(rect.bottom + 4) });
      detach();
      el.setAttribute('aria-describedby', hintIdRef.current);
      describedRef.current = el;
    };
    const onFocusOut = (): void => {
      setAnchor(null);
      detach();
    };
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
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
      className="pointer-events-none fixed z-[60] rounded bg-surface-card px-1.5 py-0.5 text-[11px] text-ink-3 shadow-sm ring-1 ring-hairline"
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


