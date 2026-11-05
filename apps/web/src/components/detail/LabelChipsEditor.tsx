/**
 * F-07：标签 chips 编辑器（替代「逗号分隔」输入框）。
 * - 已有标签渲染成 chip（与任务卡 chips 同一视觉），每枚可点 × 删除；
 * - 输入框回车/中英文逗号成 chip，自动 trim + 去重（大小写不同视为不同标签）；
 * - 联想 = workspace 已有标签（datalist），空输入按 Backspace 删最后一枚。
 */
import { useState, type KeyboardEvent } from 'react';

export function LabelChipsEditor({
  labels,
  suggestions,
  onChange,
}: {
  labels: string[];
  suggestions: string[];
  onChange: (labels: string[]) => void;
}) {
  const [input, setInput] = useState('');

  const add = (raw: string): void => {
    const value = raw.trim();
    if (value === '') return;
    if (labels.includes(value)) {
      setInput('');
      return;
    }
    onChange([...labels, value]);
    setInput('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
      event.preventDefault();
      add(input);
      return;
    }
    if (event.key === 'Backspace' && input === '' && labels.length > 0) {
      event.preventDefault();
      onChange(labels.slice(0, -1));
    }
  };

  return (
    <div className="space-y-1">
      <div data-testid="label-chips" className="flex flex-wrap items-center gap-1">
        {labels.map((label) => (
          <span
            key={label}
            data-testid={`label-chip-${label}`}
            className="inline-flex items-center gap-1 rounded bg-surface-raised px-1.5 py-0.5 text-xs text-ink-2"
          >
            {label}
            <button
              type="button"
              aria-label={`移除标签 ${label}`}
              data-testid={`label-chip-remove-${label}`}
              onClick={() => onChange(labels.filter((item) => item !== label))}
              className="text-ink-3 hover:text-red-600 focus-visible:outline-2 focus-visible:outline-accent"
            >
              ×
            </button>
          </span>
        ))}
        <input
          data-testid="labels-input"
          aria-label="新增标签"
          list="label-suggestions"
          value={input}
          placeholder={labels.length === 0 ? '输入标签后回车' : '继续添加…'}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => add(input)}
          className="min-w-24 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-ink outline-none focus-visible:outline-2 focus-visible:outline-accent"
        />
      </div>
      <datalist id="label-suggestions">
        {suggestions.map((label) => (
          <option key={label} value={label} />
        ))}
      </datalist>
    </div>
  );
}
