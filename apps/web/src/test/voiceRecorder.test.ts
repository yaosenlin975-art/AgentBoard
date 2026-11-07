/**
 * VOICE-CANCEL 配套：确认真实采集会话在 stop() 后释放麦克风（track.stop 被调用、AudioContext 关闭）。
 * 取消路径走的是同一个 session.stop()，因此这条覆盖的是「退出后不残留音频」的底层事实。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startVoiceSession } from '../lib/voice/recorder';

const trackStop = vi.fn();
const contextClose = vi.fn(async () => undefined);

class FakeAudioContext {
  readonly sampleRate = 48000;
  readonly audioWorklet = { addModule: vi.fn(async () => undefined) };
  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  close(): Promise<void> {
    return contextClose();
  }
}

class FakeAudioWorkletNode {
  readonly port: { onmessage: ((event: MessageEvent<Float32Array>) => void) | null } = { onmessage: null };
}

const originalAudioContext = window.AudioContext;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  trackStop.mockClear();
  contextClose.mockClear();
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  (window as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeAudioWorkletNode;
  URL.createObjectURL = vi.fn(() => 'blob:voice-worklet');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  (window as unknown as { AudioContext: unknown }).AudioContext = originalAudioContext;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe('语音采集会话的停止释放（VOICE-CANCEL）', () => {
  it('mock 会话 stop() 后麦克风轨道被停止、AudioContext 被关闭', async () => {
    const session = await startVoiceSession({
      language: 'zh-CN',
      modelId: null,
      mock: true,
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [{ stop: trackStop }] }),
      } as unknown as MediaDevices,
    });

    expect(trackStop).not.toHaveBeenCalled();
    await session.stop();

    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(contextClose).toHaveBeenCalledTimes(1);
  });
});
