/**
 * VOICE-2：识别会话（不下载真实模型；识别器用注入的假实现）。
 *
 * 关键断言：
 * - 无模型 → 409 `VOICE_MODEL_MISSING`，且**没有加载原生模块**（require.cache 无 sherpa-onnx-node，loader 未被调用）；
 * - WS 握手 + 二进制帧（Float32LE 16k）被正确接收，partial 递增、final 收尾；
 * - stop 返回最终文本；串行队列给 `queued` 事件；空转超时自动 final 关闭；
 * - 语言不支持 → 409 `VOICE_LANGUAGE_UNSUPPORTED`。
 */
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import WebSocket from 'ws';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import type { VoiceModelCatalogEntry } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { attachVoiceWebSocket } from '../src/api/voiceRoutes.js';
import { createWsHub } from '../src/ws/hub.js';
import {
  resetVoiceSessions,
  type VoiceRecognizerHandle,
  type VoiceRecognizerLoader,
} from '../src/services/voiceSessions.js';
import { resetVoiceModelTasks } from '../src/services/voiceModels.js';

const requireFromHere = createRequire(import.meta.url);
const nativeLoaded = (): boolean =>
  Object.keys(requireFromHere.cache).some((key) => key.includes('sherpa-onnx-node'));

const CATALOG: VoiceModelCatalogEntry[] = [{
  id: 'fake-model',
  name: '假模型',
  bytes: 1024,
  size_estimate: false,
  languages: ['zh', 'en'],
  url: null,
  sha256: null,
  streaming: true,
  note: 'fixture',
}];

/** 假识别器：把收到的采样数当识别结果，便于断言帧数与顺序 */
function createFakeLoader(loads: { count: number }): VoiceRecognizerLoader {
  return async (): Promise<VoiceRecognizerHandle> => {
    loads.count += 1;
    let total = 0;
    return {
      createStream() {
        let text = '';
        return {
          acceptWaveform(_sampleRate: number, samples: Float32Array) { total += samples.length; },
          isReady() { return true; },
          decode() { text = `heard:${total}`; },
          getText() { return text; },
          free() { /* noop */ },
        };
      },
      free() { /* noop */ },
    };
  };
}

const float32Frame = (samples: number[]): Buffer => {
  const buffer = Buffer.alloc(samples.length * 4);
  samples.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
};

