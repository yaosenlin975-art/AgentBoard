/**
 * Task 9：服务装配与启动。
 *
 * createApp(deps)：supertest 测试注入临时库与 FakeAdapter；
 * main()：真实 bootstrap——initSchema → recoverOnBoot → initSessionManager →
 * sender/broadcaster 装配 → refreshClis → express 路由 + 静态托管 → listen。
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express, { type Express } from 'express';
import { ADAPTERS, getAdapter as defaultGetAdapter, type AgentAdapter } from '@agentboard/adapters';
import type { Db } from './db/connection.js';
import { openDb } from './db/connection.js';
import { initSchema } from './db/schema.js';
import { loadConfig, type AgentBoardConfig } from './config.js';
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
}

export interface CreatedApp {
  app: Express;
  hub: WsHub;
}

/** 装配 express app 与 WS hub（重复调用即重建 manager/装配，测试隔离安全） */
export async function createApp(options: CreateAppOptions): Promise<CreatedApp> {
  const db = options.db;
  const getAdapter: (cliId: string) => AgentAdapter =
    options.getAdapter ?? ((id) => defaultGetAdapter(id as AgentAdapter['id']));

  initSessionManager(db, getAdapter, { maxConcurrentTurns: options.maxConcurrentTurns ?? 3 });

  const hub = createWsHub();
  setBroadcaster(hub.broadcast);
  setSessionSender(sendToSession);

  if (options.refreshClisOnBoot !== false) {
    await refreshClis(options.adapters ?? ADAPTERS);
    hub.broadcast({ type: 'clis.changed', clis: getCachedClis() });
  }

  const app = express();
  app.use(express.json());
  app.use('/api', createRouter({ db, getAdapter, broadcast: (event) => hub.broadcast(event) }));
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
  return { app, hub };
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

  const { app, hub } = await createApp({
    db,
    maxConcurrentTurns: config.maxConcurrentTurns,
    webDist: existsSync(webDist) ? webDist : null,
  });

  const server = createServer(app);
  hub.attach(server);
  await new Promise<void>((resolve) => {
    server.listen(config.port, '127.0.0.1', resolve);
  });
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
