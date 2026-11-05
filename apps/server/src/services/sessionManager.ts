/**
 * Task 8：会话轮次编排（Pinned Contracts · 会话轮次规则）。
 *
 * 模块级单例（不导出类）：Task 9 启动时 initSessionManager(db, getAdapter, { maxConcurrentTurns }) 装配；
 * comments 服务经 comments.setSessionSender(sendToSession) 接入评论唤醒。
 */
import type { Issue, Message, MessageMeta, ServerWsEvent, Session, SessionTurn } from '@agentboard/shared';
import type { AgentAdapter, AskEvent, RunTurnOptions, TurnHandle, UnifiedEvent } from '@agentboard/adapters';
import { getVerifiedImageInputCliVersion } from '@agentboard/adapters';
import type { Db } from '../db/connection.js';
import type { WorkspaceDbRouting } from '../db/resolver.js';
import {
  createSession as insertSessionRow,
  getSession,
  updateSession,
  type SessionPatch,
} from '../db/repos/session.js';
import { addMessage } from '../db/repos/message.js';
import { appendSessionEvent, lastSessionEventSeq } from '../db/repos/sessionEvent.js';
import { failAllOpenTurns, failOpenTurns, getTurn, updateTurn } from '../db/repos/sessionTurn.js';
import { initialToolMeta } from './messageMeta.js';
import { markTurnAwaiting, setAwaitingAnswerDispatcher } from './turnAwaiting.js';
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
import { NotFoundError, ValidationError, ConflictError } from '../errors.js';
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
  /**
   * STORE-4d：按库路由（缺省未装配 = 单库行为——一切读写都在传入的库上，既有测试/最小装配不变）。
   * 装配后：会话行落「工作区当前库」（未下沉回中心库），按 id 操作先定位归属工作区再经 resolver 取库。
   */
  routing?: WorkspaceDbRouting;
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
/** STORE-4d：按库路由（null = 单库行为：一切读写都在 initSessionManager 传入的库上） */
let routing: WorkspaceDbRouting | null = null;
/**
 * STORE-4d：会话 → 归属工作区（懒缓存）。
 * 会话行的位置跟随工作区 db_mode（localize/revert 整库搬移），所以缓存 workspace_id 而不是 Db 句柄
 * ——句柄由 resolver 统一懒开/换新，缓存不会握着已关闭的库；db_mode 变化后同一缓存仍解析到正确库。
 */
const workspaceBySession = new Map<string, string>();
let maxConcurrentTurns = 3;
let activeTurns = 0;
const slotWaiters: Array<() => void> = [];
const states = new Map<string, SessionState>();
let broadcaster: ((event: ServerWsEvent) => void) | null = null;
/** 在途轮次观测器：usage 节流计时器的归属登记表（复位/删会话时统一停表，避免写已关闭的库） */
const liveTrackers = new Set<TurnTracker>();

/**
 * CHAT-ASK-1B：ask 事件的活动回填通道（turn_id → 可写 stdin 的适配器句柄）。
 * 只存内存、不落库：`awaiting_json` 只留 reason/message，request_id 仅用于本次进程内的回填定位；
 * 服务重启后句柄失效，回答会以 ask_answer_binding_missing 收口，不静默丢。
 */
interface AwaitingAskBinding {
  sessionId: string;
  requestId: string;
  handle: TurnHandle;
}
const awaitingAsks = new Map<string, AwaitingAskBinding>();
/** 每轮已处理过的提问 request_id：同一 request_id 的重复 ask 不再建等待态 */
const handledAskRequests = new Map<string, { sessionId: string; requestIds: Set<string> }>();
/**
 * 本进程内由 ask 事件建立过等待态的轮次。
 * 只有这些轮次的回答才参与回填收口：历史 seed / 人工置的 ask_user 等待态没有执行器句柄，
 * 回答时保持原有语义（不接管），否则会破坏非 ask 通道的既有用例。
 * 不随会话遗忘清理（遗忘后仍要以 binding_missing 明确收口），只在轮次收口与进程复位时移除。
 */
const askOriginatedTurns = new Set<string>();

function clearAskBinding(turnId: string): void {
  awaitingAsks.delete(turnId);
  handledAskRequests.delete(turnId);
  askOriginatedTurns.delete(turnId);
}

