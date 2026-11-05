/**
 * Task 9：服务装配与启动。
 *
 * createApp(deps)：supertest 测试注入临时库与 FakeAdapter；
 * main()：真实 bootstrap——initSchema → recoverOnBoot → initSessionManager →
 * sender/broadcaster 装配 → refreshClis → express 路由 + 静态托管 → listen。
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { attachmentsDirFor, configDir, loadConfig, readSettings, type AgentBoardRuntimeConfig, type DbPathSource } from './config.js';
import { SecretVault } from './services/accounts/secretVault.js';
import { recoverAccountOperations } from './services/accounts/operationRunner.js';
import { WorkbuddyDesktopProvider, defaultWorkbuddyPaths, defaultWorkbuddyProbe } from './services/accounts/workbuddyDesktopProvider.js';
import type { CheckinProviderSpec } from './services/accounts/checkinProvider.js';
import { createCheckinProviders } from './services/accounts/httpCheckinProviders.js';
import { createAddAccountProviders } from './services/accounts/addAccountProvider.js';
import { ApiError } from './errors.js';
import type { AddAccountProviderSpec } from './services/accounts/addAccountProtocol.js';
import { MinimaxDesktopProvider, defaultMinimaxPaths, createMinimaxServerIdentityProbe } from './services/accounts/minimaxDesktopProvider.js';
import { TraeDesktopProvider } from './services/accounts/traeProvider.js';
import type { DesktopProvider } from './api/accountRoutes.js';
import type { MinimaxClientProbe } from './services/accounts/minimaxClientProbe.js';
import type { DraftRunner } from './services/smartCreateDraft.js';
import { spawnDetached, type RestartDeps } from './api/systemRoutes.js';
import { attachVoiceWebSocket, type VoiceRouterOptions } from './api/voiceRoutes.js';
import { appendServerLog, resolveServerLogPath } from './services/serverLog.js';
import { createKnowledgeDeepLinkRoutes } from './api/knowledgeDeepLinkRoutes.js';
import type { ManagedAppId } from '@agentboard/shared';
import type { ExportRunner } from './services/accounts/credentialImport.js';
import type { QuotaService } from './services/quotas/quotaService.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express, { type Express } from 'express';
import { ADAPTERS, getAdapter as defaultGetAdapter, type AgentAdapter } from '@agentboard/adapters';
import type { Db } from './db/connection.js';
import { openDb } from './db/connection.js';
import { closeWorkspaceDbs } from './db/resolver.js';
import { recoverLocalizeGates } from './services/workspaceDbOps.js';
import { acquireServerLock, describeLockHolder, releaseServerLock } from './services/serverLock.js';
import { initSchema } from './db/schema.js';
import {
  initSessionManager,
  recoverOnBoot,
  sendToSession,
  setBroadcaster,
} from './services/sessionManager.js';
import { setSessionSender } from './services/comments.js';
import { sweepExpiredLeases } from './services/claim.js';
import { getCachedClis, refreshClis } from './services/cliDetect.js';
import { apiNotFound, createRouter, errorHandler } from './api/routes.js';
import { createWsHub, type WsHub } from './ws/hub.js';
import { startAwaitingSweeper } from './services/turnAwaiting.js';
import { startDecisionReminderTicker } from './services/decisionReminder.js';
import { startDecisionGraceTicker } from './services/decisionGrace.js';
import { SERVER_VERSION } from './version.js';
import {
  AttachmentStore,
  DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_MS,
  DEFAULT_ATTACHMENT_QUOTA_BYTES,
  DEFAULT_ATTACHMENT_STAGED_TTL_MS,
} from './services/attachments.js';

export interface CreateAppOptions {
  db: Db;
  /** 适配器解析器；默认 @agentboard/adapters 的 getAdapter */
  getAdapter?: (cliId: string) => AgentAdapter;
  maxConcurrentTurns?: number;
  /** detect 探测注入（测试传 FakeAdapter 数组）；默认 ADAPTERS 四家 */
  adapters?: AgentAdapter[];
  /** false 跳过启动探测（测试）；默认 true */
  refreshClisOnBoot?: boolean;
  /** 静态托管目录（apps/web/dist）；提供且存在时启用 SPA fallback；默认不托管 */
  webDist?: string | null;
  secretVault?: SecretVault;
  /** WorkBuddy Desktop provider 注入（测试 fake 环境）；null 显式禁用；缺省 win32 按契约常量构造 */
  workbuddyProvider?: WorkbuddyDesktopProvider | null;
  /**
   * ACC-07 签到 provider：默认不注入（两产品契约 unverified → 端点 409 PROVIDER_UNVERIFIED）；
   * 只有测试/未来契约通过后的装配才传入。
   */
  checkinProvider?: CheckinProviderSpec;
  /** ACC-12：三平台签到 provider（测试可注入 fake fetch / 替换 map） */
  checkinProviders?: Partial<Record<ManagedAppId, CheckinProviderSpec>>;
  /** ACC-13：按平台的桌面 provider（capture/switch）；测试可注入 fake fs/进程 */
  desktopProviders?: Partial<Record<ManagedAppId, DesktopProvider>>;
  /** ACC-KB-B2S：协议级加号的 provider（默认按五平台协议装配；测试可注入替身） */
  addAccountProviders?: Partial<Record<ManagedAppId, AddAccountProviderSpec>>;
  /** SYSTEM-RESTART：生产在 main() 注入真实 spawn/close/exit；测试注入 fake */
  restart?: RestartDeps;
  /** KB-GRAPH 单次页面加载上限（仅测试注入；生产默认 GRAPH_MAX_PAGES=5000） */
  knowledgeGraphPageLimit?: number;
  /** 已安装技能根目录（仅测试注入；生产固定 ~/.agents/skills） */
  skillsRoot?: string;
  /** ACC-11 凭据导出 runner（仅测试注入） */
  credentialRunner?: ExportRunner;
  /** ACC-QUOTA-01 额度聚合（仅测试注入；生产用内置 60s 缓存实现） */
  quotas?: Pick<QuotaService, 'get'>;
  /** MINIMAX-PATH 客户端探测（仅测试注入；生产用内置 60s 缓存实现） */
  minimaxClientProbe?: MinimaxClientProbe;
  /** SMART-CREATE 草稿生成的一次性适配器调用（仅测试注入；生产用 getAdapter().runTurn） */
  draftRunner?: DraftRunner;
  /** SMART-CREATE 草稿生成超时（仅测试注入；生产 120s） */
  draftTimeoutMs?: number;
  /** VOICE-1：语音模型管理依赖（仅测试注入；生产走默认 catalog/目录/fetch） */
  voice?: VoiceRouterOptions;
  /** SERVER-SINGLETON：实例标识（`/api/version` 的 instance_id / db_path / started_at） */
  instance?: { instanceId: string; dbPath: string; startedAt: number };
  /** 启动期解析出的 db 路径来源（存储统计/迁移端点按它报，不在请求期重新解析） */
  dbPathSource?: DbPathSource;
  /** DB-2B：迁移编排注入（生产全部走默认值；测试注入临时状态目录/退出 spy） */
  dbMigration?: {
    stateDir?: string;
    dbPath?: string;
    attachmentStorageDir?: string;
    dbPathSource?: DbPathSource;
    exit?: (code: number) => void;
    schedule?: (fn: () => void, ms: number) => void;
  };
  /** Private image storage directory; production defaults under AgentBoard config dir. */
  attachmentStorageDir?: string;
  attachmentQuotaBytes?: number;
  attachmentStagedTtlMs?: number;
  attachmentCleanupIntervalMs?: number;
}

