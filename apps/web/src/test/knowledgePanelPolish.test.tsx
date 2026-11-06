/**
 * KB-PANEL-POLISH 回归：知识库顶部标题块移除、搜索栏两行合一行、星图初始居中。
 *
 * jsdom 不做布局（getBoundingClientRect 全 0），所以这里断言**决定几何的结构**：
 * 五个控件必须属于同一个 form（同一行的前提）、标题块可见文本必须不存在；
 * 真实 top 值与星图 pan 由 CDP 实测。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { KnowledgePanel } from '../components/knowledge/KnowledgePanel';
import { panCenteredOn, positionsCenter } from '../lib/knowledgeGraph';
import { useAppStore } from '../state/appStore';
import { server } from './server';

function renderPanel(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <KnowledgePanel workspaceId="ws-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ workspaceId: 'ws-1' });
  server.use(
    http.get('/api/knowledge/pages', () => HttpResponse.json({ items: [], next_offset: null })),
    http.get('/api/knowledge/search', () => HttpResponse.json([])),
    http.get('/api/knowledge/graph', () => HttpResponse.json({ nodes: [], edges: [] })),
  );
});

describe('知识库标题块移除（KB-PANEL-POLISH）', () => {
  it('「共享知识库」标题与副标题不再渲染，视图 tab 仍在', () => {
    renderPanel();
    expect(screen.queryByText('共享知识库')).toBeNull();
    expect(screen.queryByText('当前项目与公共经验：标题、正文与标签都可搜索')).toBeNull();
    // 区域语义仍保留在 section 的 aria-label 上（不是可见文本）
    expect(screen.getByRole('region', { name: '共享知识库' })).toBeInTheDocument();
    expect(screen.getByTestId('knowledge-view-list')).toBeInTheDocument();
    expect(screen.getByTestId('knowledge-view-graph')).toBeInTheDocument();
  });
});

describe('搜索栏两行合一行（KB-PANEL-POLISH）', () => {
  it('范围 / 搜索框 / 搜索按钮 / 状态 / 包含过期 同属一个 form', () => {
    renderPanel();
    const scope = screen.getByLabelText('知识范围');
    const keyword = screen.getByLabelText('搜索知识');
    const submit = screen.getByRole('button', { name: '搜索' });
    const status = screen.getByLabelText('知识状态');
    const expired = screen.getByLabelText('包含过期');

    const form = scope.closest('form');
    expect(form).not.toBeNull();
    for (const control of [scope, keyword, submit, status, expired]) {
      expect(control.closest('form')).toBe(form);
    }
  });

  it('9 个控件同属一个工具条容器，顺序不变（含密度 / 分组）', () => {
    renderPanel();
    const scope = screen.getByLabelText('知识范围');
    const keyword = screen.getByLabelText('搜索知识');
    const submit = screen.getByRole('button', { name: '搜索' });
    const hint = screen.getByTestId('knowledge-search-hint');
    const add = screen.getByTestId('knowledge-import-open');
    const status = screen.getByLabelText('知识状态');
    const expired = screen.getByLabelText('包含过期');
    const density = screen.getByLabelText('知识列表密度');
    const grouping = screen.getByLabelText('知识列表分组');
    const ordered: Array<[string, HTMLElement]> = [
      ['范围', scope], ['搜索框', keyword], ['搜索按钮', submit], ['Enter 提示', hint],
      ['添加', add], ['状态', status], ['包含过期', expired], ['密度', density], ['分组', grouping],
    ];

    const form = scope.closest('form');
    expect(form).not.toBeNull();
    for (const [, control] of ordered) {
      expect(control.closest('form')).toBe(form);
    }
    // DOM 顺序即视觉顺序，合并成一行后不得重排
    for (let i = 1; i < ordered.length; i += 1) {
      const prev = ordered[i - 1]![1];
      const cur = ordered[i]![1];
      expect(prev.compareDocumentPosition(cur) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // <900px 的整行断点位于「包含过期」与「密度」之间（窄屏两行降级的锚点）
    const brk = screen.getByTestId('knowledge-toolbar-break');
    expect(expired.compareDocumentPosition(brk) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(brk.compareDocumentPosition(density) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('搜索态隐藏状态筛选（与搜索接口参数一致），仍留在一个 form 里', () => {
    renderPanel();
    const keyword = screen.getByLabelText('搜索知识');
    fireEvent.change(keyword, { target: { value: '布局' } });
    const form = keyword.closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    expect(screen.queryByLabelText('知识状态')).toBeNull();
    expect(screen.queryByLabelText('包含过期')).toBeNull();
    expect(screen.getByRole('button', { name: '清除搜索' }).closest('form')).toBe(form);
  });
});

describe('星图居中换算（KB-PANEL-POLISH）', () => {
  it('positionsCenter：包围盒中心，空集返回 null', () => {
    expect(positionsCenter(new Map())).toBeNull();
    expect(positionsCenter(new Map([
      ['a', { x: 100, y: 50 }],
      ['b', { x: 300, y: 250 }],
    ]))).toEqual({ x: 200, y: 150 });
  });

  it('panCenteredOn：内容中心落在视口中心，且不夹带缩放', () => {
    const pan = panCenteredOn({ x: 360, y: 240 }, 1000, 600);
    expect(pan).toEqual({ x: 500 - 360, y: 300 - 240 });
    // 反算：中心点经 pan 变换后正好在画布中心（旧实现 pan=0 → 落在左上角）
    expect(360 + pan.x).toBeCloseTo(500, 6);
    expect(240 + pan.y).toBeCloseTo(300, 6);
    // 带缩放时锚点仍居中
    const zoomed = panCenteredOn({ x: 360, y: 240 }, 1000, 600, 2);
    expect(360 * 2 + zoomed.x).toBeCloseTo(500, 6);
    expect(240 * 2 + zoomed.y).toBeCloseTo(300, 6);
  });
});
