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
import { useCallback, useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Issue } from '@agentboard/shared';
import { api } from '../../api/client';
import {
  attachmentIds,
  attachmentMarkdown,
  collectDraftAttachments,
  filesFromClipboard,
  isImageMime,
  type DraftAttachment,
} from '../../lib/imageDraft';
import { usePanelStore } from '../../state/panelStore';
import { useSessionUsage } from '../../state/turnStore';
import { singleLine, usageFootnote } from '../../lib/turnView';
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

/**
 * CHAT-ATTACH-STATE：草稿附件的渲染来源是 panelStore 的结构化状态，
 * 正文（textarea）只存用户文字，不再内联 `![图片](...)` markdown。
 */
const EMPTY_ATTACHMENTS: DraftAttachment[] = [];

/** 非图片附件的类型徽标：优先文件扩展名，过长/无扩展名退回 FILE */
function attachmentBadge(name: string): string {
  const extension = name.includes('.') ? (name.split('.').at(-1) ?? '').toUpperCase() : '';
  return extension !== '' && extension.length <= 4 ? extension : 'FILE';
}

/**
 * D7 服务端已支持任意 MIME，但 web 的 client 类型仍按图片通道收窄；
 * 这里显式放宽到任意文件，避免为放宽类型去改共享 client（本卡范围只到 chat/**）。
 */
const uploadAttachmentAny = api.uploadAttachment as unknown as (
  workspaceId: string,
  file: File,
  mimeType: string,
) => Promise<{ id: string; file_name: string; mime_type: string; size_bytes: number; download_url: string }>;