function clearAskBindingOfSession(sessionId: string): void {
  for (const [turnId, binding] of awaitingAsks) {
    if (binding.sessionId === sessionId) awaitingAsks.delete(turnId);
  }
  for (const [turnId, handled] of handledAskRequests) {
    if (handled.sessionId === sessionId) handledAskRequests.delete(turnId);
  }
}

function closeAllTrackers(): void {
  for (const tracker of liveTrackers) tracker.close();
  liveTrackers.clear();
}

/** ask 事件 → 等待态展示文案：问题 + 选项（awaiting_json 不新增字段，选项折叠进 message 供 UI 可读） */
function formatAskMessage(event: AskEvent): string {
  const lines = event.question !== '' ? [event.question] : [];
  for (const option of event.options) {
    lines.push(option.description ? `- ${option.label}：${option.description}` : `- ${option.label}`);
  }
  return lines.join('\n');
}

/** 回填失败收口：轮次置 failed 并只推一次 session.turn（不改动其它状态机语义） */
function failAwaitingDelivery(database: Db, turn: SessionTurn, reason: string, message: string): void {
  const now = Date.now();
  const updated = updateTurn(database, turn.id, {
    state: 'failed',
    ended_at: now,
    awaiting_json: { reason, message, at: now },
    awaiting_heartbeat_at: null,
  });
  if (!updated || updated.state !== 'failed') return;
  broadcast({
    type: 'session.turn',
    session_id: updated.session_id,
    turn_id: updated.id,
    state: 'failed',
    awaiting: updated.awaiting_json,
  });
}

/**
 * CHAT-ASK-1B：把用户回答写回执行器 stdin。`turnAwaiting.answerAwaitingTurn` 在回答状态机推进成功后回调；
 * 句柄缺失 / 适配器不支持 / 写入失败一律收敛为 failed（带机器可判 reason），不静默吞。
 */
function deliverAwaitingAnswer(
  turn: SessionTurn,
  answer: { optionId?: string; text?: string },
  awaitingReason: string | null,
): void {
  // STORE-4d：轮次行在会话所在库（会话已删/库不可达时无法收口，保持静默——回答通道本就失效）
  const database = dbForSession(turn.session_id);
  if (!database) return;
  // 非 ask 驱动的等待态（历史/人工/审批路径）不参与回填，保持原有行为不变
  if (awaitingReason !== 'ask_user') return;
  // 只有本进程 ask 通道建立过等待态的轮次才接管回答；纯 seed 路径没有执行器通道，保持原语义
  if (!askOriginatedTurns.has(turn.id)) return;
  const binding = awaitingAsks.get(turn.id);
  if (!binding) {
    failAwaitingDelivery(
      database,
      turn,
      'ask_answer_binding_missing',
      '提问回填通道已失效（服务重启或轮次已收口），回答未送达执行器',
    );
    return;
  }
  awaitingAsks.delete(turn.id);
  const text = answer.text ?? answer.optionId ?? '';
  if (typeof binding.handle.answer !== 'function') {
    failAwaitingDelivery(database, turn, 'ask_answer_unsupported', '当前适配器不支持提问回填');
    return;
  }
  void binding.handle.answer(binding.requestId, text).catch((error: unknown) => {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : null;
    failAwaitingDelivery(
      database,
      turn,
      code ?? 'ask_answer_write_failed',
      error instanceof Error ? error.message : String(error),
    );
  });
}

// 模块装配即注册（回调内才读 db，resetSessionManager 后成为空操作）
setAwaitingAnswerDispatcher(deliverAwaitingAnswer);

function assertAssembled(): Db {
  if (!db) throw new Error('sessionManager 未装配');
  return db;
}

// ---- STORE-4d：按库路由 ----

/** 已下沉工作区库清单（清单查询失败按空处理，恢复/探测不因清单查询失败而中断） */
function workspaceDbs(): Db[] {
  if (routing === null) return [];
  try {
    return routing.listWorkspaceDbs();
  } catch {
    return [];
  }
}

/** workspace_id → 该工作区当前库（未装配路由 = 单库行为，全部落传入库） */
function dbForWorkspaceId(workspaceId: string): Db {
  if (routing === null) return assertAssembled();
  return routing.getDbForWorkspace(workspaceId);
}

/**
 * 会话 → 归属工作区：缓存命中直接返回；未命中先中心库后 fan-out 已下沉区逐库探测
 * （行在哪个库，workspace_id 就指向哪个工作区）。找不到返回 null（调用方决定 404 或跳过）。
 */
