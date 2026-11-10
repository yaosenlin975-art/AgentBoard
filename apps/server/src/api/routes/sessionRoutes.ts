/**
 * sessions 域 REST（CR-10c 自 routes.ts 纯搬迁，不改语义）。
 * 覆盖：会话列表（跨库并集兜底 STORE-4a）、详情/队列/消息/事件增量、新建（issue 派发或自由会话）、
 * 发送消息（图片走 image 通道、非图片拼 prompt 路径）、停止、删除（运行中/占用守卫）、
 * PATCH（model/title/archived/paused）、fork、阻塞轮次回答、单步重试、三档确认决策。
 * STORE-4a 解析闭包（dbForWorkspace / locateSessionRouted）是 routes.ts 装配期闭包、多域共用，
 * 经 SessionRouterDeps 注入。
 */
import { Router } from 'express';
import type { Request } from 'express';
import type { ZodType } from 'zod';
import { getVerifiedImageInputCliVersion } from '@agentboard/adapters';
import type { AgentAdapter } from '@agentboard/adapters';
import { imageDeliveryHint } from '../../services/imageDeliveryHint.js';
import type { ServerWsEvent } from '@agentboard/shared';
import { zhZodIssue } from '../zod.js';
import type { Db } from '../../db/connection.js';
import { getWorkspace } from '../../db/repos/workspace.js';
import { getIssue } from '../../db/repos/issue.js';
import { listSessionsByWorkspace, getSession, updateSession, deleteSession, forkSession } from '../../db/repos/session.js';
import { listTurnsBySession } from '../../db/repos/sessionTurn.js';
import { getPersona } from '../../db/repos/persona.js';
import { listMessagesBySession, deleteMessagesBySession, listFirstUserMessages } from '../../db/repos/message.js';
import { listSessionEvents } from '../../db/repos/sessionEvent.js';
import { bindAttachmentsToSession } from '../../db/repos/attachment.js';
import { removeEntityLocator, upsertEntityLocator } from '../../db/repos/entityLocator.js';
import type { EntityLocation } from '../../db/resolver.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import { buildSessionPreview } from '../../services/messageSignals.js';
import { answerAwaitingTurn } from '../../services/turnAwaiting.js';
import { decideTurnApproval } from '../../services/turnApproval.js';
import { retryFailedStep } from '../../services/turnStepRetry.js';
import { createSession, forgetSession, getSessionRuntime, pauseSession, resumeSession, sendToSession, stopSession, runRetriedStep } from '../../services/sessionManager.js';
// P3-A：lead 每轮注入成员名册 + 解析 `@成员: 任务` 派活指令
import { buildRosterBlock, dispatchLeadDirectives } from '../../services/teamOrchestration.js';
import { rollbackPersonaBlock } from '../../services/personaInjection.js';
import { dispatchIssue } from '../../services/dispatch.js';
import { hashPayload } from '../../services/idempotency.js';
import { getTaskKnowledge } from '../../services/taskKnowledge.js';
import { AttachmentStore } from '../../services/attachments.js';
import {
  createSessionSchema,
  sendMessageSchema,
  patchSessionSchema,
  forkSessionSchema,
  answerTurnSchema,
  approvalDecisionSchema,
} from '../schemas.js';

/** session 行（getSession 命中类型）：定位上下文的实体载荷 */
type SessionRow = NonNullable<ReturnType<typeof getSession>>;

export interface SessionRouterDeps {
  /** 中心库：4d 前 sessionManager 单例仍写中心库 */
  db: Db;
  /** WS 广播钩子（与 routes.ts 同一注入） */
  broadcast: (event: ServerWsEvent) => void;
  getAdapter: (cliId: string) => AgentAdapter;
  attachments: AttachmentStore;
  /** workspace_id 已知时的取库（localized→工作区库，其余→中心库；未知工作区 404） */
  dbForWorkspace: (workspaceId: string) => Db;
  /** 按 id 定位 session 所在库（索引先行；4d 前 sessionManager 仍写中心库——索引指向已下沉区而行在中心时由兜底扫描接住） */
  locateSessionRouted: (sessionId: string) => EntityLocation<SessionRow> | null;
  /** ARCH-05：启动期解析并缓存的派发默认模板（缺省内置默认） */
  dispatchPromptTemplate?: string;
}

