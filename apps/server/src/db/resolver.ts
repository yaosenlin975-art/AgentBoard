/**
 * STORE-1（M1）：按工作区选库的**解析层与判定**。
 *
 * 本阶段只做「这个请求该用哪个库」的纯逻辑与门禁，**不建库、不搬数据、不改业务数据**：
 * - 检测在服务端做（设计 §5.1 补充约束），`GET /api/workspaces` 只回显结果；
 * - 未下沉时行为与现状完全一致 → 中心库；
 * - 期望状态（中心 `workspace.db_mode`）与实际状态（文件 + 库内 `meta`）不一致时**报错收场**，不静默回退。
 *
 * 设计依据：知识页 `9548444c-3356-4af6-9221-7581dd2b2063` §5.1–§5.4。
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from './connection.js';
import { openDb } from './connection.js';
import { acquireServerLock, describeLockHolder, releaseServerLock } from '../services/serverLock.js';
import { ApiError } from '../errors.js';

/** 中心库 workspace 行的期望状态（设计 §5.1 状态机） */
export type WorkspaceDbMode = 'center' | 'localizing' | 'localized' | 'failed';

export const WORKSPACE_DB_MODES: readonly WorkspaceDbMode[] = ['center', 'localizing', 'localized', 'failed'];

/**
 * 判定错误码与 HTTP 语义（设计 §5.1 表）。
 * `MIGRATING` 是 409：读继续走中心库，写被阻断；另外两条是「不可打开」。
 */
export const WORKSPACE_DB_ERRORS = {
  WORKSPACE_DB_MIGRATING: { status: 409, message: '该工作区数据库正在迁移（中间态），暂不接受写入；请等迁移完成或执行恢复流程' },
  WORKSPACE_DB_MISSING: { status: 500, message: '中心库标记该工作区已下沉，但工作区库文件缺失；不回退中心库，请检查或恢复该文件' },
  WORKSPACE_DB_UNREADABLE: { status: 500, message: '工作区库文件存在但打不开（损坏或非 SQLite 文件）；不回退中心库，请检查或恢复该文件' },
  WORKSPACE_DB_ID_MISMATCH: { status: 409, message: '工作区库内的 workspace_id 与目录绑定不一致（可能拷了别人的 .agentboard），拒绝打开' },
  WORKSPACE_DB_LOCKED: { status: 409, message: '该工作区库已被另一个活实例打开（一个工作区库同时只允许一个进程）' },
} as const;

export type WorkspaceDbErrorCode = keyof typeof WORKSPACE_DB_ERRORS;

/** 工作区库与锁的固定位置（设计 §5.1 / §5.4） */
export function workspaceStateDir(workspacePath: string): string {
  return join(workspacePath, '.agentboard');
}

export function workspaceDbPath(workspacePath: string): string {
  return join(workspaceStateDir(workspacePath), 'agentboard.db');
}

/** 工作区库内 `meta` 的只读快照（`null` = 打不开或没有该表） */
export interface WorkspaceDbMeta {
  localized: boolean;
  workspaceId: string | null;
}

export interface DecideWorkspaceDbInput {
  workspaceId: string;
  workspacePath: string;
  /** 中心 `workspace.db_mode`（缺省/老数据按 center） */
  centerDbMode: WorkspaceDbMode;
  centerDbPath: string;
  /** 文件存在性探测（缺省走 fs；测试注入） */
  fileExists?: (path: string) => boolean;
  /** 读工作区库 meta（缺省真实只读打开；测试注入） */
  readMeta?: (dbPath: string) => WorkspaceDbMeta | null;
}

export interface WorkspaceDbDecision {
  /** 本次请求该用哪个库 */
  target: 'center' | 'workspace';
  dbPath: string;
  /** 非 null 表示这一档必须报错（写入阻断 / 不可打开） */
  error: WorkspaceDbErrorCode | null;
  /** 日志与 `/api/version` 用的一句话依据 */
  reason: string;
}

const defaultFileExists = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * 纯判定：把「中心期望 + 文件实际」映射到「用哪个库 / 是否报错」。
 * 判定顺序：中心 localizing/failed → 迁移态（读中心库、写阻断，绝不打开工作区库）；
 * 中心说已下沉但文件没了 → 缺失；文件在但打不开 → UNREADABLE（不静默回退中心库）；
 * 未下沉 → 中间态；id 不一致/缺失 → 拒绝打开；`meta.localized=1` 且自洽 → 用工作区库；无文件 → 中心库（现状）。
 */
