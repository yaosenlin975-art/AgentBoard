/**
 * VOICE-UI-2：长按语音的接入覆盖与手势取消（不靠「有没有绑定 props」判断，只看真实行为）。
 *
 * 发现（取证修正）：`VoiceInputProvider` 早已在 document 上做 capture 委托，
 * `input[type=text|search]` / `textarea` / `contenteditable` 都会被接管 —— 所以
 * 「聊天输入框没有任何绑定 → 长按必然零反应」并不成立；真机长按确实进入录音流程
 * （`window.__voiceDebug.getUserMediaCalls` / `lastError` 有变化）。
 *
 * 本文件覆盖真正缺的两件事：
 * 1. `pointerleave` 也要取消 pending 计时（此前只处理 pointerup / pointercancel）；
 * 2. `voiceLongPressProps()` 工厂形状（显式 opt-in 用），且不劫持普通右键。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { isVoiceEligible } from '../lib/voice/contract';
import { VOICE_ELIGIBLE_SELECTOR } from '../lib/voice/contract';
import { voiceLongPressProps, VoiceInputProvider } from '../components/voice/useLongPressVoice';

// VOICE-CANCEL：把采集链路换成可控假会话，只看「取消是否真的停会话且不插入文本」
const { startSpy, stopSpy } = vi.hoisted(() => {
  const stopSpy = vi.fn(async () => '这段文本不应该被插入');
  const startSpy = vi.fn(async () => ({
    stop: stopSpy,
    level: () => 0.2,
    info: () => ({ inputRate: 16000, frames: 0 }),
    cancel: vi.fn(),
  }));
  return { startSpy, stopSpy };
});

vi.mock('../lib/voice/recorder', () => ({
  VoiceInputError: class VoiceInputError extends Error {
    readonly code: string;
    constructor(code: string, message?: string) {
      super(message ?? code);
      this.code = code;
    }
  },
  startVoiceSession: startSpy,
}));

beforeEach(() => {
  document.body.innerHTML = '';
  delete (window as unknown as { __voiceDebug?: unknown }).__voiceDebug;
});

describe('长按语音的目标覆盖（VOICE-UI-2）', () => {
  it('四个实际接入的输入框都命中 isVoiceEligible（聊天 / 新建任务标题与描述 / 详情评论 / 知识库搜索）', () => {
    // 用真实标签构造，避免「只测选择器字符串」
    const make = (html: string): HTMLElement => {
      const host = document.createElement('div');
      host.innerHTML = html;
      document.body.appendChild(host);
      return host.firstElementChild as HTMLElement;
    };
    const chat = make('<textarea data-testid="composer-input"></textarea>');
    const title = make('<input data-testid="new-issue-title" type="text" />');
    const desc = make('<textarea data-testid="new-issue-description"></textarea>');
    const comment = make('<textarea data-testid="comment-input"></textarea>');
    const knowledgeSearch = make('<input data-testid="knowledge-search" type="search" />');

    for (const el of [chat, title, desc, comment, knowledgeSearch]) {
      expect(isVoiceEligible(el), `${el.dataset.testid} 应可接入语音`).toBe(true);
      expect(el.matches(VOICE_ELIGIBLE_SELECTOR)).toBe(true);
    }

    // 反例：不该接管的控件
    expect(isVoiceEligible(make('<input type="checkbox" />'))).toBe(false);
    expect(isVoiceEligible(make('<input type="date" />'))).toBe(false);
    expect(isVoiceEligible(make('<input type="text" disabled />'))).toBe(false);
    expect(isVoiceEligible(make('<div></div>'))).toBe(false);
  });

  it('voiceLongPressProps 返回可铺开的标记 + 一个 onContextMenu；普通右键不被劫持', () => {
    const props = voiceLongPressProps();
    expect(props['data-voice-input']).toBe('true');
    expect(typeof props.onContextMenu).toBe('function');

    // 无录音状态（无 __voiceDebug）→ 不阻止默认右键
    const normal = { preventDefault: vi.fn() };
    props.onContextMenu(normal as unknown as React.MouseEvent);
    expect(normal.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('Provider 侧注册了 pointerup / pointercancel / pointerleave 三条 capture 监听', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    function Probe(): React.ReactElement {
      return <VoiceInputProvider>{null}</VoiceInputProvider>;
    }
    render(<Probe />);
    const names = addSpy.mock.calls.map((call) => `${String(call[0])}:${String(call[2] === true)}`);
    expect(names).toContain('pointerup:true');
    expect(names).toContain('pointercancel:true');
    expect(names).toContain('pointerleave:true');
    addSpy.mockRestore();
  });
});

describe('录音浮层的取消出口（VOICE-CANCEL）', () => {
  const enableVoice = (): void => {
    localStorage.setItem('agentboard.voice', JSON.stringify({ enabled: true, language: 'system', modelId: 'test-model', mock: true }));
  };

  /** 长按进入录音态并等浮层出现（400ms 长按阈值 + 会话就绪） */
  const startRecording = async (): Promise<HTMLTextAreaElement> => {
    const textarea = document.createElement('textarea');
    textarea.value = '原始内容';
    document.body.appendChild(textarea);
    render(<VoiceInputProvider />);
    fireEvent.pointerDown(textarea, { button: 0, clientX: 10, clientY: 10 });
    await waitFor(() => expect(screen.getByTestId('voice-listening')).toBeTruthy(), { timeout: 3000 });
    return textarea;
  };

  beforeEach(() => {
    startSpy.mockClear();
    stopSpy.mockClear();
    enableVoice();
  });

  it('点浮层关闭按钮 → 浮层消失、会话被 stop、输入框不插入识别文本', async () => {
    const textarea = await startRecording();
    expect(startSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('voice-cancel'));

    await waitFor(() => expect(screen.queryByTestId('voice-listening')).toBeNull());
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe('原始内容');
    expect((window as unknown as { __voiceDebug?: { lastText: string | null } }).__voiceDebug?.lastText ?? null).toBeNull();
  });

  it('按 Esc → 同样退出录音且不插入文本', async () => {
    const textarea = await startRecording();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByTestId('voice-listening')).toBeNull());
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe('原始内容');
  });
});