function resolveSessionWorkspaceId(sessionId: string): string | null {
  const cached = workspaceBySession.get(sessionId);
  if (cached !== undefined) return cached;
  let row = getSession(assertAssembled(), sessionId);
  if (row === null) {
    for (const wsDb of workspaceDbs()) {
      row = getSession(wsDb, sessionId);
      if (row !== null) break;
    }
  }
  if (row === null) return null;
  workspaceBySession.set(sessionId, row.workspace_id);
  return row.workspace_id;
}

/** 会话所在库；会话不存在返回 null（后台收口路径用，不抛） */
function dbForSession(sessionId: string): Db | null {
  const workspaceId = resolveSessionWorkspaceId(sessionId);
  if (workspaceId === null) return null;
  try {
    return dbForWorkspaceId(workspaceId);
  } catch {
    return null;
  }
}

/** 会话所在库；会话不存在抛 NotFoundError，判定错误（LOCKED/MISSING/…）原样向上抛——与请求路径同语义 */
function requireSessionDb(sessionId: string): Db {
  const workspaceId = resolveSessionWorkspaceId(sessionId);
  if (workspaceId === null) throw new NotFoundError('会话不存在');
  return dbForWorkspaceId(workspaceId);
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
  routing = opts.routing ?? null;
  maxConcurrentTurns = opts.maxConcurrentTurns;
  states.clear();
  workspaceBySession.clear();
  awaitingAsks.clear();
  handledAskRequests.clear();
  askOriginatedTurns.clear();
  closeAllTrackers();
  activeTurns = 0;
  slotWaiters.length = 0;
  broadcaster = null;
  // CHAT-AWAIT1（契约 #5）：启动即恢复——此刻内存里没有任何执行器，任何 running/awaiting 轮次
  // 都是上个进程遗留的孤儿，一律置 failed（reason=server_restart），不允许悄悄留在 awaiting。
  // STORE-4d：遍历中心库 + 全部已下沉工作区库；单库失败不阻断装配（该库恢复失败由 recoverOnBoot 侧落日志）。
  failAllOpenTurns(database, { reason: 'server_restart', message: '服务重启，轮次中断', at: Date.now() });
  for (const wsDb of workspaceDbs()) {
    try {
      failAllOpenTurns(wsDb, { reason: 'server_restart', message: '服务重启，轮次中断', at: Date.now() });
    } catch {
      /* 单库失败不阻断启动 */
    }
  }
}

