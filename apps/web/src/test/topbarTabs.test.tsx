/**
 * TOPBAR-TABS 回归：三视图切换时，顶栏 tab 组的水平起点与垂直位置必须恒定。
 *
 * jsdom 不做布局（getBoundingClientRect 全是 0），所以这里断言**决定几何的那层结构**：
 * tab 组的包裹层与其父级工具条外壳在三视图下必须是同一份 class，视图根节点不得带内边距
 * （根节点内边距会把外壳整体推偏）。真实像素由 CDP 三视口实测保证。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { ReactElement } from 'react';
import { Board } from '../components/board/Board';
import { KnowledgePanel } from '../components/knowledge/KnowledgePanel';
import { useAppStore } from '../state/appStore';
import { server } from './server';

function withClient(node: ReactElement): ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

/** 视图根节点上的盒模型内边距类（会把工具条外壳整体推偏） */
function paddingClasses(element: Element): string[] {
  return element.className.split(/\s+/).filter((cls) => /^p[trblxy]?-/.test(cls));
}

interface TabShell { wrapper: Element; shell: Element | null; viewRoot: Element | null }

/** TOPBAR-REDESIGN：新顶栏是唯一的 view-toolbar-shell 宿主，直接按 testid 向上定位 */
function tabShell(wrapperTestId: string): TabShell {
  const wrapper = screen.getByTestId(wrapperTestId);
  const shell = wrapper.closest('[data-testid="view-toolbar-shell"]');
  return { wrapper, shell, viewRoot: shell?.parentElement ?? null };
}

function renderBoard(): TabShell & { shell: Element; viewRoot: Element } {
  render(withClient(
    <Board />,
  ));
  const result = tabShell('board-toolbar-controls');
  if (!result.shell || !result.viewRoot) throw new Error('看板顶栏外壳缺失');
  return result as TabShell & { shell: Element; viewRoot: Element };
}

function renderKnowledge(): TabShell {
  render(withClient(
    <KnowledgePanel workspaceId="ws-1" />,
  ));
  return tabShell('knowledge-toolbar-controls');
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ workspaceId: 'ws-1' });
  server.use(
    http.get('/api/issues', () => HttpResponse.json([])),
    http.get('/api/sessions', () => HttpResponse.json([])),
    http.get('/api/workspaces', () => HttpResponse.json([{ id: 'ws-1', name: '主项目', path: 'D:/ws/main', created_at: 1 }])),
    http.get('/api/knowledge/pages', () => HttpResponse.json({ items: [], next_offset: null })),
    http.get('/api/knowledge/search', () => HttpResponse.json([])),
  );
});

describe('顶栏 tab 组跨视图位置恒定（TOPBAR-TABS）', () => {
  it('看板保留工具条外壳；知识库/日志的空壳被移除（TOOLBAR-BLANK）', () => {
    const board = renderBoard();
    renderKnowledge();

    // 看板壳内有搜索框 / 标签 / 新建入口 → 外壳照常渲染，仍是 px-4 py-2 + 下边框
    expect(board.shell.className).toContain('px-4');
    expect(board.shell.className).toContain('py-2');
    expect(board.shell.className).toContain('border-b');
    expect(paddingClasses(board.viewRoot)).toEqual([]);
    // 包裹层仍在，且锚点 testid 未丢
    expect(screen.getByTestId('board-toolbar-controls')).toBeInTheDocument();

    // 知识库壳内已无控件 → 整个外壳不渲染（否则会留 ~40px 空白带）
    expect(screen.queryByTestId('view-toolbar-shell')).toBeInTheDocument(); // 看板仍有一个
    const knowledgeRoot = screen.getByRole('region', { name: '共享知识库' });
    expect(within(knowledgeRoot as HTMLElement).queryByTestId('view-toolbar-shell')).toBeNull();
    // 锚点迁到内容区，测试仍可定位
    expect(screen.getByTestId('knowledge-toolbar-controls')).toBeInTheDocument();
  });

  it('知识库内容区仍保留原有内边距（不能靠去掉页面留白来对齐 tab）', () => {
    renderKnowledge();
    const region = screen.getByRole('region', { name: '共享知识库' });
    // 内容区仍是 flex-1 + p-4（空白带去掉后，页面留白不能跟着消失）
    const content = [...region.querySelectorAll('div')].find((el) => el.className.includes('p-4'));
    expect(content, '知识库内容区仍应有 p-4 容器').toBeTruthy();
    expect(content!.className).toContain('flex-1');
    // 标题块按用户要求移除（KB-PANEL-POLISH）
    expect(within(region as HTMLElement).queryByText('共享知识库')).toBeNull();
  });
});
