/**
 * workspaces 域 REST（CR-10b 自 routes.ts 纯搬迁，不改语义）。
 * 覆盖：per-workspace changelog / statuses 子挂载、工作区 CRUD 与批量重排、删除（知识占用/
 * 运行会话/子任务守卫 + STORE-7 归档）、release-running、工作区附件、STORE-2a/3a 库下沉
 * （localize/cleanup/revert/状态查询）、STORE-5/6 快照（export/validate/import）、approval-rules。
 * STORE-1/4a 解析上下文（workspaceResolverDeps/requireWorkspaceRow/dbForWorkspace）与
 * currentDbPath/attachmentsDirOf 是 routes.ts 装配期闭包、多域共用，经 WorkspaceRouterDeps 注入。
 */
import { statSync } from 'node:fs';
import express, { Router } from 'express';
import type { ZodType } from 'zod';
import type { ServerWsEvent } from '@agentboard/shared';
import { zhZodIssue } from '../zod.js';
import type { Db } from '../../db/connection.js';
import {
  createWorkspace,
  getWorkspace,
  getWorkspaceDeleteBlockers,
  listWorkspaces,
  listWorkspacesPage,
  listWorkspaceIds,
  reorderWorkspaces,
} from '../../db/repos/workspace.js';
import { getWorkspaceKnowledgeOccupancy } from '../../db/repos/knowledge.js';
import { listActiveApprovalRules, revokeApprovalRule } from '../../db/repos/approvalRule.js';
import { removeEntityLocatorByWorkspace } from '../../db/repos/entityLocator.js';
import {
  WORKSPACE_DB_MODES,
  assertWorkspaceDbWritable,
  closeWorkspaceDb,
  decideWorkspaceDb,
  getDbForWorkspace,
  isWorkspaceDbDisabled,
  readWorkspaceMetaCached,
  workspaceDbPath,
  type ResolverDeps,
  type WorkspaceDbMode,
  type WorkspaceLike,
} from '../../db/resolver.js';
import { createChangelogRouter } from '../changelogRoutes.js';
import { createWorkspaceStatusRouter } from '../workspaceStatusRoutes.js';
import { ApiError, ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import { releaseRunning } from '../../services/releaseRunning.js';
import { AttachmentStore, MAX_IMAGE_BYTES, attachmentContentDisposition } from '../../services/attachments.js';
import { getActiveWorkspaceDbJob, getLocalizeJob, startLocalizeJob, startWorkspaceDbOpJob } from '../../services/workspaceLocalizeJob.js';
import { buildWorkspaceDbStatus } from '../../services/workspaceDbStatus.js';
import {
  exportWorkspaceSnapshot,
  importWorkspaceSnapshot,
  resolveSnapshotDir,
  validateWorkspaceSnapshot,
} from '../../services/workspaceSnapshot.js';
import { deleteWorkspaceRemovingDeletedKnowledge } from '../../services/workspaceKnowledgePurge.js';
import { archiveWorkspaceState, rollbackWorkspaceArchive } from '../../services/workspaceArchive.js';
import { computeSnapshotLag } from '../../services/workspaceSnapshotLag.js';
import { appendServerLog } from '../../services/serverLog.js';
import { httpMutation } from '../../services/idempotency.js';
import {
  createWorkspaceSchema,
  reorderWorkspacesSchema,
  releaseRunningSchema,
  workspaceLocalizeSchema,
  workspaceDbOpSchema,
  workspaceSnapshotExportSchema,
  workspaceSnapshotImportSchema,
  pageQuerySchema,
} from '../schemas.js';

export interface WorkspaceRouterDeps {
  /** 中心库：工作区注册权威 */
  db: Db;
  /** WS 广播钩子（与 routes.ts 同一注入） */
  broadcast: (event: ServerWsEvent) => void;
  attachments: AttachmentStore;
  /** STORE-1/4a：resolver 装配上下文（routes.ts 闭包，issue/session 域共用） */
  workspaceResolverDeps: ResolverDeps;
  /** 写闸门与 localize 共用的工作区行取用（未知工作区 404） */
  requireWorkspaceRow: (workspaceId: string) => WorkspaceLike;
  /** workspace_id 已知时的取库（localized→工作区库，其余→中心库；未知工作区 404） */
  dbForWorkspace: (workspaceId: string) => Db;
  /** DB-2B：当前进程实际使用的库路径（缺省 db.name；测试注入） */
  currentDbPath: string | null;
  /** 当前进程的附件目录解析（缺省 attachmentsDirFor(dbPath)；测试注入） */
  attachmentsDirOf: (dbPath: string) => string;
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

function requireExistingWorkspace(db: Db, id: string): void {
  if (!getWorkspace(db, id)) throw new NotFoundError('工作空间不存在');
}

/** name 留空兜底：先去尾部 / 与 \，再按 / 或 \ 分段取最后一段 */
function workspaceNameFromPath(path: string): string {
  const segments = path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]+/)
    .filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1]! : path;
}