/** 恢复未装配状态（测试隔离用） */
export function resetSessionManager(): void {
  db = null;
  resolveAdapter = null;
  routing = null;
  maxConcurrentTurns = 3;
  states.clear();
  workspaceBySession.clear();
  awaitingAsks.clear();
  handledAskRequests.clear();
  askOriginatedTurns.clear();
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

function persistSessionPatch(database: Db, sessionId: string, patch: SessionPatch): Session {
  const session = updateSession(database, sessionId, patch);
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
  database: Db,
  sessionId: string,
  role: Message['role'],
  content: string,
  signal?: SessionErrorSignal | null,
  turn?: MessageTurnContext,
): Message {
  const message = addMessage(database, {
    session_id: sessionId,
    role,
    content,
    ...(signal ? { error_code: signal.code, retryable: signal.retryable } : {}),
    ...(turn?.turn_id ? { turn_id: turn.turn_id } : {}),
    ...(turn?.step_id ? { step_id: turn.step_id } : {}),
    ...(turn?.meta_json ? { meta_json: turn.meta_json } : {}),
  });
  // BORROW-4.2：事件流双写。顺序固定「先 message 再 event」——事件 seq 与消息落库顺序一致；
  // 事件只是回放/增量拉取的底稿，丢失时可按 message.ts 重放，不反向影响聊天主链。
  appendSessionEvent(database, sessionId, 'message.added', message);
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

/** BORROW-4.3：暂停判定唯一口径——`paused_at` 非空即暂停（status 不参与） */
function isSessionPaused(database: Db, sessionId: string): boolean {
  const session = getSession(database, sessionId);
  return session !== null && session.paused_at != null;
}

/** 把会话队列合并成一次下一轮输入（不改变既有合并语义：多条消息拼成一段 prompt） */
function dequeueMergedInput(state: SessionState): TurnInput | null {
  if (state.queue.length === 0) return null;
  const pending = state.queue;
  state.queue = [];
  return {
    prompt: pending.map((item) => item.prompt).join('\n\n'),
    attachments: pending.flatMap((item) => item.attachments),
    deliveredAttachmentIds: pending.flatMap((item) => item.deliveredAttachmentIds),
    retryUnknownAttachmentIds: pending.flatMap((item) => item.retryUnknownAttachmentIds),
    sessionAttachment: pending.some((item) => item.sessionAttachment),
    messageIds: pending.flatMap((item) => item.messageIds ?? []),
  };
}

/**
 * BORROW-4.3：恢复后消费暂停期间积压的队列（按入队顺序合并交付，不丢弃）。
 * 只在无在途轮次时起轮；在途轮次结束时由 `executeTurn` 收尾分支接手（那时 paused_at 已清空）。
 */
function drainSessionQueue(database: Db, sessionId: string): void {
  const state = states.get(sessionId);
  if (!state || state.turnActive) return;
  const input = dequeueMergedInput(state);
  if (input === null) return;
  state.turnActive = true;
  if (getSession(database, sessionId)?.status !== '运行中') {
    persistSessionPatch(database, sessionId, { status: '运行中' });
  }
  broadcastRuntime(sessionId);
  void beginTurn(database, sessionId, input);
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
  clearAskBindingOfSession(sessionId);
  // STORE-4d：行已删，按库定位缓存随之失效（同 id 复用是新会话，会重新探测）
  workspaceBySession.delete(sessionId);
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

/**
 * CHAT-RETRY1：单步重试的执行通道。
 *
 * 限制（必须写进代码注释）：CLI 的工具执行发生在适配器进程内，服务端不能直接调用某个工具；
 * 这里用**同会话定向提示**恢复该步，并且：
 * - 不新建 `session_turn`（重试必须落在原轮次行上）；
 * - 不落 message / 不推 `session.event`（避免已完成步骤的消息与 diff 卡重复生成）。
 * 状态推进由 `services/turnStepRetry.ts` 负责（本函数只跑执行器并返回成败）。
 */
export async function runRetriedStep(
  sessionId: string,
  input: { turn_id: string; step_id: string; tool_name: string },
): Promise<{ ok: boolean; message: string | null }> {
  const database = requireSessionDb(sessionId);
  const session = getSession(database, sessionId);
  if (!session) throw new NotFoundError('会话不存在');
  const state = ensureState(sessionId);
  if (state.turnActive) throw new ConflictError('会话正在运行，无法单步重试');
  const resolve = resolveAdapter;
  if (!resolve) throw new ConflictError('当前装配没有适配器，无法单步重试');
  // 工作区注册表只在中心库（行不随 localize 搬移）
  const workspace = getWorkspace(assertAssembled(), session.workspace_id);
  if (!workspace) throw new NotFoundError('工作空间不存在');
  let adapter: AgentAdapter;
  try {
    adapter = resolve(session.cli);
  } catch (err) {
    throw new ConflictError(`无法解析适配器：${err instanceof Error ? err.message : String(err)}`);
  }
  const prompt = `【单步重试】第 ${input.turn_id} 轮步骤 ${input.step_id}（工具 ${input.tool_name}）执行失败，`
    + '请只重试该步骤；已完成的步骤不要重复执行。';
  const opts: RunTurnOptions = {
    cwd: workspace.path,
    model: session.model ?? undefined,
    prompt,
    adapterSessionId: session.adapter_session_id ?? undefined,
  };
  let result: Awaited<ReturnType<AgentAdapter['runTurn']>['result']>;
  try {
    result = await adapter.runTurn(opts).result;
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  if (result.adapterSessionId !== null) {
    persistSessionPatch(database, sessionId, { adapter_session_id: result.adapterSessionId });
  }
  if (result.exitCode !== 0) {
    return { ok: false, message: `重试执行器退出码 ${result.exitCode}` };
  }
  return { ok: true, message: null };
}

// ---- 对外 API ----

export async function createSession(input: CreateSessionInput): Promise<Session> {
  const center = assertAssembled();
  // STORE-4d：绑 issue 的会话先定位 issue 所在库（先中心后 fan-out 已下沉区）——会话行跟业务行同库
  let issue: Issue | null = null;
  if (input.issue_id) {
    issue = getIssue(center, input.issue_id);
    if (issue === null) {
      for (const wsDb of workspaceDbs()) {
        issue = getIssue(wsDb, input.issue_id);
        if (issue !== null) break;
      }
    }
    if (issue === null) throw new NotFoundError('任务不存在');
  }
  const workspaceId = issue ? issue.workspace_id : input.workspace_id;
  if (!workspaceId) throw new ValidationError('自由会话必须提供 workspace_id');
  // 工作区注册表只在中心库（行不随 localize 搬移）
  if (!getWorkspace(center, workspaceId)) throw new NotFoundError('工作空间不存在');
  // STORE-4d：会话行落「工作区当前库」（未下沉回中心库，行为与切库前一致）
  const database = dbForWorkspaceId(workspaceId);

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
  workspaceBySession.set(session.id, workspaceId);
  ensureState(session.id);

  if (prompt.trim() !== '') {
    const userMessage = persistMessage(database, session.id, 'user', prompt);
    void beginTurn(database, session.id, {
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
  // STORE-4d：会话行在「归属工作区当前库」；判定错误（LOCKED/MISSING/…）与请求路径同语义原样向上抛
  const database = requireSessionDb(sessionId);
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
  const userMessage = persistMessage(database, sessionId, 'user', text);
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

  // BORROW-4.3：暂停期间不开始新轮次——消息照常落 user 行并入队，恢复后按序交付（不丢、不静默拒绝）
  if (isSessionPaused(database, sessionId)) {
    state.queue.push(input);
    broadcastRuntime(sessionId);
    return { queued: true };
  }

  // 空闲（含停止/失败后续聊）：回运行中并立即起轮
  state.turnActive = true;
  if (getSession(database, sessionId)!.status !== '运行中') {
    persistSessionPatch(database, sessionId, { status: '运行中' });
  }
  void beginTurn(database, sessionId, input);
  return { queued: false };
}

export async function stopSession(sessionId: string): Promise<Session> {
  const database = requireSessionDb(sessionId);
  const state = ensureState(sessionId);
  state.turnActive = false;
  // CHAT-ASK-1B：停止即失效回填通道（迟到回答不会写进已被 kill 的进程）
  clearAskBindingOfSession(sessionId);
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
  return persistSessionPatch(database, sessionId, { status: '已结束' });
}

/**
 * BORROW-4.3：暂停会话。
 *
 * 语义写死（勿自行扩展）：
 * - 只置 `session.paused_at`，**不 kill 正在执行的工具/子进程，不撤销已写入**；
 * - 在途轮次照常跑完（工具步骤在 CLI 进程内，服务端无法逐步骤暂停），但结束后不再自动开始下一轮；
 * - 暂停期间的入站消息照常落 user 行并入队，恢复后按序交付（不丢）；
 * - `session.status` 语义不变（仍是 运行中 | 已结束 | 失败），调用方以 `paused` / `paused_at` 判断。
 */
export async function pauseSession(sessionId: string): Promise<Session> {
  const database = requireSessionDb(sessionId);
  const existing = getSession(database, sessionId);
  if (!existing) throw new NotFoundError('会话不存在');
  if (existing.paused_at != null) return existing; // 幂等：重复暂停不重复记事件
  const pausedAt = Date.now();
  const session = persistSessionPatch(database, sessionId, { paused_at: pausedAt });
  appendSessionEvent(database, sessionId, 'session.paused', { paused_at: pausedAt });
  broadcast({ type: 'session.paused', session_id: sessionId, paused_at: pausedAt, session });
  return session;
}

/**
 * BORROW-4.3：恢复会话。
 *
 * 恢复语义写死：
 * - **不重放已完成步骤**：已完成的消息/步骤 seq 全部 ≤ 恢复事件的 seq；客户端用
 *   `GET /api/sessions/:id/events?after_seq=<resume_after_seq>` 续拉即可，
 *   服务端不重发 message、不重跑 turn（依赖 BORROW-4.2 的 session_event 事件流）；
 * - 暂停期间积压的入站消息按入队顺序合并交付（不丢、不重排）；
 * - 未暂停时调用是幂等空操作（不写事件，锚点取当前最大 seq）。
 */
export async function resumeSession(sessionId: string): Promise<{ session: Session; resume_after_seq: number }> {
  const database = requireSessionDb(sessionId);
  const existing = getSession(database, sessionId);
  if (!existing) throw new NotFoundError('会话不存在');
  if (existing.paused_at == null) {
    return { session: existing, resume_after_seq: lastSessionEventSeq(database, sessionId) };
  }
  const session = persistSessionPatch(database, sessionId, { paused_at: null });
  const event = appendSessionEvent(database, sessionId, 'session.resumed', { resumed_at: Date.now() });
  broadcast({
    type: 'session.resumed',
    session_id: sessionId,
    paused_at: null,
    session,
    resume_after_seq: event.seq,
  });
  drainSessionQueue(database, sessionId);
  return { session: getSession(database, sessionId)!, resume_after_seq: event.seq };
}

/**
 * 服务重启恢复：所有 '运行中' session 置 '失败'；其占用 issue 走 fail 流程，
 * 评论作者为 system（计划钉死"system 评论"，与 failIssue 的 agent:<cli> 评论不同，故释放 SQL 就地执行）。
 * STORE-4d：传入 scope（routing）时遍历中心库 + 全部 db_mode=localized 工作区库——
 * 中心库失败维持向上抛（既有启动失败语义）；单个工作区库失败落 stderr 后继续，不阻断其余库恢复。
 */
export async function recoverOnBoot(database: Db, scope?: WorkspaceDbRouting): Promise<void> {
  await recoverDbSessions(database);
  if (scope === undefined) return;
  for (const wsDb of workspaceDbsOf(scope)) {
    try {
      await recoverDbSessions(wsDb);
    } catch (error) {
      console.error(`[agentboard] 工作区库启动恢复失败（db=${wsDb.name}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** scope.listWorkspaceDbs 的容错包装（清单失败按空处理） */
function workspaceDbsOf(scope: WorkspaceDbRouting): Db[] {
  try {
    return scope.listWorkspaceDbs();
  } catch {
    return [];
  }
}

async function recoverDbSessions(database: Db): Promise<void> {
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

async function beginTurn(database: Db, sessionId: string, input: TurnInput): Promise<void> {
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
    // BORROW-4.3：暂停期间不开始新轮次。本轮输入退回队首（已落 user 行不丢），恢复后按序交付
    if (isSessionPaused(database, sessionId)) {
      state.queue.unshift(input);
      state.turnActive = false;
      state.current = null;
      broadcastRuntime(sessionId);
      return;
    }
    await executeTurn(database, sessionId, state, ctx, input);
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
  database: Db,
  sessionId: string,
  state: SessionState,
  ctx: TurnContext,
  input: TurnInput,
): Promise<void> {
  const resolve = resolveAdapter;
  if (!resolve) return;

  const session = getSession(database, sessionId);
  if (!session) {
    state.turnActive = false;
    state.current = null;
    return;
  }
  // 工作区注册表只在中心库（行不随 localize 搬移）；cwd 取注册表里的 path
  const workspace = getWorkspace(assertAssembled(), session.workspace_id);
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
    clearAskBinding(tracker.turnId); // 轮次收口后回答通道失效，避免悬挂句柄
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
      persistMessage(database, sessionId, 'error', content, classifySessionError(content), inTurn());
      return;
    }
    persistMessage(database, sessionId, 'assistant', content, undefined, inTurn());
  };
  const flushThinking = () => {
    if (thinkingBuf === '') return;
    const content = thinkingBuf;
    thinkingBuf = '';
    persistMessage(database, sessionId, 'event', JSON.stringify({ kind: 'thinking', text: content }), undefined, inTurn());
  };
  /**
   * CHAT-ASK-1B：ask → 同轮推进 awaiting_input 并登记回填通道。
   * 只有 type:'ask' 走这里；普通 tool 事件仍按原逻辑落步骤，不回归。
   * 重复 ask（同 request_id 或轮次已在等待）不再建等待态、不重复推 session.turn。
   */
  const onAskEvent = (event: AskEvent): void => {
    const current = getTurn(database, tracker.turnId);
    if (!current || current.state !== 'running') return;
    const handled = handledAskRequests.get(tracker.turnId);
    const requestIds = handled?.requestIds ?? new Set<string>();
    if (requestIds.has(event.request_id)) return;
    requestIds.add(event.request_id);
    handledAskRequests.set(tracker.turnId, { sessionId, requestIds });
    try {
      // 不传 stepId：轨迹的 plan_json 只在轮次结束时落库（beginStep 仅广播），传当前步骤 id 会撞「步骤不存在」
      const updated = markTurnAwaiting(database, sessionId, tracker.turnId, {
        state: 'awaiting_input',
        reason: 'ask_user',
        message: formatAskMessage(event),
      });
      awaitingAsks.set(tracker.turnId, { sessionId, requestId: event.request_id, handle });
      askOriginatedTurns.add(tracker.turnId);
      broadcast({
        type: 'session.turn',
        session_id: sessionId,
        turn_id: updated.id,
        state: 'awaiting_input',
        awaiting: updated.awaiting_json,
      });
    } catch (error) {
      // 步骤对不上等异常：不建等待态，留下可读错误（不静默吞）
      // 错误码字典在 shared 内（本卡禁改），复用既有 UNKNOWN_ERROR；具体原因在可读 message 里
      persistMessage(
        database,
        sessionId,
        'error',
        `无法进入等待输入状态：${error instanceof Error ? error.message : String(error)}`,
        { code: 'UNKNOWN_ERROR', retryable: true },
        inTurn(),
      );
    }
  };

  handle.onEvent((event: UnifiedEvent) => {
    // ask 不进 session.event：共享 WS 联合类型不含 ask，等待信息统一走 session.turn 快照
    if (event.type !== 'ask') {
      broadcast({ type: 'session.event', session_id: sessionId, event });
    }
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
          database,
          sessionId,
          'event',
          JSON.stringify({ name: event.name, input: event.input }),
          undefined,
          { turn_id: tracker.turnId, step_id: step.step_id, meta_json: initialToolMeta(step.step_id) },
        );
        tracker.registerStepMessage(step.step_id, message.id);
        break;
      }
      case 'ask':
        flushThinking();
        flushText();
        onAskEvent(event);
        break;
      case 'error':
        flushThinking();
        flushText();
        tracker.noteError();
        persistMessage(database, sessionId, 'error', event.message, classifySessionError(event.message) ?? { code: 'UNKNOWN_ERROR', retryable: true }, inTurn());
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
    persistSessionPatch(database, sessionId, { adapter_session_id: result.adapterSessionId });
  }
  // 适配器带回的 stderr 尾部落 error 消息（排障：真实 CLI 静默失败/异常退出时 UI 可见）
  if (result.stderrTail && result.stderrTail.length > 0) {
    persistMessage(database, sessionId, 'error', `适配器 stderr 尾部：\n${result.stderrTail.join('\n')}`, undefined, inTurn());
  }

  // 本轮终态：退出码非零 = failed（原因机器可判），否则 done
  finishTurn(
    result.exitCode !== 0
      ? { state: 'failed', reason: 'adapter_exit_nonzero', message: `适配器退出码 ${result.exitCode}` }
      : { state: 'done' },
  );

  // BORROW-4.3：暂停期间不自动消费队列（不开始新步骤）；队列保留，恢复时由 resumeSession 统一交付
  const pending = isSessionPaused(database, sessionId) ? null : dequeueMergedInput(state);
  if (pending !== null) {
    broadcastRuntime(sessionId); // 排队消息已合并起下一轮：queued_count 归零
    void beginTurn(database, sessionId, pending); // turnActive 保持 true；下一轮重走全局槽位 FIFO
    return;
  }

  state.turnActive = false;
  state.current = null;
  if (result.exitCode !== 0) {
    await markSessionFailed(sessionId, '会话异常退出');
  } else {
    persistSessionPatch(database, sessionId, { status: '已结束' });
  }
}

/** 起轮失败（未知 CLI / 适配器抛错 / 工作空间丢失）：error 消息落库 + 会话置失败，不崩进程（Review Focus 5） */
async function startError(sessionId: string, err: unknown): Promise<void> {
  const detail = err instanceof Error ? err.message : String(err);
  const database = dbForSession(sessionId);
  if (database) persistMessage(database, sessionId, 'error', `会话启动失败：${detail}`);
  await markSessionFailed(sessionId, '会话异常退出');
}

/** 会话置失败；issue 被本会话占用时走 fail 流程（释放占用 + agent:<cli> 失败评论） */
async function markSessionFailed(sessionId: string, reason: string): Promise<void> {
  const database = dbForSession(sessionId);
  if (database === null) return;
  persistSessionPatch(database, sessionId, { status: '失败' });
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
