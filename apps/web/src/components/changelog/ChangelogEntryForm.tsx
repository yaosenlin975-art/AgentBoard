/**
 * 变更日志新增/编辑表单（LOG03）：内联渲染在面板内，避免与入口 Modal 嵌套两层遮罩。
 * CAS 冲突时保留全部输入，显示服务端原文与当前 revision，并提供「载入最新」。
 */
import { useState, type FormEvent } from 'react';
import type { WorkspaceChangeLog, WorkspaceChangeType } from '@agentboard/shared';
import type { EditableChangeType } from '../../api/changelog';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, FIELD_CLASS } from '../ui/buttonStyles';

export interface ChangelogFormValues {
  title: string;
  change_type: EditableChangeType;
  occurred_at: number;
  body_md: string;
}

export interface ChangelogFormConflict {
  message: string;
  currentRevision: number | null;
}

const EDITABLE_TYPES: EditableChangeType[] = ['新增', '修复', '调整'];

const pad = (value: number): string => String(value).padStart(2, '0');

/** 毫秒 → `datetime-local` 值（本地时区） */
export function toLocalInput(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `datetime-local` 值 → 毫秒；空/非法返回 null */
export function fromLocalInput(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export function ChangelogEntryForm({
  mode,
  initial,
  submitting,
  error,
  conflict,
  reloading,
  onCancel,
  onSubmit,
  onReloadLatest,
}: {
  mode: 'create' | 'edit';
  initial?: WorkspaceChangeLog;
  submitting: boolean;
  error: string | null;
  conflict: ChangelogFormConflict | null;
  reloading: boolean;
  onCancel: () => void;
  onSubmit: (values: ChangelogFormValues) => void;
  onReloadLatest: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [changeType, setChangeType] = useState<EditableChangeType>(
    initial !== undefined && EDITABLE_TYPES.includes(initial.change_type as EditableChangeType)
      ? (initial.change_type as EditableChangeType)
      : '新增',
  );
  const [occurredAt, setOccurredAt] = useState(toLocalInput(initial?.occurred_at ?? Date.now()));
  const [bodyMd, setBodyMd] = useState(initial?.body_md ?? '');
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (submitting) return;
    const occurred = fromLocalInput(occurredAt);
    if (title.trim() === '') return setLocalError('标题不能为空');
    if (bodyMd.trim() === '') return setLocalError('正文不能为空');
    if (occurred === null) return setLocalError('发生时间不合法');
    setLocalError(null);
    onSubmit({ title: title.trim(), change_type: changeType, occurred_at: occurred, body_md: bodyMd });
  };

  return (
    <form
      data-testid="changelog-form"
      aria-label={mode === 'create' ? '新增变更日志' : '编辑变更日志'}
      onSubmit={submit}
      className="space-y-2 rounded-md border border-neutral-300 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-900"
    >
      <label className="block text-xs text-neutral-600 dark:text-neutral-300">
        <span className="mb-1 block">标题</span>
        <input
          data-testid="changelog-form-title"
          aria-label="日志标题"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          className={`${FIELD_CLASS} w-full`}
        />
      </label>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-neutral-600 dark:text-neutral-300">
          <span className="mb-1 block">类型</span>
          <select
            data-testid="changelog-form-type"
            aria-label="日志类型"
            value={changeType}
            onChange={(event) => setChangeType(event.target.value as EditableChangeType)}
            className={FIELD_CLASS}
          >
            {EDITABLE_TYPES.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="min-w-0 flex-1 text-xs text-neutral-600 dark:text-neutral-300">
          <span className="mb-1 block">发生时间</span>
          <input
            data-testid="changelog-form-occurred"
            aria-label="发生时间"
            type="datetime-local"
            value={occurredAt}
            onChange={(event) => setOccurredAt(event.target.value)}
            className={`${FIELD_CLASS} w-full`}
          />
        </label>
      </div>
      <label className="block text-xs text-neutral-600 dark:text-neutral-300">
        <span className="mb-1 block">正文（Markdown）</span>
        <textarea
          data-testid="changelog-form-body"
          aria-label="日志正文"
          value={bodyMd}
          onChange={(event) => setBodyMd(event.target.value)}
          rows={5}
          className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        />
      </label>

      {(localError ?? error) !== null && (
        <p role="alert" data-testid="changelog-form-error" className="text-xs text-red-600 dark:text-red-400">
          {localError ?? error}
        </p>
      )}
      {conflict !== null && (
        <div
          data-testid="changelog-conflict"
          className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
        >
          <p>该日志已被更新（{conflict.message}）。当前 revision：{conflict.currentRevision ?? '未知'}。输入已保留。</p>
          <button
            type="button"
            className={`${BUTTON_SECONDARY} mt-1`}
            disabled={reloading || conflict.currentRevision === null}
            onClick={onReloadLatest}
          >
            {reloading ? '载入中…' : '载入最新'}
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        <button type="button" className={BUTTON_SECONDARY} onClick={onCancel} disabled={submitting}>
          取消
        </button>
        <button type="submit" data-testid="changelog-form-submit" className={BUTTON_PRIMARY} disabled={submitting}>
          {submitting ? '保存中…' : mode === 'create' ? '创建' : '保存'}
        </button>
      </div>
    </form>
  );
}

export const changelogTypeLabel = (type: WorkspaceChangeType): string => type;
