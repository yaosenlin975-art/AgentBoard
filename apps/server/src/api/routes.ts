/**
 * Task 9：REST 路由（Pinned Contracts REST 全表 + 契约修订）。
 *
 * CR-10：端点按域纯搬迁至 routes/<域>Routes.ts（issue/workspace/session/settings/systemMisc），
 * 本文件只留 RouterDeps 契约、STORE-1/4a 解析上下文装配、各域挂载与统一错误处理。
 */
import { Router } from 'express';
import { createKnowledgeRouter } from './knowledgeRoutes.js';
import { createAccountRouter } from './accountRoutes.js';
import { createSystemRouter, type RestartDeps } from './systemRoutes.js';
import { createArchivedChangelogRouter } from './changelogRoutes.js';
import { createStatusesAggregateRouter } from './workspaceStatusRoutes.js';
import { createIssueRouter, defaultDraftRunner, draftAdapterDetector } from './routes/issueRoutes.js';
import { createWorkspaceRouter } from './routes/workspaceRoutes.js';
import { createSessionRouter } from './routes/sessionRoutes.js';
import { createSettingsRouter } from './routes/settingsRoutes.js';
import { createPersonaRouter } from './routes/personaRoutes.js';
// P3-A：专家团 REST 与编排装配（teams / team_members；WS team_update）
import { createTeamRouter } from './routes/teamRoutes.js';
// P3-C：专家包导入 REST（WorkBuddy 包格式 → personas + 团队模板）
import { createExpertPackageRouter } from './routes/expertPackageRoutes.js';
import { handleSessionTurnEnded, initTeamOrchestration } from '../services/teamOrchestration.js';
import { createPersonaDraftService } from '../services/personaDraft.js';
import { setTurnEndedListener } from '../services/sessionManager.js';
import { createSystemMiscRouter } from './routes/systemMiscRoutes.js';
import { createVoiceRouter, type VoiceRouterOptions } from './voiceRoutes.js';
import { createBrowserRouter } from './browserRoutes.js';
import type { BrowserOpenerDeps } from '../services/browserOpener.js';
import { createDecisionRouter } from './decisionRoutes.js';
import type { DraftRunner } from '../services/smartCreateDraft.js';
import type { WorkbuddyDesktopProvider } from '../services/accounts/workbuddyDesktopProvider.js';
import type { CheckinProviderSpec, CheckinVault } from '../services/accounts/checkinProvider.js';
import type { AddAccountProviderSpec } from '../services/accounts/addAccountProtocol.js';
import type { RestoreHandler } from '../services/accounts/restore.js';
import type { QuotaService } from '../services/quotas/quotaService.js';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import type { ManagedAppId, ServerWsEvent } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import type { SecretVault } from '../services/accounts/secretVault.js';
import { AttachmentStore } from '../services/attachments.js';
import { getWorkspace } from '../db/repos/workspace.js';
import { getIssue } from '../db/repos/issue.js';
import { getSession } from '../db/repos/session.js';
import { ApiError, NotFoundError } from '../errors.js';
import {
  isMigrationActive,
  runBootSelfCheck,
} from '../services/dbMigration.js';
import { WORKSPACE_DB_MODES, getDbForWorkspace, isWorkspaceDbDisabled, locateDbForEntity, readWorkspaceMetaCached, type EntityLocation, type WorkspaceDbMode, type WorkspaceLike } from '../db/resolver.js';
// STORE-4b：entity_locator 定位索引维护（repos 挂钩的中心库句柄绑定与创建/删除写入、删表重建路径）
import { bindEntityLocatorCenter, entityLocatorNeedsBackfill, rebuildEntityLocator } from '../db/repos/entityLocator.js';
import { requireIssueInWorkspace } from '../services/claim.js';
import type { MinimaxClientProbe } from '../services/accounts/minimaxClientProbe.js';
import type { ExportRunner } from '../services/accounts/credentialImport.js';
import { httpMutation } from '../services/idempotency.js';
import { attachmentsDirFor, configDir, readSettings, writeSettings, type DbPathSource } from '../config.js';
import type { SkillsSyncOptions } from '../services/skillsSync.js';

