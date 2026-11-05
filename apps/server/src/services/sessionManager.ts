/**
 * Task 8：会话轮次编排（Pinned Contracts · 会话轮次规则）。
 *
 * 模块级单例（不导出类）：Task 9 启动时 initSessionManager(db, getAdapter, { maxConcurrentTurns }) 装配；
 * comments 服务经 comments.setSessionSender(sendToSession) 接入评论唤醒。
 */
import type { Message, MessageMeta, ServerWsEvent, Session } from '@agentboard/shared';
import type { AgentAdapter, RunTurnOptions, TurnHandle, UnifiedEvent } from '@agentboard/adapters';
import { getVerifiedImageInputCliVersion } from '@agentboard/adapters';
import type { Db } from '../db/connection.js';
import {
  createSession as insertSessionRow,
  getSession,
  updateSession,
  type SessionPatch,
} from '../db/repos/session.js';
import { addMessage } from '../db/repos/message.js';
import { failOpenTurns } from '../db/repos/sessionTurn.js';
import { initialToolMeta } from './messageMeta.js';
import { beginTurn as startTurnTracking, type TurnTracker } from './turnObservation.js';
import { classifySessionError, looksLikeErrorOutput, type SessionErrorSignal } from './messageSignals.js';
import {
  markIssueAttachmentsDelivered,
  markIssueAttachmentsSending,
  markIssueAttachmentsUnknown,
  markSessionAttachmentsDelivered,
  markSessionAttachmentsSending,
  markSessionAttachmentsUnknown,
} from '../db/repos/attachment.js';
import { getWorkspace } from '../db/repos/workspace.js';
import { getIssue } from '../db/repos/issue.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { failIssue } from './claim.js';
import { addComment } from './comments.js';

/** comments 服务唤醒注入接口（Task 9 装配真实 sendToSession；测试注入 stub） */
export interface SessionDelivery {
  attachments?: RunTurnOptions['attachments'];
  deliveredAttachmentIds?: string[];
  /** Image IDs observed as unknown when the user explicitly confirmed retry. */
  retryUnknownAttachmentIds?: string[];
  /** Actual detected CLI version already checked by dispatchIssue before claim. */
  verifiedCliVersion?: string;
  /** CHAT-IMG-DELIVERY：聊天通道标记——附件已绑定 session_attachment（自由会话的合法投递路径） */
  sessionAttachment?: boolean;
}
export type SessionSender = (sessionId: string, text: string, delivery?: SessionDelivery) => Promise<{ queued: boolean }>;

export interface SessionManagerOptions {
  /** 全局同时运行的轮次进程上限 */
  maxConcurrentTurns: number;
}

export interface CreateSessionInput {
  cli: string;
  model?: string | null;
  issue_id?: string | null;
  /** 自由会话（无 issue_id）必填：会话归属工作空间；绑 issue 时从 issue 推导 */
  workspace_id?: string;
  prompt?: string | null;
  reuse_session?: 'last' | 'new';
}

/** 单个轮次的上下文；stop 只作用于发出时的那一轮，新轮次替换 current 后旧轮结果弃用 */
interface TurnContext {
  handle: TurnHandle | null;
  stopRequested: boolean;
}

interface SessionState {
  /** 运行中收到的待合并消息（各自已落 user 行；合并后不再重复落库） */
  queue: TurnInput[];
  /** 本会话有无在途轮次（含等全局槽位） */
  turnActive: boolean;
  /** 当前轮次正在等全局并发槽位（beginTurn acquireSlot 窗口） */
  waitingSlot: boolean;
  current: TurnContext | null;
  /** CHAT-TURN1：当前轮次的观测器（session_turn 唯一写入句柄；无在途轮次为 null） */
  tracker: TurnTracker | null;
}

