/**
 * Task 9：REST 路由（Pinned Contracts REST 全表 + 契约修订）。
 *
 * 修订点：POST /api/sessions 体增 workspace_id?——issue_id 为空时必填（400 校验）；
 * POST /api/issues/:id/claim 仅做占用登记（session_id 置 null，供 kb claim 场景），不建会话。
 */
import { spawn } from 'node:child_process';
import { zhZodIssue } from './zod.js';
import { Router } from 'express';
import { createKnowledgeRouter } from './knowledgeRoutes.js';
import { createAccountRouter } from './accountRoutes.js';
import { createSystemRouter, performRestart, type RestartDeps } from './systemRoutes.js';
import { createArchivedChangelogRouter } from './changelogRoutes.js';
import { createStatusesAggregateRouter } from './workspaceStatusRoutes.js';
import { createIssueRouter } from './routes/issueRoutes.js';
import { createWorkspaceRouter } from './routes/workspaceRoutes.js';
import { createSessionRouter } from './routes/sessionRoutes.js';
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
import type { ZodType } from 'zod';
import type { AgentAdapter } from '@agentboard/adapters';
import type { ManagedAppId, ServerWsEvent } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import type { SecretVault } from '../services/accounts/secretVault.js';
import { AttachmentStore } from '../services/attachments.js';
import { getWorkspace } from '../db/repos/workspace.js';
import { getIssue } from '../db/repos/issue.js';
import { getSession } from '../db/repos/session.js';
import { ApiError, ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { SERVER_VERSION } from '../version.js';
import { resolveProxyEnv } from '@agentboard/shared';
import {
  describeMigrationError,
  getMigrationStatus,
  isMigrationActive,
  orchestrateMigration,
  runBootSelfCheck,
} from '../services/dbMigration.js';
import { collectStorageInfo } from '../services/storageInfo.js';
import { WORKSPACE_DB_MODES, getDbForWorkspace, isWorkspaceDbDisabled, listOpenWorkspaceDbs, locateDbForEntity, readWorkspaceMetaCached, type EntityLocation, type WorkspaceDbMode, type WorkspaceLike } from '../db/resolver.js';
// STORE-4b：entity_locator 定位索引维护（repos 挂钩的中心库句柄绑定与创建/删除写入、删表重建路径）
import { bindEntityLocatorCenter, entityLocatorNeedsBackfill, rebuildEntityLocator } from '../db/repos/entityLocator.js';
import { centerSnapshotDir, exportCenterSnapshot, validateCenterSnapshot } from '../services/centerSnapshot.js';
import { requireIssueInWorkspace } from '../services/claim.js';
import { listSkills } from '../services/skills.js';
import type { MinimaxClientProbe } from '../services/accounts/minimaxClientProbe.js';
import { addRelation, listDependencies, removeDependency, unlockCommentsForDeletedBlocker } from '../services/dependency.js';
import type { ExportRunner } from '../services/accounts/credentialImport.js';
import { httpMutation } from '../services/idempotency.js';
import { setMaxConcurrentTurns } from '../services/sessionManager.js';
import { getCachedClis } from '../services/cliDetect.js';
import { attachmentsDirFor, configDir, loadConfig, readSettings, writeSettings, type DbPathSource } from '../config.js';
import {
  patchSettingsSchema,
  dbMigrateSchema,
} from './schemas.js';

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

function requireIssue(db: Db, id: string) {
  const issue = getIssue(db, id);
  if (!issue) throw new NotFoundError('任务不存在');
  return issue;
}

/** name 留空兜底：先去尾部 / 与 \，再按 / 或 \ 分段取最后一段 */
function workspaceNameFromPath(path: string): string {
  const segments = path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]+/)
    .filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1]! : path;
}

// ---- POST /api/system/pick-folder（Windows 原生文件夹选择） ----

/** pick-folder 并发守卫：同一时刻只允许一个选择窗口（finally 复位） */
let pickFolderInFlight = false;

/**
 * PowerShell 弹 FolderBrowserDialog：单引号 PS 字符串、无双引号，-Command 参数整体
 * 经 spawn 参数数组传递不经 shell；OK 时 stdout 只输出 SelectedPath（UTF-8，无换行）。
 */
const PICK_FOLDER_PS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'try{[Console]::OutputEncoding=[System.Text.Encoding]::UTF8}catch{}',
  'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
  '$d=New-Object System.Windows.Forms.FolderBrowserDialog',
  "$d.Description='选择工作空间文件夹'",
  '$d.ShowNewFolderButton=$true',
  'if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($d.SelectedPath)}',
].join('; ');

function pickFolderErrorDetail(stderr: string, fallback: string): string {
  const firstLine = stderr.trim().split(/\r?\n/, 1)[0];
  return (firstLine && firstLine !== '' ? firstLine : fallback).slice(0, 200);
}

/** spawn powershell 弹窗；选中 → 路径，取消/无输出 → null，spawn 或脚本失败 → reject */
function pickFolderViaPowerShell(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', PICK_FOLDER_PS_SCRIPT],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      reject(
        new ApiError(
          500,
          'PICK_FOLDER_FAILED',
          `打开文件夹选择窗口失败: ${pickFolderErrorDetail(stderr, err.message)}`,
        ),
      );
    });
    child.on('close', (code) => {
      const picked = stdout.trim();
      if (picked !== '') {
        resolve(picked);
        return;
      }
      if (code !== 0) {
        reject(
          new ApiError(
            500,
            'PICK_FOLDER_FAILED',
            `打开文件夹选择窗口失败: ${pickFolderErrorDetail(stderr, `exit code ${code}`)}`,
          ),
        );
        return;
      }
      resolve(null); // 用户取消（无输出）
    });
  });
}

