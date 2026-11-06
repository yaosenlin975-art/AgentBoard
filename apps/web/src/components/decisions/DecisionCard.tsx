/**
 * DEC-V4-INLINE（P3）：待决策就地作答卡。
 *
 * 收起态（默认）：rank + 卡名 + 倒计时 / 停止信号 + 问题（2 行截断）+ 选项 chip 行
 * + 单行后果预览 + 动作行（主按钮「提交回答」默认禁用，选中后可用）。
 * 展开态：只渲染详细卡（全文问题、带 consequence 的选项列表、关键值、断点、答案时间线），
 * chip 行不进入 DOM（验收：展开后 queryByTestId('decision-chips-<id>') 为 null）。
 *
 * 数据口径：全部消费 P1A/P1B 已提交字段（options / issue_priority / blocked_downstream_count /
 * waiting_seconds / stop_*），详情（checkpoint / 全量 answers）走 `GET /api/decisions/:id`，
 * 不在前端自造数据源。
 */
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { formatCountdown, formatWaiting } from './countdown';
import { checkpointLines } from './DecisionSection';
import { useAnswerDecision, useDecisionDetail } from './useDecisions';
import type { DecisionAnswerDto, DecisionDetailDto, DecisionListItemDto } from './types';

/** 容器宽度阈值：≤660px 时动作行纵向堆叠、主按钮占满 */
const NARROW_BREAKPOINT = 660;

/** 自定义答案长度上限（与原型 CUSTOM_MAX 一致；服务端 answer_text 另有兜底） */
const CUSTOM_MAX = 120;
const CUSTOM_EMPTY_ERROR = '先写一句答案再提交（不能为空）';
/** 选项（含「自定义」入口）≥7 时选项区内部滚动，页面本身不跳 */
const SCROLL_THRESHOLD = 7;
const CHIPS_MAX_HEIGHT = 76;
const LIST_MAX_HEIGHT = 300;

function useNarrowContainer(breakpoint: number) {
  const ref = useRef<HTMLLIElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      // jsdom / 尚未布局时 width=0：回退到视口宽度，保证首屏也能给出确定值
      setNarrow(width > 0 ? width <= breakpoint : window.innerWidth <= breakpoint);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [breakpoint]);
  return { ref, narrow };
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
}

function currentAnswer(detail: DecisionDetailDto | null, revision: number): DecisionAnswerDto | null {
  if (detail === null) return null;
  return detail.answers.find((answer) => answer.revision === revision) ?? null;
}

function optionLabel(detail: DecisionDetailDto | null, answer: DecisionAnswerDto | null): string | null {
  if (answer === null) return null;
  const option = detail?.options.find((item) => item.id === answer.option_id);
  if (option) return option.label;
  if (answer.answer_text !== null && answer.answer_text !== '') return answer.answer_text;
  return '（空答案）';
}

export interface DecisionCardProps {
  item: DecisionListItemDto;
  now: number;
  rank: number | undefined;
  focused: boolean;
  scope: 'grace' | 'open' | 'stale' | 'answered';
  expanded: boolean;
  /** 当前选中的工作区；与 item.workspace_id 不同即跨区卡 */
  homeWorkspaceId: string;
  /** 切 tab / 切范围时递增的复位信号：清掉跨区二次确认 */
  resetSignal: string;
  onToggle: (decisionId: string) => void;
  onOpenIssue: (issueId: string) => void;
}

/** 跨区 chip 文案：短名展示、全名放 title（服务端 workspace_name） */
function shortWorkspaceName(name: string): string {
  return name.length > 8 ? `${name.slice(0, 8)}…` : name;
}

