/**
 * issues 域 REST（CR-10a 自 routes.ts 纯搬迁，不改语义）。
 * 覆盖：POST /issues/draft（SMART-CREATE）、/issues/:id 取库+写闸门中间件（STORE-1/4a）、
 * 列表/树/CRUD、依赖（DEP-1）、评论与附件、占用事务（claim/heartbeat/release/done/fail/transfer）、close/reopen。
 * STORE-1/4a 解析上下文（workspaceResolverDeps/requireWorkspaceRow/dbForWorkspace/locate* 等）
 * 是 routes.ts 装配期闭包、多域共用，经 IssueRouterDeps 注入，不在此重建。
 * 域内注册相对顺序与搬迁前一致：draft 先于 /issues/:id 中间件（'draft' 不被当成卡 id）、
 * /issues/counts 先于 GET /issues/:id（'counts' 不被当成卡 id）。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ZodType } from 'zod';
import { getVerifiedImageInputCliVersion } from '@agentboard/adapters';
import type { AgentAdapter } from '@agentboard/adapters';
import { CLAIM_FENCE_HEADER } from '@agentboard/shared';
import type { KnowledgeHint, ServerWsEvent } from '@agentboard/shared';
import { zhZodIssue } from '../zod.js';
import type { Db } from '../../db/connection.js';
import { textWindow } from '../../db/pagination.js';
import { getWorkspace } from '../../db/repos/workspace.js';
import { DEFAULT_PAGE_FIELDS, deleteIssue, getIssue, listIssues, listIssuesPage, requireNoIssueChildren } from '../../db/repos/issue.js';
import { getStopState } from '../../db/repos/decision.js';
import { getActiveChangeLog, hasChangeLogForIssue } from '../../db/repos/workspaceChangeLog.js';
import { listCommentsByIssue, listCommentsPage, getCommentContent } from '../../db/repos/comment.js';
import { listIssueAttachments, listPendingIssueAttachments } from '../../db/repos/attachment.js';
import { deleteSession, getSession, listSessionsByIssue } from '../../db/repos/session.js';
import { deleteMessagesBySession } from '../../db/repos/message.js';
import { removeEntityLocator, upsertEntityLocator } from '../../db/repos/entityLocator.js';
import {
  getDbForWorkspace,
  assertWorkspaceDbWritable,
  workspaceDbError,
  type EntityLocation,
  type ResolverDeps,
  type WorkspaceDbDecision,
  type WorkspaceLike,
} from '../../db/resolver.js';
import { createIssueCountsRouter, issuesV2Enabled, parseIssueFields } from '../issuePayloadRoutes.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import { createIssueInHierarchy, getIssueTreeChildren } from '../../services/taskHierarchy.js';
import {
  claimIssue,
  doneIssue,
  failIssue,
  heartbeatClaim,
  releaseIssue,
  transferClaimedIssue,
  updateIssueGuarded,
  updateIssueWithCAS,
  finishClaimedIssue,
  releaseClaimedIssue,
  requireIssueInWorkspace,
} from '../../services/claim.js';
import { captureIssueGitBaseline, commitIssueChanges, dropIssueGitBaseline, type IssueCommitResult } from '../../services/gitBaseline.js';
import { getTaskKnowledge } from '../../services/taskKnowledge.js';
import { addRelation, listDependencies, removeDependency, unlockCommentsForDeletedBlocker } from '../../services/dependency.js';
import { requireWorkspaceStatus, STATUS_KINDS } from '../../services/workspaceStatus.js';
import { buildKnowledgeHint } from '../../services/knowledgeNudge.js';
import { addComment, consumeComments, storeComment, wakeCommentSession, type AddCommentResult } from '../../services/comments.js';
import { amendIdempotentResult, httpMutation, finishIdempotentEffect } from '../../services/idempotency.js';
import { stopSession } from '../../services/sessionManager.js';
import { createDraftService, type DraftRunner } from '../../services/smartCreateDraft.js';
import { AttachmentStore, attachmentContentDisposition } from '../../services/attachments.js';
import { closeIssue, reopenIssue } from '../../services/issueTransitions.js';
import {
  addCommentSchema,
  claimSchema,
  createIssueSchema,
  doneSchema,
  failSchema,
  issueTreeQuerySchema,
  patchIssueSchema,
  transferIssueSchema,
  addDependencySchema,
  dependencyQuerySchema,
  draftRequestSchema,
  reopenSchema,
  pageQuerySchema, descriptionQuerySchema, commentQuerySchema, issueStatusSchema,
} from '../schemas.js';

/** issue 行（getIssue 命中类型）：定位上下文的实体载荷 */
type IssueRow = NonNullable<ReturnType<typeof getIssue>>;