export function createWorkspaceRouter(deps: WorkspaceRouterDeps): Router {
  const {
    db,
    broadcast,
    attachments,
    requireWorkspaceRow,
    dbForWorkspace,
    workspaceResolverDeps,
    currentDbPath,
    attachmentsDirOf,
  } = deps;
  const router = Router();

  router.use('/workspaces/:workspaceId/changelog', createChangelogRouter(deps.db));
  // STATUS-2：工作区状态字典（列表/新建/删除+强制迁移）
  router.use('/workspaces/:workspaceId/statuses', createWorkspaceStatusRouter(deps.db));

  // ---- workspaces ----
  /**
   * STORE-1（M1）：工作区行带上「服务端判定结果」——`db_mode`（中心期望状态）、`db_path`（判定后实际会用的库）、
   * `db_target`/`db_reason`（排障用）。判定输入只有「中心行 + 文件 + 库内 meta」，**不接受客户端传参决定走库**。
   */
  const withWorkspaceDb = <T extends { id: string; path: string }>(row: T) => {
    const dbModeRaw = (row as T & { db_mode?: string | null }).db_mode ?? 'center';
    const centerDbMode = (WORKSPACE_DB_MODES as readonly string[]).includes(dbModeRaw) ? (dbModeRaw as (typeof WORKSPACE_DB_MODES)[number]) : 'center';
    // PERF-1（F2）：判定读 meta 走常驻只读句柄（readWorkspaceMetaCached）——列表不再每工作区每请求开库
    const decision = decideWorkspaceDb({ workspaceId: row.id, workspacePath: row.path, centerDbMode, centerDbPath: db.name, readMeta: readWorkspaceMetaCached, ...(isWorkspaceDbDisabled() ? { disabled: true } : {}) });
    // STORE-7：snapshot_lag 只读提示（快照是派生物；无 manifest → null）
    const snapshotLag = computeSnapshotLag({ workspaceId: row.id, workspacePath: row.path, effectiveDbPath: decision.dbPath, centerDb: db });
    return { ...row, db_mode: centerDbMode, db_path: decision.dbPath, db_target: decision.target, db_reason: decision.reason, snapshot_lag: snapshotLag };
  };
  router.get('/workspaces', (req, res) => {
    if (req.query.limit !== undefined || req.query.offset !== undefined) {
      const page = parseBody(pageQuerySchema, req.query);
      const result = listWorkspacesPage(db, page.limit, page.offset);
      res.json({ ...result, items: result.items.map(withWorkspaceDb) });
    } else res.json(listWorkspaces(db).map(withWorkspaceDb));
  });

  /**
   * WS-REORDER：批量重排工作区展示顺序。
   * 必填 `Idempotency-Key`（同 key 同 body 重放返回首次结果、不改写；同 key 不同 body → 409）。
   * 并发语义：顺序冲突为 LWW（后写覆盖）；集合与当前库不一致 → 409 WORKSPACE_SET_CHANGED（附 missing/extra），
   * 不按部分集合静默重排。
   */
  router.post('/workspaces/reorder', (req, res) => {
    if (!req.get('Idempotency-Key')) throw new ValidationError('该接口要求 Idempotency-Key（UUID）');
    const body = parseBody(reorderWorkspacesSchema, req.body);
    const current = listWorkspaceIds(db);
    const unknown = body.ordered_ids.filter(id => !current.includes(id));
    if (unknown.length > 0) throw new ValidationError(`工作空间不存在: ${unknown.join(', ')}`);
    const missing = current.filter(id => !body.ordered_ids.includes(id));
    const extra = body.ordered_ids.filter(id => !current.includes(id));
    if (missing.length > 0 || extra.length > 0) {
      throw new ApiError(409, 'WORKSPACE_SET_CHANGED', '工作区集合已变化，请刷新后重试', { missing, extra });
    }
    const result = httpMutation(db, req, () => ({ workspaces: reorderWorkspaces(db, body.ordered_ids), reordered_at: Date.now() }));
    res.json(result.result);
  });

  router.post('/workspaces', (req, res) => {
    const body = parseBody(createWorkspaceSchema, req.body);
    let stat;
    try {
      stat = statSync(body.path);
    } catch {
      throw new ValidationError(`路径不存在或不是目录: ${body.path}`);
    }
    if (!stat.isDirectory()) throw new ValidationError(`路径不存在或不是目录: ${body.path}`);
    // name 留空 → 从 path basename 兜底（路径存在性校验已在前，空路径不会到这里）
    const name = body.name !== '' ? body.name : workspaceNameFromPath(body.path);
    res.json(createWorkspace(db, { name, path: body.path }));
  });

  router.delete('/workspaces/:id', async (req, res) => {
    const workspaceId = req.params.id!;
    // KB-DEL（N-03）：知识占用只算**未软删**的页与其 revision（口径见 repos/knowledge.ts）；
    // 已 `status='deleted'` 的页对用户不可见，不再阻断，由下面的 purge 一并硬删——
    // `knowledge_page.workspace_id` 是 ON DELETE RESTRICT，留着它们空间行本来就删不掉。
    // purge 只可能发生在显式 `--yes` 的 DELETE 上（`kb delete-space` 缺 --yes 不发请求），
    // 且删了多少页/多少条 revision 一律回显（响应头 + 服务日志）。
    const knowledge = getWorkspaceKnowledgeOccupancy(db, workspaceId);
    if (knowledge.pages > 0) {
      // 拒绝原因点名剩余页 id（最多 5 个，多了只报总数），用户才能直接去删/迁这几页
      const shown = 5;
      throw new ConflictError(
        `该空间仍有 ${knowledge.pages} 个知识页及 ${knowledge.revisions} 条历史 revision`
        + `（剩余页：${knowledge.pageIds.slice(0, shown).join(', ')}`
        + `${knowledge.pageIds.length > shown ? ` 等 ${knowledge.pageIds.length} 个` : ''}），请先删除或迁移知识页后再移除`,
      );
    }
    const blockers = getWorkspaceDeleteBlockers(db, workspaceId);
    if (blockers.runningSessions > 0)
      throw new ConflictError(`该空间有 ${blockers.runningSessions} 个运行中会话，请先结束会话后再移除`);
    if (blockers.childIssues > 0)
      throw new ConflictError(`该空间有 ${blockers.childIssues} 个子任务仍挂在父任务下，请先解除关联后再移除`);
    // STORE-7：已下沉工作区不删库文件——先把库（含 -wal/-shm）+ 附件移入归档目录并落记录；
    // 未下沉时归档服务是 no-op，行为与现状一致。删行失败则把文件移回，不留在归档目录。
    const workspaceRow = getWorkspace(db, workspaceId);
    const mode = (workspaceRow as unknown as { db_mode?: string | null } | null)?.db_mode ?? 'center';
    // 归档要 rename 活库文件，先收该工作区的 resolver 句柄（Windows 上有句柄时 rename=EBUSY）
    if (workspaceRow !== null) closeWorkspaceDb(workspaceId, workspaceResolverDeps.instanceId, workspaceDbPath(workspaceRow.path));
    const archived = workspaceRow === null
      ? null
      : archiveWorkspaceState(db, { workspaceId, name: workspaceRow.name, path: workspaceRow.path, dbMode: mode });
    let purged: ReturnType<typeof deleteWorkspaceRemovingDeletedKnowledge>;
    try {
      purged = deleteWorkspaceRemovingDeletedKnowledge(db, workspaceId);
    } catch (error) {
      if (archived?.archived === true && workspaceRow !== null) rollbackWorkspaceArchive(db, { workspaceId, path: workspaceRow.path });
      throw error;
    }
    if (archived?.archived === true && archived.dir !== undefined) {
      // 头值用 encodeURI 保证非 ASCII 路径可安全传输；服务日志留原文
      res.setHeader('X-Workspace-Archived', encodeURI(archived.dir));
      appendServerLog(
        `[workspace-archive] ${workspaceId} 库与附件移入 ${archived.dir}（db ${archived.dbBytes} 字节 / 附件 ${archived.attachmentFiles} 个${archived.alreadyArchived ? '，沿用既有归档副本' : ''}）`,
      );
    }
    if (purged.pages > 0) {
      res.setHeader('X-Knowledge-Purged', `pages=${purged.pages}; revisions=${purged.revisions}`);
      appendServerLog(
        `[workspace-delete] ${workspaceId} 移除时硬删已软删知识页 ${purged.pages} 个、历史 revision ${purged.revisions} 条（仅 status='deleted'）`,
      );
    }
    // 空间行已由 purge 服务在同一事务内删除（外键 CASCADE 带走任务/会话/评论/消息）
    // STORE-4b：该区全部实体（issue/session/知识页）随空间移除，定位索引一并清（common 页 workspace_id 为 NULL 不受影响）
    removeEntityLocatorByWorkspace(db, workspaceId);
    await attachments.processCleanup();
    res.status(204).end();
  });

  /**
   * REL-1：工作区批量退回待规划（「进行中」列头救火键的服务端契约）。
   * workspace 只取路径参数 —— 明确不读 effectiveWorkspace（`body.workspace_id ?? query.workspace_id`），
   * 不存在「省略工作区就清全部」；未知工作区 404 零写入。body 里的 workspace_id 直接忽略。
   */
  router.post('/workspaces/:workspaceId/release-running', (req, res) => {
    const workspaceId = String(req.params.workspaceId);
    if (!getWorkspace(db, workspaceId)) throw new NotFoundError('工作空间不存在');
    // STORE-4a：批量退回是写操作——迁移中间态冻结（409），落库走该区解析库
    const row = requireWorkspaceRow(workspaceId);
    assertWorkspaceDbWritable(workspaceResolverDeps, row);
    const rdb = dbForWorkspace(workspaceId);
    const body = parseBody(releaseRunningSchema, req.body ?? {});
    const { released, skipped } = releaseRunning(rdb, workspaceId, body);
    if (body.dry_run !== true) {
      for (const issue of released) broadcast({ type: 'issue.changed', issue });
    }
    res.json({ released, skipped });
  });

  router.post('/workspaces/:workspaceId/attachments', express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }), async (req, res) => {
    const workspaceId = req.params.workspaceId!;
    if (!getWorkspace(db, workspaceId)) throw new NotFoundError('工作空间不存在');
    if (!Buffer.isBuffer(req.body)) throw new ValidationError('图片请求体必须为原始二进制');
    const uploaded = await attachments.upload(workspaceId, req.get('Content-Type') ?? '', req.get('X-File-Name') ?? undefined, req.body);
    res.status(201).json(uploaded);
  });

  router.get('/workspaces/:workspaceId/attachments/:attachmentId', (req, res, next) => {
    const workspaceId = req.params.workspaceId!;
    if (!getWorkspace(db, workspaceId)) throw new NotFoundError('工作空间不存在');
    const id = req.params.attachmentId!;
    // CHAT-IMG-DELIVERY：workspace 内 staged/attached 均可读——聊天消息里的 markdown URL 绑定会话后仍能显示
    const filePath = attachments.workspacePath(workspaceId, id);
    res.type(attachments.workspaceMime(workspaceId, id));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // D7：按 kind 决定下载建议——image 内联，通用文件强制下载
    res.setHeader('Content-Disposition', attachmentContentDisposition(attachments.workspaceKind(workspaceId, id), attachments.workspaceName(workspaceId, id)));
    res.sendFile(filePath, { dotfiles: 'allow' }, (error) => { if (error && !res.headersSent) next(error); });
  });

  // ---- STORE-2a/3a：工作区库下沉（localize）——八阶段状态机的 REST 入口（2b CLI 消费）----
  /**
   * POST /api/workspaces/:id/db/localize：body { dryRun?, overwrite?, resume? } → 202 { jobId, ... }。
   * dry-run 与真实迁移统一走 jobId 模型；真实迁移开跑即置中心 db_mode=localizing，
   * 该工作区写闸门随之 409 WORKSPACE_DB_MIGRATING、读继续走中心库、其它工作区无感。
   * STORE-3a：resume=true 从 `<ws>/.agentboard/localize.json` 记录的阶段续跑（崩溃矩阵见
   * workspaceLocalizeRun.localizeWorkspace）；dryRun=true 时忽略 resume，resume=true 时忽略 overwrite。
   */
  router.post('/workspaces/:id/db/localize', async (req, res) => {
    const workspaceId = req.params.id!;
    const wsRow = requireWorkspaceRow(workspaceId); // 未知工作区显式 404，不进任务表
    // STORE-4a：作业要建/换工作区库文件，先收掉本进程的路由句柄（Windows 打开中的句柄让 rename/unlink EBUSY）
    // PERF-1（F2）：meta 只读句柄一并收（未下沉半成品库可能只有 meta 句柄，传路径兜底）
    closeWorkspaceDb(workspaceId, workspaceResolverDeps.instanceId, workspaceDbPath(wsRow.path));
    const body = parseBody(workspaceLocalizeSchema, req.body ?? {});
    const job = startLocalizeJob(db, {
      workspaceId,
      dryRun: body.dryRun === true,
      overwrite: body.overwrite === true,
      resume: body.resume === true,
      ...(currentDbPath === null ? {} : { attachmentsDir: attachmentsDirOf(currentDbPath) }),
    });
    res.status(202).json(job);
  });

  /** GET /api/workspaces/:id/db/localize/:jobId：阶段、计数、last_error（任务表只在内存，重启即 404） */
  router.get('/workspaces/:id/db/localize/:jobId', (req, res) => {
    const job = getLocalizeJob(String(req.params.id), String(req.params.jobId));
    if (job === null) throw new NotFoundError('迁移任务不存在');
    res.json(job);
  });

  /**
   * STORE-3a：POST /api/workspaces/:id/db/localize/cleanup → 202 { jobId, kind: 'cleanup', ... }。
   * 只清失败半成品（工作区侧目标库 / -wal / -shm / 附件目录 / 残留快照 / localize.json），
   * 中心库数据不动；failed/localizing 的中心 db_mode 落回 center（写闸门释放）。
   * db_mode=localized（活库）或工作区库是唯一数据副本时 409 拒绝。
   */
  router.post('/workspaces/:id/db/localize/cleanup', (req, res) => {
    const workspaceId = req.params.id!;
    const wsRow = requireWorkspaceRow(workspaceId);
    // STORE-4a：清残留文件前收句柄；PERF-1（F2）：meta 只读句柄一并收（传路径兜底半成品库）
    closeWorkspaceDb(workspaceId, workspaceResolverDeps.instanceId, workspaceDbPath(wsRow.path));
    parseBody(workspaceDbOpSchema, req.body ?? {});
    const job = startWorkspaceDbOpJob(db, {
      workspaceId,
      kind: 'cleanup',
      ...(currentDbPath === null ? {} : { attachmentsDir: attachmentsDirOf(currentDbPath) }),
    });
    res.status(202).json(job);
  });

  /**
   * STORE-3a：POST /api/workspaces/:id/db/localize/revert → 202 { jobId, kind: 'revert', ... }。
   * 反向迁移：附件回拷（sha256）+ 单事务反向插行（逐表行数守恒，复用 verify 守恒语义）+
   * db_mode=center；提交后工作区库移入 `<ws>/.agentboard/backup/`。中心已有该区行（disabled
   * 期间回写等分叉）时 409 拒绝，不静默覆盖。
   */
  router.post('/workspaces/:id/db/localize/revert', (req, res) => {
    const workspaceId = req.params.id!;
    const wsRow = requireWorkspaceRow(workspaceId);
    // STORE-4a：回迁挪文件前收句柄；PERF-1（F2）：meta 只读句柄一并收（传路径兜底）
    closeWorkspaceDb(workspaceId, workspaceResolverDeps.instanceId, workspaceDbPath(wsRow.path));
    parseBody(workspaceDbOpSchema, req.body ?? {});
    const job = startWorkspaceDbOpJob(db, {
      workspaceId,
      kind: 'revert',
      ...(currentDbPath === null ? {} : { attachmentsDir: attachmentsDirOf(currentDbPath) }),
    });
    res.status(202).json(job);
  });

  /**
   * STORE-3a：GET /api/workspaces/:id/db → 工作区库状态只读汇总（db_mode / 闸门 / db 路径 /
   * 数据归属侧行数与附件 / 快照落后条数 / localize.json 中间态 / disabled+needsRevert）。
   */
  router.get('/workspaces/:id/db', (req, res) => {
    const workspaceId = req.params.id!;
    requireWorkspaceRow(workspaceId);
    const active = getActiveWorkspaceDbJob(workspaceId);
    res.json(buildWorkspaceDbStatus(db, { workspaceId }, {
      centerDbPath: currentDbPath ?? db.name,
      ...(currentDbPath === null ? {} : { attachmentsDir: attachmentsDirOf(currentDbPath) }),
      ...(active === null ? {} : { activeJob: { jobId: active.jobId, kind: active.kind ?? 'localize', status: active.status, stage: active.stage } }),
    }));
  });

  /** STORE-5：快照只能作用于已下沉的工作区库（库为准；中心库模式先 enable） */
  const localizedWorkspaceDb = (wsRow: { id: string; path: string; dbMode: WorkspaceDbMode }) => {
    const resolution = getDbForWorkspace(workspaceResolverDeps, wsRow);
    if (resolution.decision.target !== 'workspace') {
      throw new ApiError(
        409, 'SNAPSHOT_NOT_LOCALIZED',
        `快照只作用于工作区库：该工作区当前解析为 ${resolution.decision.target}（${resolution.decision.reason}），先 kb workspace-db enable`,
      );
    }
    return resolution.db;
  };

  /**
   * STORE-5/6：POST /api/workspaces/:id/db/snapshot/export { includeMessages?, includeAttachments? }
   * → { dir, manifest }。已下沉时读工作区库；未下沉时从中心库按 workspace 过滤导出（STORE-6），
   * 这样「没 enable 也能把看板提交进 git」。导出后回读自校验。
   */
  router.post('/workspaces/:id/db/snapshot/export', (req, res) => {
    const wsRow = requireWorkspaceRow(req.params.id!);
    const body = parseBody(workspaceSnapshotExportSchema, req.body ?? {});
    if (wsRow.dbMode === 'localizing') {
      throw new ApiError(409, 'SNAPSHOT_MIGRATING', '工作区库迁移进行中，暂不导出快照（迁移结束后会自动导出）');
    }
    const resolution = getDbForWorkspace(workspaceResolverDeps, wsRow);
    const includeMessages = body.includeMessages === true;
    const includeAttachments = body.includeAttachments === true;
    if (resolution.decision.target === 'workspace') {
      const dbPath = workspaceDbPath(wsRow.path);
      res.json(exportWorkspaceSnapshot({
        db: resolution.db,
        workspacePath: wsRow.path,
        sourceDbPath: dbPath,
        includeMessages,
        includeAttachments,
        attachmentsDir: attachmentsDirOf(dbPath),
      }));
      return;
    }
    // STORE-6：中心库模式——行集按 workspace_id 过滤，附件取中心库同级 attachments/
    const centerPath = currentDbPath ?? db.name;
    res.json(exportWorkspaceSnapshot({
      db: resolution.db,
      workspaceId: wsRow.id,
      workspacePath: wsRow.path,
      sourceDbPath: centerPath,
      includeMessages,
      includeAttachments,
      attachmentsDir: attachmentsDirOf(centerPath),
    }));
  });

  /**
   * STORE-5：GET /api/workspaces/:id/db/snapshot/validate?dir=
   * 只读校验 manifest + 文件哈希/行数；目录缺省 <ws>/.agentboard/snapshot，且必须位于工作区内。
   */
  router.get('/workspaces/:id/db/snapshot/validate', (req, res) => {
    const wsRow = requireWorkspaceRow(req.params.id!);
    const dir = resolveSnapshotDir(wsRow.path, typeof req.query.dir === 'string' ? req.query.dir : undefined);
    const checked = validateWorkspaceSnapshot(dir);
    res.json({
      ok: true,
      dir: checked.dir,
      manifest: checked.manifest,
      tables: [...checked.rows.entries()].map(([table, rows]) => ({ table, rows: rows.length })),
    });
  });

  /**
   * STORE-5：POST /api/workspaces/:id/db/snapshot/import { dir?, replace? }
   * 只允许同 workspace_id 的空工作区库；replace=true 先 VACUUM INTO 备份再覆盖，失败整体回滚。
   */
  router.post('/workspaces/:id/db/snapshot/import', (req, res) => {
    const wsRow = requireWorkspaceRow(req.params.id!);
    const body = parseBody(workspaceSnapshotImportSchema, req.body ?? {});
    const rdb = localizedWorkspaceDb(wsRow);
    const dir = resolveSnapshotDir(wsRow.path, body.dir);
    res.json(importWorkspaceSnapshot({
      db: rdb,
      dir,
      workspaceId: wsRow.id,
      workspacePath: wsRow.path,
      replace: body.replace === true,
    }));
  });

  // ---- approval rules（CHAT-APP1 契约 #16/#17）----
  // 只列未撤销规则（撤销入口数据源）；DELETE 是软撤销，行保留作审计。
  // STORE-4a：规则行随工作区下沉，读写走该区解析库
  router.get('/workspaces/:workspaceId/approval-rules', (req, res) => {
    const workspaceId = req.params.workspaceId!;
    requireExistingWorkspace(db, workspaceId);
    res.json(listActiveApprovalRules(dbForWorkspace(workspaceId), workspaceId));
  });

  router.delete('/workspaces/:workspaceId/approval-rules/:ruleId', (req, res) => {
    const workspaceId = req.params.workspaceId!;
    requireExistingWorkspace(db, workspaceId);
    res.json(revokeApprovalRule(dbForWorkspace(workspaceId), workspaceId, req.params.ruleId!));
  });

  return router;
}
