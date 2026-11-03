import type { ReactNode } from 'react';

/**
 * UNSLOP-5：键盘键帽（keycap）。
 * 统一表示界面里出现的快捷键：`<kbd>` 语义 + 发丝线边框 + 等宽字体 + 小尺寸。
 * 只做展示，不参与交互，也不进入 tab 顺序。
 */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-hairline bg-surface-card px-1 font-mono text-[10px] leading-none text-ink-3">
      {children}
    </kbd>
  );
}
