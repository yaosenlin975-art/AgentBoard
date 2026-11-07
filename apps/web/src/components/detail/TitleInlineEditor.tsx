/**
 * 详情标题（D1/DETAIL-LAYOUT）：渲染在卡片顶栏（关闭按钮那一行）。
 * - 阅读态 2 行截断（窄屏 <920px 3 行，原型 task-detail-redesign-2026-11-05 §1.1/§1.5）+ title 属性给全文 + ✎ 紧邻其右；
 * - 编辑态在同一行原地展开输入框，保存/取消工具条换行到标题下方。
 * - 两态互斥渲染：编辑时原文本整块让位，不出现「文字 + 输入框」并存；
 * - 进入编辑前量出阅读态高度锁给输入框容器，标题行高度不跳变（工具条增高属已知差异，见未决 11）；
 * - Enter 提交 / Esc 取消（有改动保留一次草稿）/ 点编辑区外部保持编辑态；
 * - 空值、超长、保存失败、409 冲突都在行内给可读提示，且不丢用户输入。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ApiError } from '../../api/client';

/**
 * 标题字数上限：取自服务端 `createIssueSchema` 的 `max(200)`（apps/server/src/api/schemas.ts 的 KB-CLI-1 口径）。
 * 注意：就地编辑走 PATCH /api/issues/:id，其 `patchIssueSchema.title` 目前**没有**长度约束，
 * DB 列 `issue.title TEXT` 也无长度限制，所以 200 是「比服务端更严」的前端拦截；
 * 是否给 PATCH 补同口径约束（需改 apps/server，超出本卡文件集）待卡上决策。
 */
export const TITLE_MAX_LENGTH = 200;
/** 超过该字数才显示计数 */
export const TITLE_COUNTER_THRESHOLD = 160;

export interface TitleSaveOptions {
  /** true = 冲突后「仍然保存」，跳过 CAS（不带 expected_updated_at） */
  force: boolean;
}

export interface TitleInlineEditorProps {
  title: string;
  /** 提交标题；抛错时由本组件展示提示并保留输入 */
  onSave: (value: string, options: TitleSaveOptions) => Promise<void>;
  /** 编辑工具条投影目标（卡片头部下方独立一行）；为空时工具条留在标题块内 */
  editBarSlot?: HTMLElement | null;
}