export interface CreatedApp {
  app: Express;
  hub: WsHub;
  secretVault: SecretVault;
  attachments: AttachmentStore;
}

/** 装配 express app 与 WS hub（重复调用即重建 manager/装配，测试隔离安全） */
export async function createApp(options: CreateAppOptions): Promise<CreatedApp> {
  const db = options.db;
  const secretVault = options.secretVault ?? new SecretVault(resolve(dirname(db.name), 'accounts'));
  const attachments = new AttachmentStore(db, options.attachmentStorageDir ?? resolve(dirname(db.name), 'attachments'), {
    attachmentQuotaBytes: options.attachmentQuotaBytes ?? DEFAULT_ATTACHMENT_QUOTA_BYTES,
    attachmentStagedTtlMs: options.attachmentStagedTtlMs ?? DEFAULT_ATTACHMENT_STAGED_TTL_MS,
    attachmentCleanupIntervalMs: options.attachmentCleanupIntervalMs ?? DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_MS,
  });
  recoverAccountOperations(db);
  // STORE-3a：启动塌缩——上次进程死在迁移中的 localizing 一律落 failed（写闸门生命周期跨进程兜底）；
  // job 表只在内存，启动时不可能有活任务，塌缩恒安全。恢复路径：resume / cleanup。
  recoverLocalizeGates(db);
  const getAdapter: (cliId: string) => AgentAdapter =
    options.getAdapter ?? ((id) => defaultGetAdapter(id as AgentAdapter['id']));

  initSessionManager(db, getAdapter, { maxConcurrentTurns: options.maxConcurrentTurns ?? 3 });

  const hub = createWsHub();
  setBroadcaster(hub.broadcast);
  setSessionSender(sendToSession);

  // WorkBuddy Desktop provider：默认仅 win32 按契约常量装配（构造无副作用；路径/探针见 provider 文件头）
  const workbuddy = options.workbuddyProvider !== undefined
    ? options.workbuddyProvider ?? undefined
    : process.platform === 'win32'
      ? new WorkbuddyDesktopProvider({ db, vault: secretVault, paths: defaultWorkbuddyPaths(), probe: defaultWorkbuddyProbe, broadcast: event => hub.broadcast(event) })
      : undefined;

  // MiniMax 桌面 provider（B4S-3：restore 端点的回滚处理器要用同一个实例，故先建好再装配）
  // S5 的服务端身份校验能力也在这里装配（provider 本身默认不装配 → PROVIDER_NOT_IMPLEMENTED）
  const injectedMinimax = options.desktopProviders?.minimax as MinimaxDesktopProvider | undefined;
  const minimaxProvider: MinimaxDesktopProvider = injectedMinimax
    ?? new MinimaxDesktopProvider({ db, vault: secretVault, paths: defaultMinimaxPaths(), serverIdentityProbe: createMinimaxServerIdentityProbe(), ...(options.minimaxClientProbe ? { clientProbe: options.minimaxClientProbe } : {}) });
  // ACC-GET：Trae 捕获 provider（只读 storage.json；能力表在 registry 按 storage 是否存在给出 true/false）
  const traeProvider = new TraeDesktopProvider({ db, vault: secretVault });

  // DB-2B：迁移编排依赖（缺省由路由自行推导：stateDir=configDir、dbPath=db.name）
  const migration = options.dbMigration ?? {};
  const migrationDeps = {
    // 附件目录与 AttachmentStore 用同一个值（存储统计/迁移都按它算，不各自推导）
    attachmentStorageDir: migration.attachmentStorageDir ?? attachments.storageDir,
    // 来源取启动期解析结果：readSettings 首读会把默认值写回 config.json（含 dbPath），
    // 请求期再 loadConfig 会把 default 误判成 settings。
    ...(options.dbPathSource !== undefined ? { dbPathSource: options.dbPathSource } : {}),
    ...(options.instance !== undefined ? { instance: options.instance } : {}),
    ...(migration.stateDir !== undefined ? { dbMigrationStateDir: migration.stateDir } : {}),
    ...(migration.dbPath !== undefined ? { dbPath: migration.dbPath } : {}),
    ...(migration.dbPathSource !== undefined ? { dbPathSource: migration.dbPathSource } : {}),
    ...(migration.exit !== undefined ? { dbMigrationExit: migration.exit } : {}),
    ...(migration.schedule !== undefined ? { dbMigrationSchedule: migration.schedule } : {}),
  };

  if (options.refreshClisOnBoot !== false) {
    await refreshClis(options.adapters ?? ADAPTERS);
    hub.broadcast({ type: 'clis.changed', clis: getCachedClis() });
  }

  const app = express();
  // KB-IMG-1：启动后后台回收没有行引用的孤儿图片文件（失败不影响启动）
  void (async () => {
    try {
      const { createKnowledgeImageStore } = await import('./services/knowledgeImages.js');
      await createKnowledgeImageStore({ db }).sweepOrphans();
    } catch { /* 回收失败不影响服务 */ }
  })();
  // KBIMP-1B：导入端点单独放宽请求体上限。全局 parser 在路由之前执行，100kb 会先把
  // 「单次 ≤1MB / 单页 ≤100000 字符」的导入判成 413，路由级 parser 永远拿不到 body。
  // IMPORT-LIMIT-S：单文件上限 10MB，JSON 转义膨胀约 1.1–1.4 倍 → 请求体上限 12MB（其余端点仍 100kb）
  app.use('/api/knowledge/pages/import', express.json({ limit: '12mb' }));
  app.use(express.json());
  // 所有 /api 响应带版本头（含后续抛错路径——setHeader 在响应发出前始终生效），供 CLI 零额外请求比对
  app.use('/api', (_req, res, next) => {
    res.setHeader('x-agentboard-version', SERVER_VERSION);
    next();
  });
  app.use('/api', createRouter({ db, getAdapter, secretVault, attachments, broadcast: (event) => hub.broadcast(event), accounts: { workbuddy, checkinProvider: options.checkinProvider, checkinProviders: options.checkinProviders, desktopProviders: { ...options.desktopProviders, minimax: minimaxProvider, trae: options.desktopProviders?.trae ?? traeProvider } as unknown as Partial<Record<ManagedAppId, Pick<WorkbuddyDesktopProvider, 'captureCurrent' | 'switchAccount'>>>, vault: secretVault, quotas: options.quotas, minimaxClientProbe: options.minimaxClientProbe, addAccountProviders: options.addAccountProviders ?? createAddAccountProviders(), restoreHandlers: { minimax: async ({ account, snapshotRef }) => { if (!snapshotRef) throw new ApiError(409, 'SNAPSHOT_MISSING', '缺少恢复依据快照，无法回滚'); await minimaxProvider.restoreFromSnapshot({ account, snapshotRef }); } } }, knowledgeGraphPageLimit: options.knowledgeGraphPageLimit, skillsRoot: options.skillsRoot, credentialRunner: options.credentialRunner, restart: options.restart, draftRunner: options.draftRunner, draftTimeoutMs: options.draftTimeoutMs, voice: options.voice, ...migrationDeps }));
  app.use('/api', apiNotFound);

  const webDist = options.webDist ?? null;
  if (webDist && existsSync(webDist)) {
    // CHUNK-CACHE：带 hash 的构建产物（chunk/字体/图标）可长缓存；HTML 必须 no-cache，
    // 否则旧页面会继续引用已被重建替换掉的旧 hash chunk（浏览器报 Failed to fetch dynamically imported module）。
    const HASHED_ASSET = /-[A-Za-z0-9_-]{8,}\.(?:js|css|mjs|woff2?|ttf|png|jpe?g|gif|svg|webp|avif|ico)$/;
    const assetsDir = join(webDist, 'assets');
    if (existsSync(assetsDir)) {
      app.use('/assets', express.static(assetsDir, { index: false, immutable: true, maxAge: '365d', fallthrough: true }));
      // 未命中的 /assets/* 必须真 404（text/plain），不能被下面的 SPA fallback 兜成 HTML 200：
      // 浏览器把 HTML 当 JS 解析时报的是语法/模块错误，掩盖「chunk 不存在」这个真实原因。
      app.use('/assets', (_req, res) => {
        res.status(404).type('text/plain').send('Asset not found');
      });
    }
    app.use(express.static(webDist, {
      index: false,
      setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', HASHED_ASSET.test(basename(filePath)) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }));
    // BORROW-3.2：知识深链（/k/:id/:slug 与 /k/:id）——uuid 预检三态（404/410/回壳），先于 SPA fallback
    app.use(createKnowledgeDeepLinkRoutes(db, webDist));
    // SPA fallback：非 /api 的 GET 落 index.html（HTML 一律 no-cache，允许 304）
    // 根路径显式给 index.html：serve-static 关掉 index 后 `/` 不进 fallback（实测 404），这里补一条
    app.get('/', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(webDist, 'index.html'), (err) => {
        if (err) res.status(404).type('text/plain').send('index.html missing');
      });
    });
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) {
        next();
        return;
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(webDist, 'index.html'), (err) => {
        if (err) next(err);
      });
    });
  }

  app.use(errorHandler);
  return { app, hub, secretVault, attachments };
}

