/**
 * VOICE-3 用例：长按手势状态机（400ms / 6px 两态）、纯函数插入（光标处/替换选中/一次撤销前提）、
 * 采集侧纯净函数（重采样/Int16），以及设置持久化。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { LONG_PRESS_MS, MOVE_CANCEL_PX, isVoiceEligible } from '../lib/voice/contract';
import { IDLE_GESTURE, gestureDown, gestureEnd, gestureMove, gestureTick, movedTooFar } from '../lib/voice/gesture';
import { downsampleTo16k, frameLevel, startVoiceSession, toInt16 } from '../lib/voice/recorder';
import { insertVoiceText } from '../lib/voice/insertText';
import { DEFAULT_VOICE_SETTINGS } from '../lib/voice/contract';
import { VOICE_SETTINGS_KEY, loadVoiceSettings, sanitizeVoiceSettings, saveVoiceSettings } from '../lib/voice/settings';

beforeEach(() => {
  localStorage.clear();
});

describe('长按手势状态机（VOICE-3）', () => {
  it('按住 400ms 未拖动 → 进入录音；提前松手 → 取消不录音', () => {
    // 阈值必须真的是 400ms（写死字面量，避免测试跟着常量一起漂移）
    expect(LONG_PRESS_MS).toBe(400);
    const down = gestureDown(100, 100, 1000);
    expect(down.phase).toBe('pending');
    // 399ms 还不够
    expect(gestureTick(down, 1000 + LONG_PRESS_MS - 1).startRecording).toBe(false);
    // 到 400ms → 开始录音（这里才是 getUserMedia 的唯一触发点）
    const armed = gestureTick(down, 1000 + LONG_PRESS_MS);
    expect(armed.startRecording).toBe(true);
    expect(armed.state.phase).toBe('recording');
    // 录音中松手 → 停
    expect(gestureEnd(armed.state).stopRecording).toBe(true);

    // 提前松手：pending → idle，既不开始也不停止
    const early = gestureEnd(down);
    expect(early.startRecording).toBe(false);
    expect(early.stopRecording).toBe(false);
    expect(early.state.phase).toBe('idle');
  });

  it('pending 期间位移 > 6px → 取消（让原生文字选择接管）', () => {
    expect(MOVE_CANCEL_PX).toBe(6);
    const down = gestureDown(100, 100, 1000);
    // 6px 内不算拖动、7px 才算（字面量，防止常量被改而测试不响）
    expect(movedTooFar({ x: 100, y: 100 }, 106, 100)).toBe(false);
    expect(movedTooFar({ x: 100, y: 100 }, 107, 100)).toBe(true);

    const moved = gestureMove(down, 109, 100);
    expect(moved.state.phase).toBe('idle');
    // 取消后再到点也不会开始录音
    expect(gestureTick(moved.state, 1000 + LONG_PRESS_MS * 2).startRecording).toBe(false);
    // 位移在阈值内则保持 pending
    expect(gestureMove(down, 102, 102).state.phase).toBe('pending');
  });

  it('idle 状态下任何事件都不触发录音', () => {
    expect(gestureTick(IDLE_GESTURE, 10_000).startRecording).toBe(false);
    expect(gestureMove(IDLE_GESTURE, 200, 200).state.phase).toBe('idle');
    expect(gestureEnd(IDLE_GESTURE).stopRecording).toBe(false);
  });

  it('接入范围：文本控件可接，date/checkbox/number 与禁用控件不接', () => {
    const text = document.createElement('input');
    const search = document.createElement('input');
    search.type = 'search';
    const area = document.createElement('textarea');
    const date = document.createElement('input');
    date.type = 'date';
    const check = document.createElement('input');
    check.type = 'checkbox';
    const disabled = document.createElement('input');
    disabled.disabled = true;
    for (const el of [text, search, area]) expect(isVoiceEligible(el)).toBe(true);
    for (const el of [date, check, disabled]) expect(isVoiceEligible(el)).toBe(false);
    expect(isVoiceEligible(null)).toBe(false);
  });
});

describe('语音文本插入（VOICE-3）', () => {
  it('插到光标处、替换选中、光标落在插入文本末尾', () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.value = '前后';
    input.setSelectionRange(1, 1);
    const result = insertVoiceText(input, '中间');
    expect(input.value).toBe('前中间后');
    expect(result.caret).toBe(1 + '中间'.length);
    expect(input.selectionStart).toBe(result.caret);

    // 有选中 → 替换
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    textarea.value = 'ABCD';
    textarea.setSelectionRange(1, 3);
    const replaced = insertVoiceText(textarea, 'XY');
    expect(textarea.value).toBe('AXYD');
    expect(replaced.caret).toBe(3);
  });

  it('空文本不插入；非文本元素返回 unsupported', () => {
    const input = document.createElement('input');
    input.value = 'a';
    expect(insertVoiceText(input, '').ok).toBe(false);
    const div = document.createElement('div');
    expect(insertVoiceText(div, 'x').ok).toBe(false);
  });
});

describe('采集侧纯函数（VOICE-3）', () => {
  it('48k → 16k 线性重采样后长度 1/3，16k 原样返回', () => {
    const input = new Float32Array(4800);
    for (let i = 0; i < input.length; i += 1) input[i] = Math.sin((i / 4800) * Math.PI * 2);
    const out = downsampleTo16k(input, 48000);
    expect(out.length).toBe(1600);
    expect(downsampleTo16k(input, 16000)).toBe(input);
  });

  it('Float32 → Int16 做钳制；frameLevel 归一化到 0..1', () => {
    const pcm = toInt16(new Float32Array([0, 1, -1, 2, -2]));
    expect(Array.from(pcm)).toEqual([0, 32767, -32768, 32767, -32768]);
    expect(frameLevel(new Float32Array(0))).toBe(0);
    const loud = frameLevel(new Float32Array([0.9, -0.9, 0.9, -0.9]));
    expect(loud).toBeGreaterThan(0.9);
    expect(loud).toBeLessThanOrEqual(1);
  });
});

describe('上行帧格式（与服务端 Float32LE 契约对齐）', () => {
  /** 最小采集环境桩：AudioContext/AudioWorkletNode/getUserMedia/WS 全部可观察 */
  const setupRecorder = async (options: { stopText?: string } = {}) => {
    const sent: ArrayBuffer[] = [];
    const order: string[] = [];
    const socket = {
      binaryType: 'arraybuffer',
      readyState: 1,
      addEventListener: () => undefined,
      send: (data: ArrayBuffer) => { sent.push(data); },
      close: () => { order.push('close'); },
    };
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      order.push(`fetch:${url}`);
      if (url.endsWith('/stop')) {
        return { ok: true, status: 200, json: async () => ({ session_id: 's1', text: options.stopText ?? '', frames: 1, state: 'ended' }) };
      }
      return { ok: true, status: 201, json: async () => ({ session_id: 's1', sample_rate: 16000 }) };
    }) as unknown as typeof fetch;
    let workletNode: { port: { onmessage: ((event: { data: Float32Array }) => void) | null } } | null = null;
    class FakeAudioWorkletNode {
      port: { onmessage: ((event: { data: Float32Array }) => void) | null } = { onmessage: null };
      constructor() { workletNode = this; }
    }
    class FakeAudioContext {
      sampleRate = 48000;
      audioWorklet = { addModule: async (): Promise<void> => undefined };
      createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
        return { connect: () => undefined, disconnect: () => undefined };
      }
      async close(): Promise<void> { /* noop */ }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeAudioWorkletNode;
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = () => 'blob:voice-worklet';
    URL.revokeObjectURL = () => undefined;

    const session = await startVoiceSession({
      language: 'zh',
      modelId: null,
      mock: false,
      fetchImpl,
      wsFactory: () => socket as unknown as WebSocket,
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }),
      } as unknown as MediaDevices,
    });
    // startVoiceSession 内部 new 出来的节点：通过捕获的实例触发采集回调
    return {
      session,
      sent,
      order,
      emit: (samples: Float32Array) => { workletNode?.port.onmessage?.({ data: samples }); },
      restore: () => { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; },
    };
  };

  it('WS 上行发送的是 Float32LE 原始采样，而不是 Int16', async () => {
    const h = await setupRecorder();
    h.emit(new Float32Array(4800).fill(0.5));
    expect(h.sent.length).toBe(1);
    const buffer = h.sent[0] as ArrayBuffer;
    // 48k → 16k：4800 采样降为 1600；每采样 4 字节 Float32
    expect(buffer.byteLength).toBe(1600 * 4);
    const view = new DataView(buffer);
    expect(view.getFloat32(0, true)).toBeCloseTo(0.5, 5);
    await h.session.stop();
    h.restore();
  });

  it('stop 先请求 /stop 取回最终文本，再关 WS（文本不丢）', async () => {
    const h = await setupRecorder({ stopText: '你好世界' });
    const text = await h.session.stop();
    expect(text).toBe('你好世界');
    // 顺序：建会话 → /stop 取文本 → 关 WS；提前关 WS 会丢服务端推的 final
    expect(h.order.indexOf('fetch:/api/voice/session/s1/stop')).toBeGreaterThan(-1);
    expect(h.order.indexOf('fetch:/api/voice/session/s1/stop')).toBeLessThan(h.order.indexOf('close'));
    h.restore();
  });
});

describe('语音设置持久化（VOICE-3/4 共用）', () => {
  it('默认关闭；非法结构回落默认；写入后可读回', () => {
    expect(loadVoiceSettings()).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(sanitizeVoiceSettings({ enabled: 'yes', language: 42, modelId: 7 })).toEqual(DEFAULT_VOICE_SETTINGS);
    saveVoiceSettings({ enabled: true, language: 'zh-CN', modelId: 'm1', mock: true });
    expect(JSON.parse(localStorage.getItem(VOICE_SETTINGS_KEY) ?? '{}')).toMatchObject({ enabled: true, language: 'zh-CN' });
    expect(loadVoiceSettings()).toMatchObject({ enabled: true, language: 'zh-CN', modelId: 'm1', mock: true });
  });
});
