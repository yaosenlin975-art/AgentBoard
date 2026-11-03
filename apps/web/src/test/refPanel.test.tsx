/**
 * MD-LINKS-1：右侧浮窗支持知识页 / 日志详情（panelStore 的 ref 视图 + RefPanel + RightPanel 分支）。
 * 链接解析与权限在子卡 MD-LINKS-2；这里只锁「浮窗能按 kind 显示内容、404 显示无权限或不存在」。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { KnowledgePage, WorkspaceChangeLog } from '@agentboard/shared';
import { RefPanel } from '../components/right/RefPanel';
import { RightPanel } from '../components/right/RightPanel';
import { useAppStore } from '../state/appStore';
import { usePanelStore } from '../state/panelStore';
import { resetOverlays, useOverlayStore } from '../state/overlayStore';
import { server } from './server';

const workspaceId = 'ws-1';

function knowledgePage(overrides: Partial<KnowledgePage> = {}): KnowledgePage {
  return {
    id: 'kp-1',
    scope: 'common',
    workspace_id: null,
    slug: 'bom-guard',
    title: 'BOM 守卫',
    body_md: '公共知识正文',
    status: 'active',
    revision: 1,
    created_by: 'user',
    updated_by: 'user',
    created_at: 1,
    updated_at: 1,
    expires_at: null,
    ...overrides,
  } as KnowledgePage;
}

function changeLog(overrides: Partial<WorkspaceChangeLog> = {}): WorkspaceChangeLog {
  return {
    id: 'log-1',
    workspace_id: workspaceId,
    origin_workspace_id: workspaceId,
    origin_workspace_name: '项目',
    origin_workspace_path: 'D:/project',
    title: '日志标题',
    body_md: '日志正文',
    change_type: '新增',
    occurred_at: 1,
    created_by: 'user',
    updated_by: 'user',
    created_at: 1,
    updated_at: 1,
    revision: 2,
    legacy_source_key: null,
    ...overrides,
  };
}

function withClient(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  resetOverlays();
  usePanelStore.setState({ view: null, issueId: null, sessionId: null, chatSession: null, unread: {}, refPanel: null, rightOpen: false });
  useAppStore.setState({ workspaceId, wsStatus: 'open' });
  // RefPanel 的正文是 MarkdownView（懒加载门控依赖 IntersectionObserver），jsdom 里立即视为可见
  class ImmediateIntersectionObserver {
    private callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
    }
    observe(element: Element): void {
      if (element.hasAttribute('data-changelog-id')) return;
      setTimeout(() => {
        this.callback(
          [{ isIntersecting: true, target: element } as unknown as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }, 0);
    }
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  Object.defineProperty(window, 'IntersectionObserver', { value: ImmediateIntersectionObserver, writable: true, configurable: true });
});

describe('panelStore：ref 视图', () => {
  it('openRef 设 view=ref 并带 kind/id/title；与 detail/chat 互斥清空', () => {
    usePanelStore.getState().openRef({ kind: 'knowledge', id: 'kp-1', title: 'BOM 守卫' });
    expect(usePanelStore.getState()).toMatchObject({
      view: 'ref',
      refPanel: { kind: 'knowledge', id: 'kp-1', title: 'BOM 守卫' },
      rightOpen: true,
      issueId: null,
    });

    usePanelStore.getState().openDetail('i-1');
    expect(usePanelStore.getState()).toMatchObject({ view: 'detail', issueId: 'i-1', refPanel: null });

    usePanelStore.getState().openRef({ kind: 'log', id: 'log-1', title: '日志标题' });
    usePanelStore.getState().openChat('s-1');
    expect(usePanelStore.getState()).toMatchObject({ view: 'chat', refPanel: null });

    usePanelStore.getState().openRef({ kind: 'log', id: 'log-1', title: '日志标题' });
    usePanelStore.getState().clearView();
    expect(usePanelStore.getState()).toMatchObject({ view: null, refPanel: null, rightOpen: false });
  });
});

describe('RefPanel：按 kind 显示内容', () => {
  it('知识：拉 /api/knowledge/pages/:id 并渲染标题与正文', async () => {
    server.use(
      http.get('/api/knowledge/pages/kp-1', () => HttpResponse.json(knowledgePage())),
    );
    usePanelStore.setState({ refPanel: { kind: 'knowledge', id: 'kp-1', title: 'BOM 守卫' } });
    withClient(<RefPanel />);

    expect(await screen.findByTestId('ref-panel-knowledge')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('BOM 守卫');
    const body = screen.getByTestId('ref-panel-body');
    await waitFor(() => expect(body).toHaveTextContent('公共知识正文'));
  });

  it('日志：拉当前工作区 changelog 详情并渲染', async () => {
    server.use(
      http.get(`/api/workspaces/${workspaceId}/changelog/log-1`, () => HttpResponse.json(changeLog())),
    );
    usePanelStore.setState({ refPanel: { kind: 'log', id: 'log-1', title: '日志标题' } });
    withClient(<RefPanel />);

    expect(await screen.findByTestId('ref-panel-log')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('日志标题');
    await waitFor(() => expect(screen.getByTestId('ref-panel-body')).toHaveTextContent('日志正文'));
  });

  it('知识 404 → 显示「无权限或不存在」（不当空白/外链）', async () => {
    server.use(
      http.get('/api/knowledge/pages/missing', () =>
        HttpResponse.json({ error: { code: 'NOT_FOUND', message: '不存在' } }, { status: 404 }),
      ),
    );
    usePanelStore.setState({ refPanel: { kind: 'knowledge', id: 'missing', title: '缺失' } });
    withClient(<RefPanel />);

    expect(await screen.findByTestId('ref-panel-error')).toHaveTextContent('无权限或不存在');
  });

  it('没有目标时给空态', () => {
    usePanelStore.setState({ refPanel: null });
    withClient(<RefPanel />);
    expect(screen.getByTestId('ref-panel-empty')).toBeInTheDocument();
  });
});

describe('RightPanel：ref 视图', () => {
  it('view=ref 时标题按 kind 显示「知识 / 日志」并渲染 RefPanel', async () => {
    server.use(
      http.get('/api/knowledge/pages/kp-1', () => HttpResponse.json(knowledgePage())),
      http.get('/api/managed-account-capabilities', () => HttpResponse.json([])),
      http.get('/api/managed-accounts', () => HttpResponse.json([])),
    );
    usePanelStore.getState().openRef({ kind: 'knowledge', id: 'kp-1', title: 'BOM 守卫' });
    useOverlayStore.getState().openRight();
    withClient(<RightPanel />);

    const panel = await screen.findByTestId('right-panel');
    expect(within(panel).getByRole('heading', { level: 2 })).toHaveTextContent('知识');
    expect(within(panel).getByTestId('ref-panel-view')).not.toHaveAttribute('aria-hidden', 'true');
    expect(await within(panel).findByTestId('ref-panel-knowledge')).toBeInTheDocument();

    usePanelStore.getState().openRef({ kind: 'log', id: 'log-1', title: '日志标题' });
    await waitFor(() => expect(within(panel).getByRole('heading', { level: 2 })).toHaveTextContent('日志'));
  });
});
