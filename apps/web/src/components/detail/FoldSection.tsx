/**
 * 详情折叠区（D3）：关联会话 / 附件 / 原始 JSON / 审计证据 共用同一个折叠壳。
 *
 * - 默认收起；标题右侧显示「展开 / 收起」。
 * - 展开动效：grid-template-rows 0fr → 1fr，160ms cubic-bezier(0.2,0,0,1)；prefers-reduced-motion 压到 1ms。
 * - 收起时内容仍挂载（动画需要），但整块 `inert`，不会被 tab 聚焦、也不进可访问性树。
 */
import { useState, type ReactNode } from 'react';

export interface FoldSectionProps {
  title: string;
  testId: string;
  /** 标题后缀计数（如会话数），可选 */
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function FoldSection({ title, testId, count, defaultOpen = false, children }: FoldSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = `${testId}-body`;

  return (
    <section data-testid={testId} aria-label={title} className="border-t border-hairline pt-1.5">
      <button
        type="button"
        data-testid={`${testId}-toggle`}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-2 py-1 text-left text-[11.5px] font-semibold text-ink-2 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className={`inline-block text-[9px] transition-transform duration-[160ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:duration-[1ms] ${open ? 'rotate-90' : ''}`}
          >
            ▸
          </span>
          <span className="truncate">{title}</span>
          {count !== undefined && <span className="font-normal text-ink-3">（{count}）</span>}
        </span>
        <span className="shrink-0 text-[10.5px] font-normal text-ink-3">{open ? '收起' : '展开'}</span>
      </button>
      <div
        id={bodyId}
        data-testid={`${testId}-body`}
        className={`grid transition-[grid-template-rows] duration-[160ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:duration-[1ms] ${
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="min-h-0 overflow-hidden" inert={open ? undefined : true}>
          <div className="pb-2 pt-1">{children}</div>
        </div>
      </div>
    </section>
  );
}