export function TitleInlineEditor({ title, onSave, editBarSlot = null }: TitleInlineEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  /** 进入编辑前锁定的阅读态高度；null 表示不锁（jsdom/测量为 0 时） */
  const [lockedHeight, setLockedHeight] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  /** 409 后提供「仍然保存」入口 */
  const [conflict, setConflict] = useState(false);

  const displayRef = useRef<HTMLHeadingElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  /** Esc 后保留的一次草稿：下次进入编辑恢复并提示一次 */
  const draftRef = useRef<string | null>(null);
  const wasEditingRef = useRef(false);

  // 进入编辑：聚焦并预填原文，光标置末尾（不全选，避免误键入覆盖原标题）
  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, [editing]);

  // 退出编辑：焦点回到 ✎（保存成功与取消同一路径）
  useLayoutEffect(() => {
    if (wasEditingRef.current && !editing) editButtonRef.current?.focus();
    wasEditingRef.current = editing;
  }, [editing]);

  const startEditing = useCallback(() => {
    const height = displayRef.current?.getBoundingClientRect().height ?? 0;
    setLockedHeight(height > 0 ? height : null);
    setDraft(draftRef.current ?? title);
    setError(null);
    setConflict(false);
    setHint(draftRef.current !== null ? '已恢复上次未保存的草稿。' : null);
    draftRef.current = null;
    setEditing(true);
  }, [title]);

  const stopEditing = useCallback(() => {
    setEditing(false);
    setLockedHeight(null);
    setError(null);
    setHint(null);
    setConflict(false);
  }, []);

  const cancel = useCallback(() => {
    // 未决 4：有改动保留一次草稿，无改动直接退出
    draftRef.current = draft === title ? null : draft;
    stopEditing();
  }, [draft, title, stopEditing]);

  const submit = useCallback(
    async (force: boolean) => {
      if (saving) return;
      const value = draft.trim();
      if (value === '') {
        setError('标题不能为空，请填写后再保存。');
        inputRef.current?.focus();
        return;
      }
      if (value.length > TITLE_MAX_LENGTH) {
        setError(`标题最多 ${TITLE_MAX_LENGTH} 字，当前 ${value.length} 字（已保留你的输入）。`);
        inputRef.current?.focus();
        return;
      }
      setSaving(true);
      setError(null);
      try {
        await onSave(value, { force });
        draftRef.current = null;
        setDraft(value);
        stopEditing();
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setConflict(true);
          setError('保存冲突：任务在你编辑期间已被更新。你的输入已保留，可点「仍然保存」覆盖。');
        } else {
          setError(`保存失败：${e instanceof Error ? e.message : '未知错误'}。你的输入已保留，可重试。`);
        }
      } finally {
        setSaving(false);
      }
    },
    [draft, onSave, saving, stopEditing],
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      // 中文输入法组词中的 Enter 不提交
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      void submit(false);
      return;
    }
    if (event.key === 'Escape') {
      // 只结束标题编辑，不冒泡到面板的 Esc 关闭
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };

  if (!editing) {
    return (
      <div data-testid="title-editor" className="flex min-w-0 w-full items-center gap-1">
        <h1
          ref={displayRef}
          id="detail-title"
          data-testid="title-display"
          title={title}
          className="min-w-0 break-words line-clamp-2 max-[919.98px]:line-clamp-3 text-[15px] font-semibold leading-[1.42] text-ink"
        >
          {title}
        </h1>
        <button
          ref={editButtonRef}
          type="button"
          data-testid="title-edit-btn"
          aria-label="编辑标题"
          title="编辑标题"
          onClick={startEditing}
          className="shrink-0 rounded px-1 text-ink-3 transition-colors hover:bg-accent-soft hover:text-accent"
        >
          ✎
        </button>
      </div>
    );
  }

  const overLimit = draft.length > TITLE_MAX_LENGTH;
  const editBar = (
      <div
        data-testid="title-edit-bar"
        className="mt-1 flex flex-wrap items-center gap-1.5 border-t border-dashed border-hairline pt-1"
      >
        {draft.length > TITLE_COUNTER_THRESHOLD && (
          <span
            data-testid="title-counter"
            className={`text-[10.5px] tabular-nums ${overLimit ? 'font-semibold text-red-600 dark:text-red-400' : 'text-ink-3'}`}
          >
            {draft.length} / {TITLE_MAX_LENGTH}
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          data-testid="title-cancel"
          onClick={cancel}
          disabled={saving}
          className="rounded border border-hairline px-2 py-0.5 text-xs text-ink-2 transition-colors hover:bg-accent-soft disabled:opacity-40"
        >
          取消
        </button>
        <button
          type="button"
          data-testid="title-save"
          onClick={() => void submit(false)}
          disabled={saving}
          className="rounded bg-accent px-2 py-0.5 text-xs font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
        >
          {saving ? '保存中…' : '保存'}
        </button>
        {conflict && (
          <button
            type="button"
            data-testid="title-force-save"
            onClick={() => void submit(true)}
            disabled={saving}
            className="rounded border border-accent px-2 py-0.5 text-xs font-medium text-accent transition-colors hover:bg-accent-soft disabled:opacity-40"
          >
            仍然保存
          </button>
        )}
        {hint !== null && (
          <p data-testid="title-draft-hint" role="status" className="basis-full text-xs text-ink-2">
            {hint}
          </p>
        )}
        {error !== null && (
          <p data-testid="title-error" role="alert" className="basis-full text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
  );

  return (
    <div data-testid="title-editor" className="w-full min-w-0 text-sm">
      <div
        data-testid="title-edit-wrap"
        className="flex min-w-0 w-full items-center"
        style={lockedHeight === null ? undefined : { height: `${lockedHeight}px` }}
      >
        <input
          ref={inputRef}
          id="detail-title"
          data-testid="title-input"
          aria-label="编辑标题"
          value={draft}
          disabled={saving}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
            setConflict(false);
          }}
          onKeyDown={onKeyDown}
          className="h-full w-full rounded border border-accent bg-surface-card px-1.5 text-[15px] font-semibold text-ink outline-none ring-2 ring-accent-soft"
        />
      </div>
      {/* 编辑工具条：有外部槽位时投影到头部下方独立一行，不撑高 h-10 头部 */}
      {editBarSlot !== null ? createPortal(editBar, editBarSlot) : editBar}
    </div>
  );
}