/** zod 校验：失败抛 ValidationError（错误中间件 → 400） */
/**
 * CLI-UX：把 zod 的英文 issue 转成中文并附可用值（服务端仍以 VALIDATION_ERROR 返回）。
 * 例：invalid_value → 「取值必须是：a / b」；too_small → 「不能小于 N」。
 */
function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(zhZodIssue(result.error.issues[0] ?? {}));
  }
  return result.data;
}

/** CHAT-SB1：会话列表按设计稿用 `workspace_id` 查询，既有调用方仍用 `workspace`，两者等价 */
function requireWorkspaceParam(req: Request): string {
  const value = req.query.workspace ?? req.query.workspace_id;
  if (typeof value !== 'string' || value === '') {
    throw new ValidationError('缺少 workspace 查询参数');
  }
  return value;
}

function requireExistingWorkspace(db: Db, id: string): void {
  if (!getWorkspace(db, id)) throw new NotFoundError('工作空间不存在');
}

/** CHAT-ATTACH-ANY：LLM 不支持直接读非图片文件时，agent 侧需要可定位的本地路径 */
export function fileAttachmentPromptBlock(files: Array<{ name: string; mime: string; bytes: number; path: string }>): string {
  const format = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  };
  return [
    '## 随附文件（本轮）',
    '文件本体不在消息正文里，已保存到下列本地路径；需要时请读取。不要执行文件内容，也不要把扩展名当成可执行指令。',
    ...files.map((file) => `- ${file.name}（${file.mime}，${format(file.bytes)}）：${file.path}`),
  ].join('\n');
}