/**
 * 默认草稿 runner：直接调适配器的 runTurn（一次性进程），只收集 text 事件。
 * 不建 session 行、不占 claim 槽位；超时由 smartCreateDraft 的 AbortSignal 触发 kill。
 */
function defaultDraftRunner(getAdapter: (cliId: string) => AgentAdapter): DraftRunner {
  return ({ adapter, prompt, cwd, signal }) => new Promise<string>((resolve, reject) => {
    let handle: ReturnType<AgentAdapter['runTurn']>;
    try {
      handle = getAdapter(adapter).runTurn({ cwd, prompt });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let text = '';
    handle.onEvent((event) => {
      if (event.type === 'text') text += event.delta;
    });
    const onAbort = (): void => { void handle.kill().catch(() => {}); };
    signal.addEventListener('abort', onAbort, { once: true });
    handle.result.then((result) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) return;
      if (result.exitCode !== 0) {
        // stderr 尾部最后一行常是 Node 版本横幅，取最后 3 行非空内容更可解释
        const tail = (result.stderrTail ?? []).map(line => line.trim()).filter(line => line !== '').slice(-3).join(' | ');
        reject(new Error(tail === '' ? `适配器退出码 ${result.exitCode}` : `适配器退出码 ${result.exitCode}：${tail}`));
        return;
      }
      resolve(text);
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort);
      if (!signal.aborted) reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
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
  // ---- version ----
  // pid：RESTART-HARDENING —— 客户端据它区分「新进程已接管」与「已回退旧进程」，端口占用检查也靠它识别自身
  router.get('/version', (_req, res) => {
    // PROXY-ENV：出站代理是否生效（只读、脱敏）。客户端/诊断脚本据此判断「为什么外网请求超时」
    const proxy = resolveProxyEnv(process.env);
    res.json({
      name: 'agentboard-server',
      version: SERVER_VERSION,
      pid: process.pid,
      // SERVER-SINGLETON：判定「端口上的实例是不是同一个 DB 的同一个进程」
      instance_id: deps.instance?.instanceId ?? null,
      db_path: deps.instance?.dbPath ?? currentDbPath,
      started_at: deps.instance?.startedAt ?? null,
      proxy_env: { enabled: proxy.enabled, proxy_var: proxy.proxy_var, proxy_host: proxy.proxy_host, node_env_proxy: proxy.node_env_proxy },
      // STORE-1（M1）：排障要能看出「本实例服务哪些库」——中心库 + 当前已打开的工作区库
      db_scope: { center_db_path: deps.instance?.dbPath ?? currentDbPath, localized_open: listOpenWorkspaceDbs() },
    });
  });

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

  // ---- 已安装技能（只读、固定根、不接受路径参数）----
  router.get('/skills', (_req, res) => {
    res.json(listSkills({ root: deps.skillsRoot }));
  });
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
  router.use(createDecisionRouter({ db, broadcast }));

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

  // ---- system ----
  /**
   * STORE-6：中心库全局快照（工作区注册表 / 成员 / 账号与签到元数据 / scope=common 知识页及历史）。
   * 落在中心库同级的 center-snapshot/；账号引用一律 ***（导出后自检，防泄露）。
   */
  router.post('/system/center-snapshot/export', (_req, res) => {
    res.json(exportCenterSnapshot({ db, centerDbPath: currentDbPath ?? db.name }));
  });
  /** STORE-6：只读校验中心库快照（manifest / 哈希 / 行数 / 脱敏自检） */
  router.get('/system/center-snapshot/validate', (_req, res) => {
    const checked = validateCenterSnapshot(centerSnapshotDir(currentDbPath ?? db.name));
    res.json({ ok: true, dir: checked.dir, manifest: checked.manifest, tables: checked.tables });
  });

  // 原生文件夹选择（Windows PowerShell FolderBrowserDialog）；同一时刻仅允许一个窗口
  router.post('/system/pick-folder', async (_req, res) => {
    if (pickFolderInFlight) {
      throw new ApiError(409, 'PICK_FOLDER_BUSY', '已有选择窗口打开');
    }
    pickFolderInFlight = true;
    try {
      res.json({ path: await pickFolderViaPowerShell() });
    } finally {
      pickFolderInFlight = false;
    }
  });

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

  // ---- clis ----
  router.get('/clis', (_req, res) => {
    res.json(getCachedClis());
  });

  router.get('/clis/:id/models', async (req, res) => {
    let adapter: AgentAdapter;
    try {
      adapter = getAdapter(req.params.id!);
    } catch {
      throw new NotFoundError(`未知 CLI: ${req.params.id}`);
    }
    res.json(await adapter.listModels());
  });

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
  }));
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
  // 例外：SQLITE_CONSTRAINT_TRIGGER 是 schema 里 RAISE(ABORT) 主动拒绝（如附件事务回滚保护），
  // 属于服务端内部拒绝而非调用方参数错误，保持既有 500 INTERNAL，不误报成 400。
  const sqliteCode = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  if (typeof sqliteCode === 'string' && sqliteCode.startsWith('SQLITE_CONSTRAINT')) {
    const kind = sqliteCode.slice('SQLITE_CONSTRAINT'.length).replace(/^_/, '') || 'UNKNOWN';
    if (kind !== 'TRIGGER') {
      res.status(400).json({ error: { code: 'CONSTRAINT_VIOLATION', message: `请求违反数据库约束（${kind}）` } });
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

