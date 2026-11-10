/**
 * TOOLBAR-BLANK：知识库/日志视图不挂看板顶栏（避免页顶留空白带），但锚点 testid 仍可定位。
 *
 * TOPBAR-REDESIGN（2026-11-10）：旧 ViewToolbarShell 已由看板专用的 TopBar 取代，
 * 外壳自身的空态单测随组件删除；这里保留「知识库/日志无 view-toolbar-shell」两条。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { KnowledgePanel } from '../components/knowledge/KnowledgePanel';
import { ChangelogPanel } from '../components/changelog/ChangelogPanel';
import { useAppStore } from '../state/appStore';
import { server } from './server';

function withClient(ui: React.ReactElement): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  useAppStore.setState({ workspaceId: 'ws-1', selectedLabelsByWorkspace: {} });
  server.use(
    http.get('/api/issues', () => HttpResponse.json([])),
    http.get('/api/sessions', () => HttpResponse.json([])),
    http.get('/api/knowledge/pages', () => HttpResponse.json({ items: [], next_offset: null })),
    http.get('/api/knowledge/search', () => HttpResponse.json([])),
    http.get('/api/workspaces', () => HttpResponse.json([{ id: 'ws-1', name: '主项目', path: 'D:/ws/main', created_at: 1 }])),
    http.get('/api/workspaces/ws-1/changelog', () => HttpResponse.json({ items: [], next_offset: null })),
  );
});

describe('知识库/日志不挂看板顶栏（TOOLBAR-BLANK）', () => {
  it('知识库面板无看板顶栏，但锚点 testid 仍可定位', () => {
    withClient(<KnowledgePanel workspaceId="ws-1" />);
    const knowledge = screen.getByRole('region', { name: '共享知识库' });
    expect(knowledge.querySelector('[data-testid="view-toolbar-shell"]')).toBeNull();
    expect(screen.getByTestId('knowledge-toolbar-controls')).toBeInTheDocument();
  });

  it('日志面板同样无空外壳，锚点保留', () => {
    withClient(<ChangelogPanel workspaceId="ws-1" />);
    const log = screen.getByTestId('changelog-panel');
    expect(log.querySelector('[data-testid="view-toolbar-shell"]')).toBeNull();
    expect(screen.getByTestId('log-toolbar-controls')).toBeInTheDocument();
  });
});
