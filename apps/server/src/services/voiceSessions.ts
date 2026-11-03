/**
 * VOICE-2：识别会话（WS 流式 + 串行识别器 + 空转回收）。
 *
 * 口径（Docs/design-2026-11-03-local-voice-input.md §服务端-识别会话）：
 * - 上行：二进制帧，**16kHz 单声道 Float32（小端）**；一帧任意长度，按帧累加进流。
 * - 下行：JSON `{ type: 'state' | 'queued' | 'partial' | 'final' | 'error' }`。
 * - 识别器**串行**（并发上限 1，可配）：同时只有一个会话在跑，其它排队并收到 `queued` 事件。
 * - 会话空转 15s 自动关闭（`idleTimeoutMs` 可注入，测试用短值）。
 * - **延迟加载原生模块**：`sherpa-onnx-node` 只在「模型已下载 + 真正要开流」时才 `import()`；
 *   未下载模型时创建会话直接 409 `VOICE_MODEL_MISSING`，绝不 require 原生模块（否则启动即炸）。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { Db } from '../db/connection.js';
import { ApiError, NotFoundError } from '../errors.js';
import { listVoiceModels, resolveModelsRoot, type VoiceModelDeps } from './voiceModels.js';

export const VOICE_SAMPLE_RATE = 16_000;
export const VOICE_IDLE_TIMEOUT_MS = 15_000;
export const VOICE_MAX_CONCURRENCY = 1;

/** 识别器句柄（真实实现包一层 sherpa-onnx-node；测试注入假实现） */
export interface VoiceStreamHandle {
  acceptWaveform(sampleRate: number, samples: Float32Array): void;
  isReady(): boolean;
  decode(): void;
  getText(): string;
  free(): void;
}

export interface VoiceRecognizerHandle {
  createStream(): VoiceStreamHandle;
  free(): void;
}

export type VoiceRecognizerLoader = (input: {
  modelId: string;
  modelDir: string;
  language: string;
  streaming: boolean;
}) => Promise<VoiceRecognizerHandle>;

export interface VoiceSessionDeps extends VoiceModelDeps {
  /** 识别器加载器（测试注入假 recognizer；缺省 lazyImportSherpa） */
  loader?: VoiceRecognizerLoader;
  idleTimeoutMs?: number;
  maxConcurrency?: number;
  now?: () => number;
}

export type VoiceSessionState = 'queued' | 'running' | 'ended';

interface VoiceSession {
  id: string;
  modelId: string;
  language: string;
  streaming: boolean;
  state: VoiceSessionState;
  socket: WebSocket | null;
  recognizer: VoiceRecognizerHandle | null;
  stream: VoiceStreamHandle | null;
  frames: number;
  samples: number;
  lastPartial: string;
  finalText: string | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleTimeoutMs: number;
}

const sessions = new Map<string, VoiceSession>();
const queue: string[] = [];
let runningId: string | null = null;

/** 测试用：清空会话与队列（避免跨用例串味） */
export function resetVoiceSessions(): void {
  for (const session of sessions.values()) {
    if (session.idleTimer !== null) clearTimeout(session.idleTimer);
    try { session.stream?.free(); } catch { /* 忽略 */ }
    try { session.recognizer?.free(); } catch { /* 忽略 */ }
  }
  sessions.clear();
  queue.length = 0;
  runningId = null;
}