interface TurnInput {
  prompt: string;
  attachments: NonNullable<RunTurnOptions['attachments']>;
  deliveredAttachmentIds: string[];
  retryUnknownAttachmentIds: string[];
  /** CHAT-IMG-DELIVERY：附件绑定在 session_attachment（聊天入口），投递状态走会话版 */
  sessionAttachment: boolean;
  /** CHAT-TURN1 #6：本条输入落库的 user 消息 id（轮次行后建，起轮时回填 turn_id） */
  messageIds?: string[];
}

/** 会话运行时态（内存，不入库）：队列长度/等待槽位/排队文本副本 */
export interface SessionRuntime {
  queuedCount: number;
  waitingSlot: boolean;
  queuedTexts: string[];
}

let db: Db | null = null;
let resolveAdapter: ((cliId: string) => AgentAdapter) | null = null;
let maxConcurrentTurns = 3;
let activeTurns = 0;
const slotWaiters: Array<() => void> = [];
const states = new Map<string, SessionState>();
let broadcaster: ((event: ServerWsEvent) => void) | null = null;
/** 在途轮次观测器：usage 节流计时器的归属登记表（复位/删会话时统一停表，避免写已关闭的库） */
const liveTrackers = new Set<TurnTracker>();

function closeAllTrackers(): void {
  for (const tracker of liveTrackers) tracker.close();
  liveTrackers.clear();
}

function assertAssembled(): Db {
  if (!db) throw new Error('sessionManager 未装配');
  return db;
}

/** Task 9 启动装配；重复调用即重建 manager（内存队列、槽位计数、广播钩子清零） */
export function initSessionManager(
  database: Db,
  getAdapter: (cliId: string) => AgentAdapter,
  opts: SessionManagerOptions,
): void {
  if (!Number.isInteger(opts.maxConcurrentTurns) || opts.maxConcurrentTurns < 1) {
    throw new ValidationError('maxConcurrentTurns 必须为 ≥1 的整数');
  }
  db = database;
  resolveAdapter = getAdapter;
  maxConcurrentTurns = opts.maxConcurrentTurns;
  states.clear();
  closeAllTrackers();
  activeTurns = 0;
  slotWaiters.length = 0;
  broadcaster = null;
}

/** 恢复未装配状态（测试隔离用） */
export function resetSessionManager(): void {
  db = null;
  resolveAdapter = null;
  maxConcurrentTurns = 3;
  states.clear();
  closeAllTrackers();
  activeTurns = 0;
  slotWaiters.length = 0;
  broadcaster = null;
}

/** 运行时调整并发上限（PATCH /api/settings）：校验同 init；未装配时按装配门槛报错 */
export function setMaxConcurrentTurns(n: number): void {
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('maxConcurrentTurns 必须为 ≥1 的整数');
  }
  assertAssembled();
  maxConcurrentTurns = n;
}

/** Task 9 接 WS hub：广播 session.event / message.added / session.changed（CHAT-TURN1 追加 session.plan / session.usage） */
export function setBroadcaster(fn: (event: ServerWsEvent) => void): void {
  broadcaster = fn;
}

function broadcast(event: ServerWsEvent): void {
  broadcaster?.(event);
}

function markImageDelivery(
  database: Db,
  session: Session,
  attachmentIds: string[],
  state: 'unknown' | 'delivered',
  sessionAttachment = false,
): void {
  if (attachmentIds.length === 0) return;
  // CHAT-IMG-DELIVERY：按绑定路径分派——聊天入口绑 session_attachment；评论/派发绑 comment_attachment
  if (sessionAttachment || session.issue_id === null) {
    if (state === 'unknown') markSessionAttachmentsUnknown(database, session.id, attachmentIds);
    else markSessionAttachmentsDelivered(database, session.id, attachmentIds, Date.now());
    return;
  }
  const commentIds = state === 'unknown'
    ? markIssueAttachmentsUnknown(database, session.issue_id, attachmentIds)
    : markIssueAttachmentsDelivered(database, session.issue_id, attachmentIds, Date.now());
  broadcast({ type: 'comment.delivery.changed', issue_id: session.issue_id, comment_ids: commentIds });
}

