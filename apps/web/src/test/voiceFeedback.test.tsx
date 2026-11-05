/**
 * VOICE-UI-3：提示可见性与音波行为。
 *
 * - VoiceHint：enabled 时聚焦可语音输入控件 → 出现「长按可语音输入」浮层并给该控件挂 aria-describedby；
 *   失焦即撤；enabled=false（STT 关闭/无模型）时完全不出现。
 * - VoiceMicWave：active 期间 rAF 逐帧写竖条高度并计数到 `window.__voiceWaveFrames`；松手（active=false）
 *   组件卸载、帧计数停止增长；`prefers-reduced-motion: reduce` 时不跑 rAF（帧计数保持 0），只做离散变化。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { VoiceHint, VoiceMicWave, WAVE_BARS } from '../components/voice/VoiceFeedback';

function reducedMotion(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: matches && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { __voiceWaveFrames?: number }).__voiceWaveFrames;
});

describe('VoiceHint（聚焦提示）', () => {
  it('enabled：聚焦输入框出现提示并挂 aria-describedby；失焦后撤销', () => {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    render(<VoiceHint enabled />);

    expect(screen.queryByTestId('voice-hint')).toBeNull();
    act(() => { input.focus(); });
    const hint = screen.getByTestId('voice-hint');
    expect(hint).toHaveTextContent('长按可语音输入');
    expect(input.getAttribute('aria-describedby')).toBe(hint.id);
    // 浮层定位：fixed + 不占文档流（不改变输入框高度）
    expect(hint.className).toContain('fixed');
    expect(hint.className).toContain('pointer-events-none');

    act(() => { input.blur(); });
    expect(screen.queryByTestId('voice-hint')).toBeNull();
    expect(input.hasAttribute('aria-describedby')).toBe(false);
  });

  it('enabled=false（STT 关闭/无模型）：聚焦也不出现', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    render(<VoiceHint enabled={false} />);
    act(() => { input.focus(); });
    expect(screen.queryByTestId('voice-hint')).toBeNull();
    expect(input.hasAttribute('aria-describedby')).toBe(false);
  });
});

describe('VoiceHint 跟随锚点（CHAT-MICPOP）', () => {
  /** jsdom 的 getBoundingClientRect 恒为 0，注入可控矩形才能观察「滚动后是否真的重算」 */
  function stubRect(el: HTMLElement, left: number, top: number, height: number): void {
    el.getBoundingClientRect = () => ({
      x: left, y: top, left, top, right: left + 200, bottom: top + height, width: 200, height,
      toJSON: () => ({}),
    }) as DOMRect;
  }

  it('滚动后按锚点实时矩形重算坐标，与输入框间距保持不变', () => {
    const scrollBox = document.createElement('div');
    const input = document.createElement('input');
    input.type = 'text';
    scrollBox.appendChild(input);
    document.body.appendChild(scrollBox);
    stubRect(input, 120, 400, 32);
    render(<VoiceHint enabled />);

    act(() => { input.focus(); });
    const hintTop = (): number => parseFloat(screen.getByTestId('voice-hint').style.top);
    const hintLeft = (): number => parseFloat(screen.getByTestId('voice-hint').style.left);
    /** 提示顶边与输入框底边的间距（判据：滚动前后变化 ≤2px） */
    const gap = (): number => hintTop() - input.getBoundingClientRect().bottom;
    expect(hintLeft()).toBe(120);
    expect(hintTop()).toBe(436);
    expect(gap()).toBe(4);

    // 聊天区滚动（非 window 滚动）：提示必须跟着输入框重算，而不是停在原屏幕坐标
    stubRect(input, 120, 300, 32);
    act(() => { scrollBox.dispatchEvent(new Event('scroll')); });
    expect(hintTop()).toBe(336);
    expect(gap()).toBe(4);

    // 窗口尺寸变化（缩放）走同一重算路径
    stubRect(input, 100, 350, 32);
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(hintLeft()).toBe(100);
    expect(hintTop()).toBe(386);
    expect(gap()).toBe(4);
  });

  it('锚点滚出视口时提示隐藏（不悬空），滚回后恢复且 aria-describedby 不回退', () => {
    const scrollBox = document.createElement('div');
    const input = document.createElement('input');
    input.type = 'text';
    scrollBox.appendChild(input);
    document.body.appendChild(scrollBox);
    render(<VoiceHint enabled />);

    act(() => { input.focus(); });
    const hintId = screen.getByTestId('voice-hint').id;

    // 输入框滚到视口上方之外：提示不得留在原地悬空
    stubRect(input, 120, -120, 32);
    act(() => { scrollBox.dispatchEvent(new Event('scroll')); });
    expect(screen.queryByTestId('voice-hint')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBe(hintId);

    // 滚回视口内：重新出现并与输入框保持 4px 间距
    stubRect(input, 120, 500, 32);
    act(() => { scrollBox.dispatchEvent(new Event('scroll')); });
    const hint = screen.getByTestId('voice-hint');
    expect(hint.id).toBe(hintId);
    expect(parseFloat(hint.style.top)).toBe(536);
  });
});

describe('VoiceMicWave（录音音波）', () => {
  it('active 时 rAF 逐帧写竖条高度并计数；active=false 后帧计数停止增长', async () => {
    reducedMotion(false);
    let level = 0.2;
    const getLevel = (): number => level;
    const { rerender } = render(<VoiceMicWave active getLevel={getLevel} />);
    expect(screen.getAllByTestId(/voice-wave-bar-/)).toHaveLength(WAVE_BARS);

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    const framesWhileActive = (window as unknown as { __voiceWaveFrames?: number }).__voiceWaveFrames ?? 0;
    expect(framesWhileActive).toBeGreaterThan(0);
    const lowHeight = screen.getByTestId('voice-wave-bar-2').style.height;

    level = 0.95;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    const highHeight = screen.getByTestId('voice-wave-bar-2').style.height;
    expect(parseInt(highHeight, 10)).toBeGreaterThan(parseInt(lowHeight, 10));

    // 松手：组件卸载，帧计数不再增长
    rerender(<VoiceMicWave active={false} getLevel={getLevel} />);
    expect(screen.queryByTestId('voice-wave')).toBeNull();
    const framesAtStop = (window as unknown as { __voiceWaveFrames?: number }).__voiceWaveFrames ?? 0;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
    expect((window as unknown as { __voiceWaveFrames?: number }).__voiceWaveFrames ?? 0).toBe(framesAtStop);
  });

  it('prefers-reduced-motion: reduce → 不跑 rAF（帧计数为 0），仍渲染竖条', async () => {
    reducedMotion(true);
    render(<VoiceMicWave active getLevel={() => 0.6} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
    expect((window as unknown as { __voiceWaveFrames?: number }).__voiceWaveFrames ?? 0).toBe(0);
    expect(screen.getAllByTestId(/voice-wave-bar-/)).toHaveLength(WAVE_BARS);
  });
});
