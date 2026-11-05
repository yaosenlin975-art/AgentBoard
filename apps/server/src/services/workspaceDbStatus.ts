/**
 * STORE-3a：`GET /api/workspaces/:id/db` 的只读状态汇总。
 *
 * 回答四个问题（不写任何数据、不打开可变句柄）：
 * - 数据现在在哪：db_mode（中心期望）+ 解析层判定（disabled 紧急开关含在内）+ 数据归属侧的行数/附件；
 * - 闸门是否冻结：writeGate=frozen 表示该区写请求当前 409 WORKSPACE_DB_MIGRATING；
 * - 迁移中间态：localize.json 的 stage / last_error / backup_path（resume 依据、goal5 恢复指向）；
 * - 分叉有多大：snapshotLagRows = Σ max(0, 中心−工作区库)，已下沉后中心又被写入时 >0（revert 前必看）。
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from '../db/connection.js';
import { NotFoundError } from '../errors.js';
import { decideWorkspaceDb, isWorkspaceDbDisabled, readWorkspaceMeta, workspaceDbPath, workspaceStateDir } from '../db/resolver.js';
import { readLocalizeState } from './workspaceLocalize.js';
import { WORKSPACE_TABLE_QUERIES, centerRevertBlockingRows, collectWorkspaceAttachmentKeys, countScopedRowsByTable } from './workspaceLocalizeRun.js';
import type { WorkspaceDbStatusView } from '@agentboard/shared';

export interface WorkspaceDbStatusDeps {
  /** 中心库路径（路由层传入；缺省用 centerDb.name） */
  centerDbPath?: string;
  /** 中心库附件目录（缺省 `<中心库目录>/attachments`） */
  attachmentsDir?: string;
  /** AGENTBOARD_WORKSPACE_DB=disabled 是否生效（缺省读进程 env） */
  disabled?: boolean;
  /** 本进程该工作区的活动任务（job 注册表回填） */
  activeJob?: WorkspaceDbStatusView['activeJob'];
}

export function buildWorkspaceDbStatus(centerDb: Db, input: { workspaceId: string }, deps: WorkspaceDbStatusDeps = {}): WorkspaceDbStatusView {
  const row = centerDb.prepare('SELECT id, path, db_mode FROM workspace WHERE id = ?').get(input.workspaceId) as { id: string; path: string; db_mode?: string | null } | undefined;
  if (row === undefined) throw new NotFoundError('工作空间不存在');
  const mode = row.db_mode === 'localizing' || row.db_mode === 'localized' || row.db_mode === 'failed' ? row.db_mode : 'center';
  const centerDbPath = deps.centerDbPath ?? centerDb.name;
  const disabled = deps.disabled ?? isWorkspaceDbDisabled();
  const decision = decideWorkspaceDb({
    workspaceId: row.id,
    workspacePath: row.path,
    centerDbMode: mode,
    centerDbPath,
    ...(disabled ? { disabled: true } : {}),
  });

  const wsDbPath = workspaceDbPath(row.path);
  const wsDbExists = existsSync(wsDbPath);
  const wsMeta = wsDbExists ? readWorkspaceMeta(wsDbPath) : null;
  // 数据归属：工作区库可打开且自洽（localized=1 + id 一致）→ 工作区库，否则中心库
  const ownerIsWorkspace = wsMeta !== null && wsMeta.localized && wsMeta.workspaceId === row.id;
  const ownerAttachmentsDir = ownerIsWorkspace
    ? join(workspaceStateDir(row.path), 'attachments')
    : deps.attachmentsDir ?? join(dirname(centerDbPath), 'attachments');

  let counts: Record<string, number> = {};
  let attachmentRows = 0;
  let attachmentFiles = 0;
  let attachmentBytes = 0;
  let snapshotLagRows: number | null = null;

  const ownerDb: Db | null = ownerIsWorkspace ? openReadonly(wsDbPath) : centerDb;
  try {
    if (ownerDb !== null) {
      const byTable = countScopedRowsByTable(ownerDb, row.id);
      counts = { ...byTable, rows_total: Object.values(byTable).reduce((sum, n) => sum + n, 0) };
      attachmentRows = counts.attachment ?? 0;
      for (const key of collectWorkspaceAttachmentKeys(ownerDb, row.id)) {
        try {
          attachmentBytes += statSync(join(ownerAttachmentsDir, key)).size;
          attachmentFiles += 1;
        } catch { /* 库里有行但文件缺失：files 只计实际存在的 */ }
      }
    }
  } finally {
    if (ownerIsWorkspace && ownerDb !== null) {
      try { ownerDb.close(); } catch { /* 忽略 */ }
    }
  }

  // 快照落后（分模式）：localized = revert 阻断行数（排除可派生的 workspace_status，与 revert 前置同口径）；
  // 其余 = Σ max(0, 中心−工作区库)（快照未拷齐的部分）
  if (wsMeta !== null) {
    const wsDb = openReadonly(wsDbPath);
    if (wsDb !== null) {
      try {
        if (mode === 'localized') {
          snapshotLagRows = centerRevertBlockingRows(centerDb, row.id);
        } else {
          const centerCounts = countScopedRowsByTable(centerDb, row.id);
          const wsCounts = countScopedRowsByTable(wsDb, row.id);
          snapshotLagRows = WORKSPACE_TABLE_QUERIES.reduce((sum, query) => sum + Math.max(0, (centerCounts[query.table] ?? 0) - (wsCounts[query.table] ?? 0)), 0);
        }
      } finally {
        try { wsDb.close(); } catch { /* 忽略 */ }
      }
    }
  }

  const state = readLocalizeState(row.path);
  return {
    workspaceId: row.id,
    dbMode: mode,
    writeGate: decision.error === 'WORKSPACE_DB_MIGRATING' ? 'frozen' : 'open',
    disabled,
    needsRevert: disabled && mode === 'localized',
    centerDbPath,
    workspaceDbPath: wsDbPath,
    workspaceDbExists: wsDbExists,
    effectiveDbPath: decision.dbPath,
    counts,
    attachments: { rows: attachmentRows, files: attachmentFiles, bytes: attachmentBytes, dir: ownerAttachmentsDir },
    snapshotLagRows,
    localizeState: state === null ? null : {
      migrationId: state.migration_id,
      stage: state.stage,
      lastError: state.last_error,
      backupPath: state.backup_path,
      startedAt: state.started_at,
    },
    activeJob: deps.activeJob ?? null,
    error: decision.error,
    reason: decision.reason,
  };
}

function openReadonly(dbPath: string): Db | null {
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}
