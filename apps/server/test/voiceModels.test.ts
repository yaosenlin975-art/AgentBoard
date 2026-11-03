/**
 * VOICE-1：模型管理与下载（不下载真实模型——全部用本地小测试文件 + 注入 catalog/fetch/freeBytes）。
 *
 * 覆盖：清单不触发下载、202 起任务、同 id 幂等复用、进度单调、sha256 校验通过/不符、
 * 空间不足、下载中删除 409、删除后目录消失、未配置 url 明确拒绝、SSE 事件以终态收尾。
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import type { VoiceModelCatalogEntry } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { resetVoiceModelTasks } from '../src/services/voiceModels.js';

const PAYLOAD = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex');

/** 小测试文件服务：slow=true 时按块慢慢吐，便于观察 downloading 中间态 */
async function serveFixture(options: { slow?: boolean; corruptLength?: boolean } = {}): Promise<{ port: number; close: () => Promise<void>; hits: () => number }> {
  let hits = 0;
  const server: Server = createServer(async (req, res) => {
    hits += 1;
    if (req.url === '/missing') {
      res.writeHead(404);
      res.end('nope');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(PAYLOAD.length) });
    if (!options.slow) {
      res.end(PAYLOAD);
      return;
    }
    const chunkSize = 512;
    for (let offset = 0; offset < PAYLOAD.length; offset += chunkSize) {
      res.write(PAYLOAD.subarray(offset, offset + chunkSize));
      await new Promise(r => setTimeout(r, 15));
    }
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    hits: () => hits,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const entry = (port: number, overrides: Partial<VoiceModelCatalogEntry> = {}): VoiceModelCatalogEntry => ({
  id: 'test-model',
  name: '测试模型',
  bytes: PAYLOAD.length,
  size_estimate: false,
  languages: ['zh'],
  url: `http://127.0.0.1:${port}/model.bin`,
  sha256: PAYLOAD_SHA,
  streaming: true,
  note: 'fixture',
  ...overrides,
});

describe('voice models (VOICE-1)', () => {
  let t: TestDb;
  let root: string;
  let app: Express;
  let fixture: Awaited<ReturnType<typeof serveFixture>>;
  let catalog: VoiceModelCatalogEntry[];
  let freeBytes: number | null;
  let fetchCalls: number;

  const openApp = async () => {
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => { if (id === 'fake') return adapter; throw new Error(`未知适配器 id: ${id}`); },
      adapters: [adapter],
      refreshClisOnBoot: false,
      voice: {
        catalog,
        rootDir: root,
        freeBytes: async () => freeBytes,
        fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => { fetchCalls += 1; return fetch(input, init); }) as typeof fetch,
      },
    });
    app = created.app;
  };

  const waitFor = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error('waitFor 超时');
  };

  const progress = async (id = 'test-model') => (await request(app).get(`/api/voice/models/${id}/progress?poll=1`)).body as {
    state: string; bytes: number; total: number; error: string | null; task_id: string | null;
  };

  beforeEach(async () => {
    resetVoiceModelTasks();
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-voice-'));
    fixture = await serveFixture();
    catalog = [entry(fixture.port)];
    freeBytes = 10 * 1024 * 1024;
    fetchCalls = 0;
    await openApp();
  });

  afterEach(async () => {
    await fixture.close();
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('listsCatalogWithoutTriggeringAnyDownload', async () => {
    const res = await request(app).get('/api/voice/models');
    expect(res.status).toBe(200);
    expect(res.body.models).toHaveLength(1);
    expect(res.body.models[0]).toMatchObject({ id: 'test-model', state: 'not_downloaded', downloaded_bytes: 0 });
    // 关键：只读清单绝不发起网络请求
    expect(fetchCalls).toBe(0);
    expect(fixture.hits()).toBe(0);
  });

  it('downloadsToPartThenRenamesAtomicallyWithVerifiedSha', async () => {
    const started = await request(app).post('/api/voice/models/test-model/download').send({});
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ model_id: 'test-model', reused: false, state: 'downloading' });
    const taskId = started.body.task_id as string;
    expect(typeof taskId).toBe('string');

    await waitFor(async () => (await progress()).state === 'downloaded');
    const snapshot = await progress();
    expect(snapshot).toMatchObject({ state: 'downloaded', bytes: PAYLOAD.length, total: PAYLOAD.length, error: null });

    const dir = join(root, 'test-model');
    expect(readdirSync(dir).sort()).toEqual(['model.bin', 'model.meta.json']);
    expect(readFileSync(join(dir, 'model.bin')).equals(PAYLOAD)).toBe(true);
    const meta = JSON.parse(readFileSync(join(dir, 'model.meta.json'), 'utf8')) as { sha256_actual: string; sha256_verified: boolean | null };
    expect(meta.sha256_actual).toBe(PAYLOAD_SHA);
    expect(meta.sha256_verified).toBe(true);

    const list = await request(app).get('/api/voice/models');
    expect(list.body.models[0]).toMatchObject({ state: 'downloaded', downloaded_bytes: PAYLOAD.length, sha256_verified: true });
  });

  it('reusesInFlightTaskOnRepeatedDownloadCalls', async () => {
    await fixture.close();
    fixture = await serveFixture({ slow: true });
    catalog = [entry(fixture.port)];
    await openApp();

    const first = await request(app).post('/api/voice/models/test-model/download').send({});
    const second = await request(app).post('/api/voice/models/test-model/download').send({});
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.task_id).toBe(first.body.task_id);
    expect(second.body.reused).toBe(true);
    // 只有一个下载任务 → 只发一次请求
    await waitFor(async () => (await progress()).state === 'downloaded');
    expect(fixture.hits()).toBe(1);
  });

  it('reportsMonotonicProgressWhileDownloading', async () => {
    await fixture.close();
    fixture = await serveFixture({ slow: true });
    catalog = [entry(fixture.port)];
    await openApp();

    await request(app).post('/api/voice/models/test-model/download').send({});
    const samples: number[] = [];
    await waitFor(async () => {
      const snapshot = await progress();
      samples.push(snapshot.bytes);
      return snapshot.state === 'downloaded';
    });
    expect(samples.length).toBeGreaterThan(1);
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1] as number);
    }
    expect(samples.at(-1)).toBe(PAYLOAD.length);
  });

  it('keepsPartFileAndDoesNotMarkDownloadedWhenChecksumMismatches', async () => {
    catalog = [entry(fixture.port, { sha256: 'deadbeef'.repeat(8) })];
    await openApp();

    await request(app).post('/api/voice/models/test-model/download').send({});
    await waitFor(async () => (await progress()).state === 'failed');
    const snapshot = await progress();
    expect(snapshot.error).toBe('VOICE_CHECKSUM_MISMATCH');
    expect(snapshot.error_message).toContain('sha256 校验不符');

    const dir = join(root, 'test-model');
    // .part 保留（可续/可清理），没有 model.bin、没有 meta
    expect(readdirSync(dir)).toEqual(['model.bin.part']);
    const list = await request(app).get('/api/voice/models');
    expect(list.body.models[0].state).toBe('failed');
    expect(list.body.models[0].sha256_verified).toBeNull();
  });

  it('refusesToStartWhenDiskSpaceIsInsufficient', async () => {
    freeBytes = 1024; // 远小于 payload + 余量
    await request(app).post('/api/voice/models/test-model/download').send({});
    await waitFor(async () => (await progress()).state === 'failed');
    const snapshot = await progress();
    expect(snapshot.error).toBe('VOICE_NO_SPACE');
    expect(snapshot.error_message).toContain('磁盘剩余');
    // 没有发起网络请求，也没留下 .part
    expect(fixture.hits()).toBe(0);
    expect(existsSync(join(root, 'test-model', 'model.bin.part'))).toBe(false);
  });

  it('reportsDownloadFailedOnHttpErrorAndKeepsNoModelFile', async () => {
    catalog = [entry(fixture.port, { url: `http://127.0.0.1:${fixture.port}/missing` })];
    await openApp();
    await request(app).post('/api/voice/models/test-model/download').send({});
    await waitFor(async () => (await progress()).state === 'failed');
    const snapshot = await progress();
    expect(snapshot.error).toBe('VOICE_DOWNLOAD_FAILED');
    expect(existsSync(join(root, 'test-model', 'model.bin'))).toBe(false);
  });

  it('rejectsDeleteWhileDownloadingAndSucceedsAfterwards', async () => {
    await fixture.close();
    fixture = await serveFixture({ slow: true });
    catalog = [entry(fixture.port)];
    await openApp();

    await request(app).post('/api/voice/models/test-model/download').send({});
    const busy = await request(app).delete('/api/voice/models/test-model');
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('VOICE_MODEL_BUSY');

    await waitFor(async () => (await progress()).state === 'downloaded');
    const removed = await request(app).delete('/api/voice/models/test-model');
    expect(removed.status).toBe(200);
    expect(removed.body.deleted).toBe(true);
    expect(existsSync(join(root, 'test-model'))).toBe(false);
    expect((await progress()).state).toBe('not_downloaded');
  });

  it('refusesDownloadWhenCatalogHasNoUrlInsteadOfGuessing', async () => {
    catalog = [entry(fixture.port, { url: null, sha256: null })];
    await openApp();
    const res = await request(app).post('/api/voice/models/test-model/download').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VOICE_MODEL_URL_MISSING');
    expect(fetchCalls).toBe(0);
  });

  it('streamsProgressOverSseAndEndsOnTerminalState', async () => {
    await fixture.close();
    fixture = await serveFixture({ slow: true });
    catalog = [entry(fixture.port)];
    await openApp();

    // SSE 需要真实监听：supertest 的缓冲语义拿不到流式分块
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${port}/api/voice/models/test-model/progress`, { signal: controller.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const started = await request(app).post('/api/voice/models/test-model/download').send({});
      expect(started.status).toBe(202);

      const events: Array<{ state: string; bytes: number }> = [];
      const decoder = new TextDecoder();
      let buffer = '';
      const reader = response.body!.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.split('\n').find(item => item.startsWith('data: '));
          if (line) events.push(JSON.parse(line.slice(6)) as { state: string; bytes: number });
        }
      }
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.at(-1)?.state).toBe('downloaded');
      expect(events.at(-1)?.bytes).toBe(PAYLOAD.length);
      // 单调不减
      for (let i = 1; i < events.length; i += 1) {
        expect(events[i]!.bytes).toBeGreaterThanOrEqual(events[i - 1]!.bytes);
      }
    } finally {
      await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    }
  });
});
