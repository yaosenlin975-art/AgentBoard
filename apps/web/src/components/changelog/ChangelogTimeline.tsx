/**
 * 变更日志时间轴（LOG03）：活动与归档共用的只读渲染层。
 * 排序恒为 `occurred_at DESC, id DESC`（最新在顶），按浏览器本地日期分组，条目折叠标题行、展开渲染 Markdown 正文。
 * `readonly` 时不渲染任何写操作（归档区据此保证只读）。
 */
import { useMemo, useState } from 'react';
import { MarkdownView } from '../../lib/markdown';
import type { WorkspaceChangeLog } from '@agentboard/shared';
import { Badge, type BadgeTone } from '../ui/Badge';
import { BUTTON_DANGER, BUTTON_SECONDARY } from '../ui/buttonStyles';

const TYPE_TONE: Record<string, BadgeTone> = {
  新增: 'green',
  修复: 'blue',
  调整: 'neutral',
  历史: 'purple',
};

const pad = (value: number): string => String(value).padStart(2, '0');

/** 本地日期分组键（YYYY-MM-DD），按浏览器时区 */
export function localDayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 本地时间显示（YYYY-MM-DD HH:mm） */
export function localDateTime(ms: number): string {
  const date = new Date(ms);
  return `${localDayKey(ms)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 稳定排序：最新在顶；同一发生时间按 id 降序（与服务端 `occurred_at DESC,id DESC` 一致） */
export function sortChangelog(entries: readonly WorkspaceChangeLog[]): WorkspaceChangeLog[] {
  return [...entries].sort((left, right) => {
    if (right.occurred_at !== left.occurred_at) return right.occurred_at - left.occurred_at;
    return right.id.localeCompare(left.id);
  });
}

export interface ChangelogDayGroup {
  day: string;
  entries: WorkspaceChangeLog[];
}

/** 分组：保持入参排序，日期按首次出现顺序（即最新日期在前） */
export function groupChangelogByDay(entries: readonly WorkspaceChangeLog[]): ChangelogDayGroup[] {
  const groups: ChangelogDayGroup[] = [];
  const index = new Map<string, ChangelogDayGroup>();
  for (const entry of entries) {
    const day = localDayKey(entry.occurred_at);
    const existing = index.get(day);
    if (existing) {
      existing.entries.push(entry);
      continue;
    }
    const group = { day, entries: [entry] };
    index.set(day, group);
    groups.push(group);
  }
  return groups;
}

export interface ChangelogTimelineProps {
  entries: readonly WorkspaceChangeLog[];
  readonly?: boolean;
  emptyText?: string;
  onEdit?: (entry: WorkspaceChangeLog) => void;
  onDelete?: (entry: WorkspaceChangeLog) => void;
}

export function ChangelogTimeline({ entries, readonly = false, emptyText = '（暂无变更日志）', onEdit, onDelete }: ChangelogTimelineProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const groups = useMemo(() => groupChangelogByDay(sortChangelog(entries)), [entries]);

  const toggle = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (entries.length === 0) {
    return (
      <p data-testid="changelog-empty" className="rounded-md border border-dashed border-hairline px-3 py-8 text-center text-sm text-ink-3">
        {emptyText}
      </p>
    );
  }

  return (
    <ol aria-label="变更日志时间轴" className="space-y-4" data-testid="changelog-timeline">
      {groups.map((group) => (
        <li key={group.day} data-testid={`changelog-day-${group.day}`}>
          <h3 className="mb-1.5 text-xs font-semibold text-ink-3">{group.day}</h3>
          <ul className="space-y-2 border-l border-hairline pl-3">
            {group.entries.map((entry) => {
              const isOpen = expanded.has(entry.id);
              return (
                <li
                  key={entry.id}
                  data-testid={`changelog-entry-${entry.id}`}
                  className="rounded-md border border-hairline bg-surface-card p-2.5"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={TYPE_TONE[entry.change_type] ?? 'neutral'}>{entry.change_type}</Badge>
                    <span className="text-xs text-ink-3">{localDateTime(entry.occurred_at)}</span>
                    <span className="ml-auto text-xs text-ink-3">rev:{entry.revision}</span>
                  </div>
                  <button
                    type="button"
                    data-testid={`changelog-toggle-${entry.id}`}
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? '收起' : '展开'}日志：${entry.title}`}
                    onClick={() => toggle(entry.id)}
                    className="mt-1 block w-full break-words text-left text-sm font-medium text-ink hover:text-accent"
                  >
                    {entry.title}
                  </button>
                  {isOpen && (
                    <div data-testid={`changelog-body-${entry.id}`}>
                      <MarkdownView
                        compact
                        className="mt-2 break-words rounded border border-hairline px-2 py-1.5"
                      >
                        {entry.body_md}
                      </MarkdownView>
                    </div>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                    <span>{entry.updated_by === 'user' ? '用户' : entry.updated_by}</span>
                    <span>更新 {localDateTime(entry.updated_at)}</span>
                    {!readonly && (
                      <span className="ml-auto flex items-center gap-1.5">
                        <button
                          type="button"
                          aria-label={`编辑日志：${entry.title}`}
                          onClick={() => onEdit?.(entry)}
                          className={BUTTON_SECONDARY}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          aria-label={`删除日志：${entry.title}`}
                          onClick={() => onDelete?.(entry)}
                          className={BUTTON_DANGER}
                        >
                          删除
                        </button>
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}

