/**
 * settings 域 REST（CR-10d 自 routes.ts 纯搬迁，不改语义）。
 * 覆盖：GET/PATCH /api/settings、GET /api/settings/storage（DB-3B-S 只读汇总）、
 * POST /api/settings/db-path/migrate 与 GET 状态查询（DB-2B 迁移编排）。
 * resolveDbPathSource / triggerRestart 闭包只有本域消费，随域迁入（原为 routes.ts 装配期闭包，
 * 依赖经 SettingsRouterDeps 注入）；migrationStateDir 仍由 routes.ts 装配（启动自检共用）。
 */
import { Router } from 'express';
import type { ZodType } from 'zod';
import { zhZodIssue } from '../zod.js';
import type { Db } from '../../db/connection.js';
import { ApiError, NotFoundError, ValidationError } from '../../errors.js';
import {
  describeMigrationError,
  getMigrationStatus,
  isMigrationActive,
  orchestrateMigration,
} from '../../services/dbMigration.js';
import { collectStorageInfo } from '../../services/storageInfo.js';
import { setMaxConcurrentTurns } from '../../services/sessionManager.js';
import { performRestart, type RestartDeps } from '../systemRoutes.js';
import { attachmentsDirFor, loadConfig, readSettings, writeSettings, type DbPathSource } from '../../config.js';
import { AttachmentStore } from '../../services/attachments.js';
import {
  patchSettingsSchema,
  dbMigrateSchema,
} from '../schemas.js';