export function decideWorkspaceDb(input: DecideWorkspaceDbInput): WorkspaceDbDecision {
  const targetPath = workspaceDbPath(input.workspacePath);
  const fileExists = input.fileExists ?? defaultFileExists;
  const readMeta = input.readMeta ?? readWorkspaceMeta;
  const exists = fileExists(targetPath);

  // STORE-2a（D4）：中心 failed = 迁移失败待恢复，库内容未定——meta.localized=1 也不放行工作区库
  if (input.centerDbMode === 'failed') {
    return { target: 'center', dbPath: input.centerDbPath, error: 'WORKSPACE_DB_MIGRATING', reason: '中心 db_mode=failed（迁移失败待恢复）：读走中心库、写被阻断，不打开工作区库' };
  }
  // STORE-2a：中心 localizing = 迁移进行中。目标库没建好时也必须冻结该区写
  //（copy/switch 之间的中心写入会在切换时丢），读继续走中心库（switch 前中心行仍在）。
  if (input.centerDbMode === 'localizing') {
    return { target: 'center', dbPath: input.centerDbPath, error: 'WORKSPACE_DB_MIGRATING', reason: '中心 db_mode=localizing（迁移进行中）：读走中心库、写被阻断' };
  }
  if (input.centerDbMode === 'localized' && !exists) {
    return { target: 'center', dbPath: input.centerDbPath, error: 'WORKSPACE_DB_MISSING', reason: '中心=localized 但工作区库文件不存在（不回退中心库）' };
  }
  if (!exists) {
    return { target: 'center', dbPath: input.centerDbPath, error: null, reason: `未下沉（无 .agentboard/agentboard.db，中心 db_mode=${input.centerDbMode}）` };
  }
  const meta = readMeta(targetPath);
  if (meta === null) {
    // STORE-2a（D3）：打不开 ≠ 迁移中间态。损坏库报 UNREADABLE；getDbForWorkspace 对非
    // MIGRATING 错误直接抛——读路径不得静默回退中心库（中心数据可能已过期或缺失）。
    return { target: 'center', dbPath: input.centerDbPath, error: 'WORKSPACE_DB_UNREADABLE', reason: '工作区库存在但打不开（损坏或非 SQLite 文件）：不回退中心库，请修复或恢复该文件' };
  }
  if (!meta.localized) {
    return { target: 'center', dbPath: input.centerDbPath, error: 'WORKSPACE_DB_MIGRATING', reason: 'meta.localized=0（迁移中间态：读走中心库、写被阻断）' };
  }
  // STORE-2a（D5）：放行前先判定自洽——库内 workspace_id 缺失（null）与不一致同等处理，
  // 身份不明的库（可能拷错 .agentboard）绝不打开。
  if (meta.workspaceId !== input.workspaceId) {
    return { target: 'center', dbPath: input.centerDbPath, error: 'WORKSPACE_DB_ID_MISMATCH', reason: `库内 workspace_id=${meta.workspaceId ?? '（缺失）'} 与目录工作区 ${input.workspaceId} 不一致` };
  }
  return { target: 'workspace', dbPath: targetPath, error: null, reason: `已下沉（meta.localized=1，中心 db_mode=${input.centerDbMode}）` };
}

/** 判定错误 → HTTP 错误（写入门禁与打开路径共用） */
export function workspaceDbError(code: WorkspaceDbErrorCode): ApiError {
  const spec = WORKSPACE_DB_ERRORS[code];
  return new ApiError(spec.status, code, spec.message);
}

/** 真实读取工作区库 meta（只读打开；任何失败返回 null，不抛） */
export function readWorkspaceMeta(dbPath: string): WorkspaceDbMeta | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const hasMeta = db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name='meta'").get();
    if (hasMeta === undefined) return { localized: false, workspaceId: null };
    const localized = db.prepare("SELECT value FROM meta WHERE key='localized'").get() as { value?: unknown } | undefined;
    const idRow = db.prepare("SELECT value FROM meta WHERE key='workspace_id'").get() as { value?: unknown } | undefined;
    return {
      localized: String(localized?.value ?? '0') === '1',
      workspaceId: typeof idRow?.value === 'string' ? idRow.value : null,
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* 忽略 */
    }
  }
}

/** 句柄缓存：常驻（工作区数量级个位数到几十，设计 §5.3 明确不做淘汰） */
const handles = new Map<string, Db>();
/** 已持有的每工作区锁目录（workspaceId → `.agentboard`） */
const heldLocks = new Map<string, string>();
/** STORE-2a：打开缘由（db_scope.localized_open[] 排障字段） */
export type WorkspaceDbOpenReason = 'first-write' | 'read' | 'migrate' | 'recovery';

export interface OpenWorkspaceDbInfo {
  workspaceId: string;
  dbPath: string;
  /** 打开时间（epoch ms） */
  openedAt: number;
  /** first-write=写闸门放行时首开；read=读路径首开；migrate/recovery 供迁移/恢复路径使用 */
  openReason: WorkspaceDbOpenReason;
  /** M2 只记录不回收：恒 false，字段留给后续回收策略 */
  reclaimable: boolean;
}

const handleMeta = new Map<string, { openedAt: number; reason: WorkspaceDbOpenReason }>();

