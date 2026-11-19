/**
 * G4：客户端错误上报端点（`POST /api/client-diagnostics`）。
 *
 * 背景：桌面端偶尔白屏（React 无 ErrorBoundary → 整树卸载），release 无 devtools 时无法取证。
 * 本端点写独立 JSONL 日志。测试关注三件易漏的事：
 * - 限流后日志里**只有 20 条内容 + 1 条限流记录**（不记被丢弃的内容）
 * - 日志落在 `<configDir>/logs/` 下、**不落安装根**（防回退 D6 的 bug）
 * - 轮转固定名 `.1`（与 D14 的 main.log 同口径）
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClientDiagnosticsRouter, resetClientDiagnosticsRateLimit } from '../src/api/routes/clientDiagnosticsRoutes.js';
import { appendWithRotation, CLIENT_LOG_MAX_BYTES, resolveClientLogPath } from '../src/services/clientDiagnosticsLog.js';
import { errorHandler } from '../src/api/routes.js';

const BASE = {
  instance_id: 'inst-test-1',
  kind: 'react' as const,
  message: '渲染崩溃：Cannot read properties of undefined',
  stack: 'at Board (board.tsx:42)\nat render (react-dom.js:1)',
  source: 'board.tsx',
  url: 'app://index.html#/board',
  user_agent: 'Mozilla/5.0 AgentBoard',
  client_ts: 1794890000000,
  app_version: '0.1.0',
};

describe('G4 客户端错误上报端点', () => {
  let dir: string;
  let logPath: string;
  let app: Express;

  beforeEach(() => {
    resetClientDiagnosticsRateLimit();
    dir = mkdtempSync(join(tmpdir(), 'agentboard-cd-'));
    logPath = join(dir, 'logs', 'client-error.log');
    app = express();
    app.use(express.json());
    app.use('/api', createClientDiagnosticsRouter({ appendLog: line => appendWithRotation(logPath, line) }));
    app.use(errorHandler);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const lines = (): string[] => (existsSync(logPath) ? readFileSync(logPath, 'utf8').trimEnd().split('\n') : []);

  it('正常上报 → 200 且文件新增一行、JSON 可解析、字段完整', async () => {
    const res = await request(app).post('/api/client-diagnostics').send({ ...BASE, context: { view: 'board' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const rows = lines();
    expect(rows).toHaveLength(1);
    const parsed = JSON.parse(rows[0]!) as Record<string, unknown>;
    expect(parsed.instance_id).toBe(BASE.instance_id);
    expect(parsed.kind).toBe('react');
    expect(parsed.message).toBe(BASE.message);
    expect(parsed.stack).toBe(BASE.stack);
    expect(parsed.client_ts).toBe(BASE.client_ts);
    expect(parsed.app_version).toBe('0.1.0');
    expect(parsed.context).toEqual({ view: 'board' });
    // 服务端另记 received_at，客户端时间戳原样保留
    expect(typeof parsed.received_at).toBe('string');
    expect(new Date(parsed.received_at as string).toISOString()).toBe(parsed.received_at);
  });

  it('message 超长（> 2000）→ 400 且不写文件', async () => {
    const res = await request(app).post('/api/client-diagnostics').send({ ...BASE, message: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(lines()).toHaveLength(0);
  });

  it('未知字段 → 400（.strict()）', async () => {
    const res = await request(app).post('/api/client-diagnostics').send({ ...BASE, bogus: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('bogus');
    expect(lines()).toHaveLength(0);
  });

  it('限流：前 20 次 200，第 21 次 429，日志只有 20 条内容 + 1 条限流记录', async () => {
    for (let i = 0; i < 20; i += 1) {
      const ok = await request(app).post('/api/client-diagnostics').send({ ...BASE, message: `第 ${i + 1} 条` });
      expect(ok.status).toBe(200);
    }
    const limited = await request(app).post('/api/client-diagnostics').send({ ...BASE, message: '第 21 条应被丢弃' });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('CLIENT_DIAGNOSTICS_RATE_LIMITED');
    // 继续刷屏（第 22、23 次）仍 429，且不得再写限流记录——否则限流记录自己成了刷屏源
    for (const n of [22, 23]) {
      const more = await request(app).post('/api/client-diagnostics').send({ ...BASE, message: `第 ${n} 条应被丢弃` });
      expect(more.status).toBe(429);
    }

    const rows = lines();
    // 20 条内容 + 1 条限流记录
    expect(rows).toHaveLength(21);
    const content = rows.filter(row => !row.startsWith('rate_limit:'));
    expect(content).toHaveLength(20);
    // 被丢弃的内容不得出现在日志里
    expect(rows.join('\n')).not.toContain('第 21 条应被丢弃');
    expect(rows.join('\n')).not.toContain('第 22 条应被丢弃');
    // 限流记录只有一条
    expect(rows.filter(row => row.startsWith('rate_limit:'))).toHaveLength(1);
  });

  it('限流窗口过期后恢复放行', async () => {
    let clock = 1_000_000;
    const scoped = express();
    scoped.use(express.json());
    scoped.use('/api', createClientDiagnosticsRouter({ appendLog: line => appendWithRotation(logPath, line), now: () => clock }));
    scoped.use(errorHandler);
    for (let i = 0; i < 20; i += 1) {
      expect((await request(scoped).post('/api/client-diagnostics').send(BASE)).status).toBe(200);
    }
    expect((await request(scoped).post('/api/client-diagnostics').send(BASE)).status).toBe(429);
    clock += 60_000;
    expect((await request(scoped).post('/api/client-diagnostics').send(BASE)).status).toBe(200);
  });

  it('轮转：预置 5MB+ 文件 → 新写入产生 .1，且 .1 是旧内容', async () => {
    mkdirSync(join(dir, 'logs'), { recursive: true });
    const oldContent = `${'A'.repeat(1024)}\n`.repeat(Math.ceil(CLIENT_LOG_MAX_BYTES / 1025) + 1);
    writeFileSync(logPath, oldContent, 'utf8');
    expect(statSync(logPath).size).toBeGreaterThan(CLIENT_LOG_MAX_BYTES);

    const res = await request(app).post('/api/client-diagnostics').send(BASE);
    expect(res.status).toBe(200);

    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(readFileSync(`${logPath}.1`, 'utf8')).toBe(oldContent);
    // 主文件只剩新写入的那一行
    expect(lines()).toHaveLength(1);
    expect(JSON.parse(lines()[0]!).message).toBe(BASE.message);
  });

  it('路径：落在 configDir 的 logs/ 下，不落安装根', () => {
    const previous = process.env.APPDATA;
    const fakeAppData = join(dir, 'AppData', 'Roaming');
    process.env.APPDATA = fakeAppData;
    try {
      const resolved = resolveClientLogPath();
      // 严格等于 <APPDATA>/AgentBoard/logs/client-error.log
      expect(resolved).toBe(join(fakeAppData, 'AgentBoard', 'logs', 'client-error.log'));
      // 不含 repo / 安装根成分
      expect(resolved).not.toContain('.agentboard');
      expect(resolved).not.toContain(join('AgentBoard', 'app'));
      expect(resolved.startsWith(fakeAppData)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previous;
    }
  });
});
