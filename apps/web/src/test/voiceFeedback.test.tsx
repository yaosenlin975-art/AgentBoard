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
    stubRect(input, 10, 100, 32);
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

/** jsdom 的 getBoundingClientRect 恒为 0，注入可控矩形才能观察「滚动后是否真的重算」 */
function stubRect(el: HTMLElement, left: number, top: number, height: number, width = 200): void {
  el.getBoundingClientRect = () => ({
    x: left, y: top, left, top, right: left + width, bottom: top + height, width, height,
    toJSON: () => ({}),
  }) as DOMRect;
}

/** jsdom 无布局：clientWidth/clientHeight 恒为 0，裁剪判定需要显式注入 */
function stubBoxSize(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: height });
}

describe('VoiceHint 跟随锚点（CHAT-MICPOP）', () => {
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
    stubRect(input, 120, 400, 32);
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

  // CHAT-MICPOP-2 回归：零尺寸锚点（折叠/未布局的输入框）以前会算出 (0, 4)，
  // 即提示钉在视口左上角且不再跟随任何滚动。
  it('锚点没有布局盒（零尺寸）时不出提示，拿到有效矩形后自动恢复', () => {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    stubRect(input, 0, 0, 0, 0);
    render(<VoiceHint enabled />);

    act(() => { input.focus(); });
    expect(screen.queryByTestId('voice-hint')).toBeNull();
    expect(input.hasAttribute('aria-describedby')).toBe(true);

    stubRect(input, 120, 300, 32);
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(parseFloat(screen.getByTestId('voice-hint').style.top)).toBe(336);
  });

  it('锚点被裁剪祖先完全裁掉时隐藏，部分可见时仍贴合显示', () => {
    const clipBox = document.createElement('div');
    clipBox.style.overflowY = 'hidden';
    const input = document.createElement('input');
    input.type = 'text';
    clipBox.appendChild(input);
    document.body.appendChild(clipBox);
    stubRect(clipBox, 0, 0, 200);
    stubBoxSize(clipBox, 200, 200);
    stubRect(input, 10, 400, 32);
    render(<VoiceHint enabled />);

    // 输入框在容器可视范围（0..200）之外：不得停在容器外的坐标上
    act(() => { input.focus(); });
    expect(screen.queryByTestId('voice-hint')).toBeNull();

    // 部分可见：仍然显示，间距 4px
    stubRect(input, 10, 150, 32);
    act(() => { clipBox.dispatchEvent(new Event('scroll')); });
    expect(parseFloat(screen.getByTestId('voice-hint').style.top)).toBe(186);
  });

  it('层级低于抽屉/弹窗（z-35），不再压在最上层', () => {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    stubRect(input, 10, 100, 32);
    render(<VoiceHint enabled />);
    act(() => { input.focus(); });
    const hint = screen.getByTestId('voice-hint');
    expect(hint.className).toContain('z-[35]');
    expect(hint.className).not.toContain('z-[60]');
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
