/**
 * Task 8：会话轮次编排（Pinned Contracts · 会话轮次规则）。
 *
 * 模块级单例（不导出类）：Task 9 启动时 initSessionManager(db, getAdapter, { maxConcurrentTurns }) 装配；
 * comments 服务经 comments.setSessionSender(sendToSession) 接入评论唤醒。
 */
import type { Message, Session, WsEvent } from '@agentboard/shared';
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
import {
  markIssueAttachmentsDelivered,
  markIssueAttachmentsSending,
  markIssueAttachmentsUnknown,
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
}

interface TurnInput {
  prompt: string;
  attachments: NonNullable<RunTurnOptions['attachments']>;
  deliveredAttachmentIds: string[];
  retryUnknownAttachmentIds: string[];
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
let broadcaster: ((event: WsEvent) => void) | null = null;

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

/** Task 9 接 WS hub：广播 session.event / message.added / session.changed */
export function setBroadcaster(fn: (event: WsEvent) => void): void {
  broadcaster = fn;
}

function broadcast(event: WsEvent): void {
  broadcaster?.(event);
}

function markImageDelivery(
  database: Db,
  issueId: string | null,
  attachmentIds: string[],
  state: 'unknown' | 'delivered',
): void {
  if (!issueId || attachmentIds.length === 0) return;
  const commentIds = state === 'unknown'
    ? markIssueAttachmentsUnknown(database, issueId, attachmentIds)
    : markIssueAttachmentsDelivered(database, issueId, attachmentIds, Date.now());
  broadcast({ type: 'comment.delivery.changed', issue_id: issueId, comment_ids: commentIds });
}

function persistSessionPatch(sessionId: string, patch: SessionPatch): Session {
  const session = updateSession(assertAssembled(), sessionId, patch);
  broadcast({ type: 'session.changed', session });
  return session;
}

function persistMessage(sessionId: string, role: Message['role'], content: string): Message {
  const message = addMessage(assertAssembled(), { session_id: sessionId, role, content });
  broadcast({ type: 'message.added', message });
  return message;
}

function ensureState(sessionId: string): SessionState {
  let state = states.get(sessionId);
  if (!state) {
    state = { queue: [], turnActive: false, waitingSlot: false, current: null };
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
    persistMessage(session.id, 'user', prompt);
    void beginTurn(session.id, { prompt, attachments: [], deliveredAttachmentIds: [], retryUnknownAttachmentIds: [] });
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
    if (!session.issue_id || (delivery.deliveredAttachmentIds?.length ?? 0) !== attachments.length) {
      throw new ValidationError('IMAGE_ATTACHMENT_SELECTION_INVALID:图片必须绑定到任务并逐张提供 ID');
    }
  }
  const state = ensureState(sessionId);
  const input: TurnInput = {
    prompt: text,
    attachments,
    deliveredAttachmentIds: delivery.deliveredAttachmentIds ?? [],
    retryUnknownAttachmentIds: delivery.retryUnknownAttachmentIds ?? [],
  };

  // 先落 user 行（空闲/排队都落）
  persistMessage(sessionId, 'user', text);

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

  let adapter: AgentAdapter;
  try {
    adapter = resolve(session.cli);
  } catch (err) {
    state.turnActive = false;
    state.current = null;
    await startError(sessionId, err);
    return;
  }

  let detectedCliVersion: string | undefined;
  if (input.attachments.length > 0) {
    detectedCliVersion = await getVerifiedImageInputCliVersion(adapter, session.model ?? undefined) ?? undefined;
    if (!detectedCliVersion) {
      state.turnActive = false;
      state.current = null;
      await startError(sessionId, new ValidationError('IMAGE_DELIVERY_UNVERIFIED:当前 CLI/model 组合没有通过图片输入验证'));
      return;
    }
    if (!session.issue_id) {
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
    if (input.attachments.length > 0) markImageDelivery(database, session.issue_id, input.deliveredAttachmentIds, 'unknown');
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
    persistMessage(sessionId, 'assistant', content);
  };
  const flushThinking = () => {
    if (thinkingBuf === '') return;
    const content = thinkingBuf;
    thinkingBuf = '';
    persistMessage(sessionId, 'event', JSON.stringify({ kind: 'thinking', text: content }));
  };
  handle.onEvent((event: UnifiedEvent) => {
    broadcast({ type: 'session.event', session_id: sessionId, event });
    switch (event.type) {
      case 'text':
        textBuf += event.delta;
        break;
      case 'thinking':
        thinkingBuf += event.delta;
        break;
      case 'tool':
        flushThinking();
        flushText();
        persistMessage(sessionId, 'event', JSON.stringify({ name: event.name, input: event.input }));
        break;
      case 'error':
        flushThinking();
        flushText();
        persistMessage(sessionId, 'error', event.message);
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
    markImageDelivery(database, session.issue_id, input.deliveredAttachmentIds, 'unknown');
    throw err;
  }
  ctx.handle = null;
  flushThinking(); // 无 end 事件收尾（kill / 异常退出）时兜底落盘（先于 text，保持事件时序）
  flushText();

  if (input.attachments.length > 0) {
    markImageDelivery(database, session.issue_id, input.deliveredAttachmentIds, result.exitCode === 0 ? 'delivered' : 'unknown');
  }

  if (state.current !== ctx) return; // 已被新轮次取代：旧结果弃用
  if (ctx.stopRequested) return; // stop 已置 '已结束' 并保留队列

  if (result.adapterSessionId !== null) {
    persistSessionPatch(sessionId, { adapter_session_id: result.adapterSessionId });
  }
  // 适配器带回的 stderr 尾部落 error 消息（排障：真实 CLI 静默失败/异常退出时 UI 可见）
  if (result.stderrTail && result.stderrTail.length > 0) {
    persistMessage(sessionId, 'error', `适配器 stderr 尾部：\n${result.stderrTail.join('\n')}`);
  }

  if (state.queue.length > 0) {
    const pending = state.queue;
    state.queue = [];
    broadcastRuntime(sessionId); // 排队消息已合并起下一轮：queued_count 归零
    void beginTurn(sessionId, {
      prompt: pending.map((item) => item.prompt).join('\n\n'),
      attachments: pending.flatMap((item) => item.attachments),
      deliveredAttachmentIds: pending.flatMap((item) => item.deliveredAttachmentIds),
      retryUnknownAttachmentIds: pending.flatMap((item) => item.retryUnknownAttachmentIds),
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
