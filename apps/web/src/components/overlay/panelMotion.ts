/**
 * 浮窗进出场过渡（PANEL-MOTION-2）。
 * 左浮窗（工作空间列表）与右浮窗（任务详情/聊天）共用同一套时长/缓动 token，避免两窗节奏不一致。
 * - 时长 160ms（要求区间 120–200ms），位移 + 透明度组合；
 * - `prefers-reduced-motion: reduce` 命中时不做位移、不做过渡（瞬时切换）；
 * - 关闭时保留挂载到出场动画结束（presence），避免「一关就消失、没有出场」；
 * - 只用 transform/opacity，不动 width/height，保证主内容不重排（PANEL-FLOAT 语义：浮窗不占布局）。
 */
import { useEffect, useState, type CSSProperties } from 'react';

export const PANEL_MOTION_MS = 160;
export const PANEL_MOTION_EASE = 'cubic-bezier(0.2, 0, 0, 1)';
/** 两窗共用的过渡声明（测试断言同一 token 用） */
export const PANEL_MOTION_TRANSITION =
  `transform ${PANEL_MOTION_MS}ms ${PANEL_MOTION_EASE}, opacity ${PANEL_MOTION_MS}ms ${PANEL_MOTION_EASE}`;

export type PanelMotionPhase = 'entering' | 'open' | 'leaving';
export type PanelMotionDirection = 'drop' | 'slide-right';

const HIDDEN_OFFSET: Record<PanelMotionDirection, string> = {
  // 左浮窗挂在触发按钮正下方：自上而下 8px 落下
  drop: 'translateY(-8px)',
  // 右浮窗贴右侧边缘：自右向左 16px 滑入
  'slide-right': 'translateX(16px)',
};

/** 系统是否要求减少动态效果（jsdom 的 matchMedia 桩返回 false → 走完整动画分支） */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (): void => setReduced(mql.matches === true);
    mql.addEventListener?.('change', onChange);
    onChange();
    return () => mql.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

/**
 * 挂载与相位：open=true → mounted + entering →（下一帧）open；
 * open=false → leaving →（动画结束）卸载。reducedMotion 时直接卸载（无出场动画）。
 */
export function usePanelPresence(
  open: boolean,
  reducedMotion: boolean,
  durationMs: number = PANEL_MOTION_MS,
): { mounted: boolean; phase: PanelMotionPhase } {
  const [mounted, setMounted] = useState(open);
  const [phase, setPhase] = useState<PanelMotionPhase>(open ? 'open' : 'leaving');

  useEffect(() => {
    if (open) {
      setMounted(true);
      setPhase('entering');
      // 双 rAF：先让浏览器用「隐藏态」（位移 + 透明）绘制一帧，再切到 open 才会产生过渡
      let inner = 0;
      const outer = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(() => {
            inner = requestAnimationFrame(() => setPhase('open'));
          })
        : (setTimeout(() => setPhase('open'), 0) as unknown as number);
      return () => {
        if (typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(outer as number);
          if (inner !== 0) cancelAnimationFrame(inner);
        } else {
          clearTimeout(outer as unknown as ReturnType<typeof setTimeout>);
        }
      };
    }
    if (!mounted) {
      setPhase('leaving');
      return;
    }
    setPhase('leaving');
    if (reducedMotion) {
      setMounted(false);
      return;
    }
    const timer = setTimeout(() => setMounted(false), durationMs);
    return () => clearTimeout(timer);
  }, [open, reducedMotion, durationMs, mounted]);

  return { mounted, phase };
}

/** 相位 → 内联样式（位移 + 透明度；reduced-motion 时退化为瞬时） */
export function panelMotionStyle(
  direction: PanelMotionDirection,
  phase: PanelMotionPhase,
  reducedMotion: boolean,
): CSSProperties {
  if (reducedMotion) return { opacity: 1, transform: 'none', transition: 'none' };
  const hidden = phase !== 'open';
  return {
    opacity: hidden ? 0 : 1,
    transform: hidden ? HIDDEN_OFFSET[direction] : 'none',
    transition: PANEL_MOTION_TRANSITION,
    // 只有出场阶段屏蔽命中：进场时（entering）已经开始接受点击/焦点，避免刚打开点不动
    pointerEvents: phase === 'leaving' ? 'none' : 'auto',
  };
}
