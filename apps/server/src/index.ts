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
import { configDir, loadConfig, type AgentBoardConfig } from './config.js';
import { SecretVault } from './services/accounts/secretVault.js';
import { recoverAccountOperations } from './services/accounts/operationRunner.js';
import { WorkbuddyDesktopProvider, defaultWorkbuddyPaths, defaultWorkbuddyProbe } from './services/accounts/workbuddyDesktopProvider.js';
import type { CheckinProviderSpec } from './services/accounts/checkinProvider.js';
import type { ExportRunner } from './services/accounts/credentialImport.js';
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
  /** KB-GRAPH 单次页面加载上限（仅测试注入；生产默认 GRAPH_MAX_PAGES=5000） */
  knowledgeGraphPageLimit?: number;
  /** 已安装技能根目录（仅测试注入；生产固定 ~/.agents/skills） */
  skillsRoot?: string;
  /** ACC-11 凭据导出 runner（仅测试注入） */
  credentialRunner?: ExportRunner;
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
  app.use(express.json());
  // 所有 /api 响应带版本头（含后续抛错路径——setHeader 在响应发出前始终生效），供 CLI 零额外请求比对
  app.use('/api', (_req, res, next) => {
    res.setHeader('x-agentboard-version', SERVER_VERSION);
    next();
  });
  app.use('/api', createRouter({ db, getAdapter, secretVault, attachments, broadcast: (event) => hub.broadcast(event), accounts: { workbuddy, checkinProvider: options.checkinProvider, vault: secretVault }, knowledgeGraphPageLimit: options.knowledgeGraphPageLimit, skillsRoot: options.skillsRoot, credentialRunner: options.credentialRunner }));
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
  config: AgentBoardConfig;
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

  const { app, hub, attachments } = await createApp({
    db,
    maxConcurrentTurns: config.maxConcurrentTurns,
    webDist: existsSync(webDist) ? webDist : null,
    attachmentStorageDir: join(configDir(), 'attachments'),
    attachmentQuotaBytes: config.attachmentQuotaBytes,
    attachmentStagedTtlMs: config.attachmentStagedTtlMs,
    attachmentCleanupIntervalMs: config.attachmentCleanupIntervalMs,
  });

  const server = createServer(app);
  hub.attach(server);
  await new Promise<void>((resolve) => {
    server.listen(config.port, '127.0.0.1', resolve);
  });
  attachments.startCleanupWorker();
  console.log(`AgentBoard listening on http://127.0.0.1:${config.port} (db: ${config.dbPath})`);
  return { server, hub, config, db };
}

// 直接运行（node dist/index.js）时启动；被 import 时不产生副作用
const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