export interface RouterDeps {
  db: Db;
  attachments: AttachmentStore;
  secretVault?: SecretVault;
  getAdapter: (cliId: string) => AgentAdapter;
  /** WS 广播钩子（index.ts 装配 hub.broadcast）；CHAT-AWAIT1：放宽到 ServerWsEvent 以容纳 session.turn */
  broadcast: (event: ServerWsEvent) => void;
  /** 账号 provider 装配（ACC-05/ACC-07）；缺省时账号写接口返回 PROVIDER_UNAVAILABLE */
  accounts?: { workbuddy?: WorkbuddyDesktopProvider; checkinProvider?: CheckinProviderSpec; checkinProviders?: Partial<Record<ManagedAppId, CheckinProviderSpec>>; vault?: CheckinVault; desktopProviders?: Partial<Record<ManagedAppId, Pick<WorkbuddyDesktopProvider, 'captureCurrent' | 'switchAccount'>>>; quotas?: Pick<QuotaService, 'get'>; minimaxClientProbe?: MinimaxClientProbe; addAccountProviders?: Partial<Record<ManagedAppId, AddAccountProviderSpec>>; restoreHandlers?: Partial<Record<ManagedAppId, RestoreHandler>> };
  /** KB-GRAPH 页面加载上限（仅测试注入；生产用 GRAPH_MAX_PAGES） */
  knowledgeGraphPageLimit?: number;
  /** 已安装技能根目录（仅测试注入；生产固定 ~/.agents/skills） */
  skillsRoot?: string;
  /** SYSTEM-RESTART：服务自重启依赖（生产 main() 注入；测试可注入 fake） */
  restart?: RestartDeps;
  /** ACC-11 凭据导出 runner（仅测试注入） */
  credentialRunner?: ExportRunner;
  /** SMART-CREATE：一次性适配器调用（仅测试注入；生产用 getAdapter().runTurn） */
  draftRunner?: DraftRunner;
  /** SMART-CREATE：草稿生成超时（ms，仅测试注入；生产 120s） */
  draftTimeoutMs?: number;
  /** STORE-1：按工作区选库的解析层（缺省自动装配：中心库=当前 db、instanceId 取 instance、port 取设置） */
  workspaceDbResolver?: boolean;
  /** SERVER-SINGLETON：实例标识（`/api/version` 输出；测试可注入） */
  instance?: { instanceId: string; dbPath: string; startedAt: number };
  /** DB-2B：迁移编排的固定状态目录（缺省 configDir()；测试注入临时目录） */
  dbMigrationStateDir?: string;
  /** DB-2B：当前进程实际使用的库路径（缺省 db.name；测试注入） */
  dbPath?: string;
  /** DB-2B：当前进程的附件目录（缺省 attachmentsDirFor(dbPath)） */
  attachmentStorageDir?: string;
  /** DB-2B：dbPath 来源（缺省按 AGENTBOARD_DB 是否设置推断） */
  dbPathSource?: DbPathSource;
  /** DB-2B：自检失败时的进程退出（缺省 process.exit；测试注入 spy） */
  dbMigrationExit?: (code: number) => void;
  /** DB-2B：自检通过后旧文件清理的重试调度（缺省 setTimeout；测试注入） */
  dbMigrationSchedule?: (fn: () => void, ms: number) => void;
  /** VOICE-1：语音模型管理依赖（仅测试注入 catalog/fetch/freeBytes/rootDir；生产用默认值） */
  voice?: VoiceRouterOptions;
  /** ACC-INCOGNITO：无痕浏览器打开依赖（仅测试注入 spawn/existsSync；生产用系统探测） */
  browserOpener?: BrowserOpenerDeps;
  /** ARCH-05：启动期解析并缓存的派发默认模板（缺省内置默认） */
  dispatchPromptTemplate?: string;
  /** SKILLS-SYNC：home / 技能来源 / 记录目录（仅测试注入；生产用默认探测） */
  skillsSync?: SkillsSyncOptions;
}

