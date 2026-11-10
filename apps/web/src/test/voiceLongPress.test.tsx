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
import { usePanelStore } from '../state/panelStore';

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

/**
 * VOICE-INSERT：真实浏览器里长按录音期间鼠标移出输入框（很常见：移到浮层、窗口边缘、
 * 或按住时手抖出 1-2 行高的输入框）会触发 document capture 上的 pointerleave，
 * 旧实现直接静默 cancel()，转写文本永远到不了输入框。这里用真实事件序列取证。
 */
describe('录音中指针移出输入框（VOICE-INSERT 根因）', () => {
  const enableVoice = (): void => {
    localStorage.setItem('agentboard.voice', JSON.stringify({ enabled: true, language: 'system', modelId: 'test-model', mock: true }));
  };

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

  it('录音中 pointerleave 不应取消：松手后文本仍插入输入框', async () => {
    const textarea = await startRecording();
    textarea.setSelectionRange(4, 4);

    // 指针移出输入框（relatedTarget 是普通元素，不是文本节点）
    fireEvent.pointerLeave(textarea, { relatedTarget: document.body });

    // 期望：录音不被打断，浮层仍在
    expect(screen.queryByTestId('voice-listening')).not.toBeNull();
    expect(stopSpy).not.toHaveBeenCalled();

    fireEvent.pointerUp(document, { button: 0, clientX: 10, clientY: 10 });

    await waitFor(() => expect(stopSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(textarea.value).toBe('原始内容这段文本不应该被插入'));
    expect(textarea.selectionStart).toBe('原始内容这段文本不应该被插入'.length);
  });

  it('pending 阶段 pointerleave 仍取消长按计时（不启动录音）', async () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    render(<VoiceInputProvider />);
    fireEvent.pointerDown(textarea, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerLeave(textarea, { relatedTarget: document.body });

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(startSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('voice-listening')).toBeNull();
  });
});

/**
 * VOICE-INSERT：聊天输入框是「React 受控 textarea + panelStore 外部存储」。
 * 旧测试只覆盖裸 DOM input/textarea，测不出「DOM 改了但 store 没同步、下一次渲染回滚」。
 */
describe('受控输入框 + 外部 store 的插入链路（VOICE-INSERT）', () => {
  const enableVoice = (): void => {
    localStorage.setItem('agentboard.voice', JSON.stringify({ enabled: true, language: 'system', modelId: 'test-model', mock: true }));
  };

  function ControlledComposer({ draftKey }: { draftKey: string }): React.ReactElement {
    const value = usePanelStore((s) => s.chatDrafts[draftKey] ?? '');
    const setChatDraft = usePanelStore((s) => s.setChatDraft);
    return (
      <textarea
        data-testid="controlled-composer"
        value={value}
        onChange={(event) => setChatDraft(draftKey, event.target.value)}
      />
    );
  }

  const holdAndRelease = async (textarea: HTMLTextAreaElement): Promise<void> => {
    fireEvent.pointerDown(textarea, { button: 0, clientX: 10, clientY: 10 });
    await waitFor(() => expect(screen.getByTestId('voice-listening')).toBeTruthy(), { timeout: 3000 });
    fireEvent.pointerUp(document, { button: 0, clientX: 10, clientY: 10 });
  };

  beforeEach(() => {
    startSpy.mockClear();
    stopSpy.mockClear();
    enableVoice();
    usePanelStore.setState({ chatDrafts: {} });
  });

  it('setter 回退分支：插入后 store 与 DOM 同步，光标在末尾', async () => {
    usePanelStore.setState({ chatDrafts: { t: '前缀 ' } });
    render(<><VoiceInputProvider /><ControlledComposer draftKey="t" /></>);
    const textarea = screen.getByTestId('controlled-composer') as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(3, 3);

    await holdAndRelease(textarea);

    const expected = '前缀 这段文本不应该被插入';
    await waitFor(() => expect(usePanelStore.getState().chatDrafts.t).toBe(expected));
    expect(textarea.value).toBe(expected);
    expect(textarea.selectionStart).toBe(expected.length);
  });

  it('execCommand 分支：浏览器编辑事件同样同步回受控 store', async () => {
    const doc = document as unknown as { execCommand?: (command: string, showUI: boolean, value?: string) => boolean };
    const original = doc.execCommand;
    // 模拟浏览器 execCommand('insertText')：改值 + 派发 input，受控组件应通过 onChange 同步
    doc.execCommand = (command: string, _showUI: boolean, value?: string): boolean => {
      if (command !== 'insertText') return false;
      const active = document.activeElement as HTMLTextAreaElement | null;
      if (active === null || typeof active.setRangeText !== 'function') return false;
      const start = active.selectionStart ?? active.value.length;
      const end = active.selectionEnd ?? start;
      active.setRangeText(value ?? '', start, end, 'end');
      active.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };

    try {
      usePanelStore.setState({ chatDrafts: { t: '前缀 ' } });
      render(<><VoiceInputProvider /><ControlledComposer draftKey="t" /></>);
      const textarea = screen.getByTestId('controlled-composer') as HTMLTextAreaElement;
      textarea.focus();
      textarea.setSelectionRange(3, 3);

      await holdAndRelease(textarea);

      const expected = '前缀 这段文本不应该被插入';
      await waitFor(() => expect(usePanelStore.getState().chatDrafts.t).toBe(expected));
      expect(textarea.value).toBe(expected);
      expect(textarea.selectionStart).toBe(expected.length);
    } finally {
      if (original === undefined) delete doc.execCommand;
      else doc.execCommand = original;
    }
  });
});

describe('失败面必须有可见提示（VOICE-INSERT）', () => {
  const enableVoice = (): void => {
    localStorage.setItem('agentboard.voice', JSON.stringify({ enabled: true, language: 'system', modelId: 'test-model', mock: true }));
  };

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

  it('空转写（纯空白）→ 不插入且弹出可见提示', async () => {
    stopSpy.mockResolvedValueOnce('   ');
    const textarea = await startRecording();

    fireEvent.pointerUp(document, { button: 0, clientX: 10, clientY: 10 });

    await waitFor(() => expect(screen.getByTestId('voice-error')).toBeTruthy());
    expect(screen.getByTestId('voice-error').textContent).toContain('没有识别到语音');
    expect(textarea.value).toBe('原始内容');
  });

  it('插入目标在松手前被移除 → 不静默，弹出可见提示', async () => {
    const textarea = await startRecording();
    textarea.remove();

    fireEvent.pointerUp(document, { button: 0, clientX: 10, clientY: 10 });

    await waitFor(() => expect(screen.getByTestId('voice-error')).toBeTruthy());
    expect(screen.getByTestId('voice-error').textContent).toContain('没有插入到输入框');
  });
});