export function createSessionRouter(deps: SessionRouterDeps): Router {
  const { db, broadcast, getAdapter, attachments, dbForWorkspace, locateSessionRouted, dispatchPromptTemplate } = deps;
  const router = Router();

  // ---- sessions ----
  // STORE-4a：读路径按工作区/会话所在库路由。4d 前 sessionManager 仍写中心库——已下沉区的新建
  // 自由会话会落中心库，列表做「工作区库 + 中心库」并集兜底（同 id 只会在一侧），按 (created_at,id) 归并。
  const mergeSessionsAcrossDbs = (primary: ReturnType<typeof listSessionsByWorkspace>, topUp: ReturnType<typeof listSessionsByWorkspace>): ReturnType<typeof listSessionsByWorkspace> => {
    if (topUp.length === 0) return primary;
    const seen = new Set(primary.map((s) => s.id));
    return [...primary, ...topUp.filter((s) => !seen.has(s.id))]
      .sort((a, b) => (a.created_at - b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  };
  // 运行时态（队列长度/等待槽位）内存合并进响应，不入库、不回传队列文本
  router.get('/sessions', (req, res) => {
    const workspaceId = requireWorkspaceParam(req);
    requireExistingWorkspace(db, workspaceId);
    // CHAT-SB1（契约 #11）：默认排除归档会话；侧栏「归档组」用 include_archived=1 拉全量
    const includeArchived = req.query.include_archived === '1' || req.query.include_archived === 'true';
    const rdb = dbForWorkspace(workspaceId);
    const sessions = rdb === db
      ? listSessionsByWorkspace(db, workspaceId, { includeArchived })
      : mergeSessionsAcrossDbs(listSessionsByWorkspace(rdb, workspaceId, { includeArchived }), listSessionsByWorkspace(db, workspaceId, { includeArchived }));
    const sessionIds = sessions.map((s) => s.id);
    // AUDIT-SRV（F-03）：首条用户消息预览 + 来源（dispatch=绑任务，chat=自由会话），一次查回避免 N+1
    const previews = new Map([...listFirstUserMessages(rdb, sessionIds), ...(rdb === db ? [] : listFirstUserMessages(db, sessionIds))]);
    res.json(
      sessions.map((s) => {
        const runtime = getSessionRuntime(s.id);
        return {
          ...s,
          paused: s.paused_at != null,
          preview: buildSessionPreview(previews.get(s.id) ?? ''),
          source: s.issue_id === null ? 'chat' : 'dispatch',
          queued_count: runtime.queuedCount,
          waiting_slot: runtime.waitingSlot,
        };
      }),
    );
  });

  // 聊天视图刷新恢复：panelStore 持久化的 sessionId 在 chatSession 缺失时按 id 拉取
  router.get('/sessions/:id', (req, res) => {
    const routed = locateSessionRouted(req.params.id!);
    if (!routed) throw new NotFoundError('会话不存在');
    const runtime = getSessionRuntime(routed.value.id);
    // CHAT-AWAIT1（契约 #18）：详情带该会话 turns，阻塞/超时状态可直接读取
    res.json({
      ...routed.value,
      paused: routed.value.paused_at != null,
      queued_count: runtime.queuedCount,
      waiting_slot: runtime.waitingSlot,
      turns: listTurnsBySession(routed.db, routed.value.id),
    });
  });

  // 停止后队列查看（只读，不提供编辑）：返回当前内存排队文本
  router.get('/sessions/:id/queue', (req, res) => {
    if (!locateSessionRouted(req.params.id!)) throw new NotFoundError('会话不存在');
    res.json({ texts: getSessionRuntime(req.params.id!).queuedTexts });
  });

  router.get('/sessions/:id/messages', (req, res) => {
    const routed = locateSessionRouted(req.params.id!);
    if (!routed) throw new NotFoundError('会话不存在');
    const raw = req.query.after;
    let after = 0;
    if (typeof raw === 'string' && raw !== '') {
      after = Number(raw);
      if (!Number.isFinite(after) || after < 0) throw new ValidationError('after 必须为非负整数时间戳');
    }
    res.json(listMessagesBySession(routed.db, req.params.id!, after));
  });

  // BORROW-4.2：会话事件流增量拉取（after_seq 之后的全部事件，seq 升序；老会话返回空数组）
  router.get('/sessions/:id/events', (req, res) => {
    const routed = locateSessionRouted(req.params.id!);
    if (!routed) throw new NotFoundError('会话不存在');
    const raw = req.query.after_seq;
    let afterSeq = 0;
    if (typeof raw === 'string' && raw !== '') {
      afterSeq = Number(raw);
      if (!Number.isInteger(afterSeq) || afterSeq < 0) {
        throw new ValidationError('after_seq 必须为非负整数');
      }
    }
    res.json(listSessionEvents(routed.db, req.params.id!, afterSeq));
  });

  // 契约修订：issue_id 为空时 body.workspace_id 必填；绑 issue 时自动 claim+派发
  // STORE-4a：创建/发送/停止走 sessionManager 单例（4d 前绑中心库），本卡不改其落库位置；
  // 已下沉区的会话读侧由上方并集兜底，派发链路的彻底切库属 4d。
  router.post('/sessions', async (req, res) => {
    const body = parseBody(createSessionSchema, req.body);
    let session;
    let knowledge: ReturnType<typeof getTaskKnowledge> | undefined;
    let remainingAttachmentCount: number | undefined;
    let replayed = false;
    if (body.issue_id) {
      const result = await dispatchIssue(db, { getAdapter, attachments, promptTemplate: dispatchPromptTemplate }, {
        issueId: body.issue_id,
        cli: body.cli,
        model: body.model ?? null,
        promptTemplate: body.prompt,
        reuse_session: body.reuse_session,
        knowledge_enabled: body.knowledge_enabled,
        knowledge_query: body.knowledge_query,
        retry_unknown_images: body.retry_unknown_images,
        selected_attachment_ids: body.selected_attachment_ids,
        idempotency_key: req.get('Idempotency-Key') ?? undefined,
        idempotency_payload_hash: req.get('Idempotency-Key') ? hashPayload({ body, query: req.query }) : undefined,
      });
      replayed = result.replayed ?? false;
      if (!replayed) broadcast({ type: 'issue.changed', issue: result.issue });
      session = result.session;
      knowledge = result.knowledge;
      remainingAttachmentCount = result.remaining_attachment_count;
    } else {
      session = await createSession({
        cli: body.cli,
        model: body.model ?? null,
        workspace_id: body.workspace_id,
        prompt: body.prompt ?? null,
      });
    }
    if (!replayed) {
      broadcast({ type: 'session.changed', session });
      // STORE-4b：新会话登记定位索引（4d 前 sessionManager 落中心库，索引仍记归属工作区——
      // 读侧索引探测未命中时由兜底扫描在中心库接住，4d 切库后无需迁移索引行）
      upsertEntityLocator(db, 'session', session.id, session.workspace_id);
    }
    const result = knowledge ? { ...session, knowledge } : session;
    res.json(remainingAttachmentCount === undefined ? result : { ...result, remaining_attachment_count: remainingAttachmentCount });
  });

  router.post('/sessions/:id/messages', async (req, res) => {
    const body = parseBody(sendMessageSchema, req.body);
    const attachmentIds = body.attachment_ids ?? [];
    // P3-A：lead 会话每轮在用户消息前注入成员名册与状态（非 lead 会话 roster 为 null，原文不变）
    const roster = buildRosterBlock(db, req.params.id!);
    const text = roster === null ? body.text : `${roster}\n\n---\n\n${body.text}`;
    if (attachmentIds.length === 0) {
      const result = await sendToSession(req.params.id!, text);
      // 派活指令按**原消息**解析（名册里含 @成员名 示例，不能当指令）
      dispatchLeadDirectives(db, req.params.id!, body.text);
      res.json(result);
      return;
    }
    // CHAT-ATTACH-ANY：先按 DB 里的 kind 分流——图片仍走 image 通道（需要 CLI 图片能力验证），
    // 非图片文件不进 image 通道：路径/元数据拼进 prompt，文件本体留在服务端存储由 agent 读取。
    const session = getSession(db, req.params.id!);
    if (!session) throw new NotFoundError('会话不存在');
    const imageIds: string[] = [];
    const fileIds: string[] = [];
    for (const id of attachmentIds) {
      (attachments.workspaceKind(session.workspace_id, id) === 'image' ? imageIds : fileIds).push(id);
    }
    let verifiedCliVersion: string | undefined;
    if (imageIds.length > 0) {
      let adapter: AgentAdapter;
      try { adapter = getAdapter(session.cli); }
      catch {
        // 取不到适配器（未知 cli id）：给「换执行方式」的通用指路
        throw new ValidationError(`IMAGE_DELIVERY_UNVERIFIED:${imageDeliveryHint({
          cliId: 'unknown',
          displayName: session.cli,
          detectedVersion: null,
          ...(session.model ? { model: session.model } : {}),
        })}`);
      }
      const detected = await getVerifiedImageInputCliVersion(adapter, session.model ?? undefined);
      if (detected === null || !adapter.supportsImageInput(session.model ?? undefined, detected)) {
        const version = await adapter.detect().catch(() => ({ installed: false, version: null as string | null }));
        throw new ValidationError(`IMAGE_DELIVERY_UNVERIFIED:${imageDeliveryHint({
          cliId: adapter.id,
          displayName: adapter.displayName,
          detectedVersion: version.version,
          ...(session.model ? { model: session.model } : {}),
        })}`);
      }
      verifiedCliVersion = detected;
    }
    bindAttachmentsToSession(db, session.workspace_id, session.id, attachmentIds, Date.now());
    const imageAttachments = imageIds.map((id) => ({
      path: attachments.sessionPath(session.id, id),
      mimeType: attachments.sessionMime(session.id, id) as 'image/png' | 'image/jpeg' | 'image/webp',
    }));
    const prompt = fileIds.length === 0
      ? text
      : [text, fileAttachmentPromptBlock(fileIds.map((id) => ({
        name: attachments.workspaceName(session.workspace_id, id),
        mime: attachments.workspaceMime(session.workspace_id, id),
        bytes: attachments.workspaceSize(session.workspace_id, id),
        path: attachments.sessionPath(session.id, id),
      })))].filter((part) => part.trim() !== '').join('\n\n');
    const sent = await sendToSession(session.id, prompt, {
      attachments: imageAttachments,
      deliveredAttachmentIds: imageIds,
      fileAttachmentIds: fileIds,
      ...(verifiedCliVersion ? { verifiedCliVersion } : {}),
      sessionAttachment: true,
    });
    dispatchLeadDirectives(db, session.id, body.text);
    res.json(sent);
  });

  router.post('/sessions/:id/stop', async (req, res) => {
    res.json(await stopSession(req.params.id!));
  });

  // 持久删除会话（聊天视图删除入口）：运行中/正占用任务时 409 拒绝（不自动释放 claim、不加 system 评论）；
  // 删除顺序照 issue 删除示范——事务内先删 message 再删 session，最后清内存态并无 body 204 + 广播 session.deleted。
  // 幂等：重复删除已删会话落 404（会话不存在），不会 500。
  router.delete('/sessions/:id', (req, res) => {
    const routed = locateSessionRouted(req.params.id!);
    if (!routed) throw new NotFoundError('会话不存在');
    const session = routed.value;
    if (session.status === '运行中') throw new ConflictError('会话正在运行，请先停止再删除');
    if (session.issue_id !== null) {
      const issue = getIssue(routed.db, session.issue_id);
      if (
        issue !== null &&
        issue.status === '进行中' &&
        issue.claimed_by !== null &&
        issue.session_id === session.id
      ) {
        throw new ConflictError(
          `该会话正占用任务「${issue.title}」，请先标记待验收或释放占用后再删除`,
        );
      }
    }
    routed.db.transaction(() => {
      deleteMessagesBySession(routed.db, session.id);
      deleteSession(routed.db, session.id);
    })();
    // P1-C：personaInjection='file' 的工作区标记块随会话删除回收（文件不存在/无本会话块时为空操作；
    // 失败不阻断删除——残留块在下次同 id 会话 apply 时原位替换，孤儿块不影响其它内容）
    const workspaceForBlock = getWorkspace(db, session.workspace_id);
    if (workspaceForBlock) {
      try {
        rollbackPersonaBlock(session, workspaceForBlock.path);
      } catch (err) {
        console.error(`[agentboard] persona 标记块回收失败（session=${session.id}）：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    forgetSession(session.id);
    // STORE-4b：会话行已删，清定位索引（写失败只留过期行，读侧兜底扫描接住）
    removeEntityLocator(db, 'session', session.id);
    broadcast({ type: 'session.deleted', session_id: session.id });
    res.status(204).end();
  });

  // Task 14：修改会话模型（下一轮生效——sessionManager.runTurn 起轮时读取 session.model）
  // 会话标题：同一端点接受 title（1–50 字，null 清空回到派生标题），与 model 可同时提交。
  // CHAT-SB1：同一端点接受 archived（true=归档 / false=恢复）；运行中归档与删除同口径 409。
  // BORROW-4.3：同一端点接受 paused（true=暂停 / false=恢复）；暂停只拦新轮次，不 kill 在途工具。
  // P1-C：同一端点接受 persona_id / tool_policy / skill_policy / persona_injection（下一轮生效——
  // runTurn 起轮时读 session 四列装配 opts；tool/skill policy 落库存 JSON 字符串，null=清空）。
  router.patch('/sessions/:id', async (req, res) => {
    const body = parseBody(patchSessionSchema, req.body);
    const routed = locateSessionRouted(req.params.id!);
    if (!routed) throw new NotFoundError('会话不存在');
    // 暂停/恢复必须经 sessionManager：恢复要消费暂停期间积压的队列并写 session.resumed 事件
    if (body.paused !== undefined) {
      if (body.paused) {
        const paused = await pauseSession(req.params.id!);
        res.json({ ...paused, paused: true });
        return;
      }
      const resumed = await resumeSession(req.params.id!);
      res.json({
        ...resumed.session,
        paused: resumed.session.paused_at != null,
        resume_after_seq: resumed.resume_after_seq,
      });
      return;
    }
    const current = routed.value;
    if (body.archived === true && current.status === '运行中') {
      throw new ConflictError('会话正在运行，请先停止再归档');
    }
    // P1-C：persona_id 指向的 persona 必须存在（悬空引用在起轮侧按缺失静默跳过，写入侧直接拒绝更可判）
    if (body.persona_id !== undefined && body.persona_id !== null && getPersona(db, body.persona_id) === null) {
      throw new ValidationError('persona_id 指向的 persona 不存在');
    }
    const patch: {
      model?: string | null; title?: string | null; archived_at?: number | null;
      persona_id?: string | null; tool_policy?: string | null; skill_policy?: string | null; persona_injection?: string | null;
    } = {};
    if (body.model !== undefined) patch.model = body.model;
    if (body.title !== undefined) patch.title = body.title;
    if (body.archived !== undefined) patch.archived_at = body.archived ? Date.now() : null;
    // P1-C：persona 注入四字段透传（tool/skill policy 对象 → JSON 字符串列；null=清空）
    if (body.persona_id !== undefined) patch.persona_id = body.persona_id;
    if (body.tool_policy !== undefined) patch.tool_policy = body.tool_policy === null ? null : JSON.stringify(body.tool_policy);
    if (body.skill_policy !== undefined) patch.skill_policy = body.skill_policy === null ? null : JSON.stringify(body.skill_policy);
    if (body.persona_injection !== undefined) patch.persona_injection = body.persona_injection;
    const session = updateSession(routed.db, req.params.id!, patch);
    broadcast({
      type: 'session.changed',
      session,
      session_id: session.id,
      title: session.title ?? null,
      archived_at: session.archived_at ?? null,
      forked_from_session_id: session.forked_from_session_id ?? null,
    });
    res.json({ ...session, paused: session.paused_at != null });
  });

  // CHAT-SB1（契约 #12）：分叉会话——复制截止消息到新会话（不复制 plan / adapter_session_id），
  // 新会话继承 issue_id / cli / model，并写 forked_from_session_id + fork_message_id 来源标记。
  router.post('/sessions/:id/fork', (req, res) => {
    const body = parseBody(forkSessionSchema, req.body ?? {});
    const routed = locateSessionRouted(req.params.id!);
    if (!routed) throw new NotFoundError('会话不存在');
    const session = forkSession(routed.db, req.params.id!, {
      fromMessageId: body.from_message_id ?? null,
      title: body.title,
    });
    // STORE-4b：分叉出的新会话同样登记定位索引
    upsertEntityLocator(db, 'session', session.id, session.workspace_id);
    broadcast({
      type: 'session.changed',
      session,
      session_id: session.id,
      title: session.title ?? null,
      archived_at: session.archived_at ?? null,
      forked_from_session_id: session.forked_from_session_id ?? null,
    });
    res.json(session);
  });

  // CHAT-AWAIT1（契约 #13）：回答阻塞轮次——同一 turn 继续（步骤 awaiting→done，下一步 running），
  // 非 awaiting_input 一律 409（重复回答天然幂等）；成功推一次 session.turn。
  router.post('/sessions/:id/turns/:turnId/answer', (req, res) => {
    const body = parseBody(answerTurnSchema, req.body ?? {});
    const routed = locateSessionRouted(req.params.id!);
    if (!routed) throw new NotFoundError('会话不存在');
    const turn = answerAwaitingTurn(routed.db, routed.value.id, req.params.turnId!, {
      optionId: body.option_id,
      text: body.text,
    });
    broadcast({
      type: 'session.turn',
      session_id: routed.value.id,
      turn_id: turn.id,
      state: turn.state,
      awaiting: null,
    });
    res.json(turn);
  });

  // CHAT-RETRY1（契约 #15）：单步重试——只重跑该 failed + retryable 的步骤，不新建轮次、不整轮重发。
  // 校验/幂等/状态推进与广播都在 service 内完成（重复提交在状态校验处 409，不会执行第二次）。
  router.post('/sessions/:id/turns/:turnId/steps/:stepId/retry', async (req, res) => {
    const routed = locateSessionRouted(req.params.id!);
    if (!routed) throw new NotFoundError('会话不存在');
    const result = await retryFailedStep(routed.db, routed.value.id, req.params.turnId!, req.params.stepId!, {
      broadcast,
      execute: ({ session_id, turn_id, step_id, tool_name }) => runRetriedStep(session_id, { turn_id, step_id, tool_name }),
    });
    res.json(result);
  });

  // CHAT-APP1（契约 #14）：三档确认决策——allow 按档写规则并恢复 running，deny 置 stopped；
  // 非 awaiting_approval / 重复决策 → 409；request_id 不匹配 → 404；写类工具 + workspace 档 → 403。
  router.post('/sessions/:id/turns/:turnId/approvals/:requestId', (req, res) => {
    const body = parseBody(approvalDecisionSchema, req.body ?? {});
    const routed = locateSessionRouted(req.params.id!);
    if (!routed) throw new NotFoundError('会话不存在');
    const result = decideTurnApproval(routed.db, routed.value.id, req.params.turnId!, req.params.requestId!, body);
    broadcast({
      type: 'session.turn',
      session_id: routed.value.id,
      turn_id: result.turn.id,
      state: result.turn.state,
      awaiting: result.turn.state === 'running' ? null : result.turn.awaiting_json,
    });
    res.json(result);
  });

  return router;
}