const send = (session: VoiceSession, payload: Record<string, unknown>): void => {
  const socket = session.socket;
  if (socket === null || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
};

/** 语言归一：`zh-CN` → `zh`；模型不支持 → 409 VOICE_LANGUAGE_UNSUPPORTED */
export function normalizeVoiceLanguage(language: string | undefined, supported: readonly string[]): string {
  const raw = (language ?? '').trim();
  const base = raw === '' ? 'zh' : raw.toLowerCase().split(/[-_]/)[0] ?? 'zh';
  if (supported.length > 0 && !supported.includes(base)) {
    throw new ApiError(
      409,
      'VOICE_LANGUAGE_UNSUPPORTED',
      `模型不支持语言「${raw}」（支持：${supported.join(' / ')}），请在设置里切换语言或换模型`,
    );
  }
  return base;
}

/**
 * 缺省加载器：**只有走到这里才会 import 原生模块**（模块顶层不 require）。
 * 模型目录里缺少 sherpa 需要的文件时明确报错，不静默降级。
 */
export const lazyImportSherpa: VoiceRecognizerLoader = async ({ modelDir, streaming }) => {
  if (!streaming) {
    throw new ApiError(409, 'VOICE_MODEL_NOT_STREAMING', '当前仅支持流式模型（非流式模型暂未接入识别会话）');
  }
  const files = existsSync(modelDir) ? readdirSync(modelDir) : [];
  const pick = (pattern: RegExp): string | undefined => files.find((name) => pattern.test(name));
  const encoder = pick(/encoder.*\.onnx$/i);
  const decoder = pick(/decoder.*\.onnx$/i);
  const joiner = pick(/joiner.*\.onnx$/i);
  const tokens = pick(/tokens\.txt$/i);
  if (encoder === undefined || decoder === undefined || joiner === undefined || tokens === undefined) {
    throw new ApiError(
      409,
      'VOICE_MODEL_INCOMPLETE',
      `模型目录缺少流式识别所需文件（需要 encoder/decoder/joiner .onnx 与 tokens.txt）：${modelDir}`,
    );
  }
  const sherpa = (await import('sherpa-onnx-node')) as {
    OnlineRecognizer: new (config: Record<string, unknown>) => {
      createStream(): {
        acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
      };
      isReady(stream: unknown): boolean;
      decode(stream: unknown): void;
      getResult(stream: unknown): { text?: string };
    };
  };
  const recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: VOICE_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(modelDir, encoder),
        decoder: join(modelDir, decoder),
        joiner: join(modelDir, joiner),
      },
      tokens: join(modelDir, tokens),
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
  });
  return {
    createStream() {
      const stream = recognizer.createStream();
      return {
        acceptWaveform(sampleRate, samples) { stream.acceptWaveform({ sampleRate, samples }); },
        isReady() { return recognizer.isReady(stream); },
        decode() { recognizer.decode(stream); },
        getText() { return recognizer.getResult(stream).text ?? ''; },
        free() { /* sherpa 流由 GC 回收 */ },
      };
    },
    free() { /* recognizer 由 GC 回收 */ },
  };
};

/** 已下载的模型目录（未下载 → null） */
function downloadedModel(db: Db, modelId: string | undefined, deps: VoiceSessionDeps): { id: string; dir: string; languages: readonly string[]; streaming: boolean } | null {
  const models = listVoiceModels(db, deps);
  const candidates = models.filter((model) => model.state === 'downloaded');
  const chosen = modelId === undefined || modelId === '' ? candidates[0] : candidates.find((model) => model.id === modelId);
  if (chosen === undefined) return null;
  return {
    id: chosen.id,
    dir: join(resolveModelsRoot(db, deps), chosen.id),
    languages: chosen.languages,
    streaming: chosen.streaming,
  };
}

export interface CreateVoiceSessionInput {
  model_id?: string;
  language?: string;
}

export interface CreatedVoiceSession {
  session_id: string;
  sample_rate: number;
  model_id: string;
  language: string;
  state: VoiceSessionState;
  queue_position: number;
}

export function createVoiceSession(db: Db, input: CreateVoiceSessionInput, deps: VoiceSessionDeps = {}): CreatedVoiceSession {
  const model = downloadedModel(db, input.model_id, deps);
  if (model === null) {
    throw new ApiError(
      409,
      'VOICE_MODEL_MISSING',
      '还没有下载可用的语音模型：请到「设置 → 语音输入」里下载模型后再试',
    );
  }
  const language = normalizeVoiceLanguage(input.language, model.languages);
  const session: VoiceSession = {
    id: randomUUID(),
    modelId: model.id,
    language,
    streaming: model.streaming,
    state: 'queued',
    socket: null,
    recognizer: null,
    stream: null,
    frames: 0,
    samples: 0,
    lastPartial: '',
    finalText: null,
    idleTimer: null,
    idleTimeoutMs: deps.idleTimeoutMs ?? VOICE_IDLE_TIMEOUT_MS,
  };
  sessions.set(session.id, session);
  queue.push(session.id);
  const position = queue.length + (runningId === null ? 0 : 1);
  void startNext(db, deps);
  return {
    session_id: session.id,
    sample_rate: VOICE_SAMPLE_RATE,
    model_id: session.modelId,
    language: session.language,
    state: session.state,
    queue_position: position,
  };
}

function armIdleTimer(db: Db, deps: VoiceSessionDeps, session: VoiceSession): void {
  if (session.idleTimer !== null) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    if (session.state !== 'running') return;
    finishSession(db, deps, session, 'idle');
  }, session.idleTimeoutMs);
  // 空转计时不应拖住进程退出
  session.idleTimer.unref?.();
}

async function startNext(db: Db, deps: VoiceSessionDeps): Promise<void> {
  const limit = Math.max(1, deps.maxConcurrency ?? VOICE_MAX_CONCURRENCY);
  while (runningId === null && queue.length > 0) {
    const id = queue.shift() as string;
    const session = sessions.get(id);
    if (session === undefined || session.state === 'ended') continue;
    const modelDir = join(resolveModelsRoot(db, deps), session.modelId);
    const loader = deps.loader ?? lazyImportSherpa;
    try {
      // 只有这里才碰原生模块（lazyImportSherpa 内部 import）
      const recognizer = await loader({ modelId: session.modelId, modelDir, language: session.language, streaming: session.streaming });
      session.recognizer = recognizer;
      session.stream = recognizer.createStream();
    } catch (error) {
      session.state = 'ended';
      const code = error instanceof ApiError ? error.code : 'VOICE_RECOGNIZER_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      send(session, { type: 'error', code, message });
      session.socket?.close(1011, code);
      continue;
    }
    runningId = session.id;
    session.state = 'running';
    send(session, { type: 'state', state: 'running' });
    armIdleTimer(db, deps, session);
    if (limit > 1) break; // 预留：多并发时逐个起
  }
}

