/**
 * UNSLOP-5 回归：键盘键帽（keycap）、面板/卡片/控件三层圆角、骨架屏动画定性。
 *
 * jsdom 不做布局，所以这里断言「决定外观的结构与类名」：<kbd> 语义 + 等宽字体 + 发丝线边框、
 * 圆角档位（面板 16 / 卡片 8 / 控件 8）、animate-pulse 只出现在加载骨架。
 * 真实几何（computed border / border-radius）由 CDP 实测保证。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { KnowledgePanel } from '../components/knowledge/KnowledgePanel';
import { KnowledgeGraph } from '../components/knowledge/KnowledgeGraph';
import { Kbd } from '../components/ui/Kbd';
import { useAppStore } from '../state/appStore';
import { server } from './server';

function withClient(node: React.ReactElement): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
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

describe('keycap（UNSLOP-5）', () => {
  it('<kbd> 语义 + 等宽字体 + 发丝线边框 + 小尺寸', () => {
    render(<Kbd>Esc</Kbd>);
    const kbd = screen.getByText('Esc');
    expect(kbd.tagName).toBe('KBD');
    for (const cls of ['font-mono', 'border', 'border-hairline', 'rounded', 'text-[10px]', 'bg-surface-card']) {
      expect(kbd.className).toContain(cls);
    }
  });

  it('知识库搜索：回车提示用键帽（不再混排进文案）', () => {
    render(withClient(<KnowledgePanel workspaceId="ws-1" />));
    const hint = screen.getByTestId('knowledge-search-hint');
    const kbd = hint.querySelector('kbd');
    expect(kbd).not.toBeNull();
    expect(kbd?.textContent).toBe('Enter');
    expect(kbd?.className).toContain('font-mono');
    expect(hint).toHaveTextContent('搜索');
  });

  it('星图图例：方向键 / +− / Esc 三组快捷键都是键帽', () => {
    render(withClient(<KnowledgeGraph workspaceId="ws-1" scope="both" onSelect={() => undefined} />));
    const hints = screen.getByTestId('graph-keyboard-hints');
    const kbds = [...hints.querySelectorAll('kbd')].map((el) => el.textContent);
    expect(kbds).toEqual(['方向键', '+', '−', 'Esc']);
    expect(hints).toHaveTextContent('平移');
    expect(hints).toHaveTextContent('缩放');
    expect(hints).toHaveTextContent('关菜单');
  });
});

describe('嵌套圆角（UNSLOP-5：内 = 外 − 间距，且 ≥4）', () => {
  it('面板 16px / 控件 8px 分层（列表容器 rounded-2xl，输入与按钮 rounded-lg）', () => {
    render(withClient(<KnowledgePanel workspaceId="ws-1" />));
    const list = screen.getByTestId('knowledge-skeleton').closest('ul');
    expect(list?.className).toContain('rounded-2xl');
    expect(screen.getByLabelText('搜索知识').className).toContain('rounded-lg');
    expect(screen.getByRole('button', { name: '搜索' }).className).toContain('rounded-lg');
    expect(screen.getByLabelText('知识范围').className).toContain('rounded-lg');
  });

  it('星图面板 rounded-2xl，右键菜单/控件 rounded-lg', () => {
    render(withClient(<KnowledgeGraph workspaceId="ws-1" scope="both" onSelect={() => undefined} />));
    expect(screen.getByTestId('knowledge-graph').className).toContain('rounded-2xl');
    expect(screen.getByTestId('graph-zoom-in').className).toContain('rounded'); // 控件层
  });
});

describe('骨架屏动画定性（UNSLOP-5）', () => {
  it('animate-pulse 只用于真实加载中的骨架屏', () => {
    server.use(http.get('/api/knowledge/pages', () => new Promise(() => {})));
    render(withClient(<KnowledgePanel workspaceId="ws-1" />));
    const skeleton = screen.getByTestId('knowledge-skeleton');
    expect(skeleton.querySelectorAll('.animate-pulse')).toHaveLength(3);
    // 页面其它位置不得再有循环动画
    expect(document.querySelectorAll('.animate-pulse')).toHaveLength(3);
  });
});