export interface IssueRouterDeps {
  /** 中心库：工作区注册权威、定位索引所在库 */
  db: Db;
  /** WS 广播钩子（与 routes.ts 同一注入） */
  broadcast: (event: ServerWsEvent) => void;
  getAdapter: (cliId: string) => AgentAdapter;
  attachments: AttachmentStore;
  /** SMART-CREATE：一次性适配器调用（仅测试注入；生产用 getAdapter().runTurn） */
  draftRunner?: DraftRunner;
  /** SMART-CREATE：草稿生成超时（ms，仅测试注入；生产 120s） */
  draftTimeoutMs?: number;
  /** STORE-1/4a：resolver 装配上下文（routes.ts 闭包，workspace/session 域共用） */
  workspaceResolverDeps: ResolverDeps;
  /** 写闸门与 localize 共用的工作区行取用（未知工作区 404） */
  requireWorkspaceRow: (workspaceId: string) => WorkspaceLike;
  /** workspace_id 已知时的取库（localized→工作区库，其余→中心库；未知工作区 404） */
  dbForWorkspace: (workspaceId: string) => Db;
  /** 按 id 定位 issue 所在库（索引先行，未命中/过期回退 fan-out 已下沉区） */
  locateIssueRouted: (issueId: string) => EntityLocation<IssueRow> | null;
  /** 同上但未命中即 404 */
  requireIssueRouted: (issueId: string) => EntityLocation<IssueRow>;
  /** 端点内统一解析本请求的业务库（workspace_id 优先，其次按实体 id 定位，都拿不到回中心库） */
  resolveRequestDb: (req: Request, entityId?: string) => Db;
  /** body.workspace_id ?? query.workspace_id */
  effectiveWorkspace: (req: Request) => string | undefined;
  /** STORE-4a：mutation 的业务写与幂等记录落「本请求解析出的库」 */
  mutation: <T>(rdb: Db, req: Request, perform: (routedDb: Db) => T) => { result: T; replayed: boolean };
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

/**
 * OPT-01：`GET /api/issues` 的 kind 集合过滤（`kinds=open,started,review`）。
 * kind 取值以 STATUS-3 的字典为准；未知值 400 并列出可用 kind，不做静默忽略。
 */
function parseKindsFilter(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new ValidationError('kinds 必须是逗号分隔的 kind 列表');
  const kinds = raw.split(',').map((kind) => kind.trim()).filter((kind) => kind !== '');
  const allowed = STATUS_KINDS as readonly string[];
  if (kinds.length === 0) throw new ValidationError(`kinds 不能为空（可用 kind：${allowed.join(' / ')}）`);
  const unknownKinds = kinds.filter((kind) => !allowed.includes(kind));
  if (unknownKinds.length > 0) throw new ValidationError(`kinds 含未知值：${unknownKinds.join(' / ')}（可用 kind：${allowed.join(' / ')}）`);
  return [...new Set(kinds)];
}

/** OPT-01：`unclaimed=1` 只取无主卡（`claimed_by IS NULL`）；`0` 为显式关闭 */
function parseUnclaimedFilter(raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new ValidationError('unclaimed 只接受 1 / 0');
}

async function wakeStoredComment(
  db: Db,
  getAdapter: (cliId: string) => AgentAdapter,
  attachments: AttachmentStore,
  issueId: string,
  sessionId: string,
  content: string,
  attachmentIds: string[],
): Promise<{ woke: boolean; warning?: string }> {
  if (attachmentIds.length === 0) {
    try {
      await wakeCommentSession(sessionId, content);
      return { woke: true };
    } catch {
      return { woke: false, warning: 'WAKE_FAILED' };
    }
  }

  const session = getSession(db, sessionId);
  if (!session) return { woke: false, warning: 'IMAGE_DELIVERY_UNVERIFIED' };
  let adapter: AgentAdapter;
  try { adapter = getAdapter(session.cli); }
  catch { return { woke: false, warning: 'IMAGE_DELIVERY_UNVERIFIED' }; }
  const verifiedCliVersion = await getVerifiedImageInputCliVersion(adapter, session.model ?? undefined);
  if (verifiedCliVersion === null) return { woke: false, warning: 'IMAGE_DELIVERY_UNVERIFIED' };

  try {
    const imageAttachments = attachmentIds.map((id) => ({
      path: attachments.issuePath(issueId, id),
      mimeType: attachments.issueMime(issueId, id) as 'image/png' | 'image/jpeg' | 'image/webp',
    }));
    await wakeCommentSession(sessionId, content || '请查看随附图片。', {
      attachments: imageAttachments,
      deliveredAttachmentIds: attachmentIds,
      verifiedCliVersion,
    });
    return { woke: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { woke: false, warning: message.includes('IMAGE_DELIVERY_UNVERIFIED') ? 'IMAGE_DELIVERY_UNVERIFIED' : 'WAKE_FAILED' };
  }
}

/**
 * 默认草稿 runner：直接调适配器的 runTurn（一次性进程），只收集 text 事件。
 * 不建 session 行、不占 claim 槽位；超时由 smartCreateDraft 的 AbortSignal 触发 kill。
 */
function defaultDraftRunner(getAdapter: (cliId: string) => AgentAdapter): DraftRunner {
  return ({ adapter, prompt, cwd, signal }) => new Promise<string>((resolve, reject) => {
    let handle: ReturnType<AgentAdapter['runTurn']>;
    try {
      handle = getAdapter(adapter).runTurn({ cwd, prompt });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let text = '';
    handle.onEvent((event) => {
      if (event.type === 'text') text += event.delta;
    });
    const onAbort = (): void => { void handle.kill().catch(() => {}); };
    signal.addEventListener('abort', onAbort, { once: true });
    handle.result.then((result) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) return;
      if (result.exitCode !== 0) {
        // stderr 尾部最后一行常是 Node 版本横幅，取最后 3 行非空内容更可解释
        const tail = (result.stderrTail ?? []).map(line => line.trim()).filter(line => line !== '').slice(-3).join(' | ');
        reject(new Error(tail === '' ? `适配器退出码 ${result.exitCode}` : `适配器退出码 ${result.exitCode}：${tail}`));
        return;
      }
      resolve(text);
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort);
      if (!signal.aborted) reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export function createIssueRouter(deps: IssueRouterDeps): Router {
  const {
    db,
    broadcast,
    getAdapter,
    attachments,
    mutation,
    effectiveWorkspace,
    resolveRequestDb,
    requireIssueRouted,
    locateIssueRouted,
    requireWorkspaceRow,
    dbForWorkspace,
    workspaceResolverDeps,
  } = deps;
  const router = Router();

  // ---- SMART-CREATE：智能创建草稿（不落库，设计 §4）----
  // 必须在 /issues/:id 中间件之前注册：否则 'draft' 会被当成 issue id 去查库并 404。
  const draftService = createDraftService({
    db,
    run: deps.draftRunner ?? defaultDraftRunner(getAdapter),
    detectAdapter: async (cliId) => {
      try {
        const detected = await deps.getAdapter(cliId).detect();
        return { installed: detected.installed, version: detected.version, ...(detected.message === undefined ? {} : { message: detected.message }) };
      } catch (error) {
        return { installed: false, version: null, message: `适配器 ${cliId} 探测失败：${error instanceof Error ? error.message : String(error)}` };
      }
    },
    existingLabels: (workspaceId) => {
      const rows = db.prepare('SELECT labels FROM issue WHERE workspace_id=?').all(workspaceId) as Array<{ labels: string }>;
      const set = new Set<string>();
      for (const row of rows) {
        try { for (const label of JSON.parse(row.labels) as unknown[]) if (typeof label === 'string' && label.trim() !== '') set.add(label); } catch { /* 脏数据忽略 */ }
      }
      return [...set].sort();
    },
    workspacePath: (workspaceId) => getWorkspace(db, workspaceId)?.path ?? process.cwd(),
    ...(deps.draftTimeoutMs === undefined ? {} : { timeoutMs: deps.draftTimeoutMs }),
  });
  router.post('/issues/draft', async (req, res) => {
    const body = parseBody(draftRequestSchema, req.body);
    const workspace = getWorkspace(db, body.workspace_id);
    if (!workspace) throw new NotFoundError('工作空间不存在');
    const draft = await draftService.generate({
      workspace_id: body.workspace_id,
      requirement: body.requirement,
      adapter: body.adapter,
      ...(body.priority === undefined ? {} : { priority: body.priority }),
    });
    res.json(draft);
  });

  router.use('/issues/:id', (req, _res, next) => {
    const raw = req.query.workspace_id ?? req.body?.workspace_id;
    // STORE-4a：本请求的业务库——workspace_id 已知按工作区取库；未知则按 id 定位（中心→fan-out）
    let rdb: Db = db;
    // PERF-1（F3）：判定与存在性随取库/校验一并产出，写闸门只复用不重查——非 GET 不再重复
    // getIssue + 工作区行 + 重判定（改造前闸门每请求多 3 条查询，判定还要重开工作区库）。
    let decided: WorkspaceDbDecision | null = null; // 取库时带回的判定（仅对应 gateWorkspaceId 时可复用）
    let gateWorkspaceId: string | null = null;      // 闸门要验的工作区（issue 所属区）
    let issueVerified = false;                      // issue 存在性已在本请求证实
    if (raw !== undefined) {
      if (typeof raw !== 'string' || !raw) throw new ValidationError('workspace_id 不合法');
      if (req.query.workspace_id && req.body?.workspace_id && req.query.workspace_id !== req.body.workspace_id) throw new ValidationError('workspace_id 不一致');
      const routed = getDbForWorkspace(workspaceResolverDeps, requireWorkspaceRow(raw));
      rdb = routed.db;
      decided = routed.decision;
      gateWorkspaceId = raw;
      const wrappedMutation = req.get('Idempotency-Key') && ((req.method === 'PATCH' && req.path === '/') || (req.method === 'POST' && ['/claim', '/release', '/done', '/fail', '/comments', '/dependencies', '/close', '/reopen'].includes(req.path)));
      if (!wrappedMutation) {
        // requireIssueInWorkspace 的 getIssue 已按 workspace_id 过滤：命中即 workspace_id === raw，判定可直接复用
        requireIssueInWorkspace(rdb, String(req.params.id), raw);
        issueVerified = true;
      }
    } else if (req.method !== 'GET' && req.method !== 'HEAD') {
      const hit = locateIssueRouted(String(req.params.id));
      if (hit !== null) {
        rdb = hit.db;
        issueVerified = true;
        gateWorkspaceId = hit.value.workspace_id; // 定位探测即 getIssue：复用命中行，不再重查
      }
    }
    // STORE-1（M1）写入门禁：中间态/缺失/id 不匹配/被锁 → 409 或 500，读路径不受影响
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!issueVerified) {
        const issue = getIssue(rdb, String(req.params.id));
        if (issue !== null) {
          issueVerified = true;
          gateWorkspaceId = issue.workspace_id;
          // 判定只对应 raw 工作区；issue 不属于 raw（raw 未下沉时 issue 可能在中心库）→ 判定不可复用
          if (decided !== null && gateWorkspaceId !== raw) decided = null;
        }
      }
      if (issueVerified && gateWorkspaceId !== null) {
        if (decided !== null) {
          // 判定已随取库带回：getDbForWorkspace 对非 MIGRATING 错误已在此前抛出，这里补 MIGRATING 冻结
          if (decided.error !== null) throw workspaceDbError(decided.error);
        } else {
          assertWorkspaceDbWritable(workspaceResolverDeps, requireWorkspaceRow(gateWorkspaceId));
        }
      }
    }
    next();
  });

  // ---- issues ----
  // STORE-4a：本组端点按请求取库（localized 工作区读写工作区库，未下沉区仍中心库）；
  // 工作区注册与状态字典的权威在中心库，requireExistingWorkspace 保持中心查询。
  router.get('/issues', (req, res) => {
    const workspaceId = requireWorkspaceParam(req);
    requireExistingWorkspace(db, workspaceId);
    const rdb = dbForWorkspace(workspaceId);
    // CLI-LIST-GUARD：status 必须是该工作区已定义的状态（内置 + 自定义），
    // 非法 → 400 并列出可用状态；合法 → 两个分支都真的按它过滤（旧实现非分页分支直接忽略 status）。
    const status = req.query.status === undefined ? undefined : requireWorkspaceStatus(rdb, workspaceId, parseBody(issueStatusSchema, req.query.status));
    // PERF-4a：fields= 白名单（回滚开关关闭时解析结果为 undefined，按旧完整字段返回）
    const rawFields = typeof req.query.fields === 'string' ? req.query.fields : undefined;
    const parsedFields = parseIssueFields(rawFields);
    const paginated = req.query.limit !== undefined || req.query.offset !== undefined;
    // PERF-4：分页且未显式给 fields 时走精简字段集（不含 description），避免长正文撑爆 payload；
    // 显式 fields= 优先，非分页保持完整字段兼容，回滚开关关闭时行为不变。
    const fields = parsedFields ?? (paginated && rawFields === undefined && issuesV2Enabled() ? DEFAULT_PAGE_FIELDS : undefined);
    // OPT-01：kind 集合 / 未占用过滤（缺省查询参数时行为与旧版一致）
    const kinds = parseKindsFilter(req.query.kinds);
    const unclaimed = parseUnclaimedFilter(req.query.unclaimed);
    const filters = { ...(kinds === undefined ? {} : { kinds }), ...(unclaimed === true ? { unclaimed } : {}) };
    if (paginated) {
      const page = parseBody(pageQuerySchema, req.query);
      res.json(listIssuesPage(rdb, workspaceId, { ...page, status, fields, filters }));
    } else res.json(listIssues(rdb, workspaceId, status, fields, filters));
  });

  // PERF-4a：多工作区状态计数聚合；必须注册在 `/issues/:id` 之前，避免 'counts' 被当成卡 id
  router.use('/issues/counts', createIssueCountsRouter({ db, dbForWorkspace }));

  router.get('/issues/tree', (req, res) => {
    const workspaceId = requireWorkspaceParam(req);
    requireExistingWorkspace(db, workspaceId);
    const rdb = dbForWorkspace(workspaceId);
    const input = parseBody(issueTreeQuerySchema, req.query);
    // CLI-LIST-GUARD：树视图的 status 同样按工作区字典校验，避免自定义状态被静默过滤成空树
    const treeStatus = input.status === undefined ? undefined : requireWorkspaceStatus(rdb, workspaceId, input.status);
    const result = getIssueTreeChildren(rdb, {
      workspace_id: workspaceId,
      parent_issue_id: input.parent_issue_id ?? null,
      limit: input.limit,
      status: treeStatus,
      cursor: input.cursor,
    });
    res.json(result);
  });

  router.post('/issues', (req, res) => {
    // STORE-1（M1）：该工作区库不可写时不允许新建卡（与 /issues/:id 写操作同一门禁）
    if (typeof req.body?.workspace_id === 'string') {
      assertWorkspaceDbWritable(workspaceResolverDeps, requireWorkspaceRow(req.body.workspace_id));
    }
    const body = parseBody(createIssueSchema, req.body);
    const rdb = dbForWorkspace(body.workspace_id);
    const outcome = mutation(rdb, req, () => { requireExistingWorkspace(db, body.workspace_id); return createIssueInHierarchy(rdb, body); });
    // KB-CLI-1：幂等重放标记（CLI 文本/JSON 依此区分新建与重放）
    if (outcome.replayed) res.setHeader('x-agentboard-replayed', '1');
    if (!outcome.replayed) {
      broadcast({ type: 'issue.changed', issue: outcome.result });
      // STORE-4b：新卡登记定位索引（中心库；写失败自动降级为读侧 fan-out 兜底）
      upsertEntityLocator(db, 'issue', outcome.result.id, body.workspace_id);
    }
    res.json(outcome.result);
  });

  // kb show 依赖：按 id 取单个 issue（设计 §6.2；REST 全表补充，只读不改契约语义）
  // STORE-4a：不带 workspace_id 时按 id 定位所在库（4b 索引前中心命中即中心，否则 fan-out 已下沉区）
  router.get('/issues/:id', (req, res) => {
    const issue = requireIssueRouted(req.params.id!).value;
    if (req.query.description_offset_chars !== undefined || req.query.description_max_chars !== undefined) {
      const input = parseBody(descriptionQuerySchema, req.query); const window = textWindow(issue.description, input.description_offset_chars, input.description_max_chars);
      res.json({ ...issue, description: window.content, description_truncated: window.truncated, next_description_offset_chars: window.next_offset_chars });
    } else res.json(issue);
  });

  router.patch('/issues/:id', (req, res) => {
    const body = parseBody(patchIssueSchema, req.body);
    const { workspace_id, expected_updated_at, fence, ...patch } = body;
    if (expected_updated_at !== undefined && !workspace_id) throw new ValidationError('CAS 必须提供 workspace_id');
    const rdb = resolveRequestDb(req, String(req.params.id));
    const outcome = mutation(rdb, req, (routedDb) => expected_updated_at !== undefined
      ? updateIssueWithCAS(routedDb, req.params.id!, workspace_id!, expected_updated_at, patch)
      : updateIssueGuarded(routedDb, req.params.id!, patch, fence));
    if (!outcome.replayed) broadcast({ type: 'issue.changed', issue: outcome.result });
    res.json(outcome.result);
  });

  // 设计 §7.4：非占用中删除，级联清理关联会话与消息。
  // 先停各绑定会话的运行中轮次（stopSession 对无在途轮次会话幂等：不 kill、仅状态落库已结束），
  // 再在同一事务内显式删 message → session → issue（不依赖 FK CASCADE 语义）。
  // STORE-4a：业务行在 issue 所在库；stopSession 是 sessionManager 单例（4d 前绑中心库）——
  // 会话行不在中心库时无本进程在途轮次，NotFoundError 吞掉继续删（会话行由本库事务一并清）。
  router.delete('/issues/:id', async (req, res) => {
    const routed = requireIssueRouted(req.params.id!);
    const rdb = routed.db;
    const issue = routed.value;
    if (issue.claimed_by !== null) throw new ConflictError('占用中禁止删除');
    requireNoIssueChildren(rdb, issue.id);
    const bound = listSessionsByIssue(rdb, issue.id);
    for (const session of bound) {
      try {
        await stopSession(session.id);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    }
    let unlockComments: ReturnType<typeof unlockCommentsForDeletedBlocker> = [];
    rdb.transaction(() => {
      for (const session of bound) {
        deleteMessagesBySession(rdb, session.id);
        deleteSession(rdb, session.id);
      }
      // DEP-1 §17-B4：删掉 blocker 卡时，同事务给每个被阻塞卡留解锁痕迹
      unlockComments = unlockCommentsForDeletedBlocker(rdb, issue.id);
      deleteIssue(rdb, issue.id);
    })();
    // STORE-4b：实体行已删，清定位索引（写在事务外——索引在中心库、与 rdb 不同连接；
    // 若此间失败只留过期行，读侧探测未命中自动回退 fan-out，不会错读）
    for (const session of bound) removeEntityLocator(db, 'session', session.id);
    removeEntityLocator(db, 'issue', issue.id);
    await attachments.processCleanup();
    broadcast({ type: 'issue.deleted', issue_id: issue.id, workspace_id: issue.workspace_id });
    for (const comment of unlockComments) broadcast({ type: 'comment.added', comment });
    for (const session of bound) {
      broadcast({ type: 'session.deleted', session_id: session.id });
    }
    res.status(204).end();
  });

  // ---- 依赖（DEP-1）----
  // 读写都锁定工作区（§17-B1）：GET/DELETE 走 query，POST 走 body；跨区依赖在服务层与服务端触发器双重拒绝。
  router.get('/issues/:id/dependencies', (req, res) => {
    const { workspace_id: workspaceId } = parseBody(dependencyQuerySchema, req.query);
    const rdb = dbForWorkspace(workspaceId);
    requireIssueInWorkspace(rdb, req.params.id!, workspaceId);
    // DEC-V4-API-DEP：只认 depth=2 展开两跳；缺省/其它值维持一跳，静默不报错
    const depth = String(req.query.depth ?? '') === '2' ? 2 : 1;
    res.json(listDependencies(rdb, req.params.id!, { depth }));
  });

  router.post('/issues/:id/dependencies', (req, res) => {
    const body = parseBody(addDependencySchema, req.body);
    const rdb = dbForWorkspace(body.workspace_id);
    const outcome = mutation(rdb, req, (routedDb) => addRelation(routedDb, {
      blocked_issue_id: req.params.id!, blocker_issue_id: body.blocker_issue_id, workspace_id: body.workspace_id,
      relation: body.relation ?? 'blocks',
      reason: body.reason ?? null,
    }));
    if (!outcome.replayed) {
      broadcast({ type: 'issue.changed', issue: getIssue(rdb, req.params.id!)! });
      broadcast({ type: 'issue.changed', issue: getIssue(rdb, body.blocker_issue_id)! });
    }
    res.status(201).json(outcome.result);
  });

  router.delete('/issues/:id/dependencies/:blockerId', (req, res) => {
    const { workspace_id: workspaceId } = parseBody(dependencyQuerySchema, req.query);
    const rdb = dbForWorkspace(workspaceId);
    const outcome = mutation(rdb, req, (routedDb) => removeDependency(routedDb, {
      blocked_issue_id: req.params.id!, blocker_issue_id: req.params.blockerId!, workspace_id: workspaceId,
    }));
    if (!outcome.replayed) {
      broadcast({ type: 'issue.changed', issue: getIssue(rdb, req.params.id!)! });
      broadcast({ type: 'issue.changed', issue: getIssue(rdb, req.params.blockerId!)! });
    }
    res.status(204).end();
  });

  // ---- comments ----
  router.get('/issues/:id/comments', (req, res) => {
    const rdb = requireIssueRouted(req.params.id!).db;
    if (req.query.limit !== undefined || req.query.offset !== undefined) res.json(listCommentsPage(rdb, req.params.id!, parseBody(pageQuerySchema, req.query)));
    else res.json(listCommentsByIssue(rdb, req.params.id!));
  });
  router.get('/issues/:id/pending-attachments', (req, res) => {
    const rdb = requireIssueRouted(req.params.id!).db;
    const input = parseBody(pageQuerySchema, req.query);
    res.json(listPendingIssueAttachments(rdb, req.params.id!, input));
  });
  // D7：详情折叠区附件路径索引——该卡全部 attached 附件（评论/会话关联去重，created_at DESC），
  // 固定 URL 仍指向 workspace 下载端点，不新增 markdown scheme
  router.get('/issues/:id/attachments', (req, res) => {
    const routed = requireIssueRouted(req.params.id!);
    const input = parseBody(pageQuerySchema, req.query);
    const page = listIssueAttachments(routed.db, req.params.id!, input);
    const workspaceId = routed.value.workspace_id;
    res.json({
      items: page.items.map((item) => ({
        id: item.id,
        file_name: item.file_name,
        kind: item.kind,
        size_bytes: item.size_bytes,
        url: `/api/workspaces/${workspaceId}/attachments/${item.id}`,
      })),
      next_offset: page.next_offset,
    });
  });
  router.get('/issues/:id/comments/:commentId', (req, res) => {
    const rdb = requireIssueRouted(req.params.id!).db;
    const input = parseBody(commentQuerySchema, req.query);
    const comment = getCommentContent(rdb, req.params.id!, req.params.commentId!, input.content_offset_chars, input.content_max_chars);
    res.json({ ...comment, next_content_offset_chars: comment.next_offset_chars });
  });

  router.get('/issues/:id/attachments/:attachmentId', (req, res, next) => {
    requireIssueRouted(req.params.id!);
    const issueId = req.params.id!;
    const attachmentId = req.params.attachmentId!;
    const filePath = attachments.issuePath(issueId, attachmentId);
    res.type(attachments.issueMime(issueId, attachmentId));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // D7：按 kind 决定下载建议——image 内联，通用文件强制下载
    res.setHeader('Content-Disposition', attachmentContentDisposition(attachments.issueKind(issueId, attachmentId), attachments.issueName(issueId, attachmentId)));
    res.sendFile(filePath, { dotfiles: 'allow' }, (error) => { if (error && !res.headersSent) next(error); });
  });

  router.post('/issues/:id/comments', async (req, res) => {
    const body = parseBody(addCommentSchema, req.body);
    const attachmentIds = body.attachment_ids ?? [];
    const workspaceId = effectiveWorkspace(req);
    if (attachmentIds.length > 0 && !workspaceId) throw new ValidationError('图片评论必须提供 workspace_id');
    const rdb = resolveRequestDb(req, String(req.params.id));
    if (workspaceId) requireIssueInWorkspace(rdb, req.params.id!, workspaceId);
    // 作者身份：body.agent_id 存在 → agent:<agent_id>（agent 写评论），否则 user；唤醒判定在 addComment 内不变
    const author: string = body.agent_id ? `agent:${body.agent_id}` : 'user';
    const key = req.get('Idempotency-Key');
    if (key) {
      let wakeSessionId: string | null = null;
      const outcome = httpMutation(rdb, req, () => {
        const stored = storeComment(rdb, req.params.id!, author, body.content, attachmentIds, readFence(req, body));
        wakeSessionId = stored.wakeSessionId;
        return {
          comment: stored.comment,
          woke: false,
          ...(attachmentIds.length > 0 ? { warning: 'IMAGE_DELIVERY_UNVERIFIED' } : {}),
        } as AddCommentResult & { warning?: string };
      }, author === 'user');
      if (outcome.replayed) { res.json(outcome.result); return; }
      const result = outcome.result;
      if (attachmentIds.length > 0) result.warning = 'IMAGE_DELIVERY_UNVERIFIED';
      if (wakeSessionId) {
        const wake = await wakeStoredComment(rdb, getAdapter, attachments, req.params.id!, wakeSessionId, body.content, attachmentIds);
        result.woke = wake.woke;
        if (wake.warning) result.warning = wake.warning;
        else delete result.warning;
      }
      finishIdempotentEffect(rdb, key, result);
      broadcast({ type: 'comment.added', comment: result.comment });
      broadcast({ type: 'issue.changed', issue: getIssue(rdb, req.params.id!)! });
      res.json(result); return;
    }
    const stored = storeComment(rdb, req.params.id!, author, body.content, attachmentIds, readFence(req, body));
    let woke = false;
    let warning: string | undefined;
    if (attachmentIds.length > 0) warning = 'IMAGE_DELIVERY_UNVERIFIED';
    if (stored.wakeSessionId) {
      const wake = await wakeStoredComment(rdb, getAdapter, attachments, req.params.id!, stored.wakeSessionId, body.content, attachmentIds);
      woke = wake.woke;
      warning = wake.warning;
    }
    broadcast({ type: 'comment.added', comment: stored.comment });
    broadcast({ type: 'issue.changed', issue: getIssue(rdb, req.params.id!)! });
    res.json({ comment: stored.comment, woke, ...(warning ? { warning } : {}) });
  });

  // 留言消费（kb 占用场景）：事务内读全部评论 + 标注新评论 + 推进游标，恰好一次
  router.post('/issues/:id/comments/consume', (req, res) => {
    res.json(consumeComments(resolveRequestDb(req, String(req.params.id)), req.params.id!));
  });

  // ---- 占用事务 ----
  // REST claim 仅占用登记（session_id=null），不建会话；派发场景走 POST /api/sessions
  router.post('/issues/:id/claim', async (req, res) => {
    const body = parseBody(claimSchema, req.body);
    const rdb = resolveRequestDb(req, String(req.params.id));
    const outcome = mutation(rdb, req, (routedDb) => {
      const issue = claimIssue(routedDb, req.params.id!, body.agent_id, null);
      return { ...issue, knowledge: getTaskKnowledge(routedDb, issue, body.knowledge_enabled ?? true, body.knowledge_query) };
    });
    // 领取后记录 git 基线（GIT-ON-DONE）；失败静默，不阻断领取
    if (!outcome.replayed) await captureIssueGitBaseline(rdb, req.params.id!);
    if (!outcome.replayed) broadcast({ type: 'issue.changed', issue: outcome.result });
    res.json(outcome.result);
  });

  // BORROW-0.2：占用续租。不进幂等表——心跳只刷新租约，重放无意义；fence 校验属 B03。
  // DEC-9b：心跳随租约回传 stop_requested，agent 无需额外轮询 GET /issues/:id/stop；
  // 读库口径与 /stop 完全同源（同一个 getStopState + 同一个 db），不另写判断。
  router.post('/issues/:id/heartbeat', (req, res) => {
    const body = parseBody(claimSchema, req.body);
    const rdb = resolveRequestDb(req, String(req.params.id));
    const lease = heartbeatClaim(rdb, req.params.id!, body.agent_id, readFence(req, body));
    broadcast({ type: 'issue.changed', issue: getIssue(rdb, req.params.id!)! });
    res.json({ ...lease, stop_requested: getStopState(db, req.params.id!).stop_requested });
  });

  // BORROW-0.3：fence 双通道——body.fence 优先，回退 x-claim-fence 头；缺席=软模式；值非法一律 400
  function readFence(req: Request, body: { fence?: number } | undefined): number | undefined {
    if (body?.fence !== undefined) return body.fence;
    const raw = req.get(CLAIM_FENCE_HEADER);
    if (raw === undefined || raw === '') return undefined;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ValidationError(`x-claim-fence 头需为 ≥0 整数，收到 ${JSON.stringify(raw)}`);
    return parsed;
  }

  // 自动评论补 WS 推送：comment 非空时追加 comment.added（顺序与手动评论端点一致：先 comment.added 后 issue.changed）
  async function claimAction(req: Request, res: Response, action: 'release' | 'done' | 'fail') {
    const issueId = String(req.params.id);
    const workspace = effectiveWorkspace(req);
    if (req.get('Idempotency-Key') && !workspace) throw new ValidationError('幂等 owner 操作必须提供 workspace_id');
    const actor = action === 'release' && !workspace ? 'user' : parseBody(claimSchema, req.body).agent_id;
    const fence = readFence(req, req.body as { fence?: number } | undefined);
    const doneBody = action === 'done' ? parseBody(doneSchema, req.body) : undefined;
    const detail = action === 'done' ? doneBody!.notes : action === 'fail' ? parseBody(failSchema, req.body).reason : undefined;
    // GIT-ON-DONE 提交范围：只有 done 认 scope_paths（文件路径或目录前缀），其余动作忽略
    const scopePaths = doneBody?.scope_paths ?? [];
    // N4-04：board_only 与 scope 显式互斥（不静默择一；CLI / MCP 客户端已先拦，这里兜底 REST 直调）
    if (action === 'done' && doneBody!.board_only === true && scopePaths.length > 0) {
      throw new ValidationError(
        'board_only 与 scope 不能同时使用：纯看板任务不提交任何文件。',
        'BOARD_ONLY_SCOPE_CONFLICT',
      );
    }
    // STORE-4a：业务写与 git 基线落 issue 所在库
    const rdb = resolveRequestDb(req, issueId);
    // SK-05 / MCP-09：agent 入口（带 client）必须满足三者之一才放行：
    // ① 请求显式 ack（含 --no-changelog / skip_changelog）；
    // ② changelog_id 指向本工作区一条活动日志（MCP 的 --close-record 等价出口）；
    // ③ 库中已有本卡 changelog（issue_id=本卡，且 claim 之后创建）。
    // REST 直调不带 client，保持旧行为（兼容存量脚本与测试）。
    if (action === 'done' && doneBody!.client !== undefined && doneBody!.changelog_ack !== true) {
      const issueRow = getIssue(rdb, issueId);
      if (!issueRow) throw new NotFoundError('任务不存在');
      // 日志固定落中心库（changelog 路由挂载在 deps.db），不随工作区库下沉
      if (doneBody!.changelog_id !== undefined) {
        if (getActiveChangeLog(db, issueRow.workspace_id, doneBody!.changelog_id) === null) {
          throw new ValidationError(
            `变更日志门禁：changelog_id ${doneBody!.changelog_id} 不存在或不属于本工作区；请用 kb changelog list 确认 id 后重试。`,
            'CHANGELOG_NOT_FOUND',
          );
        }
      } else if (!hasChangeLogForIssue(db, issueRow.workspace_id, issueId, issueRow.claimed_at)) {
        throw new ValidationError(
          '变更日志门禁：done 前须先写一条用户可见变更（以下任一即可）：① `kb changelog create --issue <卡 id> --title "…" --type 修复`'
          + '（正文走 --stdin；MCP `create_changelog` 传 `issue_id`）后再 done；'
          + '② `kb done --close-record --changelog-title "…" --type 修复`（MCP `complete_task` 传 `changelog_id`）；'
          + '③ 本次确实没有用户可见变更（纯内部重构 / 仅看板操作）→ `kb done --no-changelog`，'
          + 'MCP `complete_task` 传 `skip_changelog: true`。',
          'CHANGELOG_ACK_REQUIRED',
        );
      }
    }
    // KB-WRITE-NUDGE：hint 必须在 done 清空 claimed_at/claimed_by 之前算，并随幂等结果一起缓存（重放响应要逐字一致）
    const outcome = workspace ? mutation(rdb, req, (routedDb) => {
      if (action === 'done') {
        const preFinish = getIssue(routedDb, issueId);
        const hint = preFinish ? buildKnowledgeHint(routedDb, preFinish, { changelogSettled: doneBody?.client !== undefined }) : null;
        return { ...finishClaimedIssue(routedDb, issueId, workspace, actor, 'done', detail, fence), knowledge_hint: hint };
      }
      return action === 'release'
        ? releaseClaimedIssue(routedDb, issueId, workspace, actor, fence)
        : finishClaimedIssue(routedDb, issueId, workspace, actor, action, detail, fence);
    }) : { result: action === 'release'
      ? await releaseIssue(rdb, issueId, fence) : action === 'done'
        ? await (async () => {
          const preFinish = getIssue(rdb, issueId);
          const hint = preFinish ? buildKnowledgeHint(rdb, preFinish, { changelogSettled: doneBody?.client !== undefined }) : null;
          return { ...(await doneIssue(rdb, issueId, actor, detail, fence)), knowledge_hint: hint };
        })() : await failIssue(rdb, issueId, actor, detail!, undefined, fence), replayed: false };
    const { issue, comment } = outcome.result;
    const knowledgeHint = (outcome.result as { knowledge_hint?: KnowledgeHint | null }).knowledge_hint ?? null;
    /** GIT-OBSERVABLE：done 的自动提交结果随响应回传；同 key 重放取首次结果（不重复提交） */
    let gitCommit: IssueCommitResult | null = (outcome.result as { git_commit?: IssueCommitResult | null }).git_commit ?? null;
    // KB-CLI-1：done/fail/release 幂等重放同样回传标记
    if (outcome.replayed) res.setHeader('x-agentboard-replayed', '1');
    if (!outcome.replayed) {
      if (comment) broadcast({ type: 'comment.added', comment });
      broadcast({ type: 'issue.changed', issue });
      // GIT-ON-DONE：done 后按 claim 基线提交本任务改动；幂等重放不重复提交
      if (action === 'done') {
        // N3-10：纯看板任务显式跳过提交（不产生 NO_SCOPE / exit 1，也不带走工作区脏文件）
        if (doneBody!.board_only === true) {
          dropIssueGitBaseline(rdb, issueId);
          gitCommit = { status: 'skipped', reason: 'BOARD_ONLY', note: null, pending: [] };
        } else {
          gitCommit = await commitIssueChanges(rdb, issueId, scopePaths);
        }
        if (gitCommit.note) {
          const added = await addComment(rdb, issueId, 'system', gitCommit.note);
          broadcast({ type: 'comment.added', comment: added.comment });
        }
      } else {
        dropIssueGitBaseline(rdb, issueId);
      }
    }
    const responseBody = action === 'done' ? { ...issue, comment, knowledge_hint: knowledgeHint, git_commit: gitCommit } : { ...issue, comment };
    // GIT-OBSERVABLE：提交结果晚于事务产生，按事务结果的嵌套形状补写回首次落账，保证同 key 重放逐字一致
    const idempotencyKey = req.get('Idempotency-Key');
    if (idempotencyKey && !outcome.replayed) {
      amendIdempotentResult(rdb, idempotencyKey, workspace ?? '', { issue, comment, knowledge_hint: knowledgeHint, git_commit: gitCommit });
    }
    res.json(responseBody);
  }
  router.post('/issues/:id/release', (req, res) => claimAction(req, res, 'release'));
  router.post('/issues/:id/done', (req, res) => claimAction(req, res, 'done'));
  router.post('/issues/:id/fail', (req, res) => claimAction(req, res, 'fail'));

  /**
   * BORROW-4.3：任务交接 —— 把占用从一个 agent 交给另一个 agent，写 system 评论留痕，
   * 并 bump `claim_fence`（旧占用者的 fence 立即失效，后续收尾落 STALE_FENCE）。
   * 必填 workspace_id（与 claim/done 同口径：交接是 owner 域写操作）。
   */
  router.post('/issues/:id/transfer', (req, res) => {
    const issueId = String(req.params.id);
    const body = parseBody(transferIssueSchema, req.body);
    // 工作区来源：query/header 已解析的上下文优先，其次 body.workspace_id（与 CLI/脚本同一口径）
    const workspace = effectiveWorkspace(req) ?? body.workspace_id;
    if (!workspace) throw new ValidationError('任务交接必须提供 workspace_id（或走已解析的工作区上下文）');
    const rdb = resolveRequestDb(req, issueId);
    const result = transferClaimedIssue(
      rdb, issueId, workspace, body.from_agent, body.to_agent, body.reason, readFence(req, body),
    );
    if (result.comment) broadcast({ type: 'comment.added', comment: result.comment });
    broadcast({ type: 'issue.changed', issue: result.issue });
    res.json({ ...result.issue, comment: result.comment, claim_fence: result.claim_fence });
  });

  // ---- CLI-CLOSE：验收后流转（close 待验收→已关闭；reopen 已关闭/已废弃→指定状态）----
  router.post('/issues/:id/close', (req, res) => {
    const workspace = effectiveWorkspace(req);
    const rdb = resolveRequestDb(req, String(req.params.id));
    const outcome = mutation(rdb, req, (routedDb) => closeIssue(routedDb, req.params.id!, workspace));
    if (!outcome.replayed) broadcast({ type: 'issue.changed', issue: outcome.result });
    res.json(outcome.result);
  });
  router.post('/issues/:id/reopen', (req, res) => {
    const workspace = effectiveWorkspace(req);
    const body = parseBody(reopenSchema, req.body ?? {});
    const rdb = resolveRequestDb(req, String(req.params.id));
    const outcome = mutation(rdb, req, (routedDb) => reopenIssue(routedDb, req.params.id!, body.status, workspace));
    if (!outcome.replayed) broadcast({ type: 'issue.changed', issue: outcome.result });
    res.json(outcome.result);
  });

  return router;
}