function persistSessionPatch(sessionId: string, patch: SessionPatch): Session {
  const session = updateSession(assertAssembled(), sessionId, patch);
  broadcast({ type: 'session.changed', session });
  return session;
}

/** CHAT-TURN1：轮次归属（#6/#7/#8）；轮次外的消息不传，三列保持 NULL */
export interface MessageTurnContext {
  turn_id?: string | null;
  step_id?: string | null;
  meta_json?: MessageMeta | null;
}

function persistMessage(
  sessionId: string,
  role: Message['role'],
  content: string,
  signal?: SessionErrorSignal | null,
  turn?: MessageTurnContext,
): Message {
  const message = addMessage(assertAssembled(), {
    session_id: sessionId,
    role,
    content,
    ...(signal ? { error_code: signal.code, retryable: signal.retryable } : {}),
    ...(turn?.turn_id ? { turn_id: turn.turn_id } : {}),
    ...(turn?.step_id ? { step_id: turn.step_id } : {}),
    ...(turn?.meta_json ? { meta_json: turn.meta_json } : {}),
  });
  broadcast({ type: 'message.added', message });
  return message;
}

function ensureState(sessionId: string): SessionState {
  let state = states.get(sessionId);
  if (!state) {
    state = { queue: [], turnActive: false, waitingSlot: false, current: null, tracker: null };
    states.set(sessionId, state);
  }
  return state;
}

/** 读取会话运行时态（内存队列的副本；无 state 即空闲全零） */
export function getSessionRuntime(sessionId: string): SessionRuntime {
  const state = states.get(sessionId);
  if (!state) return { queuedCount: 0, waitingSlot: false, queuedTexts: [] };
  return {
    queuedCount: state.queue.length,
    waitingSlot: state.waitingSlot,
    queuedTexts: state.queue.map((item) => item.prompt),
  };
}

/** 运行时变化广播 session.runtime（队列长度/等待槽位） */
function broadcastRuntime(sessionId: string): void {
  const runtime = getSessionRuntime(sessionId);
  broadcast({
    type: 'session.runtime',
    session_id: sessionId,
    queued_count: runtime.queuedCount,
    waiting_slot: runtime.waitingSlot,
  });
}

/**
 * 删除会话后的内存态清理（仅供 DELETE /api/sessions/:id 调用）：清该会话的队列/槽位/轮次引用，
 * 避免残留计数或 id 复用后串态。不 kill、不落库、不广播（拒绝运行中会话后调用，此处在途轮次必为空）。
 */
export function forgetSession(sessionId: string): void {
  // CHAT-TURN1：会话行删除后，在途观测器必须停表——否则 usage 节流计时器会往已删除的轮次写库
  const state = states.get(sessionId);
  if (state?.tracker) {
    state.tracker.close();
    liveTrackers.delete(state.tracker);
    state.tracker = null;
  }
  states.delete(sessionId);
}

/** 等待槽位标志变更时置位并广播（值不变不广播） */
function setWaitingSlot(sessionId: string, state: SessionState, value: boolean): void {
  if (state.waitingSlot === value) return;
  state.waitingSlot = value;
  broadcastRuntime(sessionId);
}

// ---- 全局 FIFO 槽位 ----

/** onWait：本轮确需排队等槽位时同步回调一次（用于 waiting_slot 运行时标记，语义/排队顺序不变） */
function acquireSlot(onWait?: () => void): Promise<void> {
  if (slotWaiters.length === 0 && activeTurns < maxConcurrentTurns) {
    activeTurns += 1;
    return Promise.resolve();
  }
  onWait?.();
  return new Promise<void>((resolve) => {
    slotWaiters.push(resolve);
  });
}

/** 槽位释放：有等待者直接移交（先到先发，后到不抢占），否则归还计数 */
function releaseSlot(): void {
  const next = slotWaiters.shift();
  if (next) {
    next();
  } else if (activeTurns > 0) {
    activeTurns -= 1;
  }
}

