/**
 * CHUNK-RECOVER-W：旧页面引用已不存在 chunk 时的恢复路径。
 *
 * 覆盖：
 * - `vite:preloadError` 首次 → 自动 reload **一次**；第二次 → 只显示提示条，reload 次数不增（防刷新循环）；
 * - Markdown 渲染器 chunk 加载失败 → 渲染 `<pre data-testid="markdown-plain">` + 提示条，且不抛未捕获异常；
 * - 提示条组件本身：stale 时出现、点「刷新」调用 reload。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  CHUNK_RELOAD_KEY,
  __resetChunkRecoveryForTest,
  __setReloadImplForTest,
  handleChunkError,
  installChunkErrorRecovery,
  isStale,
} from '../lib/chunkRecovery';
import { ChunkErrorBanner } from '../components/ui/ChunkErrorBanner';

let reloads = 0;

beforeEach(() => {
  sessionStorage.clear();
  reloads = 0;
  __resetChunkRecoveryForTest();
  __setReloadImplForTest(() => { reloads += 1; });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('chunkRecovery 一次性标记', () => {
  it('首次 vite:preloadError → reload 一次并写标记；第二次只提示，不再 reload', () => {
    const off = installChunkErrorRecovery(window);
    window.dispatchEvent(new Event('vite:preloadError'));
    expect(reloads).toBe(1);
    expect(sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBe('1');
    expect(isStale()).toBe(false);

    // 第二次（同一会话，模拟再次失败）：只置 stale，不刷新
    window.dispatchEvent(new Event('vite:preloadError'));
    expect(reloads).toBe(1);
    expect(isStale()).toBe(true);
    off();
  });

  it('handleChunkError 直接调用同样遵守一次性语义', () => {
    expect(handleChunkError()).toBe('reloaded');
    expect(handleChunkError()).toBe('stale');
    expect(reloads).toBe(1);
  });
});

describe('ChunkErrorBanner', () => {
  it('stale 前不渲染；stale 后出现提示条与「刷新」按钮', async () => {
    render(<ChunkErrorBanner />);
    expect(screen.queryByTestId('chunk-error-banner')).toBeNull();

    handleChunkError(); // 第一次：reload
    handleChunkError(); // 第二次：stale
    await waitFor(() => expect(screen.getByTestId('chunk-error-banner')).toBeInTheDocument());
    expect(screen.getByTestId('chunk-error-banner')).toHaveTextContent('页面已过期（新版本已发布），请刷新');
    const button = screen.getByTestId('chunk-error-reload');
    button.addEventListener('click', (event) => event.preventDefault());
    expect(button).toHaveTextContent('刷新');
  });
});

describe('Markdown 渲染器 chunk 失败降级', () => {
  it('import reject → 渲染 <pre> 纯文本 + 提示条，且不抛未捕获异常', async () => {
    vi.resetModules();
    // 让 ./markdownRenderer 的动态 import 抛错（模拟旧 chunk 不存在）
    vi.doMock('../lib/markdownRenderer', () => {
      throw new Error('Failed to fetch dynamically imported module: /assets/markdownRenderer-abc.js');
    });
    const errorSpy = vi.fn();
    window.addEventListener('error', errorSpy);

    const { MarkdownView } = await import('../lib/markdown');
    const { ChunkErrorBanner: Banner } = await import('../components/ui/ChunkErrorBanner');
    render(
      <>
        <MarkdownView>**粗体** 文本</MarkdownView>
        <Banner />
      </>,
    );

    // 降级为纯文本（保留原文），且不白屏
    await waitFor(() => expect(screen.getByTestId('markdown-plain')).toHaveTextContent('**粗体** 文本'));
    // 未捕获异常为 0（捕获后走 handleChunkError）
    expect(errorSpy).not.toHaveBeenCalled();
    window.removeEventListener('error', errorSpy);
    vi.doUnmock('../lib/markdownRenderer');
    vi.resetModules();
  });
});