export interface SettingsRouterDeps {
  /** 中心库：存储统计与迁移源库 */
  db: Db;
  attachments: AttachmentStore;
  /** DB-2B：当前进程实际使用的库路径（缺省 db.name；测试注入） */
  currentDbPath: string | null;
  /** 当前进程的附件目录解析（缺省 attachmentsDirFor(dbPath)；测试注入） */
  attachmentsDirOf: (dbPath: string) => string;
  /** DB-2B：迁移编排的固定状态目录（缺省 configDir()；测试注入临时目录） */
  migrationStateDir: string;
  /** DB-2B：dbPath 来源（缺省按 AGENTBOARD_DB 是否设置推断） */
  dbPathSource?: DbPathSource;
  /** SYSTEM-RESTART：服务自重启依赖（生产 main() 注入；测试可注入 fake） */
  restart?: RestartDeps;
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

export function createSettingsRouter(deps: SettingsRouterDeps): Router {
  const {
    db,
    attachments,
    currentDbPath,
    attachmentsDirOf,
    migrationStateDir,
  } = deps;
  const router = Router();

  // 来源三态（env / settings / default）：缺省按启动同一套规则解析（loadConfig），
  // 解析失败（例如 AGENTBOARD_HOST 非法）时退化为 env-否则-settings 两态，不让只读端点 500。
  const resolveDbPathSource = (): DbPathSource => {
    if (deps.dbPathSource !== undefined) return deps.dbPathSource;
    try {
      return loadConfig(process.env).dbPathSource;
    } catch {
      return (process.env.AGENTBOARD_DB ?? '') !== '' ? 'env' : 'settings';
    }
  };
  const triggerRestart = async (): Promise<void> => {
    if (!deps.restart) throw new Error('当前装配未启用服务重启');
    const outcome = await performRestart(deps.restart);
    if (!outcome.ok) throw new Error(outcome.message);
  };

  // ---- settings ----
  // 读侧只反映 config.json 持久化值（环境变量覆盖不参与，见 config.readSettings 注释）
  router.get('/settings', (_req, res) => {
    const settings = readSettings();
    // DB-1：对外规范名是 db_path；dbPath 保留给既有前端字段（同值，避免破坏已有设置界面）
    res.json({ ...settings, db_path: settings.dbPath });
  });

  // 写侧：端口/DB 路径重启生效（启动时 loadConfig 读取）；并发上限即时生效
  router.patch('/settings', (req, res) => {
    const body = parseBody(patchSettingsSchema, req.body);
    // DB-2B：迁移进行中不接受直接改 db 路径（否则与新库切换打架）
    if ((body.db_path !== undefined || body.dbPath !== undefined) && isMigrationActive(migrationStateDir)) {
      const text = describeMigrationError('DB_MIGRATION_BUSY');
      throw new ApiError(409, text.code, '迁移进行中，暂不接受直接修改 db 路径；请等迁移结束：' + text.message);
    }
    // DB-1：db_path 是对外规范名；与 dbPath 同时出现且不一致时明确报错（不静默取一个）
    if (body.db_path !== undefined && body.dbPath !== undefined && body.db_path !== body.dbPath) {
      throw new ValidationError('db_path 与 dbPath 同时出现且不一致：请只传 db_path');
    }
    const patch: Partial<typeof body> = { ...body, ...(body.db_path !== undefined ? { dbPath: body.db_path } : {}) };
    delete (patch as { db_path?: string }).db_path;
    const current = readSettings();
    const next = writeSettings(patch);
    if (body.maxConcurrentTurns !== undefined && body.maxConcurrentTurns !== current.maxConcurrentTurns) {
      setMaxConcurrentTurns(body.maxConcurrentTurns);
    }
    attachments.configure({
      attachmentQuotaBytes: next.attachmentQuotaBytes,
      attachmentStagedTtlMs: next.attachmentStagedTtlMs,
      attachmentCleanupIntervalMs: next.attachmentCleanupIntervalMs,
    });
    // DB-1：响应与 GET /settings 同形（都带对外 db_path），避免同一资源两种形状
    res.json({ ...next, db_path: next.dbPath });
  });

  // ---- DB-3B-S：存储位置只读汇总 ----
  // 只读：不改配置、不触发迁移。数字全部服务端算（含 ×1.2 空间门槛），前端只格式化。
  router.get('/settings/storage', (_req, res) => {
    if (currentDbPath === null) {
      throw new ApiError(503, 'DB_STORAGE_UNAVAILABLE', '当前装配拿不到中心库路径，存储统计不可用');
    }
    const attachmentsDir = attachmentsDirOf(currentDbPath);
    res.json(collectStorageInfo({
      dbPath: currentDbPath,
      attachmentsDir,
      dbPathSource: resolveDbPathSource(),
      countIssues: () => Number((db.prepare('SELECT COUNT(*) AS n FROM issue').get() as { n: number }).n),
    }));
  });

  // ---- DB-2B：数据库位置迁移编排 ----
  // 顺序：preflight → snapshot → verify → switch → restart（旧进程）→ selfcheck → cleanup | rolled_back（新进程）。
  // 自检在新进程启动时跑，故本端点只保证「已切换 + 已拉起新进程」；结果用 GET 状态查询。
  router.post('/settings/db-path/migrate', async (req, res) => {
    const body = parseBody(dbMigrateSchema, req.body);
    if (resolveDbPathSource() === 'env') {
      const text = describeMigrationError('DB_MIGRATION_ENV_OVERRIDDEN');
      throw new ApiError(409, text.code, text.message);
    }
    if (isMigrationActive(migrationStateDir)) {
      const text = describeMigrationError('DB_MIGRATION_BUSY');
      throw new ApiError(409, text.code, text.message);
    }
    if (!deps.restart) {
      const text = describeMigrationError('DB_MIGRATION_RESTART_UNAVAILABLE');
      throw new ApiError(503, text.code, text.message);
    }
    if (currentDbPath === null) {
      throw new ApiError(503, 'DB_MIGRATION_UNAVAILABLE', '当前装配拿不到中心库路径，迁移不可用');
    }
    const status = await orchestrateMigration({
      fromDbPath: currentDbPath,
      toDbPath: body.target_db_path,
      fromAttachmentsDir: attachmentsDirOf(currentDbPath),
      toAttachmentsDir: attachmentsDirFor(body.target_db_path),
      ...(body.overwrite !== undefined ? { overwrite: body.overwrite } : {}),
      stateDir: migrationStateDir,
      sourceDb: db,
      applySettings: (path) => { writeSettings({ dbPath: path }); },
      triggerRestart,
    });
    if (status.ok === false) {
      throw new ApiError(status.retryable ? 409 : 500, status.code ?? 'DB_MIGRATION_COPY_FAILED', status.message);
    }
    res.status(202).json({
      migration_id: status.migration_id,
      backup_dir: status.backup_dir,
      stages: status.stages,
      stage: status.stage,
      message: status.message,
    });
  });

  // 迁移状态：重启后由新进程读盘返回（内存表在重启时丢失）
  router.get('/settings/db-path/migrate/:migrationId', (req, res) => {
    const status = getMigrationStatus(migrationStateDir, req.params.migrationId);
    if (status === null) throw new NotFoundError('迁移记录不存在');
    res.json(status);
  });

  return router;
}
