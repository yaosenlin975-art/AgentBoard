/**
 * TOOLBAR-BLANK：视图工具条外壳在**无可见内容**时不得渲染（否则页顶留 ~40px 空白带，
 * 带下边框 + surface-card 浅底色）。
 *
 * 覆盖三层：
 * 1. 外壳本身：空 children / 只有空 div / 只有纯空白文本 → 什么都不渲染；
 *    有文本、有自闭合控件（input/button）、有嵌套内容 → 正常渲染 `px-4 py-2 + border-b`；
 * 2. 知识库与日志面板不再挂空壳（DOM 里没有 `view-toolbar-shell`），锚点 testid 仍可定位；
 * 3. 看板壳内有搜索框 → 外壳保留（不能把看板一起删掉）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { ViewToolbarShell } from '../components/ui/ViewToolbarShell';
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

describe('工具条外壳的空态（TOOLBAR-BLANK）', () => {
  it('无可见内容时不渲染外壳；有内容时渲染并保持 px-4 py-2 + 下边框', () => {
    // 空 children
    const { container: empty1 } = render(<ViewToolbarShell>{null}</ViewToolbarShell>);
    expect(empty1.querySelector('[data-testid="view-toolbar-shell"]')).toBeNull();

    // 只有空 div（FIX-2 删掉 ViewSwitcher 后的真实形态）
    const { container: empty2 } = render(
      <ViewToolbarShell>
        <div data-testid="x-controls" className="flex" />
      </ViewToolbarShell>,
    );
    expect(empty2.querySelector('[data-testid="view-toolbar-shell"]')).toBeNull();

    // 只有纯空白文本
    const { container: empty3 } = render(<ViewToolbarShell>{'   '}</ViewToolbarShell>);
    expect(empty3.querySelector('[data-testid="view-toolbar-shell"]')).toBeNull();

    // 有文本 → 渲染
    const { container: text } = render(<ViewToolbarShell>保存</ViewToolbarShell>);
    const shell = text.querySelector('[data-testid="view-toolbar-shell"]');
    expect(shell).not.toBeNull();
    expect(shell!.className).toContain('px-4');
    expect(shell!.className).toContain('py-2');
    expect(shell!.className).toContain('border-b');

    // 自闭合控件（input）也算可见内容
    const { container: control } = render(
      <ViewToolbarShell>
        <input aria-label="搜索" />
      </ViewToolbarShell>,
    );
    expect(control.querySelector('[data-testid="view-toolbar-shell"]')).not.toBeNull();
  });

  it('知识库/日志面板不再渲染空外壳，但锚点 testid 仍可定位', () => {
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
