/**
 * STATUS-2：工作区状态字典的 REST 通道（设计 §3.2 / D3）。
 *
 * 路径挂在 `/api/workspaces/:workspaceId/statuses`（与 `/workspaces/:workspaceId/changelog` 同款嵌套），
 * 路径参数即工作区身份；body 里再给 `workspace_id` 时只用于一致性校验（不一致 → 400），不另立口径。
 *
 * | 方法 | 路径 | 语义 |
 * |---|---|---|
 * | GET | `/statuses` | 该工作区状态列表（sort_order 升序） |
 * | POST | `/statuses` | 新增自定义状态（body: name, kind, sort_order?）；重名 409 |
 * | DELETE | `/statuses/:statusId?migrate_to=<name>` | 删自定义状态；缺 migrate_to → 400；内置 → 409 |
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/connection.js';
import { getWorkspace } from '../db/repos/workspace.js';
import { NotFoundError, ValidationError } from '../errors.js';
import {
  STATUS_KINDS,
  createWorkspaceStatus,
  listWorkspaceStatuses,
  removeWorkspaceStatus,
} from '../services/workspaceStatus.js';

const createStatusSchema = z.object({
  name: z.string().trim().min(1, '状态名不能为空').max(50),
  kind: z.enum(STATUS_KINDS),
  sort_order: z.number().int().optional(),
  workspace_id: z.string().trim().min(1).optional(),
}).strict();

const deleteQuerySchema = z.object({
  migrate_to: z.string().trim().min(1).optional(),
  workspace_id: z.string().trim().min(1).optional(),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '));
  }
  return parsed.data;
}

/** 路径参数工作区必须存在；body/query 若另给 workspace_id，必须与路径一致 */
function requireWorkspace(db: Db, workspaceId: string, declared?: string): string {
  if (declared !== undefined && declared !== workspaceId) throw new ValidationError('workspace_id 与路径不一致');
  if (!getWorkspace(db, workspaceId)) throw new NotFoundError('工作空间不存在');
  return workspaceId;
}

/**
 * KB-CLI-4（CLI-20）：多工作区状态字典聚合 —— `GET /api/statuses?workspace_ids=a,b,c`。
 * 一次取回全部工作区的字典，CLI 的 `list-tasks --all` 因此从「每区一次」收敛到「一次」。
 * 契约：`{ items: [{ workspace_id, statuses: WorkspaceStatus[] }] }`，顺序与入参一致；未知工作区 404。
 */
export function createStatusesAggregateRouter(db: Db): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const raw = typeof req.query.workspace_ids === 'string' ? req.query.workspace_ids : '';
    const ids = raw.split(',').map(item => item.trim()).filter(item => item !== '');
    if (ids.length === 0) throw new ValidationError('需要 workspace_ids=<id,id,…>（逗号分隔，至少一个）');
    if (ids.length > 200) throw new ValidationError('workspace_ids 一次最多 200 个工作区');
    if (new Set(ids).size !== ids.length) throw new ValidationError('workspace_ids 有重复项');
    const items = ids.map((workspaceId) => {
      requireWorkspace(db, workspaceId, undefined);
      return { workspace_id: workspaceId, statuses: listWorkspaceStatuses(db, workspaceId) };
    });
    res.json({ items });
  });

  return router;
}

export function createWorkspaceStatusRouter(db: Db): Router {
  const router = Router({ mergeParams: true });

  router.get('/', (req, res) => {
    const workspaceId = requireWorkspace(db, String((req.params as Record<string, string>).workspaceId), typeof req.query.workspace_id === 'string' ? req.query.workspace_id : undefined);
    res.json(listWorkspaceStatuses(db, workspaceId));
  });

  router.post('/', (req, res) => {
    const body = parseBody(createStatusSchema, req.body);
    const workspaceId = requireWorkspace(db, String((req.params as Record<string, string>).workspaceId), body.workspace_id);
    const created = createWorkspaceStatus(db, {
      workspace_id: workspaceId,
      name: body.name,
      kind: body.kind,
      sort_order: body.sort_order,
    });
    res.status(201).json(created);
  });

  router.delete('/:statusId', (req, res) => {
    const query = parseBody(deleteQuerySchema, req.query);
    const workspaceId = requireWorkspace(db, String((req.params as Record<string, string>).workspaceId), query.workspace_id);
    res.json(removeWorkspaceStatus(db, {
      workspace_id: workspaceId,
      status_id: String((req.params as Record<string, string>).statusId),
      migrate_to: query.migrate_to,
    }));
  });

  return router;
}
