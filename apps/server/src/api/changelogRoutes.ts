/**
 * LOG01｜工作区变更日志 REST（设计 §6）。
 * - 活动日志挂在 `/workspaces/:workspaceId/changelog`，全程限定 URL 所属工作区；
 * - 归档日志挂在 `/changelog/archived-workspaces/:originWorkspaceId/...`，只读且只按 origin ID 查询；
 * - 跨工作区记录统一 404 `CHANGELOG_NOT_FOUND`，避免跨空间探测；
 * - 写入复用既有 `Idempotency-Key` 语义，更新/删除在事务内做 `expected_revision` CAS。
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/connection.js';
import { ApiError, NotFoundError, ValidationError } from '../errors.js';
import { getWorkspace } from '../db/repos/workspace.js';
import { getIssue } from '../db/repos/issue.js';
import {
  createChangeLog,
  deleteChangeLog,
  getActiveChangeLog,
  getArchivedChangeLog,
  listActiveChangeLogs,
  listArchivedChangeLogs,
  listArchivedWorkspaces,
  patchChangeLog,
} from '../db/repos/workspaceChangeLog.js';
import { httpMutation } from '../services/idempotency.js';
import { applyLegacyChangelog, previewLegacyChangelog, verifyLegacyChangelogRetire } from '../services/changelogImport.js';
import {
  changeLogCreateSchema,
  changeLogDeleteSchema,
  changeLogPatchSchema,
  changeLogQuerySchema,
  changelogImportApplySchema,
  changelogImportPreviewSchema,
  changelogImportVerifySchema,
} from './schemas.js';

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new ValidationError(result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  return result.data;
}

const archivedWorkspaceQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) })
  .strict();

/** 活动日志：挂载点已带 `:workspaceId`，需 mergeParams 读取 */
export function createChangelogRouter(db: Db): Router {
  const router = Router({ mergeParams: true });

  const requireWorkspace = (raw: unknown): string => {
    const workspaceId = String(raw ?? '');
    if (workspaceId === '' || !getWorkspace(db, workspaceId)) throw new NotFoundError('工作空间不存在');
    return workspaceId;
  };

  router.get('/', (req, res) => {
    const workspaceId = requireWorkspace((req.params as Record<string, string>).workspaceId);
    const query = parse(changeLogQuerySchema, req.query);
    res.json(listActiveChangeLogs(db, workspaceId, query));
  });

  router.post('/', (req, res) => {
    const workspaceId = requireWorkspace((req.params as Record<string, string>).workspaceId);
    const body = parse(changeLogCreateSchema, req.body);
    // N4-03：--issue 归属必须真实存在且属于本工作区，避免写出不会过 done 门禁的「幽灵归属」
    if (body.issue_id !== undefined && getIssue(db, body.issue_id, workspaceId) === null) {
      throw new ValidationError(
        `issue_id ${body.issue_id} 不存在或不属于本工作区；请先用 kb show <id> 确认任务 id，或省略 --issue 写无归属日志。`,
      );
    }
    const workspace = getWorkspace(db, workspaceId)!;
    const { result } = httpMutation(db, req, () => createChangeLog(db, workspace, body));
    res.status(201).json(result);
  });

  // ---- 旧 CHANGELOG 导入（LOG02 新增端点；必须注册在 `/:id` 之前）----
  router.post('/import/preview', (req, res) => {
    const workspaceId = requireWorkspace((req.params as Record<string, string>).workspaceId);
    const body = parse(changelogImportPreviewSchema, req.body);
    res.json(previewLegacyChangelog(db, { workspace_id: workspaceId, source_path: body.source_path }));
  });

  router.post('/import/apply', (req, res) => {
    const workspaceId = requireWorkspace((req.params as Record<string, string>).workspaceId);
    const body = parse(changelogImportApplySchema, req.body);
    const { result } = httpMutation(db, req, () =>
      applyLegacyChangelog(db, {
        workspace_id: workspaceId,
        source_path: body.source_path,
        preview_sha256: body.preview_sha256,
        actor: body.actor,
      }),
    );
    res.json(result);
  });

  router.post('/import/verify-retire', (req, res) => {
    const workspaceId = requireWorkspace((req.params as Record<string, string>).workspaceId);
    const body = parse(changelogImportVerifySchema, req.body);
    // 只读：仅返回结论，不删除/移动/改写源文件
    res.json(verifyLegacyChangelogRetire(db, { workspace_id: workspaceId, source_path: body.source_path }));
  });

  router.get('/:id', (req, res) => {
    const workspaceId = requireWorkspace((req.params as Record<string, string>).workspaceId);
    const log = getActiveChangeLog(db, workspaceId, req.params.id!);
    if (!log) throw new ApiError(404, 'CHANGELOG_NOT_FOUND', '变更日志不存在');
    res.json(log);
  });

  router.patch('/:id', (req, res) => {
    const workspaceId = requireWorkspace((req.params as Record<string, string>).workspaceId);
    const body = parse(changeLogPatchSchema, req.body);
    const { expected_revision, actor, ...patch } = body;
    const { result } = httpMutation(db, req, () => patchChangeLog(db, { workspace_id: workspaceId, id: req.params.id!, expected_revision, actor, patch }));
    res.json(result);
  });

  router.delete('/:id', (req, res) => {
    const workspaceId = requireWorkspace((req.params as Record<string, string>).workspaceId);
    const body = parse(changeLogDeleteSchema, req.body);
    httpMutation(db, req, () => {
      deleteChangeLog(db, { workspace_id: workspaceId, id: req.params.id!, expected_revision: body.expected_revision });
      return { deleted: true, id: req.params.id };
    });
    res.status(204).end();
  });

  return router;
}

/** 归档日志：只读，仅按不可变 origin_workspace_id 查询 */
export function createArchivedChangelogRouter(db: Db): Router {
  const router = Router();

  router.get('/archived-workspaces', (req, res) => {
    const { limit, offset } = parse(archivedWorkspaceQuery, req.query);
    res.json(listArchivedWorkspaces(db, limit, offset));
  });

  router.get('/archived-workspaces/:originWorkspaceId/entries', (req, res) => {
    const query = parse(changeLogQuerySchema, req.query);
    res.json(listArchivedChangeLogs(db, req.params.originWorkspaceId!, query));
  });

  router.get('/archived-workspaces/:originWorkspaceId/entries/:id', (req, res) => {
    const log = getArchivedChangeLog(db, req.params.originWorkspaceId!, req.params.id!);
    if (!log) throw new ApiError(404, 'CHANGELOG_NOT_FOUND', '变更日志不存在');
    res.json(log);
  });

  return router;
}
