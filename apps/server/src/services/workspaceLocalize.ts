/**
 * STORE-2（M2a）第一步：`enable` 的前置检查（只读）、`--dry-run` 统计与状态文件。
 *
 * 本文件当前只负责「搬数据之前」的部分，刻意不碰中心库：
 * - `preflightLocalize()`：六条硬拒绝（设计 §6.2），**全部只读**，失败即停、不动任何数据；
 * - `dryRunLocalize()`：统计该工作区将要搬的行数/附件数/预计字节，**不产生文件、不改中心库**（验收 1）；
 * - `localize.json`：每阶段前落盘的中间态（`migration_id / workspace_id / stage / center_db / backup_path / started_at / counts / last_error`）。
 *
 * 后续阶段（backup/create/copy/copy_attachments/verify/switch/finalize）在 M2a 里继续补；
 * 切换读写的判定见卡评论 `b1e03bf1`（七条全成立才允许翻 `openWorkspaceDbs`）。
 */
import { accessSync, constants, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { statfs } from 'node:fs/promises';
import type { Db } from '../db/connection.js';
import { ApiError } from '../errors.js';
import { WORKSPACE_LOCALIZE_STAGES } from '@agentboard/shared';
import { DB_MIGRATION_SPACE_MARGIN, listFilesRecursive } from './dbMigration.js';
import { workspaceStateDir } from '../db/resolver.js';

/** 固定阶段顺序（设计 §6.3）；词表唯一来源 packages/shared（2b CLI 同源） */
export const LOCALIZE_STAGES = WORKSPACE_LOCALIZE_STAGES;
export type LocalizeStage = (typeof LOCALIZE_STAGES)[number];

export interface LocalizeState {
  migration_id: string;
  workspace_id: string;
  stage: LocalizeStage;
  center_db: string;
  backup_path: string | null;
  started_at: number;
  counts: Record<string, number>;
  last_error: string | null;
}

export function localizeStatePath(workspacePath: string): string {
  return join(workspaceStateDir(workspacePath), 'localize.json');
}

export function readLocalizeState(workspacePath: string): LocalizeState | null {
  try {
    const parsed = JSON.parse(readFileSync(localizeStatePath(workspacePath), 'utf8')) as Partial<LocalizeState>;
    if (typeof parsed.migration_id !== 'string' || typeof parsed.workspace_id !== 'string' || typeof parsed.stage !== 'string') return null;
    return parsed as LocalizeState;
  } catch {
    return null;
  }
}

export function writeLocalizeState(workspacePath: string, state: LocalizeState): void {
  mkdirSync(workspaceStateDir(workspacePath), { recursive: true });
  writeFileSync(localizeStatePath(workspacePath), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function clearLocalizeState(workspacePath: string): void {
  rmSync(localizeStatePath(workspacePath), { force: true });
}

/** 六条硬拒绝的错误码（设计 §6.2）；STORE-3a 追加 resume 专用两条 */
export const LOCALIZE_PREFLIGHT_ERRORS = {
  WORKSPACE_PATH_NOT_LOCAL: { status: 409, message: '工作区目录不在本机磁盘（网络盘/可移动盘不支持下沉）' },
  MIGRATION_BUSY: { status: 409, message: '已有迁移在进行中（同一时间只允许一个）' },
  TARGET_DB_EXISTS: { status: 409, message: '目标库已存在；确认重来请带 --overwrite' },
  INSUFFICIENT_SPACE: { status: 409, message: '目标磁盘空间不足（需 ≥ 数据 + 附件 的 1.2 倍）' },
  CENTER_DB_UNHEALTHY: { status: 500, message: '中心库完整性检查未通过，已停止（未动任何数据）' },
  WORKSPACE_BUSY: { status: 409, message: '该工作区有运行中的会话，请先结束后再迁移' },
  WORKSPACE_NOT_FOUND: { status: 404, message: '工作空间不存在' },
  ALREADY_LOCALIZED: { status: 409, message: '该工作区已下沉（db_mode=localized），无需再次 enable' },
  /** STORE-3a：resume 但没有 localize.json（无可恢复中间态） */
  NO_LOCALIZE_STATE: { status: 409, message: '没有可恢复的迁移中间态（localize.json 不存在）；全新迁移请去掉 resume' },
  /** STORE-3a：localize.json 存在但不属于该工作区/中心库，或 stage 不在词表 */
  LOCALIZE_STATE_INVALID: { status: 409, message: 'localize.json 与当前工作区/中心库不一致或阶段非法，请执行 cleanup 后重来' },
} as const;

export type LocalizeErrorCode = keyof typeof LOCALIZE_PREFLIGHT_ERRORS;

export function localizeError(code: LocalizeErrorCode, detail?: string, status?: number): ApiError {
  const spec = LOCALIZE_PREFLIGHT_ERRORS[code];
  return new ApiError(status ?? spec.status, code, detail === undefined || detail === '' ? spec.message : `${spec.message}：${detail}`);
}

/** 该工作区需要搬迁的行数与字节（dry-run 与 preflight 的空间判断共用） */
export interface LocalizeCounts {
  issue: number;
  issue_comment: number;
  session: number;
  message: number;
  issue_dependency: number;
  issue_git_baseline: number;
  issue_draft_audit: number;
  attachment: number;
  knowledge_page: number;
  knowledge_revision: number;
  knowledge_link: number;
  knowledge_attachment: number;
  change_log: number;
  rows_total: number;
  attachment_files: number;
  attachment_bytes: number;
  db_bytes: number;
  estimated_bytes: number;
}

/**
 * 统计该工作区将搬的数据量（**只读**：不建目录、不写文件、不改中心库）。
 * 表名与列名都取自 schema 现状；数量用 COUNT(*)，附件只走文件系统 stat。
 */
export function countWorkspacePayload(
  centerDb: Db,
  workspace: { id: string; path: string },
  deps: { attachmentsDir?: string } = {},
): LocalizeCounts {
  const count = (sql: string, ...params: unknown[]): number => Number((centerDb.prepare(sql).get(...params) as { n: number }).n);
  const scoped = count('SELECT COUNT(*) AS n FROM issue WHERE workspace_id = ?', workspace.id);
  const counts: Omit<LocalizeCounts, 'rows_total' | 'attachment_files' | 'attachment_bytes' | 'db_bytes' | 'estimated_bytes'> = {
    issue: scoped,
    issue_comment: count('SELECT COUNT(*) AS n FROM issue_comment c JOIN issue i ON i.id = c.issue_id WHERE i.workspace_id = ?', workspace.id),
    session: count('SELECT COUNT(*) AS n FROM session WHERE workspace_id = ?', workspace.id),
    message: count('SELECT COUNT(*) AS n FROM message m JOIN session s ON s.id = m.session_id WHERE s.workspace_id = ?', workspace.id),
    issue_dependency: count('SELECT COUNT(*) AS n FROM issue_dependency d JOIN issue i ON i.id = d.blocked_issue_id WHERE i.workspace_id = ?', workspace.id),
    issue_git_baseline: count('SELECT COUNT(*) AS n FROM issue_git_baseline b JOIN issue i ON i.id = b.issue_id WHERE i.workspace_id = ?', workspace.id),
    issue_draft_audit: count('SELECT COUNT(*) AS n FROM issue_draft_audit WHERE workspace_id = ?', workspace.id),
    attachment: count('SELECT COUNT(*) AS n FROM attachment WHERE workspace_id = ?', workspace.id),
    knowledge_page: count("SELECT COUNT(*) AS n FROM knowledge_page WHERE scope='workspace' AND workspace_id = ?", workspace.id),
    knowledge_revision: count("SELECT COUNT(*) AS n FROM knowledge_revision r JOIN knowledge_page p ON p.id = r.page_id WHERE p.scope='workspace' AND p.workspace_id = ?", workspace.id),
    knowledge_link: count("SELECT COUNT(*) AS n FROM knowledge_link l JOIN knowledge_page p ON p.id = l.source_page_id WHERE p.scope='workspace' AND p.workspace_id = ?", workspace.id),
    knowledge_attachment: count("SELECT COUNT(*) AS n FROM knowledge_attachment a JOIN knowledge_page p ON p.id = a.page_id WHERE p.scope='workspace' AND p.workspace_id = ?", workspace.id),
    change_log: count('SELECT COUNT(*) AS n FROM workspace_change_log WHERE origin_workspace_id = ?', workspace.id),
  };
  const attachmentsDir = deps.attachmentsDir ?? join(dirname(centerDb.name), 'attachments');
  const files = listFilesRecursive(attachmentsDir);
  const rowsTotal = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return {
    ...counts,
    rows_total: rowsTotal,
    // 附件目录是全局的（中心库目录），真实拷贝时按 attachment 表取 key 再逐个搬；这里给上界供空间判断
    attachment_files: files.length,
    attachment_bytes: files.reduce((sum, f) => sum + f.bytes, 0),
    db_bytes: safeSize(centerDb.name),
    estimated_bytes: files.reduce((sum, f) => sum + f.bytes, 0) + safeSize(centerDb.name),
  };
}

function safeSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** 本地盘判定（Windows：盘符直连；其它平台不做判断，交给 preflight 的可写探测） */
export function isLocalWorkspacePath(path: string): boolean {
  if (!isAbsolute(path)) return false;
  if (process.platform !== 'win32') return true;
  // UNC（\\server\share）与非盘符路径视为非本地
  return /^[A-Za-z]:[\\/]/.test(path);
}

export interface PreflightLocalizeInput {
  workspaceId: string;
  overwrite?: boolean;
  /** STORE-3a：resume 语义——放行 localize.json 中间态与已存在的目标库（残留由状态机先清理） */
  resume?: boolean;
  /** 测试注入 */
  freeBytes?: (dir: string) => Promise<number | null>;
  integrityCheck?: (db: Db) => string;
  /** 中心库附件目录（缺省 `<中心库目录>/attachments`） */
  attachmentsDir?: string;
}

/**
 * 六条硬拒绝（全部只读）。返回统计与将要创建的目标路径；任一不满足直接抛固定错误码。
 * 注意：**不创建目录、不写文件、不改中心库**——真正的 backup/create 在后续阶段。
 */
export async function preflightLocalize(centerDb: Db, input: PreflightLocalizeInput): Promise<{ workspace: { id: string; path: string }; counts: LocalizeCounts; targetDbPath: string }> {
  const workspace = centerDb.prepare('SELECT id, path, db_mode FROM workspace WHERE id = ?').get(input.workspaceId) as { id: string; path: string; db_mode?: string | null } | undefined;
  if (workspace === undefined) throw localizeError('WORKSPACE_NOT_FOUND');
  if ((workspace.db_mode ?? 'center') === 'localized') throw localizeError('ALREADY_LOCALIZED');

  if (!isLocalWorkspacePath(workspace.path)) throw localizeError('WORKSPACE_PATH_NOT_LOCAL', workspace.path);
  // 已有中间态（localize.json）→ 视为迁移进行中（同一时间只允许一个）；resume 语义放行（残留由状态机清理）
  if (input.resume !== true && readLocalizeState(workspace.path) !== null) throw localizeError('MIGRATION_BUSY', localizeStatePath(workspace.path));

  const targetDbPath = join(workspaceStateDir(workspace.path), 'agentboard.db');
  if (input.resume !== true && existsSyncSafe(targetDbPath) && input.overwrite !== true) throw localizeError('TARGET_DB_EXISTS', targetDbPath);

  const integrity = (input.integrityCheck ?? defaultIntegrityCheck)(centerDb);
  if (integrity !== 'ok') throw localizeError('CENTER_DB_UNHEALTHY', integrity);

  const busy = Number((centerDb.prepare("SELECT COUNT(*) AS n FROM session WHERE workspace_id = ? AND status = '运行中'").get(workspace.id) as { n: number }).n);
  if (busy > 0) throw localizeError('WORKSPACE_BUSY', `${busy} 个会话运行中`);

  const counts = countWorkspacePayload(centerDb, workspace, input.attachmentsDir === undefined ? {} : { attachmentsDir: input.attachmentsDir });
  const need = Math.ceil(counts.estimated_bytes * DB_MIGRATION_SPACE_MARGIN);
  const free = await (input.freeBytes ?? defaultFreeBytes)(dirname(targetDbPath));
  if (free !== null && free < need) throw localizeError('INSUFFICIENT_SPACE', `剩余 ${free} 字节，需 ${need} 字节`);
  // 目录可写探测（只写一个临时文件再删；不产生库文件）
  try {
    mkdirSync(workspaceStateDir(workspace.path), { recursive: true });
    accessSync(workspaceStateDir(workspace.path), constants.W_OK);
  } catch (error) {
    throw localizeError('INSUFFICIENT_SPACE', `目标目录不可写（${error instanceof Error ? error.message : String(error)}）`);
  }
  return { workspace: { id: workspace.id, path: workspace.path }, counts, targetDbPath };
}

function existsSyncSafe(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function defaultIntegrityCheck(db: Db): string {
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check?: string }>;
    const first = rows[0]?.integrity_check ?? 'unknown';
    return String(first).toLowerCase() === 'ok' ? 'ok' : String(first);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function defaultFreeBytes(dir: string): Promise<number | null> {
  try {
    const stats = await statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/** `--dry-run`：只统计并回报，不产生任何文件、不改中心库（验收 1） */
export async function dryRunLocalize(centerDb: Db, input: PreflightLocalizeInput): Promise<{ counts: LocalizeCounts; targetDbPath: string }> {
  const before = safeSize(centerDb.name);
  const preflight = await preflightLocalize(centerDb, input);
  if (safeSize(centerDb.name) !== before) throw new ApiError(500, 'LOCALIZE_DRYRUN_DIRTY', 'dry-run 不应改动中心库，但中心库大小发生变化，已中止');
  return { counts: preflight.counts, targetDbPath: preflight.targetDbPath };
}