/** 结束会话：拿最终文本、释放识别器、让出串行位 */
function finishSession(db: Db, deps: VoiceSessionDeps, session: VoiceSession, reason: 'stop' | 'close' | 'idle'): string {
  if (session.idleTimer !== null) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  let text = session.finalText ?? '';
  if (session.state === 'running' && session.stream !== null) {
    try {
      text = session.stream.getText();
    } catch {
      text = session.lastPartial;
    }
  }
  session.finalText = text;
  session.state = 'ended';
  send(session, { type: 'final', text, frames: session.frames, reason });
  try { session.stream?.free(); } catch { /* 忽略 */ }
  try { session.recognizer?.free(); } catch { /* 忽略 */ }
  session.stream = null;
  session.recognizer = null;
  if (runningId === session.id) runningId = null;
  const index = queue.indexOf(session.id);
  if (index >= 0) queue.splice(index, 1);
  void startNext(db, deps);
  return text;
}

/** 把一帧 Float32LE 音频喂给识别器并推 partial */
export function pushVoiceFrame(db: Db, deps: VoiceSessionDeps, sessionId: string, buffer: Buffer): void {
  const session = sessions.get(sessionId);
  if (session === undefined) throw new NotFoundError('语音会话不存在');
  if (session.state !== 'running' || session.stream === null) {
    send(session, { type: 'queued', position: Math.max(1, queue.indexOf(session.id) + 1) });
    return;
  }
  const usable = buffer.length - (buffer.length % 4);
  if (usable === 0) return;
  const samples = new Float32Array(usable / 4);
  for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readFloatLE(i * 4);
  session.frames += 1;
  session.samples += samples.length;
  session.stream.acceptWaveform(VOICE_SAMPLE_RATE, samples);
  if (session.stream.isReady()) session.stream.decode();
  const text = session.stream.getText();
  if (text !== session.lastPartial) {
    session.lastPartial = text;
    send(session, { type: 'partial', text });
  }
  armIdleTimer(db, deps, session);
}

export function attachVoiceSocket(db: Db, deps: VoiceSessionDeps, sessionId: string, socket: WebSocket): void {
  const session = sessions.get(sessionId);
  if (session === undefined) {
    socket.send(JSON.stringify({ type: 'error', code: 'VOICE_SESSION_NOT_FOUND', message: '语音会话不存在或已结束' }));
    socket.close(1008, 'VOICE_SESSION_NOT_FOUND');
    return;
  }
  if (session.socket !== null) {
    socket.send(JSON.stringify({ type: 'error', code: 'VOICE_SESSION_BUSY', message: '该语音会话已有连接' }));
    socket.close(1008, 'VOICE_SESSION_BUSY');
    return;
  }
  session.socket = socket;
  send(session, { type: 'state', state: session.state });
  if (session.state === 'queued') {
    send(session, { type: 'queued', position: Math.max(1, queue.indexOf(session.id) + 1) });
  }
  socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (!isBinary) {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : '';
      if (text.includes('"end"')) finishSession(db, deps, session, 'stop');
      return;
    }
    const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    pushVoiceFrame(db, deps, sessionId, buffer);
  });
  socket.on('close', () => {
    if (session.state === 'running' || session.state === 'queued') finishSession(db, deps, session, 'close');
    session.socket = null;
  });
  socket.on('error', () => { /* close 里统一收尾 */ });
}

export interface StopVoiceSessionResult {
  session_id: string;
  text: string;
  frames: number;
  state: VoiceSessionState;
}

export function stopVoiceSession(db: Db, deps: VoiceSessionDeps, sessionId: string): StopVoiceSessionResult {
  const session = sessions.get(sessionId);
  if (session === undefined) throw new NotFoundError('语音会话不存在');
  const text = session.state === 'ended' ? (session.finalText ?? '') : finishSession(db, deps, session, 'stop');
  session.socket?.close(1000, 'stopped');
  return { session_id: session.id, text, frames: session.frames, state: session.state };
}

/** 会话快照（调试/测试观察用） */
export function voiceSessionSnapshot(sessionId: string): { state: VoiceSessionState; frames: number; samples: number; text: string } | null {
  const session = sessions.get(sessionId);
  if (session === undefined) return null;
  return { state: session.state, frames: session.frames, samples: session.samples, text: session.finalText ?? session.lastPartial };
}