describe('voice sessions (VOICE-2)', () => {
  let t: TestDb;
  let root: string;
  let app: Express;
  let server: Server;
  let port: number;
  let loads: { count: number };
  let loaderCalls: number;

  const writeDownloadedModel = (): void => {
    const dir = join(root, 'fake-model');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'model.bin'), 'fake');
    writeFileSync(join(dir, 'model.meta.json'), JSON.stringify({
      id: 'fake-model', bytes: 4, sha256_actual: 'x', sha256_verified: null, source_url: '', downloaded_at: Date.now(),
    }));
  };

  const openApp = async (overrides: { loader?: VoiceRecognizerLoader; idleTimeoutMs?: number } = {}) => {
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => { if (id === 'fake') return adapter; throw new Error(`未知适配器 id: ${id}`); },
      adapters: [adapter],
      refreshClisOnBoot: false,
      voice: {
        catalog: CATALOG,
        rootDir: root,
        loader: overrides.loader ?? (async () => { loaderCalls += 1; return createFakeLoader(loads)({ modelId: 'x', modelDir: 'x', language: 'zh', streaming: true }); }),
        ...(overrides.idleTimeoutMs !== undefined ? { idleTimeoutMs: overrides.idleTimeoutMs } : {}),
      },
    });
    app = created.app;
    server = createServer(app);
    attachVoiceWebSocket(server, t.db, {
      catalog: CATALOG,
      rootDir: root,
      loader: overrides.loader ?? (async () => { loaderCalls += 1; return createFakeLoader(loads)({ modelId: 'x', modelDir: 'x', language: 'zh', streaming: true }); }),
      ...(overrides.idleTimeoutMs !== undefined ? { idleTimeoutMs: overrides.idleTimeoutMs } : {}),
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    port = typeof address === 'object' && address !== null ? address.port : 0;
  };

  const connect = (sessionId: string): Promise<{ socket: WebSocket; events: Array<Record<string, unknown>> }> => new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/voice/session/${sessionId}`);
    const events: Array<Record<string, unknown>> = [];
    socket.on('message', (data: WebSocket.RawData) => { events.push(JSON.parse(data.toString()) as Record<string, unknown>); });
    socket.once('open', () => resolve({ socket, events }));
    socket.once('error', reject);
  });

  /** 在已收集的事件里等条件成立（含历史事件，避免竞态） */
  const waitIn = async (events: Array<Record<string, unknown>>, predicate: (event: Record<string, unknown>) => boolean, timeoutMs = 4000): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = events.find(predicate);
      if (hit !== undefined) return hit;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error(`等待事件超时；已收到：${JSON.stringify(events)}`);
  };

  beforeEach(() => {
    resetVoiceSessions();
    resetVoiceModelTasks();
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-voicesession-'));
    loads = { count: 0 };
    loaderCalls = 0;
  });

  afterEach(async () => {
    resetVoiceSessions();
    await new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('returns409WithoutLoadingNativeModuleWhenNoModelDownloaded', async () => {
    await openApp();
    const res = await request(app).post('/api/voice/session').send({ language: 'zh-CN' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VOICE_MODEL_MISSING');
    // 关键：原生模块没被 require，识别器 loader 也没被调用
    expect(nativeLoaded()).toBe(false);
    expect(loaderCalls).toBe(0);
  });

  it('createsSessionWithSampleRateAndStreamsFramesOverWs', async () => {
    writeDownloadedModel();
    await openApp();
    const created = await request(app).post('/api/voice/session').send({ language: 'zh-CN' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ sample_rate: 16000, model_id: 'fake-model', language: 'zh' });
    expect(typeof created.body.session_id).toBe('string');

    const { socket, events } = await connect(created.body.session_id as string);
    await waitIn(events, event => event.type === 'state' && event.state === 'running');

    socket.send(float32Frame([0.1, 0.2, 0.3, 0.4]));
    socket.send(float32Frame([0.5, 0.6, 0.7, 0.8]));
    socket.send(float32Frame([0.9, 1.0]));
    await waitIn(events, event => event.type === 'partial' && event.text === 'heard:10');

    const stopped = await request(app).post(`/api/voice/session/${created.body.session_id}/stop`).send({});
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ text: 'heard:10', frames: 3, state: 'ended' });
    // final 事件在下行流里，且 partial 单调
    await waitIn(events, event => event.type === 'final' && event.text === 'heard:10');
    const partials = events.filter(event => event.type === 'partial').map(event => String(event.text));
    expect(partials).toEqual(['heard:4', 'heard:8', 'heard:10']);
    socket.close();
  });

  it('keepsVoiceWsAliveWhenHubUpgradeHandlerCoexists', async () => {
    writeDownloadedModel();
    await openApp();
    // 真实进程里 hub.attach 与 attachVoiceWebSocket 挂在同一个 server 上：
    // hub 的 upgrade 监听不能把语音连接 destroy（否则音频帧收不到，永远出不了文本）。
    const hub = createWsHub();
    hub.attach(server);
    const created = await request(app).post('/api/voice/session').send({ language: 'zh-CN' });
    expect(created.status).toBe(201);

    const { socket, events } = await connect(created.body.session_id as string);
    await waitIn(events, event => event.type === 'state' && event.state === 'running');
    socket.send(float32Frame([0.1, 0.2]));
    await waitIn(events, event => event.type === 'partial' && event.text === 'heard:2');

    const stopped = await request(app).post(`/api/voice/session/${created.body.session_id}/stop`).send({});
    expect(stopped.body).toMatchObject({ text: 'heard:2', frames: 1, state: 'ended' });
    socket.close();
  });

  it('queuesSecondSessionUntilFirstEnds', async () => {
    writeDownloadedModel();
    await openApp();
    const first = await request(app).post('/api/voice/session').send({ language: 'zh' });
    const firstWs = await connect(first.body.session_id as string);
    await waitIn(firstWs.events, event => event.type === 'state' && event.state === 'running');
    const second = await request(app).post('/api/voice/session').send({ language: 'zh' });
    expect(second.body.state).toBe('queued');
    expect(second.body.queue_position).toBeGreaterThanOrEqual(1);

    const secondWs = await connect(second.body.session_id as string);
    await waitIn(secondWs.events, event => event.type === 'queued');

    await request(app).post(`/api/voice/session/${first.body.session_id}/stop`).send({});
    await waitIn(secondWs.events, event => event.type === 'state' && event.state === 'running');
    firstWs.socket.close();
    secondWs.socket.close();
  });

  it('autoClosesIdleSessionAfterTimeout', async () => {
    writeDownloadedModel();
    await openApp({ idleTimeoutMs: 150 });
    const created = await request(app).post('/api/voice/session').send({ language: 'zh' });
    const { socket, events } = await connect(created.body.session_id as string);
    await waitIn(events, event => event.type === 'state' && event.state === 'running');
    socket.send(float32Frame([0.1, 0.2]));
    const final = await waitIn(events, event => event.type === 'final', 3000);
    expect(final).toMatchObject({ reason: 'idle', text: 'heard:2' });
    socket.close();
  });

  it('rejectsUnsupportedLanguageWithReadableCode', async () => {
    writeDownloadedModel();
    await openApp();
    const res = await request(app).post('/api/voice/session').send({ language: 'fr-FR' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VOICE_LANGUAGE_UNSUPPORTED');
    expect(res.body.error.message).toContain('不支持语言');
  });

  it('reportsSessionNotFoundOnUnknownWsIdAndStop', async () => {
    writeDownloadedModel();
    await openApp();
    const missing = await request(app).post('/api/voice/session/not-a-session/stop').send({});
    expect(missing.status).toBe(404);
    const { socket, events } = await connect('not-a-session');
    const error = await waitIn(events, event => event.type === 'error');
    expect(error.code).toBe('VOICE_SESSION_NOT_FOUND');
    socket.close();
  });
});