function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M10 4.5v11M4.5 10h11" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 15.5v-11M5 9l5-4.5L15 9" />
    </svg>
  );
}

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
  sessionId = null,
  blocked = null,
  onSend,
}: {
  disabled: boolean;
  running: boolean;
  queuedCount: number;
  /** 当前会话所属工作区；`@` 只匹配该工作区任务 */
  workspaceId?: string | null;
  /** CHAT-VIS1：成本脚注读该会话最近一轮的 `session.usage`；缺省（无会话）时脚注显示 0 */
  sessionId?: string | null;
  /**
   * CHAT-AWAIT2：轮次处于 `awaiting_input` / `awaiting_approval` 时输入区只读，
   * 展示「在等什么」并禁用发送，避免用户以为可以继续输入、消息悄悄排队。
   */
  blocked?: { kind: 'input' | 'approval'; message: string } | null;
  /** CHAT-IMG-DELIVERY：第二参数为草稿中实际保留的粘贴图片附件 id（按出现顺序去重） */
  onSend: (text: string, attachmentIds: string[]) => Promise<void>;
}) {
  // DETAIL-VIEW-BUG2 / CHAT-SB2：草稿存 panelStore，按会话独立（视图按需挂载后切回来仍保留）
  const draftKey = sessionId ?? '';
  const value = usePanelStore((s) => s.chatDrafts[draftKey] ?? '');
  const setChatDraft = usePanelStore((s) => s.setChatDraft);
  const setValue = (text: string): void => setChatDraft(draftKey, text);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 正在上传的附件数（>0 时禁止发送，避免附件还没落盘就发出去） */
  const [uploadingAttachments, setUploadingAttachments] = useState(0);
  const [mention, setMention] = useState<MentionState | null>(null);
  const composingRef = useRef(false);
  // 选中候选后插入的文本本身仍能命中查询（如插入 `/mail-report` 后 `mar` 仍匹配），
  // 在插入后的短暂窗口内抑制刷新，避免浮窗立刻重开（100ms 只挡「同一批事件」，不影响继续输入）。
  const suppressUntilRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // CHAT-VIS1：成本脚注数据（本轮用量快照，随 session.usage 流式更新；无轮次 → null → 0）
  const usage = useSessionUsage(sessionId);
  // 附件预览条：来自 panelStore 的结构化草稿状态（与正文解耦，见 CHAT-ATTACH-STATE）
  const attachments = usePanelStore((s) => s.chatAttachments[draftKey] ?? EMPTY_ATTACHMENTS);
  const setChatAttachments = usePanelStore((s) => s.setChatAttachments);

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
    if (blocked !== null) return;
    if (sending || disabled) return;
    // CHAT-ATTACH-ANY：附件还在上传时不许发送，避免消息先发出去（不含附件）而上传结果落回空输入框
    if (uploadingAttachments > 0) {
      setError('附件还在上传，请稍候再发送');
      return;
    }
    if (text === '' && attachments.length === 0) return;
    setError(null);
    if (attachments.length > 5) {
      setError('一条消息最多附带 5 个附件，请删除多余的附件再发送');
      return;
    }
    // CHAT-ATTACH-STATE：附件 id 来自结构化状态；发出文本物化图片 markdown（非图片由服务端把
    // 路径/元数据拼进 prompt），保证消息气泡仍能渲染图片、历史与「重试上一条」的文本反解行为不变。
    const outgoing = attachments.length === 0 ? text : [text, attachmentMarkdown(attachments)].filter(Boolean).join('\n\n');
    setSending(true);
    try {
      await onSend(outgoing, attachmentIds(attachments));
      setValue('');
      setChatAttachments(draftKey, []);
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

  /**
   * 粘贴截图（CHAT-PASTE-IMAGE）：含 `image/*` 文件时接管粘贴——纯文本照常插入，
   * 图片复用既有上传链路（`api.uploadAttachment`，与评论/新建任务同一条），
   * 成功后按现有图片消息形态（markdown 图片）插到光标处；多图按顺序串行上传保持顺序；
   * 超限/类型不支持/上传失败都落到 composer-error，不静默丢弃。
   */
  const insertAtCaret = (text: string): void => {
    const el = inputRef.current;
    // 连续插入（文本 + 多图）时闭包里的 value 会过期，取 store 的最新草稿为准
    const current = usePanelStore.getState().chatDrafts[draftKey] ?? '';
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? start;
    setValue(`${current.slice(0, start)}${text}${current.slice(end)}`);
    const caret = start + text.length;
    requestAnimationFrame(() => {
      const node = inputRef.current;
      if (node === null) return;
      node.focus();
      node.setSelectionRange(caret, caret);
    });
  };

  /**
   * 附件上传（粘贴 / 「＋」选文件共用，CHAT-ATTACH-ANY）：任意类型都接受，
   * 成功后只写入结构化附件状态（正文不插标记）；上限 5 个、单文件 ≤10 MiB，
   * 超限/上传失败都落到 composer-error。非图片的投递闸门在 submit 里拦截。
   */
  const uploadAttachments = (files: File[]): void => {
    if (workspaceId === undefined || workspaceId === null) {
      setError('附件上传需要先选择工作区：在左上角选中工作区后再添加文件');
      return;
    }
    const current = usePanelStore.getState().chatAttachments[draftKey] ?? [];
    const { accepted, rejection } = collectDraftAttachments(files, current.length);
    setError(rejection);
    if (accepted.length === 0) return;
    setUploadingAttachments(accepted.length);
    void (async () => {
      for (const item of accepted) {
        try {
          const result = await uploadAttachmentAny(workspaceId, item.file, item.mimeType);
          const next = usePanelStore.getState().chatAttachments[draftKey] ?? [];
          usePanelStore.getState().setChatAttachments(draftKey, [
            ...next,
            {
              id: result.id,
              url: result.download_url,
              name: result.file_name || item.file.name || '附件',
              mime: result.mime_type || item.mimeType,
              bytes: result.size_bytes ?? item.file.size,
            },
          ]);
        } catch (e) {
          setError(e instanceof Error ? e.message : '附件上传失败');
        } finally {
          setUploadingAttachments((n) => Math.max(0, n - 1));
        }
      }
    })();
  };

  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    const files = filesFromClipboard(event.clipboardData);
    if (files.length === 0) return; // 纯文本交给原生粘贴
    event.preventDefault();
    const plain = event.clipboardData?.getData('text/plain') ?? '';
    if (plain !== '') insertAtCaret(plain);
    uploadAttachments(files);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {    const composing = e.nativeEvent.isComposing || composingRef.current;
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
    <div data-testid="composer" className="shrink-0 space-y-1 px-3 pb-3 pt-2">
      {queueHint !== null && (
        <p data-testid="queue-hint" className="text-xs text-ink-3" role="status">
          {queueHint}
        </p>
      )}
      {blocked !== null && (
        <p data-testid="composer-blocked" className="text-xs text-amber-700 dark:text-amber-300" role="status">
          {blocked.kind === 'input' ? '等待回答' : '等待审批'}：{singleLine(blocked.message)}{' '}
          —— 先在上方卡片处理，输入框暂不可编辑
        </p>
      )}
      {/* CHAT-COMPOSER-V2：截图同构的输入卡 —— 附件预览条 / 无边框文本区 / 底部「＋」与圆形发送 */}
      <div
        data-testid="composer-shell"
        className="relative rounded-3xl border border-hairline bg-surface-card shadow-sm transition-[border-color,box-shadow] duration-[160ms] ease-[cubic-bezier(0.2,0,0,1)] focus-within:border-accent/40 focus-within:ring-2 focus-within:ring-accent/20 motion-reduce:transition-none"
      >
        {mention !== null && (
          <MentionPopover
            kind={mention.kind}
            candidates={mention.candidates}
            activeIndex={mention.activeIndex}
            onPick={pickCandidate}
            onHover={(index) => setMention((prev) => (prev === null ? prev : { ...prev, activeIndex: index }))}
          />
        )}
        {attachments.length > 0 && (
          <div data-testid="composer-attachments" className="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
            {attachments.map((item) => {
              const bytes = formatBytes(item.bytes);
              const image = isImageMime(item.mime);
              return (
                <span
                  key={item.id}
                  data-testid="composer-attachment"
                  data-kind={image ? 'image' : 'file'}
                  className="flex max-w-[16rem] items-center gap-2 rounded-2xl border border-hairline bg-surface-raised/60 p-1.5 pr-1.5"
                >
                  {image ? (
                    <img
                      src={item.url}
                      alt=""
                      className="size-8 shrink-0 rounded-lg border border-hairline object-cover"
                    />
                  ) : (
                    <span
                      data-testid="composer-attachment-badge"
                      aria-hidden="true"
                      className="grid size-8 shrink-0 place-items-center rounded-lg border border-hairline bg-surface-card text-[9px] font-semibold uppercase text-ink-2"
                    >
                      {attachmentBadge(item.name)}
                    </span>
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-[11px] font-medium text-ink">{item.name}</span>
                    <span className="block truncate text-[10px] text-ink-3">
                      {bytes === null ? item.mime : `${item.mime} · ${bytes}`}
                    </span>
                  </span>
                  <button
                    type="button"
                    data-testid={`composer-attachment-remove-${item.id}`}
                    aria-label={`移除附件 ${item.name}`}
                    onClick={() =>
                      setChatAttachments(
                        draftKey,
                        usePanelStore.getState().chatAttachments[draftKey]?.filter((a) => a.id !== item.id) ?? [],
                      )
                    }
                    className="ml-0.5 grid size-5 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-hairline/60 hover:text-ink"
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
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
          onPaste={onPaste}
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
          readOnly={blocked !== null}
          rows={2}
          placeholder={
            blocked !== null
              ? '等待回答/审批中，请先处理上方卡片'
              : disabled
                ? '选择会话后输入'
                : '输入消息，Enter 发送，Shift+Enter 换行；/ 技能，@ 任务'
          }
          className="block min-h-[52px] w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-[13px] leading-[1.5] text-ink outline-none placeholder:text-ink-3 disabled:opacity-50"
        />
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-0.5">
          <button
            type="button"
            data-testid="composer-attach"
            aria-label="添加附件"
            title="添加附件（任意类型，单个 ≤10 MiB）"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || blocked !== null}
            className="flex size-8 items-center justify-center rounded-full text-ink-2 transition-colors duration-[160ms] ease-[cubic-bezier(0.2,0,0,1)] hover:bg-surface-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
          >
            <PlusIcon />
          </button>
          <input
            ref={fileInputRef}
            data-testid="composer-file-input"
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              uploadAttachments(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
          <button
            type="button"
            data-testid="composer-send"
            aria-label={sending ? '发送中' : '发送'}
            title={sending ? '发送中…' : '发送'}
            onClick={() => void submit()}
            disabled={
              disabled || blocked !== null || sending || uploadingAttachments > 0 || value.trim() === ''
            }
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink shadow-sm transition-[background-color,color,opacity] duration-[160ms] ease-[cubic-bezier(0.2,0,0,1)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:bg-surface-raised disabled:text-ink-3 disabled:opacity-70 motion-reduce:transition-none"
          >
            {sending ? (
              <span
                aria-hidden="true"
                className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
              />
            ) : (
              <ArrowUpIcon />
            )}
          </button>
        </div>
      </div>
      {uploadingAttachments > 0 && (
        <p data-testid="composer-uploading" role="status" className="text-xs text-ink-3">
          附件上传中…（完成后会自动加入附件卡，再发送）
        </p>
      )}      {error !== null && (
        <p data-testid="composer-error" role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {/*
        CHAT-VIS1：成本脚注（本轮 tokens / 估算成本 / 上下文占用）。
        - 只读 `session.usage`（服务端按字符量估算、恒 estimated=true），未开始轮次显示 0；
        - `cost_usd`/`context_limit_tokens` 无来源时显示「待接入」「未知」，不用 0 冒充；
        - 在输入区内、消息区之外 → 不改消息区滚动高度；10px 右对齐，不抢正文。
      */}
      <p
        data-testid="composer-usage"
        role="status"
        className="text-right text-[10px] text-ink-3"
      >
        {usageFootnote(usage)}
      </p>
    </div>
  );
}
