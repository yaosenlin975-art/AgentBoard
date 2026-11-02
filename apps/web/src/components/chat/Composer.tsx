/**
 * 输入区（设计 §7.5）：多行 textarea，Enter 发送 / Shift+Enter 换行（IME 组合中不发送）；
 * POST /api/sessions/:id/messages 返回 queued:true 时排队计数在 ChatPanel 维护；
 * 运行中且队列 >0 显示"排队中 N 条"，停止后显示"已停止，排队 N 条保留"。
 *
 * 联想输入（CHAT-MENTION）：
 * - token 起始的 `/` 触发技能联想（`GET /api/skills`），`@` 触发当前工作区任务联想（`GET /api/issues`）；
 * - 上下键移动高亮、Enter/Tab 确认、Esc 关闭、鼠标点击确认；
 * - **浮窗打开时 Enter 只确认候选、不发送消息**；选中只插入 `/skill` 或 `@标题` 文本；
 * - IME 组合期间不触发、不刷新候选；无匹配时关闭浮窗且不阻塞输入。
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Issue } from '@agentboard/shared';
import { api } from '../../api/client';
import {
  detectMentionTrigger,
  insertMention,
  issueCandidates,
  rankMentionCandidates,
  skillCandidates,
  type MentionCandidate,
  type MentionKind,
} from '../../lib/mention';
import { MentionPopover } from './MentionPopover';

interface SkillItem {
  name: string;
  description?: string | null;
}

interface MentionState {
  kind: MentionKind;
  start: number;
  end: number;
  query: string;
  candidates: MentionCandidate[];
  activeIndex: number;
}

export function Composer({
  disabled,
  running,
  queuedCount,
  workspaceId,
  onSend,
}: {
  disabled: boolean;
  running: boolean;
  queuedCount: number;
  /** 当前会话所属工作区；`@` 只匹配该工作区任务 */
  workspaceId?: string | null;
  onSend: (text: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mention, setMention] = useState<MentionState | null>(null);
  const composingRef = useRef(false);
  // 选中候选后插入的文本本身仍能命中查询（如插入 `/mail-report` 后 `mar` 仍匹配），
  // 在插入后的短暂窗口内抑制刷新，避免浮窗立刻重开（100ms 只挡「同一批事件」，不影响继续输入）。
  const suppressUntilRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const queueHint =
    queuedCount > 0
      ? running
        ? `排队中 ${queuedCount} 条`
        : `已停止，排队 ${queuedCount} 条保留`
      : null;

  // 技能列表：新端点 `GET /api/skills`（server 线实现；未就绪时请求失败 → 无技能候选，不影响输入）
  const skills = useQuery({
    queryKey: ['skills'],
    queryFn: async () => {
      const res = await api.get<{ items?: SkillItem[] } | SkillItem[]>('/api/skills');
      return Array.isArray(res) ? res : (res.items ?? []);
    },
    staleTime: 60_000,
    retry: false,
  });
  // 任务列表：与 Board 共用 ['issues', workspaceId] 缓存
  const issues = useQuery({
    queryKey: ['issues', workspaceId],
    queryFn: () => api.get<Issue[]>(`/api/issues?workspace=${encodeURIComponent(workspaceId ?? '')}`),
    enabled: workspaceId !== undefined && workspaceId !== null,
    staleTime: 30_000,
  });

  const candidatesFor = useCallback(
    (kind: MentionKind): MentionCandidate[] =>
      kind === 'skill'
        ? skillCandidates(skills.data ?? [])
        : issueCandidates(issues.data ?? []),
    [skills.data, issues.data],
  );

  /** 依据当前文本与光标位置刷新浮窗状态 */
  const refreshMention = useCallback(
    (text: string, caret: number): void => {
      if (composingRef.current) return; // IME 组合中不触发
      if (performance.now() < suppressUntilRef.current) {
        setMention(null);
        return;
      }
      const trigger = detectMentionTrigger(text, caret);
      if (trigger === null) {
        setMention(null);
        return;
      }
      const ranked = rankMentionCandidates(candidatesFor(trigger.kind), trigger.query);
      if (ranked.length === 0) {
        setMention(null);
        return;
      }
      setMention((prev) => {
        // 同一触发位置保持高亮不跳回第一项
        const sameContext = prev !== null && prev.start === trigger.start && prev.query === trigger.query;
        const activeIndex = sameContext ? Math.min(prev.activeIndex, ranked.length - 1) : 0;
        return { kind: trigger.kind, start: trigger.start, end: trigger.end, query: trigger.query, candidates: ranked, activeIndex };
      });
    },
    [candidatesFor],
  );

  // 候选数据到达后（技能/任务延迟加载）补一次刷新，避免先打出 `/` 时无候选
  useEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    refreshMention(value, el.selectionStart ?? value.length);
  }, [skills.data, issues.data, refreshMention, value]);

  const submit = async (): Promise<void> => {
    const text = value.trim();
    if (text === '' || sending || disabled) return;
    setError(null);
    setSending(true);
    try {
      await onSend(text);
      setValue('');
      setMention(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '发送失败');
    } finally {
      setSending(false);
    }
  };

  const pickCandidate = (candidate: MentionCandidate): void => {
    if (mention === null) return;
    const { text, caret } = insertMention(value, mention, candidate.insert);
    suppressUntilRef.current = performance.now() + 100;
    setValue(text);
    setMention(null);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el === null) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    const composing = e.nativeEvent.isComposing || composingRef.current;
    if (mention !== null && !composing) {
      const count = mention.candidates.length;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMention({ ...mention, activeIndex: (mention.activeIndex + 1) % count });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMention({ ...mention, activeIndex: (mention.activeIndex - 1 + count) % count });
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        // 浮窗打开时 Enter 只确认候选，绝不发送消息
        e.preventDefault();
        const chosen = mention.candidates[mention.activeIndex];
        if (chosen !== undefined) pickCandidate(chosen);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !composing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div data-testid="composer" className="shrink-0 space-y-1 border-t border-neutral-200 p-2 dark:border-neutral-800">
      {queueHint !== null && (
        <p data-testid="queue-hint" className="text-xs text-amber-600 dark:text-amber-400" role="status">
          {queueHint}
        </p>
      )}
      <div className="relative flex items-end gap-1.5">
        {mention !== null && (
          <MentionPopover
            kind={mention.kind}
            candidates={mention.candidates}
            activeIndex={mention.activeIndex}
            onPick={pickCandidate}
            onHover={(index) => setMention((prev) => (prev === null ? prev : { ...prev, activeIndex: index }))}
          />
        )}
        <textarea
          ref={inputRef}
          data-testid="composer-input"
          aria-label="消息输入"
          aria-autocomplete="list"
          aria-expanded={mention !== null}
          aria-controls={mention !== null ? 'mention-popover' : undefined}
          aria-activedescendant={mention !== null ? `mention-option-${mention.activeIndex}` : undefined}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            refreshMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => refreshMention(value, (e.target as HTMLTextAreaElement).selectionStart ?? value.length)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
            setMention(null);
          }}
          onCompositionEnd={(e) => {
            composingRef.current = false;
            const el = e.target as HTMLTextAreaElement;
            refreshMention(el.value, el.selectionStart ?? el.value.length);
          }}
          onBlur={() => setMention(null)}
          disabled={disabled}
          rows={2}
          placeholder={disabled ? '选择会话后输入' : '输入消息，Enter 发送，Shift+Enter 换行；/ 选技能，@ 选任务'}
          className="min-h-0 w-full resize-none rounded border border-neutral-300 px-2 py-1.5 text-xs outline-none focus:border-blue-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800"
        />
        <button
          type="button"
          data-testid="composer-send"
          onClick={() => void submit()}
          disabled={disabled || sending || value.trim() === ''}
          className="shrink-0 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {sending ? '发送中…' : '发送'}
        </button>
      </div>
      {error !== null && (
        <p data-testid="composer-error" role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