// ---- 对外 API ----

export async function createSession(input: CreateSessionInput): Promise<Session> {
  const database = assertAssembled();
  const issue = input.issue_id ? getIssue(database, input.issue_id) : null;
  if (input.issue_id && !issue) throw new NotFoundError('任务不存在');
  const workspaceId = issue ? issue.workspace_id : input.workspace_id;
  if (!workspaceId) throw new ValidationError('自由会话必须提供 workspace_id');
  if (!getWorkspace(database, workspaceId)) throw new NotFoundError('工作空间不存在');

  let adapterSessionId: string | null = null;
  if (input.reuse_session === 'last' && issue) {
    const prev = database
      .prepare(
        `SELECT adapter_session_id FROM session WHERE issue_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(issue.id) as { adapter_session_id: string | null } | undefined;
    adapterSessionId = prev?.adapter_session_id ?? null;
  }

  const prompt = input.prompt ?? '';
  // status 表达「当前轮次是否执行中」：用户新建的自由会话（无 prompt 即无轮次、后续由 sendToSession 起轮）
  // 落终态「已结束」，不长期停在不实的「运行中」；派发链路（绑 issue，prompt 留空、claim 后立即起轮）仍落「运行中」。
  const willRun = issue !== null || prompt.trim() !== '';
  const session = insertSessionRow(database, {
    workspace_id: workspaceId,
    issue_id: issue?.id ?? null,
    cli: input.cli,
    model: input.model ?? null,
    status: willRun ? '运行中' : '已结束',
  });
  if (adapterSessionId !== null) {
    updateSession(database, session.id, { adapter_session_id: adapterSessionId });
  }
  ensureState(session.id);

  if (prompt.trim() !== '') {
    const userMessage = persistMessage(session.id, 'user', prompt);
    void beginTurn(session.id, {
      prompt,
      attachments: [],
      deliveredAttachmentIds: [],
      retryUnknownAttachmentIds: [],
      sessionAttachment: false,
      messageIds: [userMessage.id],
    });
  }
  return getSession(database, session.id)!;
}

export async function sendToSession(sessionId: string, text: string, delivery: SessionDelivery = {}): Promise<{ queued: boolean }> {
  const database = assertAssembled();
  const attachments = delivery.attachments ?? [];
  if (text.trim() === '' && attachments.length === 0) throw new ValidationError('消息内容不能为空');
  const session = getSession(database, sessionId);
  if (!session) throw new NotFoundError('会话不存在');
  if (attachments.length > 0) {
    const adapter = resolveAdapter?.(session.cli);
    const verifiedCliVersion = delivery.verifiedCliVersion ?? (adapter
      ? await getVerifiedImageInputCliVersion(adapter, session.model ?? undefined)
      : null);
    if (!adapter || verifiedCliVersion === null || !adapter.supportsImageInput(session.model ?? undefined, verifiedCliVersion)) {
      throw new ValidationError('IMAGE_DELIVERY_UNVERIFIED:当前 CLI/model 组合没有通过图片输入验证');
    }
    // CHAT-IMG-DELIVERY：issue 会话要求绑定任务；自由聊天会话（issue_id=NULL）走会话级附件，
    // 仍要求逐张提供 ID（deliveredAttachmentIds 与 attachments 等长）
    if ((delivery.deliveredAttachmentIds?.length ?? 0) !== attachments.length) {
      throw new ValidationError('IMAGE_ATTACHMENT_SELECTION_INVALID:图片必须逐张提供 ID');
    }
    if (session.issue_id === null && attachments.length > 0 && !delivery.sessionAttachment) {
      throw new ValidationError('IMAGE_ATTACHMENT_SELECTION_INVALID:聊天图片必须绑定到会话（session_attachment）');
    }
  }
  const state = ensureState(sessionId);
  // 先落 user 行（空闲/排队都落）；轮次行要到真正起轮才建，所以记下 id 待回填 turn_id
  const userMessage = persistMessage(sessionId, 'user', text);
  const input: TurnInput = {
    prompt: text,
    attachments,
    deliveredAttachmentIds: delivery.deliveredAttachmentIds ?? [],
    retryUnknownAttachmentIds: delivery.retryUnknownAttachmentIds ?? [],
    sessionAttachment: delivery.sessionAttachment === true,
    messageIds: [userMessage.id],
  };

  if (state.turnActive) {
    state.queue.push(input);
    broadcastRuntime(sessionId);
    return { queued: true };
  }

  // 空闲（含停止/失败后续聊）：回运行中并立即起轮
  state.turnActive = true;
  if (getSession(database, sessionId)!.status !== '运行中') {
    persistSessionPatch(sessionId, { status: '运行中' });
  }
  void beginTurn(sessionId, input);
  return { queued: false };
}

export async function stopSession(sessionId: string): Promise<Session> {
  const database = assertAssembled();
  if (!getSession(database, sessionId)) throw new NotFoundError('会话不存在');
  const state = ensureState(sessionId);
  state.turnActive = false;
  // 停止弃轮：等槽位中的轮次将被放弃，等待标志随之复位（队列保留，计数不变不发 runtime）
  setWaitingSlot(sessionId, state, false);
  const ctx = state.current;
  if (ctx) {
    ctx.stopRequested = true;
    const handle = ctx.handle;
    ctx.handle = null;
    if (handle) {
      try {
        await handle.kill();
      } catch {
        // kill 失败不阻塞状态落库
      }
    }
  }
  return persistSessionPatch(sessionId, { status: '已结束' });
}

/**
 * 服务重启恢复：所有 '运行中' session 置 '失败'；其占用 issue 走 fail 流程，
 * 评论作者为 system（计划钉死"system 评论"，与 failIssue 的 agent:<cli> 评论不同，故释放 SQL 就地执行）。
 */
export async function recoverOnBoot(database: Db): Promise<void> {
  const stale = database.prepare(`SELECT * FROM session WHERE status = '运行中'`).all() as Session[];
  for (const session of stale) {
    const updated = updateSession(database, session.id, { status: '失败' });
    broadcast({ type: 'session.changed', session: updated });
    // CHAT-TURN1：会话置失败的同时收口其未结束轮次（否则计划条永远停在 running），
    // 原因落 awaiting_json.reason = server_restart，机器可判（验收 6）。
    failOpenTurns(database, session.id, { reason: 'server_restart', message: '服务重启，轮次中断', at: Date.now() });
    if (!session.issue_id) continue;
    const issue = getIssue(database, session.issue_id);
    if (!issue || issue.claimed_by === null || issue.session_id !== session.id) continue;
    const released = database
      .prepare(
        `UPDATE issue SET status='待规划', claimed_by=NULL, claimed_at=NULL, session_id=NULL, updated_at=?
         WHERE id=? AND claimed_by IS NOT NULL`,
      )
      .run(Date.now(), issue.id);
    if (released.changes === 1) {
      await addComment(database, issue.id, 'system', '服务重启，会话中断');
    }
  }
}

// ---- 轮次执行 ----

async function beginTurn(sessionId: string, input: TurnInput): Promise<void> {
  const state = states.get(sessionId);
  if (!state) return;
  const ctx: TurnContext = { handle: null, stopRequested: false };
  state.current = ctx;
  state.turnActive = true;
  try {
    await acquireSlot(() => setWaitingSlot(sessionId, state, true)); // 真排队等槽位时标记
    if (state.current === ctx) setWaitingSlot(sessionId, state, false);
    if (state.current !== ctx) return; // 已被新轮次取代
    if (ctx.stopRequested) {
      state.turnActive = false; // 等槽位期间被 stop：放弃本轮，队列保留
      return;
    }
    await executeTurn(sessionId, state, ctx, input);
  } catch (err) {
    // 兜底：未预期异常不崩进程，会话置失败
    if (state.current === ctx) {
      // CHAT-TURN1：漏网的异常也要收口轮次（finish 幂等，executeTurn 已收口时是空操作）
      if (state.tracker) {
        state.tracker.finish({ state: 'failed', reason: 'turn_internal_error', message: err instanceof Error ? err.message : String(err) });
        liveTrackers.delete(state.tracker);
        state.tracker = null;
      }
      state.turnActive = false;
      state.current = null;
      try {
        await startError(sessionId, err);
      } catch {
        // 兜底失败静默
      }
    }
  } finally {
    releaseSlot();
  }
}

async function executeTurn(
  sessionId: string,
  state: SessionState,
  ctx: TurnContext,
  input: TurnInput,
): Promise<void> {
  const database = assertAssembled();
  const resolve = resolveAdapter;
  if (!resolve) return;

  const session = getSession(database, sessionId);
  if (!session) {
    state.turnActive = false;
    state.current = null;
    return;
  }
  const workspace = getWorkspace(database, session.workspace_id);
  if (!workspace) {
    state.turnActive = false;
    state.current = null;
    await startError(sessionId, new Error(`工作空间不存在: ${session.workspace_id}`));
    return;
  }

  // CHAT-TURN1：轮次行在起轮点建立（此后每条早退路径都能收口成带原因的终态）。
  // 执行器语义不变：这里只旁观 adapter 事件，不增删事件类型、不干预排队/合并/kill。
  const tracker = startTurnTracking(database, {
    session_id: sessionId,
    prompt: input.prompt,
    user_message_ids: input.messageIds ?? [],
  }, { broadcast });
  state.tracker = tracker;
  liveTrackers.add(tracker);
  /** 轮次收口（tracker.finish 幂等）：同时把它从会话状态与计时器登记表摘掉 */
  const finishTurn = (outcome: Parameters<TurnTracker['finish']>[0]): void => {
    tracker.finish(outcome);
    liveTrackers.delete(tracker);
    if (state.tracker === tracker) state.tracker = null;
  };
  /** 本轮消息的轮次归属：turn_id 恒定，step_id 取当前打开的工具步骤 */
  const inTurn = (meta?: MessageMeta) => ({
    turn_id: tracker.turnId,
    ...(tracker.currentStepId() ? { step_id: tracker.currentStepId() } : {}),
    ...(meta ? { meta_json: meta } : {}),
  });

  let adapter: AgentAdapter;
  try {
    adapter = resolve(session.cli);
  } catch (err) {
    finishTurn({ state: 'failed', reason: 'adapter_resolve_failed', message: err instanceof Error ? err.message : String(err) });
    state.turnActive = false;
    state.current = null;
    await startError(sessionId, err);
    return;
  }

  let detectedCliVersion: string | undefined;
  if (input.attachments.length > 0) {
    detectedCliVersion = await getVerifiedImageInputCliVersion(adapter, session.model ?? undefined) ?? undefined;
    if (!detectedCliVersion) {
      finishTurn({ state: 'failed', reason: 'image_delivery_unverified', message: '当前 CLI/model 组合没有通过图片输入验证' });
      state.turnActive = false;
      state.current = null;
      await startError(sessionId, new ValidationError('IMAGE_DELIVERY_UNVERIFIED:当前 CLI/model 组合没有通过图片输入验证'));
      return;
    }
    // CHAT-IMG-DELIVERY：聊天入口绑定 session_attachment；评论/派发链路要求 issue 绑定（原语义）
    if (input.sessionAttachment) {
      try {
        markSessionAttachmentsSending(database, sessionId, input.deliveredAttachmentIds, Date.now());
      } catch (err) {
        finishTurn({ state: 'failed', reason: 'attachment_mark_failed', message: err instanceof Error ? err.message : String(err) });
        state.turnActive = false;
        state.current = null;
        await startError(sessionId, err);
        return;
      }
    } else {
      if (!session.issue_id) {
        finishTurn({ state: 'failed', reason: 'image_attachment_selection_invalid', message: '图片必须绑定到任务' });
        state.turnActive = false;
        state.current = null;
        await startError(sessionId, new ValidationError('IMAGE_ATTACHMENT_SELECTION_INVALID:图片必须绑定到任务'));
        return;
      }
      const commentIds = markIssueAttachmentsSending(
        database,
        session.issue_id,
        input.deliveredAttachmentIds,
        Date.now(),
        input.retryUnknownAttachmentIds,
      );
      broadcast({ type: 'comment.delivery.changed', issue_id: session.issue_id, comment_ids: commentIds });
    }
  }

  const opts: RunTurnOptions = {
    cwd: workspace.path,
    model: session.model ?? undefined,
    prompt: input.prompt,
    adapterSessionId: session.adapter_session_id ?? undefined,
    ...(detectedCliVersion ? { detectedCliVersion } : {}),
    ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
  };

  let handle: TurnHandle;
  try {
    handle = adapter.runTurn(opts);
  } catch (err) {
    finishTurn({ state: 'failed', reason: 'adapter_run_failed', message: err instanceof Error ? err.message : String(err) });
    if (input.attachments.length > 0) markImageDelivery(database, session, input.deliveredAttachmentIds, 'unknown', input.sessionAttachment);
    state.turnActive = false;
    state.current = null;
    await startError(sessionId, err);
    return;
  }
  ctx.handle = handle;

  // 连续 text delta 聚合为一条 assistant 消息；thinking delta 并列聚合为一条 kind:thinking event 消息；tool/error/end 切分
  let textBuf = '';
  let thinkingBuf = '';
  const flushText = () => {
    if (textBuf === '') return;
    const content = textBuf;
    textBuf = '';
    // AUDIT-SRV（F-04）：CLI 把额度/限流失败当普通 stdout 打印，按正文形态落 error（否则被当 assistant 正文）
    if (looksLikeErrorOutput(content)) {
      tracker.noteError();
      persistMessage(sessionId, 'error', content, classifySessionError(content), inTurn());
      return;
    }
    persistMessage(sessionId, 'assistant', content, undefined, inTurn());
  };
  const flushThinking = () => {
    if (thinkingBuf === '') return;
    const content = thinkingBuf;
    thinkingBuf = '';
    persistMessage(sessionId, 'event', JSON.stringify({ kind: 'thinking', text: content }), undefined, inTurn());
  };
  handle.onEvent((event: UnifiedEvent) => {
    broadcast({ type: 'session.event', session_id: sessionId, event });
    switch (event.type) {
      case 'text':
        textBuf += event.delta;
        tracker.onTextDelta(event.delta);
        break;
      case 'thinking':
        thinkingBuf += event.delta;
        tracker.onThinkingDelta(event.delta);
        break;
      case 'tool': {
        flushThinking();
        flushText();
        // CHAT-TURN1：一次 tool 事件 = 一个计划步骤（上一步在此收口并回填耗时/成败）
        const step = tracker.beginStep(event.name);
        const message = persistMessage(
          sessionId,
          'event',
          JSON.stringify({ name: event.name, input: event.input }),
          undefined,
          { turn_id: tracker.turnId, step_id: step.step_id, meta_json: initialToolMeta(step.step_id) },
        );
        tracker.registerStepMessage(step.step_id, message.id);
        break;
      }
      case 'error':
        flushThinking();
        flushText();
        tracker.noteError();
        persistMessage(sessionId, 'error', event.message, classifySessionError(event.message) ?? { code: 'UNKNOWN_ERROR', retryable: true }, inTurn());
        break;
      case 'end':
        flushThinking();
        flushText();
        break;
    }
  });

  let result: Awaited<typeof handle.result>;
  try {
    result = await handle.result;
  } catch (err) {
    finishTurn({ state: 'failed', reason: 'adapter_threw', message: err instanceof Error ? err.message : String(err) });
    markImageDelivery(database, session, input.deliveredAttachmentIds, 'unknown', input.sessionAttachment);
    throw err;
  }
  ctx.handle = null;
  flushThinking(); // 无 end 事件收尾（kill / 异常退出）时兜底落盘（先于 text，保持事件时序）
  flushText();

  if (input.attachments.length > 0) {
    markImageDelivery(database, session, input.deliveredAttachmentIds, result.exitCode === 0 ? 'delivered' : 'unknown', input.sessionAttachment);
  }

  if (state.current !== ctx) {
    // 已被新轮次取代：旧结果弃用，但旧轮次要收口（否则永远停在 running）
    finishTurn({ state: 'stopped', reason: 'superseded', message: '同一会话起了新轮次，本轮结果弃用' });
    return;
  }
  if (ctx.stopRequested) {
    finishTurn({ state: 'stopped', reason: 'user_stop', message: '用户停止' });
    return; // stop 已置 '已结束' 并保留队列
  }

  if (result.adapterSessionId !== null) {
    persistSessionPatch(sessionId, { adapter_session_id: result.adapterSessionId });
  }
  // 适配器带回的 stderr 尾部落 error 消息（排障：真实 CLI 静默失败/异常退出时 UI 可见）
  if (result.stderrTail && result.stderrTail.length > 0) {
    persistMessage(sessionId, 'error', `适配器 stderr 尾部：\n${result.stderrTail.join('\n')}`, undefined, inTurn());
  }

  // 本轮终态：退出码非零 = failed（原因机器可判），否则 done
  finishTurn(
    result.exitCode !== 0
      ? { state: 'failed', reason: 'adapter_exit_nonzero', message: `适配器退出码 ${result.exitCode}` }
      : { state: 'done' },
  );

  if (state.queue.length > 0) {
    const pending = state.queue;
    state.queue = [];
    broadcastRuntime(sessionId); // 排队消息已合并起下一轮：queued_count 归零
    void beginTurn(sessionId, {
      prompt: pending.map((item) => item.prompt).join('\n\n'),
      attachments: pending.flatMap((item) => item.attachments),
      deliveredAttachmentIds: pending.flatMap((item) => item.deliveredAttachmentIds),
      retryUnknownAttachmentIds: pending.flatMap((item) => item.retryUnknownAttachmentIds),
      sessionAttachment: pending.some((item) => item.sessionAttachment),
      messageIds: pending.flatMap((item) => item.messageIds ?? []),
    }); // turnActive 保持 true；下一轮重走全局槽位 FIFO
    return;
  }

  state.turnActive = false;
  state.current = null;
  if (result.exitCode !== 0) {
    await markSessionFailed(sessionId, '会话异常退出');
  } else {
    persistSessionPatch(sessionId, { status: '已结束' });
  }
}

/** 起轮失败（未知 CLI / 适配器抛错 / 工作空间丢失）：error 消息落库 + 会话置失败，不崩进程（Review Focus 5） */
async function startError(sessionId: string, err: unknown): Promise<void> {
  const detail = err instanceof Error ? err.message : String(err);
  if (db) persistMessage(sessionId, 'error', `会话启动失败：${detail}`);
  await markSessionFailed(sessionId, '会话异常退出');
}

/** 会话置失败；issue 被本会话占用时走 fail 流程（释放占用 + agent:<cli> 失败评论） */
async function markSessionFailed(sessionId: string, reason: string): Promise<void> {
  const database = assertAssembled();
  persistSessionPatch(sessionId, { status: '失败' });
  const session = getSession(database, sessionId);
  if (!session?.issue_id) return;
  const issue = getIssue(database, session.issue_id);
  if (!issue || issue.session_id !== sessionId || issue.claimed_by === null) return;
  try {
    await failIssue(database, session.issue_id, session.cli, reason, sessionId);
  } catch {
    // 占用态在间隙被释放等竞态：会话失败已落库，不阻塞收尾
  }
}
