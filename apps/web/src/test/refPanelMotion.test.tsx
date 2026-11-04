/**
 * A1：点击触发的引用浮窗进出场动画（复用 panelMotion token）。
 *
 * 断言：
 * - 默认（无 `prefers-reduced-motion: reduce`）：容器带 `PANEL_MOTION_TRANSITION`（160ms + token 缓动），
 *   且进场从「位移 + 透明」起步 → 双 rAF 后到 open；
 * - `matchMedia` 命中 reduce：`transition: none`、`opacity: 1`、`transform: none`（瞬时）；
 * - 只改 transform/opacity：容器不设 width/height（宽度语义由外层 RightPanel 决定，动画不得引发回流）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { RefPanel } from '../components/right/RefPanel';
import { PANEL_MOTION_TRANSITION, PANEL_MOTION_MS } from '../components/overlay/panelMotion';
import { useAppStore } from '../state/appStore';
import { usePanelStore } from '../state/panelStore';
import { server } from './server';

function withClient(ui: React.ReactElement): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const page = {
  id: 'kp-1', scope: 'common', workspace_id: null, slug: 'kp-1', title: '引用页',
  body_md: '正文', status: 'active', revision: 1, expires_at: null,
  created_by: 'user', updated_by: 'user', created_at: 1, updated_at: 1,
  sources: [{ source_id: 's1', source_type: 'file', locator: 'a.ts', captured_at: 1, content_hash: 'a'.repeat(64) }],
  evidence: [{ source_id: 's1', locator: 'a.ts' }],
};

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  useAppStore.setState({ workspaceId: 'ws-1', selectedLabelsByWorkspace: {} });
  usePanelStore.setState({ view: null, issueId: null, sessionId: null, refPanel: { kind: 'knowledge', id: 'kp-1', title: '引用页' } });
  server.use(http.get('/api/knowledge/pages/kp-1', () => HttpResponse.json(page)));
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

describe('引用浮窗进出场动画（A1）', () => {
  it('默认：进场容器带 panelMotion 过渡（160ms token），且不含 width/height（不动布局）', async () => {
    withClient(<RefPanel />);
    const box = await screen.findByTestId('ref-panel-motion');
    expect(box).toHaveAttribute('data-panel-motion-ms', String(PANEL_MOTION_MS));
    // 入场首帧：位移 + 透明（hidden 态）
    await waitFor(() => {
      const style = window.getComputedStyle(box);
      expect(style.transition).toBe(PANEL_MOTION_TRANSITION);
    });
    // 双 rAF 后到 open：opacity 1、transform none
    await waitFor(() => {
      expect(box.getAttribute('data-panel-state')).toBe('open');
    }, { timeout: 3000 });
    expect(box.style.opacity).toBe('1');
    expect(box.style.transform).toBe('none');
    // 只动 transform/opacity：容器不设宽度/高度
    expect(box.style.width).toBe('');
    expect(box.style.height).toBe('');
  });

  it('prefers-reduced-motion: reduce → 瞬时（transition none），data-panel-motion-ms=0', async () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    withClient(<RefPanel />);
    const box = await screen.findByTestId('ref-panel-motion');
    expect(box).toHaveAttribute('data-panel-motion-ms', '0');
    expect(box.style.transition).toBe('none');
    expect(box.style.opacity).toBe('1');
    expect(box.style.transform).toBe('none');
  });
});