export function createRouter(deps: RouterDeps): Router {
  const { db, getAdapter, broadcast, attachments } = deps;
  const router = Router();

  // STORE-1（M1）：解析层装配（中心库=当前 db；每工作区锁用与 server.lock 同一实现）
  // STORE-4a：openWorkspaceDbs 翻 true——STORE-2 搬库已落地，生产读写真正切到工作区库；
  // 判定仍由 resolver 决定（未下沉区返回中心库，行为与切库前一致）。
  // STORE-3a：disabled 紧急开关在装配期解析一次（生产改 env 必然伴随重启重建路由，无需逐请求读）
  // PERF-1（F2）：判定读 meta 走常驻只读句柄（readWorkspaceMetaCached）——列表/取库/写闸门不再每请求重开库
  const workspaceResolverDeps = {
    centerDb: db,
    openWorkspaceDbs: true,
    instanceId: deps.instance?.instanceId ?? 'inst-unset',
    port: readSettings().port,
    readMeta: readWorkspaceMetaCached,
    ...(isWorkspaceDbDisabled() ? { disabled: true } : {}),
  };
  /** 读中心库 workspace.db_mode（缺列为老库 → center，行为与现状一致） */
  const workspaceRowMode = (workspaceId: string): WorkspaceDbMode => {
    try {
      const row = db.prepare('SELECT db_mode FROM workspace WHERE id = ?').get(workspaceId) as { db_mode?: string } | undefined;
      const raw = row?.db_mode ?? 'center';
      return (WORKSPACE_DB_MODES as readonly string[]).includes(raw) ? (raw as WorkspaceDbMode) : 'center';
    } catch {
      return 'center';
    }
  };
  /**
   * STORE-2a（D7）：写闸门与 localize 端点共用的工作区行取用。
   * 未知工作区显式 404——不得用 `path ?? ''` 进判定：'' 拼 `.agentboard/agentboard.db`
   * 会落到进程 cwd 相对路径，读错文件比报错更糟。
   * PERF-1（F3）：单条预编译语句一次取齐 path+db_mode（替代 getWorkspace + workspaceRowMode
   * 两次查询）；prepare 失败（老库缺 db_mode 列）时回退两段式，口径与 workspaceRowMode 一致。
   */
  let workspaceRowStmt: ReturnType<Db['prepare']> | null | undefined; // undefined=未尝试，null=不可用（缺列回退）
  const requireWorkspaceRow = (workspaceId: string): { id: string; path: string; dbMode: WorkspaceDbMode } => {
    if (workspaceRowStmt === undefined) {
      try {
        workspaceRowStmt = db.prepare('SELECT id, path, db_mode FROM workspace WHERE id = ?');
      } catch {
        workspaceRowStmt = null;
      }
    }
    if (workspaceRowStmt !== null) {
      const row = workspaceRowStmt.get(workspaceId) as { id: string; path: string; db_mode?: string | null } | undefined;
      if (row === undefined) throw new NotFoundError('工作空间不存在');
      const rawMode = row.db_mode ?? 'center';
      return { id: row.id, path: row.path, dbMode: (WORKSPACE_DB_MODES as readonly string[]).includes(rawMode) ? (rawMode as WorkspaceDbMode) : 'center' };
    }
    const row = getWorkspace(db, workspaceId);
    if (row === null) throw new NotFoundError('工作空间不存在');
    return { id: row.id, path: row.path, dbMode: workspaceRowMode(workspaceId) };
  };
  // ---- STORE-4a：按请求取库 ----
  /** 已下沉工作区清单（fan-out 定位候选；workspace 行与 db_mode 都是中心库的注册事实） */
  const listLocalizedWorkspaces = (): Array<{ id: string; path: string; dbMode: WorkspaceDbMode }> => {
    try {
      return (db.prepare("SELECT id, path FROM workspace WHERE db_mode = 'localized'").all() as Array<{ id: string; path: string }>)
        .map((row) => ({ id: row.id, path: row.path, dbMode: 'localized' as const }));
    } catch {
      return [];
    }
  };
  /** workspace_id 已知时的取库：走 resolver 判定（localized→工作区库，未下沉/localizing/disabled→中心库），未知工作区 404 */
  const dbForWorkspace = (workspaceId: string): Db => getDbForWorkspace(workspaceResolverDeps, requireWorkspaceRow(workspaceId)).db;
  // ---- STORE-4b：定位索引 ----
  // repos 层维护索引需要知道中心库句柄：中心句柄自绑；知识路由的工作区句柄在 getWorkspaceDb 出口逐个绑
  bindEntityLocatorCenter(db, db);
  /** 索引用的工作区行解析（未知/已删返回 null，读侧对该情形回退 fan-out 兜底，不猜） */
  const findWorkspaceRow = (workspaceId: string): WorkspaceLike | null => {
    const row = getWorkspace(db, workspaceId);
    return row === null ? null : { id: row.id, path: row.path, dbMode: workspaceRowMode(workspaceId) };
  };
  /** 按 id 定位 issue 所在库（先查 entity_locator 索引，未命中/过期回退 fan-out 已下沉区） */
  const locateIssueRouted = (issueId: string): EntityLocation<NonNullable<ReturnType<typeof getIssue>>> | null =>
    locateDbForEntity(workspaceResolverDeps, listLocalizedWorkspaces(), 'issue', issueId, (rdb) => getIssue(rdb, issueId), findWorkspaceRow);
  const requireIssueRouted = (issueId: string): EntityLocation<NonNullable<ReturnType<typeof getIssue>>> => {
    const hit = locateIssueRouted(issueId);
    if (hit === null) throw new NotFoundError('任务不存在');
    return hit;
  };
  /** 按 id 定位 session 所在库（索引先行；4d 前 sessionManager 仍写中心库——索引指向已下沉区而行在中心时由兜底扫描接住） */
  const locateSessionRouted = (sessionId: string): EntityLocation<NonNullable<ReturnType<typeof getSession>>> | null =>
    locateDbForEntity(workspaceResolverDeps, listLocalizedWorkspaces(), 'session', sessionId, (rdb) => getSession(rdb, sessionId), findWorkspaceRow);
  /**
   * CR2-1：按 id 定位决策所在库。issue_decision 无 entity_locator 索引（历史表，未接入定位索引），
   * 用一次主键探针按「中心库 → 已下沉区」扫描；已下沉区数量有限，决策详情类请求可接受。
   */
  const locateDecisionDb = (decisionId: string): Db | null => {
    const hasDecision = (candidate: Db): boolean =>
      candidate.prepare('SELECT 1 AS hit FROM issue_decision WHERE id = ?').get(decisionId) !== undefined;
    try {
      if (hasDecision(db)) return db;
    } catch {
      /* 中心库异常不阻断，继续扫已下沉区 */
    }
    for (const wsRow of listLocalizedWorkspaces()) {
      try {
        const rdb = getDbForWorkspace(workspaceResolverDeps, wsRow).db;
        if (hasDecision(rdb)) return rdb;
      } catch {
        /* 该区库打不开：跳过 */
      }
    }
    return null;
  };
  // STORE-4b：删表重建路径——索引空而中心库已有实体（存量数据首启 / 索引被删后的下一启）时回填中心库部分；
  // 只扫中心库不开工作区库（已下沉区缺行由读侧兜底），任何失败不阻断启动。
  try {
    if (entityLocatorNeedsBackfill(db)) rebuildEntityLocator(db, [db]);
  } catch {
    /* 索引可重建，不是事实来源 */
  }
  /** 端点内统一解析本请求的业务库：workspace_id 优先，其次按路由参数 id 定位实体；都拿不到回中心库（调用方自行 404） */
  const resolveRequestDb = (req: Request, entityId?: string): Db => {
    const workspace = effectiveWorkspace(req);
    if (workspace !== undefined) return dbForWorkspace(String(workspace));
    if (entityId !== undefined) {
      const issueHit = locateIssueRouted(entityId);
      if (issueHit !== null) return issueHit.db;
      const sessionHit = locateSessionRouted(entityId);
      if (sessionHit !== null) return sessionHit.db;
    }
    return db;
  };

  // ---- DB-2B：迁移编排上下文 ----
  // 状态目录固定（configDir），不随库路径漂移：新进程靠它读到旧进程写的待自检意图。
  const migrationStateDir = deps.dbMigrationStateDir ?? configDir();
  // db 可能是最小装配的替身（无 name）：此时迁移端点明确 503，不在构造期抛错
  const currentDbPath: string | null = deps.dbPath ?? (typeof db.name === 'string' && db.name !== '' ? db.name : null);
  const attachmentsDirOf = (dbPath: string): string => deps.attachmentStorageDir ?? attachmentsDirFor(dbPath);

  // 新进程启动钩子：有 pending 意图就自检；失败则回滚设置并退出本进程
  // （旧进程健康判定会失败 → 重新监听旧库继续服务，即「重启回旧库」）。
  if (currentDbPath !== null && isMigrationActive(migrationStateDir)) {
    const boot = runBootSelfCheck({
      stateDir: migrationStateDir,
      currentDbPath,
      sourceDb: db,
      applySettings: (path) => { writeSettings({ dbPath: path }); },
      ...(deps.dbMigrationSchedule !== undefined ? { schedule: deps.dbMigrationSchedule } : {}),
    });
    if (boot.handled && !boot.ok && boot.needsRestartToOldDb) {
      (deps.dbMigrationExit ?? ((code: number) => process.exit(code)))(1);
    }
  }
  const effectiveWorkspace = (req: Request): string | undefined => req.body?.workspace_id ?? req.query.workspace_id;
  // STORE-4a：mutation 的业务写与幂等记录都落「本请求解析出的库」（幂等表随库走，重放在同一库命中）
  function mutation<T>(rdb: Db, req: Request, perform: (routedDb: Db) => T) {
    return httpMutation(rdb, req, () => {
      const workspace = effectiveWorkspace(req);
      if (workspace && req.params.id) requireIssueInWorkspace(rdb, String(req.params.id), workspace);
      return perform(rdb);
    });
  }
  // ---- system 杂域（CR-10d 自本文件纯搬迁到 routes/systemMiscRoutes.ts）----
  // version / skills / clis / center-snapshot / pick-folder；挂载位置即原 /version 端点处
  // （此前位于本挂载点之前的路由均无 /version、/skills、/clis、/system/* 业务路径；
  // /system/restart 属 ../systemRoutes.ts 且在挂载点之后，两文件无同路径）。
  router.use(createSystemMiscRouter({
    db,
    getAdapter,
    currentDbPath,
    ...(deps.instance === undefined ? {} : { instance: deps.instance }),
    ...(deps.skillsRoot === undefined ? {} : { skillsRoot: deps.skillsRoot }),
  }));

  // STORE-4a：知识路由按请求取库——common→中心库、workspace→工作区库（判定走 resolver）；
  // 跨区 owner 探测的 fan-out 候选 = 全部已下沉区（单区打不开跳过，命中即事实）。
  router.use('/knowledge', createKnowledgeRouter(deps.db, {
    maxGraphPages: deps.knowledgeGraphPageLimit,
    // STORE-4b：工作区句柄绑中心库——repos/knowledge 的定位索引维护要知道往哪个中心库写
    getWorkspaceDb: (workspaceId) => {
      const workspaceDb = dbForWorkspace(workspaceId);
      bindEntityLocatorCenter(workspaceDb, db);
      return workspaceDb;
    },
    listWorkspaceDbs: () => listLocalizedWorkspaces().flatMap((wsRow) => {
      try {
        return [getDbForWorkspace(workspaceResolverDeps, wsRow).db];
      } catch {
        return [];
      }
    }),
  }));

  // ---- workspaces 域（CR-10b 自本文件纯搬迁到 routes/workspaceRoutes.ts）----
  // 含 per-workspace changelog / statuses 子挂载与 CRUD/删除归档/release-running/附件/
  // localize/snapshot/approval-rules 全域端点；挂载位置即原 changelog 子挂载处。
  // 此前位于本挂载点之前的路由均无 /workspaces/* 业务路径（决策路由的
  // /workspaces/:workspaceId/decisions/* 在其后注册且本域无 'decisions' 字面路径，不受影响）。
  router.use(createWorkspaceRouter({
    db,
    broadcast,
    attachments,
    workspaceResolverDeps,
    requireWorkspaceRow,
    dbForWorkspace,
    currentDbPath,
    attachmentsDirOf,
  }));
  // KB-CLI-4：多工作区状态字典聚合（list-tasks --all 一次取全）
  router.use('/statuses', createStatusesAggregateRouter(deps.db));
  router.use('/changelog', createArchivedChangelogRouter(deps.db));
  router.use('/voice', createVoiceRouter(deps.db, deps.voice ?? {}));
  // ACC-INCOGNITO：账号授权地址用无痕窗口打开（与账号平台无关）
  router.use(createBrowserRouter(deps.browserOpener));
  router.use(createSystemRouter({ restart: deps.restart }));
  router.use(createAccountRouter({ db, workbuddy: deps.accounts?.workbuddy, checkinProvider: deps.accounts?.checkinProvider, checkinProviders: deps.accounts?.checkinProviders, desktopProviders: deps.accounts?.desktopProviders, vault: deps.accounts?.vault ?? deps.secretVault, secretVault: deps.secretVault, credentialRunner: deps.credentialRunner, quotas: deps.accounts?.quotas, minimaxClientProbe: deps.accounts?.minimaxClientProbe, addAccountProviders: deps.accounts?.addAccountProviders, addAccountVault: deps.secretVault, restoreHandlers: deps.accounts?.restoreHandlers }));
  // DEC-WIRE：决策 REST（DEC-3 定稿）必须在 '/issues/:id' 中间件之前注册，否则 /issues/:id/ask 与 /issues/:id/stop 会被当作 issue 子路由
  router.use(createDecisionRouter({
    db,
    broadcast,
    // CR2-1：决策/轮次/审批规则随区下沉 → 业务读写按实体或工作区解析到实际库；权限仍用中心库 db
    dbForWorkspace,
    locateIssueDb: (issueId) => locateIssueRouted(issueId)?.db ?? null,
    locateDecisionDb,
  }));

  // ---- issues 域（CR-10a 自本文件纯搬迁到 routes/issueRoutes.ts）----
  // 挂载点保持在决策路由之后（DEC-WIRE 顺序不变）；域内相对顺序不变：
  // draft 先于 /issues/:id 中间件（'draft' 不被当成卡 id），/issues/counts 先于 GET /issues/:id。
  router.use(createIssueRouter({
    db,
    broadcast,
    getAdapter,
    attachments,
    ...(deps.draftRunner === undefined ? {} : { draftRunner: deps.draftRunner }),
    ...(deps.draftTimeoutMs === undefined ? {} : { draftTimeoutMs: deps.draftTimeoutMs }),
    workspaceResolverDeps,
    requireWorkspaceRow,
    dbForWorkspace,
    locateIssueRouted,
    requireIssueRouted,
    resolveRequestDb,
    effectiveWorkspace,
    mutation,
  }));

  // ---- settings 域（CR-10d 自本文件纯搬迁到 routes/settingsRoutes.ts）----
  // GET/PATCH /settings、storage 只读汇总、db-path 迁移编排与状态查询；
  // resolveDbPathSource / triggerRestart 闭包仅本域消费，随域迁入（deps 注入 dbPathSource/restart）。
  router.use(createSettingsRouter({
    db,
    attachments,
    currentDbPath,
    attachmentsDirOf,
    migrationStateDir,
    ...(deps.dbPathSource === undefined ? {} : { dbPathSource: deps.dbPathSource }),
    ...(deps.restart === undefined ? {} : { restart: deps.restart }),
    ...(deps.skillsSync === undefined ? {} : { skillsSync: deps.skillsSync }),
  }));

  // ---- sessions 域（CR-10c 自本文件纯搬迁到 routes/sessionRoutes.ts）----
  // 列表（跨库并集兜底）/详情/队列/消息/事件、新建（派发或自由）、发送（图片/文件分流）、
  // 停止/删除/PATCH/fork/阻塞轮次回答/单步重试/三档确认决策；挂载位置即原 sessions 群起点。
  router.use(createSessionRouter({
    db,
    broadcast,
    getAdapter,
    attachments,
    dbForWorkspace,
    locateSessionRouted,
    ...(deps.dispatchPromptTemplate === undefined ? {} : { dispatchPromptTemplate: deps.dispatchPromptTemplate }),
  }));

  // ---- personas 域（P1-C）----
  // persona CRUD（builtin 409）与 CLI 能力探测（probeCliCapabilities，60s 缓存在 adapters 侧）
  // PERSONA-LIB：草稿生成与任务卡草稿共用 DraftRunner / 错误码口径（不落库、不建 session）
  router.use(createPersonaRouter({
    db,
    draft: createPersonaDraftService({
      run: deps.draftRunner ?? defaultDraftRunner(getAdapter),
      detectAdapter: draftAdapterDetector(getAdapter),
      cwd: process.cwd(),
      ...(deps.draftTimeoutMs === undefined ? {} : { timeoutMs: deps.draftTimeoutMs }),
    }),
  }));

  // ---- 专家团域（P3-A）----
  // teams / team_members 落中心库；成员会话行落归属工作区库（dbForWorkspace）。
  // 编排装配在这里做（与 createApp 同生命周期）：initTeamOrchestration 供广播与成员库解析，
  // 轮次结束监听把成员结果回传 lead（非团队成员会话由服务忽略）。
  initTeamOrchestration({ center: db, getDbForWorkspace: dbForWorkspace, broadcast });
  setTurnEndedListener((info) => {
    // 结果回传是旁路：失败（库已关、lead 会话已删等）不得冒泡成未处理拒绝
    void handleSessionTurnEnded(info).catch(() => undefined);
  });
  router.use(createTeamRouter({ db, broadcast, dbForWorkspace, locateSessionRouted }));
  // P3-C：专家包导入（本地 WorkBuddy 包 → personas + 团队模板）；广播 team_update，
  // 因此必须排在 initTeamOrchestration 之后（与团队路由同一挂载段）。
  router.use(createExpertPackageRouter({ db }));
  return router;
}

