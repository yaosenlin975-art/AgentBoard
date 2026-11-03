/**
 * Task 9：服务装配与启动。
 *
 * createApp(deps)：supertest 测试注入临时库与 FakeAdapter；
 * main()：真实 bootstrap——initSchema → recoverOnBoot → initSessionManager →
 * sender/broadcaster 装配 → refreshClis → express 路由 + 静态托管 → listen。
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { attachmentsDirFor, loadConfig, readSettings, type AgentBoardRuntimeConfig } from './config.js';
import { SecretVault } from './services/accounts/secretVault.js';
import { recoverAccountOperations } from './services/accounts/operationRunner.js';
import { WorkbuddyDesktopProvider, defaultWorkbuddyPaths, defaultWorkbuddyProbe } from './services/accounts/workbuddyDesktopProvider.js';
import type { CheckinProviderSpec } from './services/accounts/checkinProvider.js';
import { createCheckinProviders } from './services/accounts/httpCheckinProviders.js';
import { MinimaxDesktopProvider, defaultMinimaxPaths } from './services/accounts/minimaxDesktopProvider.js';
import type { MinimaxClientProbe } from './services/accounts/minimaxClientProbe.js';
import type { DraftRunner } from './services/smartCreateDraft.js';
import { spawnDetached, type RestartDeps } from './api/systemRoutes.js';
import { appendServerLog, resolveServerLogPath } from './services/serverLog.js';
import type { ManagedAppId } from '@agentboard/shared';
import type { ExportRunner } from './services/accounts/credentialImport.js';
import type { QuotaService } from './services/quotas/quotaService.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express, { type Express } from 'express';
import { ADAPTERS, getAdapter as defaultGetAdapter, type AgentAdapter } from '@agentboard/adapters';
import type { Db } from './db/connection.js';
import { openDb } from './db/connection.js';
import { initSchema } from './db/schema.js';
import {
  initSessionManager,
  recoverOnBoot,
  sendToSession,
  setBroadcaster,
} from './services/sessionManager.js';
import { setSessionSender } from './services/comments.js';
import { getCachedClis, refreshClis } from './services/cliDetect.js';
import { apiNotFound, createRouter, errorHandler } from './api/routes.js';
import { createWsHub, type WsHub } from './ws/hub.js';
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
  desktopProviders?: Partial<Record<ManagedAppId, MinimaxDesktopProvider>>;
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
  app.use(express.json());
  // 所有 /api 响应带版本头（含后续抛错路径——setHeader 在响应发出前始终生效），供 CLI 零额外请求比对
  app.use('/api', (_req, res, next) => {
    res.setHeader('x-agentboard-version', SERVER_VERSION);
    next();
  });
  app.use('/api', createRouter({ db, getAdapter, secretVault, attachments, broadcast: (event) => hub.broadcast(event), accounts: { workbuddy, checkinProvider: options.checkinProvider, checkinProviders: options.checkinProviders, desktopProviders: options.desktopProviders ?? { minimax: new MinimaxDesktopProvider({ db, vault: secretVault, paths: defaultMinimaxPaths(), ...(options.minimaxClientProbe ? { clientProbe: options.minimaxClientProbe } : {}) }) }, vault: secretVault, quotas: options.quotas, minimaxClientProbe: options.minimaxClientProbe }, knowledgeGraphPageLimit: options.knowledgeGraphPageLimit, skillsRoot: options.skillsRoot, credentialRunner: options.credentialRunner, restart: options.restart, draftRunner: options.draftRunner, draftTimeoutMs: options.draftTimeoutMs }));
  app.use('/api', apiNotFound);

  const webDist = options.webDist ?? null;
  if (webDist && existsSync(webDist)) {
    app.use(express.static(webDist));
    // SPA fallback：非 /api 的 GET 落 index.html
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) {
        next();
        return;
      }
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

/** 真实启动：返回运行句柄（冒烟/后续管理用） */
export async function main(): Promise<StartedServer> {
  const config = loadConfig();
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = openDb(config.dbPath);
  initSchema(db);
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

  const { app, hub, attachments } = await createApp({
    db,
    maxConcurrentTurns: config.maxConcurrentTurns,
    webDist: existsSync(webDist) ? webDist : null,
    attachmentStorageDir,
    attachmentQuotaBytes: config.attachmentQuotaBytes,
    attachmentStagedTtlMs: config.attachmentStagedTtlMs,
    attachmentCleanupIntervalMs: config.attachmentCleanupIntervalMs,
    // 生产装配：三平台真实签到 provider（测试默认不注入，保持 ACC-07 的 gated 语义）
    checkinProviders: createCheckinProviders(),
    restart: {
      spawnChild: spawnDetached,
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

  const server = createServer(app);
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
  const listeningLine = `listening http://${config.host}:${config.port} pid=${process.pid} db=${config.dbPath} attachments=${attachmentStorageDir}`;
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
