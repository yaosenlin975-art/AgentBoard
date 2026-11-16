/**
 * settings 域 REST（CR-10d 自 routes.ts 纯搬迁，不改语义）。
 * 覆盖：GET/PATCH /api/settings、SKILLS-SYNC 目标/同步/移除。
 * P1-02：数据存储只读汇总与 db-path 迁移编排端点已下线。
 */
import { Router } from 'express';
import type { ZodType } from 'zod';
import type { AgentAdapter } from '@agentboard/adapters';
import type { ModelInfo } from '@agentboard/shared';
import { zhZodIssue } from '../zod.js';
import type { Db } from '../../db/connection.js';
import { ApiError, NotFoundError, ValidationError } from '../../errors.js';
import { setMaxConcurrentTurns } from '../../services/sessionManager.js';
import type { RestartDeps } from '../systemRoutes.js';
import { readSettings, writeSettings } from '../../config.js';
import { AttachmentStore } from '../../services/attachments.js';
import { patchSettingsSchema, skillsSyncSchema } from '../schemas.js';
import { getWorkspace } from '../../db/repos/workspace.js';
import { probeTargets, removeSynced, syncSkills, type SkillsSyncOptions } from '../../services/skillsSync.js';

export interface SettingsRouterDeps {
  /** 中心库：skills-sync 工作区查询 */
  db: Db;
  attachments: AttachmentStore;
  /** CLI-DEFAULT-MODEL：adapter 注册表（PATCH cliDefaultModels 校验 CLI 存在性/能力位/模型清单） */
  getAdapter: (cliId: string) => AgentAdapter;
  /** 当前进程实际使用的库路径（缺省 db.name；测试注入） */
  currentDbPath: string | null;
  /** 当前进程的附件目录解析（缺省 attachmentsDirFor(dbPath)；测试注入） */
  attachmentsDirOf: (dbPath: string) => string;
  /** SYSTEM-RESTART：服务自重启依赖（生产 main() 注入；测试可注入 fake） */
  restart?: RestartDeps;
  /** SKILLS-SYNC：home / 技能来源 / 记录目录（测试注入临时目录；生产用默认探测） */
  skillsSync?: SkillsSyncOptions;
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

/**
 * CLI-DEFAULT-MODEL：PATCH 的 cliDefaultModels 校验与按键合并。
 * - CLI id 不在 adapter 注册表 → 400 VALIDATION_ERROR；
 * - supportsModelSelection=false（如 dsh，模型由 profile 配置决定）→ 400 VALIDATION_ERROR；
 * - 值非空时对该 CLI 调一次 listModels()：清单非空且不含该值 → 422 MODEL_UNAVAILABLE；
 *   清单为空/探测失败 → 放行保存，由 CLI 运行时校验；
 * - '' 为删键：跳过校验，合并时从当前 map 删除；其余按键覆盖当前 map。
 */
async function resolveCliDefaultModels(
  delta: Record<string, string>,
  current: Record<string, string>,
  getAdapter: (cliId: string) => AgentAdapter,
): Promise<Record<string, string>> {
  const merged: Record<string, string> = { ...current };
  for (const [cliId, rawValue] of Object.entries(delta)) {
    let adapter: AgentAdapter;
    try {
      adapter = getAdapter(cliId);
    } catch {
      throw new ValidationError(`未知 CLI: ${cliId}`);
    }
    if (adapter.supportsModelSelection === false) {
      throw new ValidationError(`该 CLI 的模型由 profile 配置决定：${cliId}`);
    }
    const value = rawValue.trim();
    if (value === '') {
      delete merged[cliId];
      continue;
    }
    let models: ModelInfo[] = [];
    try {
      models = await adapter.listModels();
    } catch {
      models = []; // 探测失败放行，由 CLI 运行时校验
    }
    if (models.length > 0 && !models.some((m) => m.id === value)) {
      throw new ApiError(422, 'MODEL_UNAVAILABLE', `模型 ${value} 不在 ${cliId} 的可用清单中`);
    }
    merged[cliId] = value;
  }
  return merged;
}

export function createSettingsRouter(deps: SettingsRouterDeps): Router {
  const { db, attachments } = deps;
  const router = Router();

  // ---- settings ----
  // 读侧只反映 config.json 持久化值（环境变量覆盖不参与，见 config.readSettings 注释）
  router.get('/settings', (_req, res) => {
    const settings = readSettings();
    // P1-01：db_path 仅作只读回显（排障用，dbPath 仍随 readSettings 持久化值回显），不可通过 PATCH 修改
    res.json({ ...settings, db_path: settings.dbPath });
  });

  // 写侧：端口重启生效（启动时 loadConfig 读取）；并发上限即时生效。
  // P1-01：dbPath / db_path 已从可写设置下线，由 patchSettingsSchema.strict() 在校验层拒掉，本分支不再处理 db 路径。
  router.patch('/settings', async (req, res) => {
    const body = parseBody(patchSettingsSchema, req.body);
    const current = readSettings();
    // CLI-DEFAULT-MODEL：先校验（400/422）再按键合并成全量 map 写回（'' 删键）
    const patch: Partial<typeof body> = { ...body };
    if (body.cliDefaultModels !== undefined) {
      patch.cliDefaultModels = await resolveCliDefaultModels(body.cliDefaultModels, current.cliDefaultModels, deps.getAdapter);
    }
    const next = writeSettings(patch);
    if (body.maxConcurrentTurns !== undefined && body.maxConcurrentTurns !== current.maxConcurrentTurns) {
      setMaxConcurrentTurns(body.maxConcurrentTurns);
    }
    attachments.configure({
      attachmentQuotaBytes: next.attachmentQuotaBytes,
      attachmentStagedTtlMs: next.attachmentStagedTtlMs,
      attachmentCleanupIntervalMs: next.attachmentCleanupIntervalMs,
    });
    // DB-1：响应与 GET /settings 同形（都带对外 db_path 只读回显），避免同一资源两种形状
    res.json({ ...next, db_path: next.dbPath });
  });

  // ---- SKILLS-SYNC：配套技能复制到本机常见 agent skills 目录 ----
  // 目标目录一律服务端枚举（target id），接口不收任意路径；工作区目标仅在传 workspace_id 时出现。
  const skillOptions = (workspaceId: string | undefined): SkillsSyncOptions => {
    const base = deps.skillsSync ?? {};
    if (workspaceId === undefined || workspaceId === '') return base;
    const workspace = getWorkspace(db, workspaceId);
    if (workspace === null) throw new NotFoundError('工作空间不存在');
    return { ...base, workspacePath: workspace.path };
  };
  const workspaceIdOf = (req: { query?: unknown; body?: unknown }): string | undefined => {
    const fromQuery = (req.query as { workspace_id?: unknown } | undefined)?.workspace_id;
    if (typeof fromQuery === 'string' && fromQuery !== '') return fromQuery;
    const fromBody = (req.body as { workspace_id?: unknown } | undefined)?.workspace_id;
    if (typeof fromBody === 'string' && fromBody !== '') return fromBody;
    return undefined;
  };

  router.get('/settings/skills-sync/targets', (req, res) => {
    res.json(probeTargets(skillOptions(workspaceIdOf(req))));
  });

  router.post('/settings/skills-sync', (req, res) => {
    const body = parseBody(skillsSyncSchema, req.body);
    const options: SkillsSyncOptions = skillOptions(body.workspace_id);
    res.json(syncSkills({
      ...options,
      targetIds: body.target_ids,
      ...(body.conflict === undefined ? {} : { conflict: body.conflict }),
    }));
  });

  router.delete('/settings/skills-sync/:targetId', (req, res) => {
    res.json(removeSynced(skillOptions(workspaceIdOf(req)), req.params.targetId));
  });

  return router;
}
