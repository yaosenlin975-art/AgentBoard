/**
 * 本地语音采集（VOICE-3）：AudioWorklet 取 PCM → 下采样到 16kHz 单声道 Float32 → WS 分块上行。
 * 上行格式以服务端契约为准：**16kHz 单声道 Float32LE**（服务端按 `readFloatLE` 逐 4 字节解码，
 * sherpa-onnx 的 `acceptWaveform` 也直接吃 Float32），因此这里原样发送降采样后的 Float32，
 * 不做 Int16 转换（两边格式不一致会让识别器收到近似静音、只能出空文本）。
 * 服务端契约（VOICE-2，见设计 §识别会话）未就绪时：请求 /api/voice/session 失败 → 抛
 * VoiceInputError('VOICE_SERVER_UNAVAILABLE')；`mock` 模式不连服务端，直接给 mock final，
 * 用来验证「长按 → 录音 → 插入」全链路（不下载任何真实模型）。
 */
import { VOICE_SAMPLE_RATE, type VoiceErrorCode, type VoiceServerEvent } from './contract';

export class VoiceInputError extends Error {
  readonly code: VoiceErrorCode | string;
  constructor(code: VoiceErrorCode | string, message?: string) {
    super(message ?? code);
    this.name = 'VoiceInputError';
    this.code = code;
  }
}

/** 把任意采样率的 Float32 单声道信号线性重采样到 16kHz（浏览器 AudioContext 常见 44.1k/48k） */
export function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === VOICE_SAMPLE_RATE) return input;
  const ratio = inputRate / VOICE_SAMPLE_RATE;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, input.length - 1);
    const weight = pos - left;
    const leftSample = input[left] ?? 0;
    const rightSample = input[right] ?? leftSample;
    out[i] = leftSample * (1 - weight) + rightSample * weight;
  }
  return out;
}

/** Float32 [-1,1] → Int16 PCM */
export function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

/** 计算一帧的 RMS，用于状态条音量条 */
export function frameLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) { const s = samples[i] ?? 0; sum += s * s; }
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}

/** AudioWorklet 处理器：把输入通道整块 postMessage 回主线程（16k 下采样在主线程做） */
const WORKLET_SOURCE = `
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) this.port.postMessage(new Float32Array(channel));
    return true;
  }
}
registerProcessor('voice-capture', VoiceCaptureProcessor);
`;

export interface VoiceSessionHandle {
  /** 停止录音并返回最终文本 */
  stop: () => Promise<string>;
  /** 当前音量（0..1），供状态条使用 */
  level: () => number;
  /** 采样率信息（测试/诊断） */
  info: () => { inputRate: number; frames: number };
  /** 取消（不插入） */
  cancel: () => void;
}

export interface StartVoiceOptions {
  language: string;
  modelId: string | null;
  mock: boolean;
  /** 测试注入 */
  fetchImpl?: typeof fetch;
  wsFactory?: (url: string) => WebSocket;
  mediaDevices?: MediaDevices;
  now?: () => number;
}

interface SessionResponse {
  session_id: string;
  sample_rate: number;
}

async function createSession(options: StartVoiceOptions): Promise<SessionResponse> {
  const doFetch = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch('/api/voice/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: options.modelId, language: options.language }),
    });
  } catch {
    throw new VoiceInputError('VOICE_SERVER_UNAVAILABLE');
  }
  if (!res.ok) {
    let code = 'VOICE_SERVER_UNAVAILABLE';
    try {
      const body = (await res.json()) as { error?: { code?: string } };
      if (body.error?.code !== undefined) code = body.error.code;
    } catch {
      // 保持默认码
    }
    throw new VoiceInputError(code);
  }
  return (await res.json()) as SessionResponse;
}

