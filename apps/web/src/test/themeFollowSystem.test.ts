/**
 * E3（MAC-TRIAL-E3）口径回归：深浅色跟随系统 + 显式选择优先。
 * 覆盖卡面三条验收的 Windows 可测部分：
 * - 系统深色 + 主题=system → 页面立即变深；系统切回浅色 → 跟随（免重启，matchMedia change 驱动）；
 * - 显式选浅/深 → 系统切换不覆盖用户选择；
 * - 窗口/壳侧（启动页、WKWebView effectiveAppearance）不在 jsdom 可测范围，见桌面壳侧验证记录。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initTheme, setTheme } from '../theme';

type MediaListener = (event: { matches: boolean }) => void;

/** 可控的 matchMedia：记录注册的 change 监听器，setDark 触发它们（模拟系统外观切换）。 */
function installMatchMedia(initialDark: boolean): { setDark: (dark: boolean) => void } {
  const listeners = new Set<MediaListener>();
  let dark = initialDark;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('dark') && dark,
      media: query,
      onchange: null,
      addEventListener: (_type: unknown, listener: MediaListener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: unknown, listener: MediaListener) => {
        listeners.delete(listener);
      },
      addListener: (listener: MediaListener) => {
        listeners.add(listener);
      },
      removeListener: (listener: MediaListener) => {
        listeners.delete(listener);
      },
      dispatchEvent: () => false,
    }),
  });
  return {
    setDark(next: boolean) {
      dark = next;
      for (const listener of listeners) listener({ matches: next });
    },
  };
}

describe('主题：系统跟随与显式选择（E3 口径）', () => {
  let restoreMatchMedia: () => void;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    const original = window.matchMedia;
    restoreMatchMedia = () => {
      Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: original });
    };
  });

  afterEach(() => {
    restoreMatchMedia();
  });

  it('主题=system（缺省）时跟随系统深色：启动即深', () => {
    installMatchMedia(true);
    initTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('系统切换深浅时跟随，无需重启（matchMedia change 生效）', () => {
    const media = installMatchMedia(false);
    initTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    media.setDark(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    media.setDark(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('显式选浅色：系统深色与后续系统切换都不覆盖用户选择', () => {
    const media = installMatchMedia(true);
    localStorage.setItem('agentboard.theme', 'light');
    initTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    media.setDark(false);
    media.setDark(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('显式选深色：系统浅色下仍保持深色', () => {
    installMatchMedia(false);
    setTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