export interface ResolverDeps {
  centerDb: Db;
  /**
   * M1 固定 false：**不打开工作区库**——STORE-1 只做判定与门禁，数据仍在中心库；
   * 提前打开一个还没搬数据的空库，只会让后续 SQL 撞「no such table」。STORE-2 落地搬库后翻 true。
   */
  openWorkspaceDbs?: boolean;
  /** 实例标识：每工作区锁与 `server.lock` 用同一实现（pid + instanceId + O_EXCL） */
  instanceId: string;
  port: number;
  /** 测试注入 */
  fileExists?: (path: string) => boolean;
  readMeta?: (dbPath: string) => WorkspaceDbMeta | null;
  open?: (dbPath: string) => Db;
}

export interface WorkspaceLike {
  id: string;
  path: string;
  dbMode: WorkspaceDbMode;
}

export interface WorkspaceResolution {
  db: Db;
  decision: WorkspaceDbDecision;
}

/**
 * 取某工作区该用的库：已下沉 → 打开/复用工作区库（并持有该工作区 `.agentboard/server.lock`）；
 * 否则返回中心库。**本阶段不写工作区库**（`meta` 镜像与数据搬迁属 STORE-2）。
 * `opts.openReason`：记录进 `db_scope.localized_open[]`（缺省 read；写闸门传 first-write）。
 */
export function getDbForWorkspace(deps: ResolverDeps, workspace: WorkspaceLike, opts: { openReason?: WorkspaceDbOpenReason } = {}): WorkspaceResolution {
  const decision = decideWorkspaceDb({
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    centerDbMode: workspace.dbMode,
    centerDbPath: deps.centerDb.name,
    ...(deps.fileExists !== undefined ? { fileExists: deps.fileExists } : {}),
    ...(deps.readMeta !== undefined ? { readMeta: deps.readMeta } : {}),
  });
  // 中间态：读走中心库（返回），写由 assertWorkspaceDbWritable 拦
  if (decision.error !== null && decision.error !== 'WORKSPACE_DB_MIGRATING') throw workspaceDbError(decision.error);
  if (decision.target === 'center') return { db: deps.centerDb, decision };
  // M1：判定为「已下沉」也不切库（数据未搬），返回中心库并把判定带出去
  if (deps.openWorkspaceDbs !== true) return { db: deps.centerDb, decision };

  const cached = handles.get(workspace.id);
  if (cached !== undefined) return { db: cached, decision };

  const stateDir = workspaceStateDir(workspace.path);
  const lock = acquireServerLock({ configDir: stateDir, dbPath: decision.dbPath, port: deps.port, instanceId: deps.instanceId });
  if (!lock.ok) {
    const holder = lock.holder === null ? '未知持有者' : describeLockHolder(lock.holder);
    throw new ApiError(409, 'WORKSPACE_DB_LOCKED', `${WORKSPACE_DB_ERRORS.WORKSPACE_DB_LOCKED.message}：${holder}`);
  }
  heldLocks.set(workspace.id, stateDir);
  const db = (deps.open ?? openDb)(decision.dbPath);
  handles.set(workspace.id, db);
  handleMeta.set(workspace.id, { openedAt: Date.now(), reason: opts.openReason ?? 'read' });
  return { db, decision };
}

/**
 * 写入门禁：中间态 / 缺失 / 打不开 / id 不匹配 / 被锁 一律按判定报错。
 * 返回判定（调用方需要 `target` 时用），失败即抛。
 */
export function assertWorkspaceDbWritable(deps: ResolverDeps, workspace: WorkspaceLike): WorkspaceDbDecision {
  const { decision } = getDbForWorkspace(deps, workspace, { openReason: 'first-write' });
  if (decision.error !== null) throw workspaceDbError(decision.error);
  return decision;
}

/** 关闭所有工作区库句柄并释放锁（进程退出时调用；退出前先 checkpoint） */
export function closeWorkspaceDbs(instanceId: string): void {
  for (const [workspaceId, db] of handles) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* 忽略 */
    }
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
    const dir = heldLocks.get(workspaceId);
    if (dir !== undefined) releaseServerLock(dir, { instanceId });
  }
  handles.clear();
  heldLocks.clear();
  handleMeta.clear();
}

/** 当前已打开的工作区库（可观测：`/api/version` 的 db_scope.localized_open[]；M2 只记录不回收） */
export function listOpenWorkspaceDbs(): OpenWorkspaceDbInfo[] {
  return [...handles.entries()].map(([workspaceId, db]) => {
    const meta = handleMeta.get(workspaceId);
    return {
      workspaceId,
      dbPath: db.name,
      openedAt: meta?.openedAt ?? 0,
      openReason: meta?.reason ?? 'read',
      reclaimable: false,
    };
  });
}

/** 测试用：清空句柄与锁记录（不关句柄，调用方自己管） */
export function resetResolverState(): void {
  handles.clear();
  heldLocks.clear();
  handleMeta.clear();
}
