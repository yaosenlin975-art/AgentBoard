/**
 * 主题：跟随系统（matchMedia）+ 手动切换（循环 system → light → dark / 设置弹窗显式三选）。
 * 暗色实现为 html 元素挂 .dark class（Tailwind @custom-variant）。
 */
import { useSyncExternalStore } from 'react';

export type Theme = 'system' | 'light' | 'dark';

const THEME_KEY = 'agentboard.theme';
const ORDER: Theme[] = ['system', 'light', 'dark'];

export const THEME_LABEL: Record<Theme, string> = {
  system: '主题：跟随系统',
  light: '主题：亮色',
  dark: '主题：暗色',
};

function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

export function getStoredTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && systemPrefersDark());
  document.documentElement.classList.toggle('dark', dark);
}

/** 主题单一状态源（模块级）：设置弹窗显式选择后顶栏循环按钮等订阅者同步刷新 */
let currentTheme: Theme = getStoredTheme();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // localStorage 不可用（隐私模式等）时仅本次会话生效
  }
  currentTheme = theme;
  applyTheme(theme);
  for (const listener of listeners) listener();
}

/** 应用初始主题并监听系统变化（App 生命周期内注册一次） */
export function initTheme(): void {
  applyTheme(getStoredTheme());
  if (typeof window.matchMedia === 'function') {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getStoredTheme() === 'system') applyTheme('system');
    });
  }
}

export function useTheme(): [Theme, () => void] {
  const theme = useSyncExternalStore(subscribe, () => currentTheme);
  const cycleTheme = (): void => {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] ?? 'system';
    setTheme(next);
  };
  return [theme, cycleTheme];
}
