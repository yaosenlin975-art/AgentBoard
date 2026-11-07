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
import { BlockedDownstream } from './BlockedDownstream';
import {
  DECISION_STALE_MS,
  downstreamCount,
  formatCountdown,
  formatElapsed,
  formatRelative,
  formatWaiting,
  remainingGraceSeconds,
} from './countdown';
import { checkpointLines } from './DecisionSection';
import { useAnswerDecision, useDecisionDetail, useExtendDecision, useWithdrawDecision } from './useDecisions';
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

/** DEC-V4-EXTEND：单次 +60s，累计上限 300s，且总宽限不超过 600s（与原型 EXTEND_STEP / EXTEND_CAP / GRACE_HARD_CAP 一致） */
const EXTEND_STEP_SECONDS = 60;
const EXTEND_CAP_SECONDS = 300;
const GRACE_HARD_CAP_SECONDS = 600;
/** 延长成功后 chip 闪一下（reduced motion 下只变背景色、不做过渡） */
const EXTEND_FLASH_MS = 700;
/** 卡片内 toast 停留时长 */
const EXTEND_NOTICE_MS = 4200;

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

/**
 * 同卡其它决策的状态摘要。
 * 列表 DTO 不含答案正文，answered 用「第 N 版」代替选项文案（不伪造选项名）。
 */
function siblingStatusLabel(sibling: DecisionListItemDto, now: number): string {
  if (sibling.state === 'answered') {
    const rel = formatRelative(sibling.answered_at === null ? null : now - sibling.answered_at);
    return `${rel === null ? '已回答' : `已回答 ${rel}`} · 第 ${sibling.answer_revision} 版`;
  }
  if (sibling.state === 'grace' && sibling.grace_until > now) {
    return `宽限中 · 剩 ${formatCountdown(remainingGraceSeconds(sibling.grace_until, now))}`;
  }
  if (sibling.locked_at !== null && sibling.locked_at <= now - DECISION_STALE_MS) {
    const elapsed = formatElapsed((now - sibling.locked_at) / 1000);
    return elapsed === null ? '超时' : `超时 ${elapsed}`;
  }
  const waiting = formatElapsed(sibling.waiting_seconds);
  return waiting === null ? '已锁' : `已锁 ${waiting}`;
}

export interface DecisionCardProps {
  item: DecisionListItemDto;
  now: number;
  rank: number | undefined;
  focused: boolean;
  /** P8：深链定位后的两次闪烁（reduced motion 下不闪，仅保留高亮边框） */
  flash?: boolean;
  /** DEC-V4-UNDO：提交成功后的 420ms leaving 态（覆盖层 + 不可再点） */
  leaving?: boolean;
  scope: 'grace' | 'open' | 'stale' | 'answered';
  expanded: boolean;
  /** 同一张任务卡上的其它决策（已由视图聚合，排除自身；用于卡头计数与展开区互跳） */
  siblings: DecisionListItemDto[];
  /** 当前选中的工作区；与 item.workspace_id 不同即跨区卡 */
  homeWorkspaceId: string;
  /** 切 tab / 切范围时递增的复位信号：清掉跨区二次确认 */
  resetSignal: string;
  onToggle: (decisionId: string) => void;
  onOpenIssue: (issueId: string) => void;
  /** 同卡决策互跳：交给视图 focusDecision，复用深链定位/展开/高亮 */
  onJumpDecision: (decisionId: string) => void;
  /** DEC-V4-UNDO：提交成功 → 视图接管撤销条与移出节奏（答案已在服务端落库） */
  onAnswered: (payload: DecisionAnsweredPayload) => void;
}

/** 提交成功后交给视图的服务端事实（revision / 撤销截止都来自 answer 响应） */
export interface DecisionAnsweredPayload {
  decisionId: string;
  issueTitle: string;
  revision: number;
  /** 答案行的 answered_by（撤销时服务端要求与它或提问者一致） */
  by: string;
  /** 服务端 `undo_until`（毫秒）；撤销倒计时唯一依据 */
  deadline: number;
  /** PERM-3：是否展示撤销入口（能力驱动的降级；窗口仍由服务端裁决） */
  canUndo: boolean;
}