export interface StartedServer {
  server: ReturnType<typeof createServer>;
  hub: WsHub;
  config: AgentBoardRuntimeConfig;
  db: Db;
}

/**
 * STORE-2a（D6）：进程退出前关掉全部工作区库句柄（wal checkpoint + close + 释放每工作区锁）。
 * 生产挂 process 'exit'（SIGINT/SIGTERM 的 process.exit 也会触发该钩子）；测试注入 register 捕获钩子验证。
 */
export function wireWorkspaceDbCloseOnExit(
  instanceId: string,
  register: (hook: () => void) => void = (hook) => { process.on('exit', hook); },
): void {
  register(() => { closeWorkspaceDbs(instanceId); });
}

/** 真实启动：返回运行句柄（冒烟/后续管理用） */
export async function main(): Promise<StartedServer> {
  const config = loadConfig();
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = openDb(config.dbPath);
  initSchema(db);
  // BORROW-0.2：启动清租——上次进程异常退出遗留的占用租约统一过闸（只清占用、任务保留「进行中」、system 评论留痕）
  const sweptLeases = sweepExpiredLeases(db);
  if (sweptLeases > 0) appendServerLog(`启动清理过期占用租约：${sweptLeases} 个任务释放占用`);
  await recoverOnBoot(db);

  // apps/server/{src,dist}/../../web/dist
  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = join(here, '..', '..', 'web', 'dist');

  // DOCKER-2：附件目录与 DB 同目录派生（容器里只挂 /data 即可）；目录不存在则创建，不可写直接报错退出
  const attachmentStorageDir = attachmentsDirFor(config.dbPath);
  try {
    mkdirSync(attachmentStorageDir, { recursive: true });
  } catch (error) {
    throw new Error(
      `附件目录不可用：${attachmentStorageDir}（${error instanceof Error ? error.message : String(error)}）`,
      { cause: error },
    );
  }

  // SERVER-SINGLETON：单例锁。**必须先于 openDb**——同一个 DB 被两个进程打开会互相踩 WAL。
  const instanceId = `inst-${process.pid.toString(36)}-${Date.now().toString(36)}`;
  const startedAt = Date.now();
  // SERVER-SINGLETON：`POST /api/system/restart` 的接班进程带 AGENTBOARD_RESTART_FROM（前任 pid），
  // 允许受让「前任还活着但正在退出」的那把锁；普通 `server:ensure` 不带，仍然拒绝双开。
  const restartFrom = Number(process.env.AGENTBOARD_RESTART_FROM ?? '');
  const lock = acquireServerLock({
    configDir: configDir(),
    dbPath: config.dbPath,
    port: config.port,
    instanceId,
    now: () => startedAt,
    ...(Number.isInteger(restartFrom) && restartFrom > 0 ? { takeoverFrom: [restartFrom] } : {}),
  });
  if (!lock.ok) {
    const holderText = lock.holder === null ? '未知持有者' : describeLockHolder(lock.holder);
    const reasonText = lock.reason === 'held-by-live'
      ? '同一 configDir 已有活着的看板实例'
      : '无法写入单例锁文件（检查目录权限）';
    console.error(`[agentboard] 拒绝启动：${reasonText}。持有者：${holderText}`);
    console.error('[agentboard] 单例口径：同 DB / 同 configDir 只能有一个实例；需要多开请换 APPDATA（configDir）与 AGENTBOARD_DB 并监听不同端口');
    process.exit(4);
  }
  if (lock.tookOver !== null) {
    appendServerLog(`单例锁接管：旧持有者 ${describeLockHolder(lock.tookOver)} 已不存在，由 pid ${process.pid} 接管`);
  }
  process.on('exit', () => { releaseServerLock(configDir(), { instanceId }); });
  // STORE-2a（D6）：退出钩子关全部工作区库句柄（SIGINT/SIGTERM 的 process.exit 同样会触发 exit 钩子）
  wireWorkspaceDbCloseOnExit(instanceId);
  // SIGINT/SIGTERM 是能捕获的退出（Windows 的 Stop-Process -Force 走 TerminateProcess，捕获不到 →
  // 靠下一次启动时「陈旧锁接管」兜底）。
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      releaseServerLock(configDir(), { instanceId });
      process.exit(0);
    });
  }

  const { app, hub, attachments } = await createApp({
    db,
    dbPathSource: config.dbPathSource,
    instance: { instanceId, dbPath: config.dbPath, startedAt },
    maxConcurrentTurns: config.maxConcurrentTurns,
    webDist: existsSync(webDist) ? webDist : null,
    attachmentStorageDir,
    attachmentQuotaBytes: config.attachmentQuotaBytes,
    attachmentStagedTtlMs: config.attachmentStagedTtlMs,
    attachmentCleanupIntervalMs: config.attachmentCleanupIntervalMs,
    // 生产装配：三平台真实签到 provider（测试默认不注入，保持 ACC-07 的 gated 语义）
    checkinProviders: createCheckinProviders({ region: config.workbuddyRegion }),
    restart: {
      // SERVER-SINGLETON：接班进程带上前任 pid，才允许受让「前任还活着但正在退出」的锁
      spawnChild: (command, args) => spawnDetached(command, args, undefined, { AGENTBOARD_RESTART_FROM: String(process.pid) }),
      closeServer: () => new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
      // RESTART-HARDENING：新进程没接管就回退旧监听，旧进程不退出
      reopenServer: () => new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => { server.off('listening', onListening); reject(error); };
        const onListening = (): void => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(config.port, config.host);
      }),
      // 交接完成后延迟一拍退出：closeAllConnections 之后立刻 process.exit 会在 libuv 关闭
      // async handle 的过程中触发 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
      // （日志里看起来像崩溃，实际是主动退出）。100ms 让关闭回调先跑完。
      exit: code => { setTimeout(() => process.exit(code), 100); },
      // 前置检查的目标端口 = 子进程将绑定的端口（env 覆盖优先，其次 config.json 现值）：
      // 设置页改过端口但还没重启时，子进程会去绑新端口，此时若新端口被别人占着就该 409，
      // 而不是先关掉自己再失败。
      port: () => Number(process.env.AGENTBOARD_PORT ?? readSettings().port),
      logPath: () => resolveServerLogPath(),
      log: (line: string) => appendServerLog(line),
    },
  });

  // CHAT-AWAIT1：阻塞态心跳 + 超时兜底（周期刷新 awaiting 心跳；超阈值收口 failed(awaiting_timeout)）
  startAwaitingSweeper(db, event => hub.broadcast(event));
  // DEC-WIRE：宽限计时器（2 秒级；内部先做一次启动补算，grace_until 已过的立即落锁）
  startDecisionGraceTicker(db, { broadcast: event => hub.broadcast(event) });
  // DEC-8：锁后分级提醒（4h/24h/72h，档位只前进不重复；不改决策状态、不自动解锁）
  startDecisionReminderTicker(db, {
    broadcast: event => hub.broadcast(event),
    onRemind: entry => appendServerLog(`decision-reminder ${entry.decision_id} level=${entry.to_level}(${entry.label}) issue=${entry.issue_id}`),
  });

  const server = createServer(app);
  // VOICE-2：语音会话 WS 必须先于 hub 注册（hub 会 destroy 非 /ws 的 upgrade）
  attachVoiceWebSocket(server, db);
  hub.attach(server);
  // SYSTEM-RESTART：新进程可能比旧进程先起来，遇到 EADDRINUSE 时重试等端口让出（最多 5s）
  for (let attempt = 0; ; attempt += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException): void => { server.off('listening', onListening); reject(error); };
        const onListening = (): void => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(config.port, config.host);
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt >= 20) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  attachments.startCleanupWorker();
  // RESTART-HARDENING：启动首行必落固定日志（stdout 在 detached/端点启动时会被丢弃）
  // DB-1：首行必须打印「实际生效的库路径 + 来源」，否则「为什么用的是这个库」无从判断
  const listeningLine = `listening http://${config.host}:${config.port} pid=${process.pid} db=${config.dbPath} db_source=${config.dbPathSource} attachments=${attachmentStorageDir}`;
  appendServerLog(listeningLine);
  console.log(`AgentBoard listening on http://${config.host}:${config.port} (db: ${config.dbPath}, attachments: ${attachmentStorageDir})`);
  return { server, hub, config, db };
}

// 直接运行（node dist/index.js）时启动；被 import 时不产生副作用
const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  main().catch((err) => {
    // 启动失败同样落盘：此前只有被丢弃的 stderr，事后无法归因
    appendServerLog(`启动失败 pid=${process.pid}：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    console.error(err);
    process.exit(1);
  });
}
