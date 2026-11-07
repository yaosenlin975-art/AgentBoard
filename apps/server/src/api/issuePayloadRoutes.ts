/**
 * PERF-4a：`/api/issues` 传输契约收敛（设计页 knowledge:1eecf12c-0eba-44be-97d0-9f6aca5752d7）。
 *
 * | 变更 | 语义 |
 * |---|---|
 * | `fields=` 白名单 | 只返回所列字段，并跳过未被请求的正文/评论数/依赖聚合/决策投影 |
 * | `GET /api/issues/counts?workspace_ids=a,b` | 一次取回多工作区的各状态计数，替代面板逐区全量拉取 |
 * | 回滚开关 `AGENTBOARD_ISSUES_V2=off\|0` | 忽略 `fields=`，counts 返回 404，退回旧契约 |
 *
 * 开关按请求读取（不是模块常量），这样同一进程内可用单测证明「关掉后行为真的退回旧契约」。
 */
import { Router } from 'express';
import type { Db } from '../db/connection.js';
import { getWorkspace } from '../db/repos/workspace.js';
import {
  ISSUE_FIELD_NAMES,
  countIssuesByStatus,
  isIssueFieldName,
  type IssueFieldName,
  type WorkspaceIssueCounts,
} from '../db/repos/issue.js';
import { NotFoundError, ValidationError } from '../errors.js';

export const ISSUES_V2_ENV = 'AGENTBOARD_ISSUES_V2';
export const MAX_COUNT_WORKSPACES = 50;

export function issuesV2Enabled(): boolean {
  const value = process.env[ISSUES_V2_ENV]?.trim().toLowerCase();
  return value !== 'off' && value !== '0';
}

/** 解析 `fields=`；开关关闭或未传 → undefined（走旧完整字段契约） */
export function parseIssueFields(raw: string | undefined): IssueFieldName[] | undefined {
  if (!issuesV2Enabled() || raw === undefined) return undefined;
  const names = raw.split(',').map(item => item.trim()).filter(item => item !== '');
  const allowed = ISSUE_FIELD_NAMES.join(' / ');
  if (names.length === 0) throw new ValidationError(`fields 需要至少一个字段名；可用值：${allowed}`);
  const unknown = names.filter(name => !isIssueFieldName(name));
  if (unknown.length > 0) throw new ValidationError(`fields 含未知字段：${unknown.join(' / ')}；可用值：${allowed}`);
  return [...new Set(names)] as IssueFieldName[];
}

function requireWorkspace(db: Db, workspaceId: string): void {
  if (!getWorkspace(db, workspaceId)) throw new NotFoundError('工作空间不存在');
}

/** 逗号串与重复参数两种写法都认；去重前后长度不等按重复项报 400（与 /statuses 聚合同口径） */
function parseWorkspaceIds(raw: unknown): string[] {
  const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join(',') : '';
  const ids = text.split(',').map(item => item.trim()).filter(item => item !== '');
  if (ids.length === 0) throw new ValidationError('需要 workspace_ids=<id,id,…>（逗号分隔，至少一个）');
  if (ids.length > MAX_COUNT_WORKSPACES) throw new ValidationError(`workspace_ids 一次最多 ${MAX_COUNT_WORKSPACES} 个工作区`);
  if (new Set(ids).size !== ids.length) throw new ValidationError('workspace_ids 有重复项');
  return ids;
}

export interface IssueCountsRouterDeps {
  /** 中心库：工作区注册与存在性校验的权威 */
  db: Db;
  /** 工作区 → 该工作区当前库（未下沉即中心库），按库分组聚合，不跨库拼 SQL */
  dbForWorkspace: (workspaceId: string) => Db;
}

export function createIssueCountsRouter(deps: IssueCountsRouterDeps): Router {
  const router = Router();

  router.get('/', (req, res) => {
    if (!issuesV2Enabled()) throw new NotFoundError('接口不存在: GET /issues/counts');
    const ids = parseWorkspaceIds(req.query.workspace_ids);
    const groups = new Map<Db, string[]>();
    for (const id of ids) {
      requireWorkspace(deps.db, id);
      const workspaceDb = deps.dbForWorkspace(id);
      const list = groups.get(workspaceDb);
      if (list === undefined) groups.set(workspaceDb, [id]);
      else list.push(id);
    }
    const counts = new Map<string, WorkspaceIssueCounts>();
    for (const [workspaceDb, workspaceIds] of groups) {
      for (const item of countIssuesByStatus(workspaceDb, workspaceIds)) counts.set(item.workspace_id, item);
    }
    // 顺序与入参一致；无卡工作区也返回 total=0，客户端不必区分缺省
    res.json({ items: ids.map(id => counts.get(id) ?? { workspace_id: id, total: 0, counts: {} }) });
  });

  return router;
}