export function DecisionCard({
  item,
  now,
  rank,
  focused,
  scope,
  expanded,
  homeWorkspaceId,
  resetSignal,
  onToggle,
  onOpenIssue,
}: DecisionCardProps) {
  const queryClient = useQueryClient();
  const { ref, narrow } = useNarrowContainer(NARROW_BREAKPOINT);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // DEC-V4-CUSTOM：自定义答案与真实选项同属一个单选组，互斥；草稿跨收起/切换保留
  const [customOpen, setCustomOpen] = useState(false);
  const [customText, setCustomText] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);
  // P5：跨区回答的二次确认；改选项 / 收起 / 切 tab / 切范围都会复位
  const [confirmCross, setConfirmCross] = useState(false);
  const prevOptionRef = useRef<string | null>(null);
  const customInputRef = useRef<HTMLInputElement | null>(null);
  // 已回答卡收起态也要展示当前答案选项 → 仅在 answered 时预取详情；展开时一律取详情
  const detailQueryEnabled = expanded || scope === 'answered';
  const detail = useDecisionDetail(detailQueryEnabled ? item.id : null);
  const answerMutation = useAnswerDecision();

  const options = [...item.options].sort((a, b) => a.ord - b.ord);
  const defaultOption = options.find((option) => option.is_default === 1) ?? options[0] ?? null;
  const selectedOption = options.find((option) => option.id === selectedOptionId) ?? null;
  // P5：跨区标注 + 服务端 capability 决定「能不能答」；不写死「跨区一定要确认」
  const crossWorkspace = item.workspace_id !== homeWorkspaceId;
  const workspaceName = item.workspace_name ?? item.workspace_id;
  const capabilities = item.capabilities ?? null;
  const roleBlocked = capabilities !== null && !capabilities.can_answer;
  const needsCrossConfirm = crossWorkspace && !roleBlocked;
  const customDraft = customText.trim();
  const preview = customOpen
    ? {
        id: '__custom__',
        ord: options.length + 1,
        label: customDraft,
        consequence: '自定义答案：原文会写进卡评论并同步任务卡',
        is_default: 0,
      }
    : (selectedOption ?? defaultOption);
  const current = currentAnswer(detail, item.answer_revision);
  const currentLabel = optionLabel(detail, current);
  const isAnswered = scope === 'answered' || item.state === 'answered';
  const canSubmit =
    !answerMutation.isPending &&
    (customOpen ? true : selectedOptionId !== null && (current === null || selectedOptionId !== current.option_id));
  const optionsScroll = options.length + 1 >= SCROLL_THRESHOLD;

  // P5：切 tab / 切范围 / 展开收起都视为「换了上下文」，跨区确认必须重来
  useEffect(() => {
    setConfirmCross(false);
  }, [resetSignal, expanded]);

  const graceRemaining =
    item.state === 'grace' && item.grace_until > now ? Math.max(0, Math.ceil((item.grace_until - now) / 1000)) : null;
  const waiting = item.state === 'open' ? formatWaiting(item.waiting_seconds ?? null) : null;

  // 展开输入框：聚焦并就近滚动到可见区域（页面本身不跳；jsdom 无 scrollIntoView 时跳过）
  useEffect(() => {
    if (!customOpen) return;
    const input = customInputRef.current;
    if (!input) return;
    input.focus();
    if (typeof input.scrollIntoView === 'function') input.scrollIntoView({ block: 'nearest' });
  }, [customOpen]);

  function handleSubmitError(err: unknown) {
    if (err instanceof ApiError) {
      // P5：401 / 403 分开给界面态，不一律「提交失败」
      if (err.status === 401) {
        setError('身份失效，请重新打开看板');
        return;
      }
      if (err.code === 'WORKSPACE_FORBIDDEN') {
        setError('无权操作该工作区的决策');
        return;
      }
      if (err.code === 'ROLE_FORBIDDEN') {
        setError('当前角色无权回答这条决策');
        return;
      }
      if (err.status === 409) {
        setError('答案版本冲突：已为你刷新，请重新选择后再提交');
        void queryClient.invalidateQueries({ queryKey: ['decisions'] });
        void queryClient.invalidateQueries({ queryKey: ['decision'] });
        return;
      }
    }
    setError(err instanceof Error ? err.message : '提交失败');
  }

  function selectOption(optionId: string) {
    setSelectedOptionId(optionId);
    setConfirmCross(false);
    // 与自定义互斥：收起输入框但保留草稿，再次点「自定义」可继续编辑
    setCustomOpen(false);
    setCustomError(null);
  }

  function closeCustom(revert: boolean) {
    setConfirmCross(false);
    setCustomOpen(false);
    setCustomError(null);
    if (revert) setSelectedOptionId(prevOptionRef.current);
  }

  function toggleCustom() {
    setConfirmCross(false);
    if (customOpen) {
      closeCustom(true);
      return;
    }
    // 记下打开前的选择，Esc / 再点一次自定义时回退；自定义与真实选项同组互斥
    prevOptionRef.current = selectedOptionId;
    setSelectedOptionId(null);
    setCustomOpen(true);
    setCustomError(null);
  }

  function onCustomChange(event: ChangeEvent<HTMLInputElement>) {
    // maxlength 挡不住程序化写入（含部分粘贴路径），这里硬截断
    setCustomText(event.target.value.slice(0, CUSTOM_MAX));
    setConfirmCross(false);
  }

  function onCustomKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    // 中文输入法选词回车不提交
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeCustom(true);
    }
  }

  /** P5：第一次点击只「上膛」，不发请求；第二次才真正提交 */
  function armCrossConfirm() {
    setConfirmCross(true);
    setError(null);
    setCustomError(null);
  }

  function submit() {
    if (answerMutation.isPending || roleBlocked) return;
    if (customOpen) {
      const text = customText.trim();
      if (text === '') {
        setCustomError(CUSTOM_EMPTY_ERROR);
        customInputRef.current?.focus();
        return;
      }
      if (text.length > CUSTOM_MAX) {
        setCustomError(`最多 ${CUSTOM_MAX} 字，当前 ${text.length} 字`);
        customInputRef.current?.focus();
        return;
      }
      // 校验通过后才进入跨区确认，避免空文本先把按钮变成「确认」
      if (needsCrossConfirm && !confirmCross) {
        armCrossConfirm();
        return;
      }
      setError(null);
      setCustomError(null);
      answerMutation.mutate(
        {
          decisionId: item.id,
          answerText: text,
          ...(isAnswered ? { expectedRevision: item.answer_revision } : {}),
        },
        {
          onSuccess: () => {
            setSelectedOptionId(null);
            setCustomOpen(false);
            setConfirmCross(false);
          },
          onError: handleSubmitError,
        },
      );
      return;
    }
    if (selectedOptionId === null || !canSubmit) return;
    if (needsCrossConfirm && !confirmCross) {
      armCrossConfirm();
      return;
    }
    setError(null);
    answerMutation.mutate(
      {
        decisionId: item.id,
        optionId: selectedOptionId,
        ...(isAnswered ? { expectedRevision: item.answer_revision } : {}),
      },
      {
        onSuccess: () => {
          setSelectedOptionId(null);
          setConfirmCross(false);
        },
        onError: handleSubmitError,
      },
    );
  }

  const actionLabel = answerMutation.isPending
    ? '提交中…'
    : confirmCross
      ? isAnswered
        ? '确认跨区修订'
        : '确认跨区回答'
      : isAnswered
        ? '提交修订'
        : '提交回答';

  return (
    <li
      ref={ref}
      data-testid={`decision-item-${item.id}`}
      data-selected={focused ? 'true' : 'false'}
      data-expanded={expanded ? 'true' : 'false'}
      className={`flex min-w-0 flex-col gap-1.5 rounded-md border bg-surface-card px-2 py-1.5 transition-colors duration-150 motion-reduce:transition-none ${
        focused ? 'border-accent bg-accent-soft' : 'border-hairline hover:bg-surface-raised'
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        {rank !== undefined && (
          <span
            data-testid={`decision-rank-${item.id}`}
            className="shrink-0 whitespace-nowrap rounded bg-surface-raised px-1 font-mono text-xs tabular-nums text-ink-3"
          >
            #{rank}
          </span>
        )}
        {crossWorkspace && (
          <span
            data-testid={`decision-workspace-${item.id}`}
            data-workspace-name={workspaceName}
            title={workspaceName}
            className="max-w-[6rem] shrink-0 truncate rounded bg-surface-raised px-1 text-xs text-ink-3"
          >
            {shortWorkspaceName(workspaceName)}
          </span>
        )}
        <button
          type="button"
          onClick={() => onOpenIssue(item.issue_id)}
          title={`打开卡详情：${item.issue_title}`}
          className="min-w-0 truncate text-left text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          {item.issue_title}
        </button>
        {graceRemaining !== null && (
          <span
            data-testid={`decision-countdown-${item.id}`}
            className="ml-auto shrink-0 whitespace-nowrap rounded bg-accent-soft px-1.5 text-xs font-medium tabular-nums text-accent"
          >
            {formatCountdown(graceRemaining)}
          </span>
        )}
        {scope === 'stale' && (
          <span className="ml-auto shrink-0 whitespace-nowrap rounded border border-hairline px-1.5 text-xs text-ink-2">
            超时
          </span>
        )}
        {scope === 'answered' && item.answered_at !== null && (
          <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-ink-3">
            已回答于 {formatClock(item.answered_at)}
          </span>
        )}
        <button
          type="button"
          data-testid={`decision-toggle-${item.id}`}
          aria-expanded={expanded}
          onClick={() => onToggle(item.id)}
          className="shrink-0 whitespace-nowrap rounded border border-hairline px-1.5 py-0.5 text-xs text-ink-2 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          {expanded ? '收起' : '展开'}
        </button>
      </div>

      {/* 停止确认状态（open / stale）：已确认优先于未确认 */}
      {item.stop_ack_at !== null ? (
        <span data-testid={`decision-stop-acked-${item.id}`} className="self-start rounded bg-surface-raised px-1.5 text-xs text-ink-2">
          已确认停止（{formatClock(item.stop_ack_at)}）
        </span>
      ) : item.stop_requested_at !== null ? (
        <span
          data-testid={`decision-stop-unacked-${item.id}`}
          className="self-start rounded border border-red-300 px-1.5 text-xs text-red-600 dark:border-red-800 dark:text-red-400"
        >
          停止未确认（{formatClock(item.stop_requested_at)}）
        </span>
      ) : null}

      {expanded ? (
        <ExpandedBody
          item={item}
          detail={detail}
          selectedOptionId={selectedOptionId}
          onSelect={selectOption}
          custom={{
            open: customOpen,
            text: customText,
            draft: customDraft,
            error: customError,
            scroll: optionsScroll,
            inputRef: customInputRef,
            onToggle: toggleCustom,
            onTextChange: onCustomChange,
            onKeyDown: onCustomKeyDown,
            onSubmit: submit,
          }}
        />
      ) : (
        <CollapsedBody
          item={item}
          options={options}
          selectedOptionId={selectedOptionId}
          preview={preview}
          onSelect={selectOption}
          custom={{
            open: customOpen,
            text: customText,
            draft: customDraft,
            error: customError,
            scroll: optionsScroll,
            inputRef: customInputRef,
            onToggle: toggleCustom,
            onTextChange: onCustomChange,
            onKeyDown: onCustomKeyDown,
            onSubmit: submit,
          }}
        />
      )}

      {currentLabel !== null && (
        <span data-testid={`decision-current-answer-${item.id}`} className="text-xs text-ink-2">
          当前答案：第 {item.answer_revision} 版「{currentLabel}」
        </span>
      )}

      {waiting !== null && <span className="text-xs text-ink-3">已等 {waiting}</span>}

      {roleBlocked && (
        <p data-testid={`decision-role-blocked-${item.id}`} className="text-xs text-ink-3">
          当前身份在「{workspaceName}」没有回答权限（只读或非成员）
        </p>
      )}

      {confirmCross && needsCrossConfirm && (
        <p
          data-testid={`decision-cross-confirm-${item.id}`}
          className="rounded border border-amber-300 bg-amber-50 px-1.5 py-1 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
        >
          跨工作区回答：提交后会回答「{workspaceName}」的决策并可能释放该卡占用；请再点一次确认。
        </p>
      )}

      {error !== null && (
        <p data-testid={`decision-error-${item.id}`} className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div
        data-testid={`decision-actions-${item.id}`}
        style={{ flexDirection: narrow ? 'column' : 'row' }}
        className="flex items-stretch gap-1.5"
      >
        <button
          type="button"
          data-testid={`decision-action-${item.id}`}
          disabled={roleBlocked || (!customOpen && selectedOptionId === null) || !canSubmit}
          onClick={submit}
          className={`whitespace-nowrap rounded-md px-2 py-1 text-xs transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-50 ${
            isAnswered
              ? 'border border-hairline text-ink-2 hover:bg-surface-raised'
              : 'bg-accent font-medium text-white hover:opacity-90'
          } ${narrow ? 'w-full' : ''}`}
        >
          {actionLabel}
        </button>
        {isAnswered && !expanded && (
          <button
            type="button"
            data-testid={`decision-revise-${item.id}`}
            onClick={() => onToggle(item.id)}
            className="whitespace-nowrap rounded-md border border-hairline px-2 py-1 text-xs text-ink-2 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            改答案
          </button>
        )}
        <button
          type="button"
          data-testid={`decision-open-${item.id}`}
          onClick={() => onOpenIssue(item.issue_id)}
          className={`whitespace-nowrap rounded-md border border-hairline px-2 py-1 text-xs text-ink-2 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
            narrow ? 'w-full' : 'ml-auto'
          }`}
        >
          卡详情
        </button>
      </div>
    </li>
  );
}

/** 自定义答案的就地编辑器状态（收起态 chip 行与展开态选项列表共用） */
interface CustomAnswerConfig {
  open: boolean;
  text: string;
  draft: string;
  error: string | null;
  scroll: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onToggle: () => void;
  onTextChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onSubmit: () => void;
}

function truncateDraft(text: string): string {
  return text.length > 12 ? `${text.slice(0, 12)}…` : text;
}

interface CollapsedBodyProps {
  item: DecisionListItemDto;
  options: DecisionListItemDto['options'];
  selectedOptionId: string | null;
  preview: DecisionListItemDto['options'][number] | null;
  onSelect: (optionId: string) => void;
  custom: CustomAnswerConfig;
}

function CollapsedBody({ item, options, selectedOptionId, preview, onSelect, custom }: CollapsedBodyProps) {
  return (
    <>
      <p className="line-clamp-2 text-xs text-ink-2">{item.question}</p>
      <div
        data-testid={`decision-chips-${item.id}`}
        role="radiogroup"
        aria-label="选择回答选项"
        style={custom.scroll ? { maxHeight: CHIPS_MAX_HEIGHT, overflowY: 'auto' } : undefined}
        className="flex flex-wrap gap-1"
      >
        {options.map((option) => {
          const selected = option.id === selectedOptionId;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              data-testid={`decision-option-${option.id}`}
              aria-pressed={selected}
              aria-checked={selected}
              onClick={() => onSelect(option.id)}
              className={`rounded-full border px-2 py-0.5 text-xs transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                selected ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-hairline text-ink-2 hover:bg-surface-raised'
              }`}
            >
              {option.label}
            </button>
          );
        })}
        <button
          type="button"
          role="radio"
          data-testid={`decision-custom-${item.id}`}
          aria-pressed={custom.open}
          aria-checked={custom.open}
          title="不在选项里？自己写一句"
          onClick={custom.onToggle}
          className={`rounded-full border border-dashed px-2 py-0.5 text-xs transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
            custom.open ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-hairline text-ink-3 hover:bg-surface-raised'
          }`}
        >
          ✎ {custom.draft === '' ? '自定义' : truncateDraft(custom.draft)}
        </button>
      </div>
      {custom.open && <CustomEditor id={item.id} custom={custom} />}
      <p data-testid={`decision-consequence-${item.id}`} className="truncate text-xs text-ink-3">
        {preview === null ? '暂无选项' : `后果：${preview.consequence}`}
      </p>
    </>
  );
}

/** 自定义答案输入框：Enter 提交 / Esc 收起（键盘处理在卡片层），空值与超长拦截在 submit 层 */
function CustomEditor({ id, custom }: { id: string; custom: CustomAnswerConfig }) {
  const errorId = `decision-custom-error-${id}`;
  return (
    <div data-testid={`decision-custom-editor-${id}`} className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <input
          ref={custom.inputRef}
          type="text"
          data-testid={`decision-custom-input-${id}`}
          aria-label="自定义答案"
          aria-invalid={custom.error !== null}
          aria-describedby={custom.error !== null ? errorId : undefined}
          maxLength={CUSTOM_MAX}
          value={custom.text}
          placeholder={`写一句你自己的答案（≤${CUSTOM_MAX} 字）· Enter 提交 · Esc 收起`}
          onChange={custom.onTextChange}
          onKeyDown={custom.onKeyDown}
          className="min-w-0 flex-1 rounded border border-dashed border-hairline bg-surface-card px-1.5 py-1 text-xs text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        />
        <span
          data-testid={`decision-custom-count-${id}`}
          className="shrink-0 font-mono text-xs tabular-nums text-ink-3"
        >
          {custom.text.length}/{CUSTOM_MAX}
        </span>
        <button
          type="button"
          data-testid={`decision-custom-submit-${id}`}
          onClick={custom.onSubmit}
          className="shrink-0 whitespace-nowrap rounded border border-hairline px-1.5 py-1 text-xs text-ink-2 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          用这句提交
        </button>
      </div>
      {custom.error !== null && (
        <p id={errorId} data-testid={errorId} className="text-xs text-red-600 dark:text-red-400">
          {custom.error}
        </p>
      )}
    </div>
  );
}

interface ExpandedBodyProps {
  item: DecisionListItemDto;
  detail: DecisionDetailDto | null;
  selectedOptionId: string | null;
  onSelect: (optionId: string) => void;
  custom: CustomAnswerConfig;
}

function ExpandedBody({ item, detail, selectedOptionId, onSelect, custom }: ExpandedBodyProps) {
  const options = [...(detail?.options ?? item.options)].sort((a, b) => a.ord - b.ord);
  const answers = [...(detail?.answers ?? [])].sort((a, b) => a.revision - b.revision);
  const current = currentAnswer(detail, item.answer_revision);
  const checkpoints = checkpointLines(detail?.checkpoint_json ?? null);

  return (
    <div data-testid={`decision-detail-${item.id}`} className="flex min-w-0 flex-col gap-1.5">
      <p data-testid={`decision-full-question-${item.id}`} className="whitespace-pre-wrap text-sm font-medium text-ink">
        {item.question}
      </p>
      {item.context_md !== '' && <p className="whitespace-pre-wrap text-xs text-ink-2">{item.context_md}</p>}

      <ul
        data-testid={`decision-options-${item.id}`}
        className="flex flex-col gap-1"
        role="radiogroup"
        style={custom.scroll ? { maxHeight: LIST_MAX_HEIGHT, overflowY: 'auto' } : undefined}
      >
        {options.map((option) => {
          const selected = option.id === selectedOptionId;
          const answered = current?.option_id === option.id;
          return (
            <li key={option.id}>
              <button
                type="button"
                role="radio"
                data-testid={`decision-detail-option-${option.id}`}
                aria-pressed={selected}
                aria-checked={selected}
                onClick={() => onSelect(option.id)}
                className={`flex w-full min-w-0 flex-col items-start gap-0.5 rounded border px-1.5 py-1 text-left transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                  selected ? 'border-accent bg-accent-soft' : 'border-hairline bg-surface-card hover:bg-surface-raised'
                }`}
              >
                <span className="flex w-full min-w-0 items-baseline gap-2">
                  <span className="shrink-0 text-xs text-ink-3">{option.ord}.</span>
                  <span className={`min-w-0 truncate text-sm ${selected || answered ? 'font-semibold text-accent' : 'text-ink'}`}>
                    {option.label}
                  </span>
                  {option.is_default === 1 && (
                    <span data-testid={`decision-default-${option.id}`} className="shrink-0 rounded bg-surface-raised px-1 text-xs text-ink-3">
                      默认
                    </span>
                  )}
                  {answered && <span className="ml-auto shrink-0 text-xs text-ink-3">（当前答案）</span>}
                </span>
                <span className="w-full text-xs text-ink-2">{option.consequence}</span>
              </button>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            role="radio"
            data-testid={`decision-detail-custom-${item.id}`}
            aria-pressed={custom.open}
            aria-checked={custom.open}
            onClick={custom.onToggle}
            className={`flex w-full min-w-0 flex-col items-start gap-0.5 rounded border border-dashed px-1.5 py-1 text-left transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
              custom.open ? 'border-accent bg-accent-soft' : 'border-hairline bg-surface-card hover:bg-surface-raised'
            }`}
          >
            <span className="flex w-full min-w-0 items-baseline gap-2">
              <span className="shrink-0 text-xs text-ink-3">✎</span>
              <span className={`min-w-0 truncate text-sm ${custom.open ? 'font-semibold text-accent' : 'text-ink'}`}>
                自定义答案{custom.draft === '' ? '' : `：${custom.draft}`}
              </span>
            </span>
            <span className="w-full text-xs text-ink-2">不在以上选项里：自己写一句，会原样写进卡评论</span>
          </button>
        </li>
      </ul>
      {custom.open && <CustomEditor id={item.id} custom={custom} />}

      <dl data-testid={`decision-meta-${item.id}`} className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-ink-3">
        <div className="flex min-w-0 gap-1">
          <dt className="shrink-0">优先级</dt>
          <dd className="truncate text-ink-2">{item.issue_priority}</dd>
        </div>
        <div className="flex min-w-0 gap-1">
          <dt className="shrink-0">下游阻塞</dt>
          <dd className="truncate text-ink-2">{item.blocked_downstream_count}</dd>
        </div>
        <div className="flex min-w-0 gap-1">
          <dt className="shrink-0">提问</dt>
          <dd className="truncate text-ink-2">{item.created_by}</dd>
        </div>
        <div className="flex min-w-0 gap-1">
          <dt className="shrink-0">提问于</dt>
          <dd className="truncate text-ink-2">{formatClock(item.created_at)}</dd>
        </div>
      </dl>

      {checkpoints.length > 0 && (
        <div data-testid={`decision-checkpoint-${item.id}`}>
          <h4 className="text-xs font-medium text-ink-2">断点</h4>
          <ul className="mt-0.5 flex flex-col gap-0.5" role="list">
            {checkpoints.map((line, index) => (
              <li key={`${index}-${line}`} className="truncate text-xs text-ink-2" title={line}>
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      {answers.length > 0 && (
        <div data-testid={`decision-answers-${item.id}`}>
          <h4 className="text-xs font-medium text-ink-2">答案时间线</h4>
          <ol className="mt-0.5 flex flex-col gap-0.5" role="list">
            {answers.map((answer) => {
              const label = optionLabel(detail, answer);
              const isCurrent = answer.revision === item.answer_revision;
              return (
                <li
                  key={answer.id}
                  data-testid={`decision-answer-revision-${item.id}-${answer.revision}`}
                  data-current={isCurrent ? 'true' : 'false'}
                  className={`text-xs ${isCurrent ? 'font-semibold text-accent' : 'text-ink-2'}`}
                >
                  <span className="tabular-nums text-ink-3">第 {answer.revision} 版</span>
                  <span className="mx-1">·</span>
                  <span>{label === null ? '（空答案）' : `「${label}」`}</span>
                  {answer.revoked_at !== null && <span className="ml-1 text-ink-3">（已撤销）</span>}
                  <span className="mx-1 text-ink-3">·</span>
                  <span className="text-ink-3">
                    {answer.answered_by}（{answer.source}）{formatClock(answer.created_at)}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
