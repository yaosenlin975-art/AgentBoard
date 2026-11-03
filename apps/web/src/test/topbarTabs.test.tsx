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

interface TabShell { wrapper: Element; shell: Element; viewRoot: Element }

function tabShell(wrapperTestId: string): TabShell {
  const wrapper = screen.getByTestId(wrapperTestId);
  const shell = wrapper.parentElement;
  const viewRoot = shell?.parentElement;
  if (!shell || !viewRoot) throw new Error(`tab 组包裹层/外壳缺失：${wrapperTestId}`);
  return { wrapper, shell, viewRoot };
}

function renderBoard(): TabShell {
  render(withClient(
    <Board layout="board" onLayout={() => undefined} knowledgeOpen={false} onToggleKnowledge={() => undefined} />,
  ));
  return tabShell('board-toolbar-controls');
}

function renderKnowledge(): TabShell {
  render(withClient(
    <KnowledgePanel workspaceId="ws-1" layout="board" onLayout={() => undefined} onToggleKnowledge={() => undefined} />,
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
  it('平铺看板与知识库共用同一份 tab 包裹层与工具条外壳 class', () => {
    const board = renderBoard();
    const knowledge = renderKnowledge();

    // 决定 left/top 的两层：包裹层 + 外壳，两侧 class 必须完全一致
    expect(knowledge.shell.className).toBe(board.shell.className);
    expect(knowledge.wrapper.className).toBe(board.wrapper.className);
    // 外壳自带 px-3 py-1；视图根节点不得再带内边距（否则整体位移）
    expect(board.shell.className).toContain('px-4');
    expect(board.shell.className).toContain('py-2');
    expect(paddingClasses(board.viewRoot)).toEqual([]);
    expect(paddingClasses(knowledge.viewRoot)).toEqual([]);
  });

  it('知识库内容区仍保留原有内边距（不能靠去掉页面留白来对齐 tab）', () => {
    const knowledge = renderKnowledge();
    const content = knowledge.shell.nextElementSibling as HTMLElement | null;
    expect(content).not.toBeNull();
    expect(content!.className).toContain('p-4');
    expect(content!.className).toContain('flex-1');
    // 标题块按用户要求移除（KB-PANEL-POLISH）；区域语义保留在 section 的 aria-label 上
    expect(within(content!).queryByText('共享知识库')).toBeNull();
    expect(screen.getByRole('region', { name: '共享知识库' })).toBeInTheDocument();
  });
});