/** 跨区 chip 文案：短名展示、全名放 title（服务端 workspace_name） */
function shortWorkspaceName(name: string): string {
  return name.length > 8 ? `${name.slice(0, 8)}…` : name;
}

/** DEC-V4-EXTEND：延长成功后的本地覆盖，服务端列表追平（extended_seconds ≥ 补丁）即复位 */
interface ExtendGracePatch {
  graceUntil: number;
  extendedSeconds: number;
  extensionCount: number;
}

export function DecisionCard({
  item,
  now,
  rank,
  focused,
  flash = false,
  leaving = false,
  scope,
  expanded,
  siblings,
  homeWorkspaceId,
  resetSignal,
  onToggle,
  onOpenIssue,
  onJumpDecision,
  onAnswered,
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
  // PERM-3：撤回（仅 can_withdraw=true 渲染入口）同样两步防误触
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const prevOptionRef = useRef<string | null>(null);
  const customInputRef = useRef<HTMLInputElement | null>(null);
  // 已回答卡收起态也要展示当前答案选项 → 仅在 answered 时预取详情；展开时一律取详情
  const detailQueryEnabled = expanded || scope === 'answered';
  const detail = useDecisionDetail(detailQueryEnabled ? item.id : null);
  const answerMutation = useAnswerDecision();
  // PERM-3：撤回决策（服务端要求 owner；capability=false 时入口不渲染）
  const withdrawMutation = useWithdrawDecision();
  // DEC-V4-EXTEND：延长宽限（+60s / 次，上限见 maxExtendSeconds）
  const extendMutation = useExtendDecision();
  const [gracePatch, setGracePatch] = useState<ExtendGracePatch | null>(null);
  const [extendFlash, setExtendFlash] = useState(false);
  const [extendNotice, setExtendNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const extendFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const extendNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const options = [...item.options].sort((a, b) => a.ord - b.ord);
  const defaultOption = options.find((option) => option.is_default === 1) ?? options[0] ?? null;
  const selectedOption = options.find((option) => option.id === selectedOptionId) ?? null;
  // P5/PERM-3：跨区标注 + 服务端 capability 决定「能不能答」；不写死「跨区一定要确认」
  const crossWorkspace = item.workspace_id !== homeWorkspaceId;
  const workspaceName = item.workspace_name ?? item.workspace_id;
  const capabilities = item.capabilities ?? null;
  // PERM-3：能力字段只认服务端投影；缺字段按 false（不放大权限）。
  // 整份 capabilities 缺失 = 旧服务端，按 state 渲染并允许点击，由 403 兜底（卡面要求 7）。
  // 撤回不可逆：旧服务端拿不到能力就不给入口，不接受「缺省放行」。
  const canAnswer = capabilities === null || capabilities.can_answer === true;
  const canRevise = capabilities === null || capabilities.can_revise === true;
  const canExtend = capabilities === null || capabilities.can_extend === true;
  const canWithdraw = capabilities !== null && capabilities.can_withdraw === true;
  const roleBlocked = !canAnswer;
  const needsCrossConfirm = crossWorkspace && canAnswer;
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
    !leaving &&
    !answerMutation.isPending &&
    canAnswer &&
    (!isAnswered || canRevise) &&
    (customOpen ? true : selectedOptionId !== null && (current === null || selectedOptionId !== current.option_id));
  const optionsScroll = options.length + 1 >= SCROLL_THRESHOLD;

  // P5/PERM-3：切 tab / 切范围 / 展开收起都视为「换了上下文」，跨区确认与撤回确认必须重来
  useEffect(() => {
    setConfirmCross(false);
    setConfirmWithdraw(false);
  }, [resetSignal, expanded]);

  const effectiveGraceUntil = gracePatch?.graceUntil ?? item.grace_until;
  const graceRemaining =
    item.state === 'grace' && effectiveGraceUntil > now
      ? Math.max(0, Math.ceil((effectiveGraceUntil - now) / 1000))
      : null;
  const extendedSeconds = gracePatch?.extendedSeconds ?? item.extended_seconds ?? 0;
  const extensionCount = gracePatch?.extensionCount ?? item.extension_count ?? 0;
  const totalGraceSeconds = item.grace_seconds + extendedSeconds;
  const maxExtendSeconds = Math.min(
    EXTEND_CAP_SECONDS,
    Math.max(0, GRACE_HARD_CAP_SECONDS - item.grace_seconds),
  );
  const extendCapped = maxExtendSeconds <= 0 || extendedSeconds >= maxExtendSeconds;
  // 临界态：剩余 ≤60 秒时按钮仍可用，只加提示样式；延长后剩余回到 60 秒以上自动清除
  const extendCritical = graceRemaining !== null && graceRemaining <= 60;
  // 进度条与原型同口径：remaining / (grace_seconds + extended_seconds)
  const progressPct =
    graceRemaining === null || totalGraceSeconds <= 0
      ? null
      : Math.max(0, Math.min(100, (graceRemaining / totalGraceSeconds) * 100));
  const waiting = item.state === 'open' ? formatWaiting(item.waiting_seconds ?? null) : null;
  // DEC-RAIL：左缘 3px 状态色轨（琥珀=宽限中 / 石墨=已锁 / 红=已超时或临界 / 绿=已回答）
  // 只影响视觉与文案，倒计时计算仍以 effectiveGraceUntil 为准。
  const cardTier: 'critical' | 'grace' | 'stale' | 'answered' | 'open' = isAnswered
    ? 'answered'
    : scope === 'stale'
      ? 'stale'
      : extendCritical
        ? 'critical'
        : scope === 'grace'
          ? 'grace'
          : 'open';
  const railClass =
    cardTier === 'critical' || cardTier === 'stale'
      ? 'bg-ab-del'
      : cardTier === 'grace'
        ? 'bg-accent'
        : cardTier === 'answered'
          ? 'bg-ab-add'
          : 'bg-ink-3';

  // 服务端列表追平本地补丁（含其他端延长）后以服务端为准
  useEffect(() => {
    if (gracePatch === null) return;
    if ((item.extended_seconds ?? 0) >= gracePatch.extendedSeconds) setGracePatch(null);
  }, [item.extended_seconds, gracePatch]);

  useEffect(() => {
    return () => {
      if (extendFlashTimer.current !== null) clearTimeout(extendFlashTimer.current);
      if (extendNoticeTimer.current !== null) clearTimeout(extendNoticeTimer.current);
    };
  }, []);

  useEffect(() => {
    if (extendNotice === null) return;
    if (extendNoticeTimer.current !== null) clearTimeout(extendNoticeTimer.current);
    extendNoticeTimer.current = setTimeout(() => setExtendNotice(null), EXTEND_NOTICE_MS);
    return () => {
      if (extendNoticeTimer.current !== null) clearTimeout(extendNoticeTimer.current);
    };
  }, [extendNotice]);

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
      // PERM-3：403 用服务端 message（角色/成员原因以服务端为准），并刷新列表；
      // 卡片留在原地，不抹掉、不跳页。
      if (err.code === 'WORKSPACE_FORBIDDEN' || err.code === 'ROLE_FORBIDDEN') {
        setError(err.message);
        void queryClient.invalidateQueries({ queryKey: ['decisions'] });
        void queryClient.invalidateQueries({ queryKey: ['decisions-count'] });
        void queryClient.invalidateQueries({ queryKey: ['decision'] });
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

  /**
   * DEC-V4-UNDO：提交成功回调。答案已在服务端落库，这里只上报事实：
   * revision 用于撤销的 expected_revision，deadline 用服务端 `undo_until`（不是本地 +6s）。
   */
  function notifyAnswered(decision: DecisionDetailDto) {
    const answer = decision.answers?.find((row) => row.id === decision.current_answer_id) ?? null;
    onAnswered({
      decisionId: item.id,
      issueTitle: item.issue_title,
      revision: decision.answer_revision,
      by: answer?.answered_by ?? 'user',
      deadline: decision.undo_until ?? Date.now() + 6000,
      // PERM-3：优先用 answer 响应里的 can_undo；旧服务端不返回 capabilities 时
      // 退回同源的 can_answer（member+ 写资格），窗口/revision 仍由服务端裁决。
      canUndo: decision.capabilities?.can_undo ?? canAnswer,
    });
  }

  function submit() {
    if (leaving || answerMutation.isPending || roleBlocked || (isAnswered && !canRevise)) return;
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
          onSuccess: (response) => {
            setSelectedOptionId(null);
            setCustomOpen(false);
            setConfirmCross(false);
            notifyAnswered(response.decision);
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
        onSuccess: (response) => {
          setSelectedOptionId(null);
          setConfirmCross(false);
          notifyAnswered(response.decision);
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

  /**
   * DEC-V4-EXTEND：延长宽限。成功按响应本地立即生效（+60s / 进度条 / 展开区同步），
   * 失败（409 DECISION_NOT_GRACE / EXTEND_LIMIT_EXCEEDED / STALE_FENCE）原样展示服务端 message 并刷新列表。
   */
  function requestExtend() {
    if (item.state !== 'grace' || extendCapped || extendMutation.isPending) return;
    extendMutation.mutate(
      { decisionId: item.id, seconds: EXTEND_STEP_SECONDS },
      {
        onSuccess: (response) => {
          setGracePatch({
            graceUntil: response.grace_until,
            extendedSeconds: response.extended_seconds,
            extensionCount: response.extension_count,
          });
          setExtendNotice({
            tone: 'info',
            text: `${item.issue_id.slice(0, 8)} 宽限 +1 分钟 · 剩余 ${formatCountdown(response.remaining_grace_seconds)}${
              response.extended_seconds >= response.max_extend_seconds ? ' · 已达延长上限' : ''
            }`,
          });
          setExtendFlash(true);
          if (extendFlashTimer.current !== null) clearTimeout(extendFlashTimer.current);
          extendFlashTimer.current = setTimeout(() => setExtendFlash(false), EXTEND_FLASH_MS);
        },
        onError: (err) => {
          setExtendNotice({
            tone: 'error',
            text: err instanceof ApiError ? err.message : '延长失败，请重试',
          });
          // 状态可能已落锁 / 上限已被改：以服务端为准刷新，倒计时由新数据计算，不会出现负数
          void queryClient.invalidateQueries({ queryKey: ['decisions'] });
          void queryClient.invalidateQueries({ queryKey: ['decision'] });
        },
      },
    );
  }

  /**
   * PERM-3：撤回决策（仅 can_withdraw=true 时入口可见，服务端仍要求 owner）。
   * 两步确认防误触；成功后失效列表（决策转 withdrawn 会离开在途队列），失败按服务端 message 就地提示。
   */
  function requestWithdraw() {
    if (withdrawMutation.isPending) return;
    if (!confirmWithdraw) {
      setConfirmWithdraw(true);
      setError(null);
      return;
    }
    withdrawMutation.mutate(
      { decisionId: item.id, reason: '用户在看板撤回' },
      {
        onSuccess: () => {
          setConfirmWithdraw(false);
          void queryClient.invalidateQueries({ queryKey: ['decisions'] });
          void queryClient.invalidateQueries({ queryKey: ['decisions-count'] });
          void queryClient.invalidateQueries({ queryKey: ['decision'] });
          void queryClient.invalidateQueries({ queryKey: ['issue'] });
          void queryClient.invalidateQueries({ queryKey: ['issues'] });
        },
        onError: (err) => {
          setConfirmWithdraw(false);
          setError(err instanceof ApiError ? err.message : '撤回失败，请重试');
          void queryClient.invalidateQueries({ queryKey: ['decisions'] });
        },
      },
    );
  }

  return (
    <li
      ref={ref}
      data-testid={`decision-item-${item.id}`}
      data-selected={focused ? 'true' : 'false'}
      data-flash={flash ? 'true' : 'false'}
      data-expanded={expanded ? 'true' : 'false'}
      data-leaving={leaving ? 'true' : 'false'}
      data-tier={cardTier}
      aria-busy={leaving}
      className={`relative flex min-w-0 flex-col gap-1.5 rounded-md border bg-surface-card px-2 py-1.5 transition-colors duration-150 motion-reduce:transition-none ${
        focused ? 'border-accent bg-accent-soft' : 'border-hairline hover:bg-surface-raised'
      } ${flash ? 'ring-2 ring-accent ring-offset-1' : ''}`}
    >
      {/* DEC-RAIL：左缘 3px 状态色轨，颜色复用 --ab-* 令牌 */}
      <span
        data-testid={`decision-rail-${item.id}`}
        data-tier={cardTier}
        aria-hidden="true"
        className={`pointer-events-none absolute bottom-0 left-0 top-0 w-[3px] rounded-l-md ${railClass}`}
      />
      {/* DEC-V4-UNDO：提交已落库，420ms 视觉移出（reduced motion 下由视图直接跳过） */}
      {leaving && (
        <div
          data-testid={`decision-leaving-${item.id}`}
          role="status"
          aria-live="polite"
          className="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-surface-card/90 text-xs font-medium text-ink-2"
        >
          已记录 · 正在移出
        </div>
      )}
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
          data-testid={`decision-issue-id-${item.id}`}
          onClick={() => onOpenIssue(item.issue_id)}
          title={`任务 ${item.issue_id}（点击打开详情）`}
          className="shrink-0 rounded font-mono text-[11px] tabular-nums text-ink-3 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          {item.issue_id.slice(0, 8)}
        </button>
        <button
          type="button"
          onClick={() => onOpenIssue(item.issue_id)}
          title={`打开卡详情：${item.issue_title}`}
          className="min-w-0 truncate text-left text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          {item.issue_title}
        </button>
        {item.issue_priority && (
          <span
            data-testid={`decision-priority-${item.id}`}
            data-priority={item.issue_priority}
            title={`任务优先级：${item.issue_priority}`}
            className={`shrink-0 whitespace-nowrap rounded border px-1 text-[10px] font-semibold leading-4 ${
              item.issue_priority === '高' ? 'border-accent text-accent' : 'border-hairline text-ink-3'
            }`}
          >
            {item.issue_priority}
          </span>
        )}
        {siblings.length > 0 && (
          <span
            data-testid={`decision-sibling-count-${item.id}`}
            className="shrink-0 whitespace-nowrap text-[10.5px] text-ink-3"
          >
            同卡 {siblings.length} 条历史
          </span>
        )}
        {graceRemaining !== null && (
          <span
            data-testid={`decision-countdown-${item.id}`}
            data-flash={extendFlash ? 'true' : 'false'}
            data-critical={extendCritical ? 'true' : 'false'}
            className={`ml-auto shrink-0 whitespace-nowrap rounded px-1.5 text-xs font-medium tabular-nums transition-colors duration-150 motion-reduce:transition-none ${
              extendFlash
                ? 'bg-accent text-white'
                : extendCritical
                  ? 'bg-[color-mix(in_srgb,var(--ab-del)_14%,transparent)] text-ab-del'
                  : 'bg-accent-soft text-accent'
            }`}
          >
            {formatCountdown(graceRemaining)}
            {extendCritical && <span className="ml-1">即将落锁</span>}
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
        <button
          type="button"
          data-testid={`decision-jump-${item.id}`}
          aria-label={`打开任务卡 ${item.issue_id}`}
          title="打开任务卡 ↗"
          onClick={() => onOpenIssue(item.issue_id)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-surface-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.5]">
            <path d="M6 3h7v7" />
            <path d="M13 3 6.5 9.5" />
            <path d="M12 10.5V13H3V4h2.5" />
          </svg>
        </button>
      </div>

      {/* DEC-V4-EXTEND：宽限进度条（remaining / 原宽限 + 已延长） */}
      {scope === 'grace' && progressPct !== null && (
        <div
          data-testid={`decision-progress-${item.id}`}
          data-pct={progressPct.toFixed(1)}
          role="progressbar"
          aria-label="剩余宽限"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progressPct)}
          className="h-0.5 w-full overflow-hidden rounded-full bg-surface-raised"
        >
          <span
            className={`block h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none ${
              extendCritical ? 'bg-ab-del' : 'bg-accent'
            }`}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

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

      {/* P6：统计行入口 + 就地下游清单（方向：本卡 blocks 了谁） */}
      <BlockedDownstream
        issueId={item.issue_id}
        workspaceId={item.workspace_id}
        count={downstreamCount(item)}
        onOpenIssue={onOpenIssue}
      />

      {expanded ? (
        <ExpandedBody
          item={item}
          detail={detail}
          selectedOptionId={selectedOptionId}
          onSelect={selectOption}
          grace={
            item.state === 'grace'
              ? {
                  totalSeconds: totalGraceSeconds,
                  originalSeconds: item.grace_seconds,
                  extendedSeconds,
                  maxExtendSeconds,
                  extensionCount,
                }
              : null
          }
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

      {/* DEC-SIBLING：同一张任务卡上的其它决策（可互跳；数据由视图从在途+24h 已回答列表聚合） */}
      {expanded && siblings.length > 0 && (
        <section
          data-testid={`decision-siblings-${item.id}`}
          aria-label="同一张任务卡上的其它决策"
          className="flex min-w-0 flex-col gap-1 border-t border-hairline pt-1.5"
        >
          <h3 className="text-[10.5px] font-medium text-ink-3">同一张任务卡</h3>
          {siblings.map((sibling) => (
            <button
              key={sibling.id}
              type="button"
              data-testid={`decision-sibling-${item.id}-${sibling.id}`}
              onClick={() => onJumpDecision(sibling.id)}
              className="flex min-w-0 items-center gap-2 rounded border border-hairline px-1.5 py-1 text-left text-xs text-ink-2 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              <span className="min-w-0 flex-1 truncate">{sibling.question}</span>
              <span className="shrink-0 whitespace-nowrap text-[10.5px] text-ink-3">
                {siblingStatusLabel(sibling, now)}
              </span>
              <span aria-hidden="true" className="shrink-0 text-ink-3">
                →
              </span>
            </button>
          ))}
        </section>
      )}

      {currentLabel !== null && (
        <span data-testid={`decision-current-answer-${item.id}`} className="text-xs text-ink-2">
          当前答案：第 {item.answer_revision} 版「{currentLabel}」
        </span>
      )}

      {waiting !== null && <span className="text-xs text-ink-3">已等 {waiting}</span>}

      {roleBlocked && (
        <p data-testid={`decision-role-blocked-${item.id}`} className="text-xs text-ink-3">
          无目标工作区写权限（{workspaceName}）
        </p>
      )}

      {confirmWithdraw && canWithdraw && (
        <p
          data-testid={`decision-withdraw-confirm-${item.id}`}
          className="rounded border border-amber-300 bg-amber-50 px-1.5 py-1 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
        >
          撤回后该决策不再等待回答（不可恢复）；请再点一次确认。
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

      {extendNotice !== null && (
        <p
          data-testid={`decision-extend-toast-${item.id}`}
          data-tone={extendNotice.tone}
          role="status"
          aria-live="polite"
          className={`self-start rounded px-1.5 py-0.5 text-xs ${
            extendNotice.tone === 'error'
              ? 'border border-red-300 text-red-600 dark:border-red-800 dark:text-red-400'
              : 'bg-accent-soft text-accent'
          }`}
        >
          {extendNotice.text}
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
        {scope === 'grace' && canExtend && (
          <button
            type="button"
            data-testid={`decision-extend-${item.id}`}
            data-critical={extendCritical ? 'true' : 'false'}
            data-extended={extendedSeconds}
            data-max-extend={maxExtendSeconds}
            disabled={extendCapped || extendMutation.isPending}
            onClick={requestExtend}
            title={`每点一次 +60 秒；累计最多 +${Math.round(maxExtendSeconds / 60)} 分钟，且总宽限不超过 10 分钟。仅宽限内可延，已锁卡不可延。`}
            className={`flex h-6 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 text-xs transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-50 ${
              extendCritical
                ? 'is-critical border-red-300 font-medium text-red-600 dark:border-red-800 dark:text-red-400'
                : 'border-hairline text-ink-2 hover:bg-surface-raised'
            }`}
          >
            {extendCapped ? '宽限已达上限' : extendMutation.isPending ? '延长中…' : '＋1 分钟'}
            <span className="font-mono text-[10px] tabular-nums text-ink-3">
              {Math.round(extendedSeconds / 60)}/{Math.round(maxExtendSeconds / 60)}
            </span>
          </button>
        )}
        <button
          type="button"
          data-testid={`decision-action-${item.id}`}
          disabled={roleBlocked || (!customOpen && selectedOptionId === null) || !canSubmit}
          onClick={submit}
          title={roleBlocked ? '无目标工作区写权限' : undefined}
          className={`whitespace-nowrap rounded-md px-2 py-1 text-xs transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-50 ${
            isAnswered
              ? 'border border-hairline text-ink-2 hover:bg-surface-raised'
              : 'bg-accent font-medium text-white hover:opacity-90'
          } ${narrow ? 'w-full' : ''}`}
        >
          {actionLabel}
        </button>
        {isAnswered && !expanded && canRevise && (
          <button
            type="button"
            data-testid={`decision-revise-${item.id}`}
            onClick={() => onToggle(item.id)}
            className="whitespace-nowrap rounded-md border border-hairline px-2 py-1 text-xs text-ink-2 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            改答案
          </button>
        )}
        {canWithdraw && item.state !== 'withdrawn' && (
          <button
            type="button"
            data-testid={`decision-withdraw-${item.id}`}
            data-confirm={confirmWithdraw ? 'true' : 'false'}
            disabled={withdrawMutation.isPending}
            onClick={requestWithdraw}
            className="whitespace-nowrap rounded-md border border-hairline px-2 py-1 text-xs text-ink-2 hover:bg-surface-raised disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            {withdrawMutation.isPending ? '撤回中…' : confirmWithdraw ? '确认撤回' : '撤回决策'}
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
  /** DEC-V4-EXTEND：宽限卡展示「宽限合计 / 已延长」；非宽限态为 null */
  grace: {
    totalSeconds: number;
    originalSeconds: number;
    extendedSeconds: number;
    maxExtendSeconds: number;
    extensionCount: number;
  } | null;
  custom: CustomAnswerConfig;
}

function ExpandedBody({ item, detail, selectedOptionId, onSelect, grace, custom }: ExpandedBodyProps) {
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
        {grace !== null && (
          <>
            <div className="flex min-w-0 gap-1" data-testid={`decision-grace-total-${item.id}`}>
              <dt className="shrink-0">宽限合计</dt>
              <dd className="truncate text-ink-2">
                {formatCountdown(grace.totalSeconds)}（原 {formatCountdown(grace.originalSeconds)}）
              </dd>
            </div>
            <div className="flex min-w-0 gap-1" data-testid={`decision-grace-extended-${item.id}`}>
              <dt className="shrink-0">已延长</dt>
              <dd className="truncate text-ink-2">
                {Math.round(grace.extendedSeconds / 60)} 分钟 / 上限 {Math.round(grace.maxExtendSeconds / 60)} 分钟（
                {grace.extensionCount} 次）
              </dd>
            </div>
          </>
        )}
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
