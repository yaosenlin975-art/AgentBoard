/**
 * IMG-04 隔离 fixture 服务（端口默认 18789）。
 *
 * 隔离边界：独立 DB 文件、独立附件根、独立合成工作区、独立端口；不读写 8787 的库/目录/附件根，
 * 不调用任何真实 CLI / 真实账号 / 真实模型推理——适配器是本文件内的测试替身（FakeAdapter）。
 *
 * 启动：node apps/server/test/fixtures/img04FixtureServer.mjs
 * 环境变量：
 *   IMGFIX_PORT   监听端口（默认 18789）
 *   IMGFIX_ROOT   fixture 根目录（默认 apps/server/test/.fixture-img04）
 *
 * 控制：
 *   写 <root>/fail-next 文件 → 下一轮适配器调用强制失败（exit 1），用于验证 unknown/待读不推进
 *   适配器每次调用追加一行 JSON 到 <root>/adapter-calls.jsonl（含 prompt / 图片列表 / 字节数）
 */
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../dist/index.js';
import { openDb } from '../../dist/db/connection.js';
import { initSchema } from '../../dist/db/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.IMGFIX_ROOT ?? join(here, '..', '.fixture-img04'));
const port = Number(process.env.IMGFIX_PORT ?? 18789);
const dbPath = join(root, 'db', 'agentboard.db');
const attachmentsDir = join(root, 'attachments');
const workspaceDir = join(root, 'workspace');
const callsPath = join(root, 'adapter-calls.jsonl');
const failNextPath = join(root, 'fail-next');

for (const dir of [dirname(dbPath), attachmentsDir, workspaceDir]) mkdirSync(dir, { recursive: true });

/**
 * 测试替身适配器：版本门禁行为与已验证组合一致（CodeBuddy 2.179.2 + minimax-m3.1-flash），
 * 但绝不 spawn 真实 CLI、绝不发起模型推理请求。
 */
let callIndex = 0;
const fakeAdapter = {
  id: 'codebuddy',
  displayName: 'Fixture Fake CodeBuddy',
  supportsModelSelection: true,
  supportsImageInput(model, cliVersion) {
    return model === 'minimax-m3.1-flash' && cliVersion === '2.179.2';
  },
  async detect() {
    return { installed: true, version: '2.179.2' };
  },
  async listModels() {
    return [{ id: 'minimax-m3.1-flash', source: 'static' }];
  },
  runTurn(opts) {
    const index = callIndex++;
    const attachments = (opts.attachments ?? []).map((a) => ({
      path: a.path,
      mimeType: a.mimeType,
      size_bytes: statSync(a.path).size,
    }));
    const record = {
      call_index: index,
      at: new Date().toISOString(),
      cwd: opts.cwd,
      model: opts.model ?? null,
      adapter_session_id: opts.adapterSessionId ?? null,
      detected_cli_version: opts.detectedCliVersion ?? null,
      prompt: opts.prompt,
      attachment_count: attachments.length,
      attachment_total_bytes: attachments.reduce((sum, a) => sum + a.size_bytes, 0),
      attachments,
    };
    appendFileSync(callsPath, `${JSON.stringify(record)}\n`, 'utf8');

    let listener = null;
    let settled = false;
    let resolveResult;
    const result = new Promise((r) => {
      resolveResult = r;
    });
    const finish = (code, adapterSessionId) => {
      if (settled) return;
      settled = true;
      listener?.({ type: 'end', exitCode: code });
      resolveResult({ exitCode: code, adapterSessionId });
    };
    setTimeout(() => {
      let forcedFailure = false;
      try {
        forcedFailure = existsSync(failNextPath);
        if (forcedFailure) rmSync(failNextPath);
      } catch {
        forcedFailure = false;
      }
      if (forcedFailure) {
        listener?.({ type: 'error', message: 'fixture: 强制失败（fail-next）' });
        finish(1, null);
        return;
      }
      listener?.({ type: 'text', delta: `[fixture] 第${index + 1}轮收到 ${attachments.length} 张图片` });
      finish(0, `fixture-as-${index + 1}`);
    }, 10);
    return {
      onEvent(cb) {
        listener = cb;
      },
      async kill() {
        finish(130, null);
      },
      result,
    };
  },
};

const db = openDb(dbPath);
initSchema(db);
const { app, hub } = await createApp({
  db,
  getAdapter: () => fakeAdapter,
  // 让 /api/clis 与 /api/clis/:id/models 反映替身适配器（浏览器验收需要选到 codebuddy + minimax-m3.1-flash）；
  // 仍不 spawn 真实 CLI、不发起推理。
  adapters: [fakeAdapter],
  refreshClisOnBoot: true,
  maxConcurrentTurns: 2,
  attachmentStorageDir: attachmentsDir,
  webDist: null,
});

const server = createServer(app);
// 与 apps/server 入口一致：把 WS hub 挂到同一 http server，浏览器才能收到 comment.delivery.changed 等实时事件
hub.attach(server);
await new Promise((r) => server.listen(port, '127.0.0.1', r));

const info = {
  port,
  pid: process.pid,
  root,
  dbPath,
  attachmentsDir,
  workspaceDir,
  callsPath,
  base_url: `http://127.0.0.1:${port}`,
};
writeFileSync(join(root, 'fixture.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
console.log(`FIXTURE_READY ${JSON.stringify(info)}`);

function shutdown() {
  server.close(() => {
    try {
      db.close();
    } catch {
      // 关闭失败不阻塞退出
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