/** 开始一次语音会话：先建会话（可 mock），再采集并上行 */
export async function startVoiceSession(options: StartVoiceOptions): Promise<VoiceSessionHandle> {
  const mediaDevices = options.mediaDevices ?? navigator.mediaDevices;
  if (mediaDevices === undefined || typeof mediaDevices.getUserMedia !== 'function') {
    throw new VoiceInputError('VOICE_NO_DEVICE');
  }

  // 只有判定通过（400ms 未拖动）才会走到这里 —— getUserMedia 调用点唯一
  let stream: MediaStream;
  try {
    stream = await mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new VoiceInputError('VOICE_PERMISSION_DENIED');
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new VoiceInputError('VOICE_NO_DEVICE');
    throw new VoiceInputError('VOICE_UNSUPPORTED');
  }

  const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (AudioContextCtor === undefined) {
    stream.getTracks().forEach((t) => t.stop());
    throw new VoiceInputError('VOICE_UNSUPPORTED');
  }
  const context = new AudioContextCtor();
  const source = context.createMediaStreamSource(stream);
  const frames: Float32Array[] = [];
  let currentLevel = 0;
  let closed = false;
  let pending = '';
  let finalFromWs: string | null = null;
  let resolveFinal: ((text: string) => void) | null = null;
  let rejectFinal: ((e: unknown) => void) | null = null;

  const finalPromise = new Promise<string>((resolve, reject) => {
    resolveFinal = resolve;
    rejectFinal = reject;
  });

  let socket: WebSocket | null = null;
  let sessionId: string | null = null;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    try {
      source.disconnect();
    } catch {
      // ignore
    }
    stream.getTracks().forEach((t) => t.stop());
    void context.close().catch(() => undefined);
    socket?.close();
  };

  // 会话与 WS：mock 模式跳过；真实模式失败则整体失败（不静默成 mock）
  if (!options.mock) {
    const session = await createSession(options);
    sessionId = session.session_id;
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/voice/session/${session.session_id}`;
    const factory = options.wsFactory ?? ((url: string) => new WebSocket(url));
    socket = factory(wsUrl);
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event) => {
      let payload: VoiceServerEvent;
      try {
        payload = JSON.parse(String(event.data)) as VoiceServerEvent;
      } catch {
        return;
      }
      if (payload.type === 'partial') pending = payload.text;
      else if (payload.type === 'final') {
        pending = payload.text;
        finalFromWs = payload.text;
        resolveFinal?.(payload.text);
      } else if (payload.type === 'error') {
        rejectFinal?.(new VoiceInputError(payload.code, payload.message));
      }
    });
  }

  // AudioWorklet：用 Blob URL 内联注册（零构建配置、零依赖）
  const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
  try {
    await context.audioWorklet.addModule(workletUrl);
  } finally {
    URL.revokeObjectURL(workletUrl);
  }
  const node = new AudioWorkletNode(context, 'voice-capture');
  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    const chunk = downsampleTo16k(event.data, context.sampleRate);
    currentLevel = frameLevel(chunk);
    frames.push(chunk);
    // 与服务端契约一致：16k mono Float32LE（服务端 readFloatLE 逐 4 字节解码）
    if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(chunk.buffer);
  };
  source.connect(node);

  return {
    level: () => currentLevel,
    info: () => ({ inputRate: context.sampleRate, frames: frames.length }),
    cancel: () => {
      cleanup();
      rejectFinal?.(new VoiceInputError('VOICE_UNSUPPORTED', '已取消'));
    },
    stop: async () => {
      cleanup();
      if (options.mock) return pending === '' ? '（语音）测试文本' : pending;
      try {
        if (sessionId !== null) {
          await fetch(`/api/voice/session/${sessionId}/stop`, { method: 'POST' }).catch(() => undefined);
        }
      } finally {
        // 服务端在 stop 后也会推 final；这里以已收到的 final 优先，否则等 1.5s
      }
      const timeout = new Promise<string>((resolve) => {
        setTimeout(() => resolve(pending), 1500);
      });
      return Promise.race([finalPromise, timeout]);
    },
  };
}
