/**
 * 联想候选浮窗（CHAT-MENTION）：纯展示 + 键盘高亮由 Composer 持有。
 * 无障碍：listbox/option，`aria-activedescendant` 由调用方设置。
 * CHAT-TRIGGER-8：候选上限由 8 放开到 50，容器 max-h + 可滚动；键盘移动时把高亮项滚进视口。
 */
import { useEffect, useRef } from 'react';
import type { MentionCandidate, MentionKind } from '../../lib/mention';

export function MentionPopover({
  kind,
  candidates,
  activeIndex,
  onPick,
  onHover,
}: {
  kind: MentionKind;
  candidates: MentionCandidate[];
  activeIndex: number;
  onPick: (candidate: MentionCandidate) => void;
  onHover: (index: number) => void;
}) {
  const title = kind === 'skill' ? '技能' : '任务';
  const listRef = useRef<HTMLDivElement | null>(null);

  // 键盘上下移动时把当前高亮项滚进视口（block:'nearest' 不影响已可见项）
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const active = list.querySelector<HTMLElement>(`[data-testid="mention-item-${activeIndex}"]`);
    // jsdom 没有 scrollIntoView：存在才调用（真实浏览器负责把高亮项滚进视口）
    if (typeof active?.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div
      ref={listRef}
      data-testid="mention-popover"
      data-kind={kind}
      role="listbox"
      aria-label={`${title}联想`}
      className="absolute bottom-full left-0 z-20 mb-1 max-h-64 w-72 overflow-y-auto overscroll-contain rounded-md border border-hairline bg-surface-card py-1 shadow-lg"
    >
      <p className="px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        {title}（共 {candidates.length} 项）
      </p>
      {candidates.map((candidate, index) => (
        <button
          key={`${candidate.id}-${index}`}
          type="button"
          role="option"
          id={`mention-option-${index}`}
          aria-selected={index === activeIndex}
          data-testid={`mention-item-${index}`}
          onMouseEnter={() => onHover(index)}
          // 用 onMouseDown 抢在 textarea blur 之前生效
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(candidate);
          }}
          className={`block w-full px-2 py-1 text-left text-xs ${
            index === activeIndex
              ? 'bg-accent-soft text-accent'
              : 'text-neutral-700 dark:text-neutral-200'
          }`}
        >
          <span className="block truncate font-medium">{candidate.label}</span>
          {candidate.hint !== undefined && (
            <span className="block truncate text-[10px] text-neutral-500 dark:text-neutral-400">{candidate.hint}</span>
          )}
        </button>
      ))}
    </div>
  );
}
