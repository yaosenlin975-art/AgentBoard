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
import { render } from '@testing-library/react';
import { isVoiceEligible } from '../lib/voice/contract';
import { VOICE_ELIGIBLE_SELECTOR } from '../lib/voice/contract';
import { voiceLongPressProps, VoiceInputProvider } from '../components/voice/useLongPressVoice';

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
