/**
 * UNSLOP 线性图标集（pass 3）：**内联 SVG，不引第三方图标依赖**。
 * 统一 16px、stroke 1.5、`currentColor`（取次级/弱化文字色），图标盒等宽，标签对齐。
 * 只放界面真正需要的少数几个：锁 / 评论 / 闪电（关联会话）/ 折叠箭头 / 三态能力（✓ ✗ ?）。
 */
import type { SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number };

function base({ size = 16, className, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
    className: className === undefined ? 'shrink-0' : `shrink-0 ${className}`,
    ...rest,
  };
}

/** 依赖锁（被阻塞） */
export function IconLock(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3.25" y="7" width="9.5" height="6.25" rx="1.5" />
      <path d="M5.75 7V5.25a2.25 2.25 0 0 1 4.5 0V7" />
    </svg>
  );
}

/** 评论数 */
export function IconComment(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M13.25 8.5a4.75 4.75 0 0 1-4.75 4.75H6.5L3 14.5l.75-2.75A4.75 4.75 0 1 1 13.25 8.5Z" />
    </svg>
  );
}

/** 关联会话 */
export function IconBolt(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M8.75 1.75 3.5 9h3.25l-.5 5.25L11.5 7H8.25l.5-5.25Z" />
    </svg>
  );
}

/** 折叠箭头（向下；向上用 rotate-180 类） */
export function IconChevronDown(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m4 6.25 4 4 4-4" />
    </svg>
  );
}

/** 能力可用 */
export function IconCheck(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m3.25 8.5 3 3 6.5-7" />
    </svg>
  );
}

/** 能力不可用 */
export function IconCross(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m4.25 4.25 7.5 7.5M11.75 4.25l-7.5 7.5" />
    </svg>
  );
}

/** 能力未知 */
export function IconQuestion(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6.25 6a1.75 1.75 0 1 1 2.6 1.55c-.5.3-.85.85-.85 1.45v.35" />
      <circle cx="8" cy="12.1" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}