/** 统一错误响应 {error:{code,message}}（ValidationError→400/NotFoundError→404/ConflictError→409/其余→500） */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    return;
  }
  if (err instanceof SyntaxError && (err as { status?: number }).status === 400) {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: '请求体不是合法 JSON' } });
    return;
  }
  if (typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.too.large') {
    // KBIMP-1B：导入端点的上限是 2 MiB 请求体，文案不能套用「单张图片」
    if (req.path.startsWith('/api/knowledge/pages/import')) {
      res.status(413).json({ error: { code: 'IMPORT_TOO_LARGE', message: '导入请求体过大（上限 12 MiB）；单文件上限 10MB、单页正文上限 2,000,000 字符' } });
      return;
    }
    res.status(413).json({ error: { code: 'ATTACHMENT_TOO_LARGE', message: '单个附件不能超过 10 MiB' } });
    return;
  }
  // CLAIM-RACE：SQLite 忙等超时（busy_timeout=5000）不是内部错误——而是「别的进程/请求正握着写锁」，
  // 映射成 409 让调用方（agent / kb CLI）知道「重试即可」，而不是当成 500 崩掉。
  if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'SQLITE_BUSY') {
    res.status(409).json({ error: { code: 'DB_BUSY', message: '数据库正被其它操作占用（写锁等待超时），请稍后重试' } });
    return;
  }
  // CR-7：仓储层的 CHECK / UNIQUE / FK / NOT NULL / PK 违例漏到这里说明请求数据不合法，不是服务故障——
  // 映射成 400，且 message 只带约束类别（不把 SQL 语句、表名、列值回显给调用方）。
  // better-sqlite3 的 code 是扩展码（SQLITE_CONSTRAINT_CHECK / _UNIQUE / _FOREIGNKEY …），按前缀归并。
  // TRIGGER 例外要按 RAISE(ABORT) 的消息分流（CR3-04）：
  //   issue parent/dependency workspace mismatch → 400 WORKSPACE_MISMATCH（调用方传错工作区）
  //   issue parent/dependency cycle → 409 DEPENDENCY_CYCLE（与仓储层预检同口径）
  //   Knowledge history is immutable → 500（服务端不变量，不是调用方错误）
  const sqliteCode = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  if (typeof sqliteCode === 'string' && sqliteCode.startsWith('SQLITE_CONSTRAINT')) {
    const kind = sqliteCode.slice('SQLITE_CONSTRAINT'.length).replace(/^_/, '') || 'UNKNOWN';
    if (kind !== 'TRIGGER') {
      res.status(400).json({ error: { code: 'CONSTRAINT_VIOLATION', message: `请求违反数据库约束（${kind}）` } });
      return;
    }
    const message = (err as { message?: unknown }).message;
    const text = typeof message === 'string' ? message.toLowerCase() : '';
    if (text.includes('workspace mismatch')) {
      res.status(400).json({ error: { code: 'WORKSPACE_MISMATCH', message: '目标卡不属于同一工作区，无法建立该关系' } });
      return;
    }
    if (text.includes('cycle')) {
      res.status(409).json({ error: { code: 'DEPENDENCY_CYCLE', message: '该关系会形成环路，已拒绝' } });
      return;
    }
  }
  // CR-7：只读库（快照归档、权限受限、磁盘降级）上写失败是服务端可用性问题，不是调用方参数错误 → 503。
  if (typeof sqliteCode === 'string' && sqliteCode.startsWith('SQLITE_READONLY')) {
    res.status(503).json({ error: { code: 'DB_READONLY', message: '数据库当前为只读模式，写入被拒绝' } });
    return;
  }
  console.error('[agentboard] 未处理错误:', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: '内部错误' } });
}

/** 未匹配的 /api 路由 → 404 JSON（避免落到静态托管） */
export const apiNotFound: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `接口不存在: ${req.method} ${req.path}` } });
};

