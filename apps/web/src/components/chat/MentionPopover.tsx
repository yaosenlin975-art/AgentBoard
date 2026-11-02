/**
 * 联想候选浮窗（CHAT-MENTION）：纯展示 + 键盘高亮由 Composer 持有。
 * 无障碍：listbox/option，`aria-activedescendant` 由调用方设置。
 */
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
  return (
    <div
      data-testid="mention-popover"
      data-kind={kind}
      role="listbox"
      aria-label={`${title}联想`}
      className="absolute bottom-full left-0 z-20 mb-1 max-h-56 w-72 overflow-auto rounded-md border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
    >
      <p className="px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        {title}（{candidates.length}）
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
              ? 'bg-blue-50 text-blue-800 dark:bg-blue-950/50 dark:text-blue-200'
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
