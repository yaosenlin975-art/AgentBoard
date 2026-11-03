/**
 * KB-MODEL：四类内容模型（design / solved / pinned / open，缺省 legacy）。
 * 覆盖：五色映射、category:/landed: 解析、legacy 回退（字段缺失不报错）、预设筛选、列表徽标。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from './server';
import { KnowledgePanel } from '../components/knowledge/KnowledgePanel';
import { KnowledgeGraph } from '../components/knowledge/KnowledgeGraph';
import {
  CATEGORY_STYLES,
  KNOWLEDGE_CATEGORIES,
  PRESET_UNLANDED_DESIGN,
  categoryColor,
  matchesQuery,
  nodeWeights,
  normalizeCategory,
  normalizeLanded,
  parseSearchQuery,
  searchMatches,
  type GraphNode,
} from '../lib/knowledgeGraph';

const node = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  title: id,
  scope: 'workspace',
  workspace_id: 'A',
  revision: 1,
  degree: 0,
  ...extra,
});

describe('normalizeCategory / normalizeLanded：缺失一律 legacy，不抛错', () => {
  it('四类 + legacy 原样，大小写与空白归一', () => {
    expect(normalizeCategory('design')).toBe('design');
    expect(normalizeCategory(' SOLVED ')).toBe('solved');
    expect(normalizeCategory('Pinned')).toBe('pinned');
    expect(normalizeCategory('open')).toBe('open');
    expect(normalizeCategory('legacy')).toBe('legacy');
  });

  it('缺失 / null / 未知 / 非字符串 → legacy（服务端字段未落库的容错）', () => {
    expect(normalizeCategory(undefined)).toBe('legacy');
    expect(normalizeCategory(null)).toBe('legacy');
    expect(normalizeCategory('')).toBe('legacy');
    expect(normalizeCategory('weird')).toBe('legacy');
    expect(normalizeCategory(42)).toBe('legacy');
    expect(normalizeCategory({ category: 'design' })).toBe('legacy');
  });

  it('landed 只认三值，其余 null', () => {
    expect(normalizeLanded('landed')).toBe('landed');
    expect(normalizeLanded('partial')).toBe('partial');
    expect(normalizeLanded('Proposed')).toBe('proposed');
    expect(normalizeLanded(undefined)).toBe(null);
    expect(normalizeLanded('done')).toBe(null);
  });
});

describe('五类固定配色（图例与画布共用同一份映射）', () => {
  it('五类颜色两两不同，且亮/暗各一套', () => {
    const light = KNOWLEDGE_CATEGORIES.map((category) => CATEGORY_STYLES[category].light);
    const dark = KNOWLEDGE_CATEGORIES.map((category) => CATEGORY_STYLES[category].dark);
    expect(new Set(light).size).toBe(5);
    expect(new Set(dark).size).toBe(5);
    for (const category of KNOWLEDGE_CATEGORIES) {
      expect(CATEGORY_STYLES[category].light).not.toBe(CATEGORY_STYLES[category].dark);
      expect(CATEGORY_STYLES[category].cssVar).toContain('--kb-cat-');
    }
  });

  it('categoryColor：缺失 → legacy 灰，design ≠ legacy', () => {
    expect(categoryColor(undefined, false)).toBe(CATEGORY_STYLES.legacy.light);
    expect(categoryColor(undefined, true)).toBe(CATEGORY_STYLES.legacy.dark);
    expect(categoryColor('design', false)).toBe(CATEGORY_STYLES.design.light);
    expect(categoryColor('design', false)).not.toBe(categoryColor(undefined, false));
  });
});

describe('parseSearchQuery：category: / landed: / tag: 前缀', () => {
  it('category:design 解析为类别过滤，无自由文本', () => {
    const parsed = parseSearchQuery('category:design');
    expect([...parsed.categories]).toEqual(['design']);
    expect(parsed.text).toBe('');
    expect(parsed.hasFilters).toBe(true);
  });

  it('landed:proposed|partial 解析为多个落地状态', () => {
    const parsed = parseSearchQuery('landed:proposed|partial');
    expect([...parsed.landed].sort()).toEqual(['partial', 'proposed']);
  });

  it('预设 = category:design landed:proposed|partial 同时生效', () => {
    const parsed = parseSearchQuery(PRESET_UNLANDED_DESIGN);
    expect([...parsed.categories]).toEqual(['design']);
    expect([...parsed.landed].sort()).toEqual(['partial', 'proposed']);
    expect(parsed.text).toBe('');
  });

  it('前缀与自由文本混用；未知前缀按文本处理', () => {
    const parsed = parseSearchQuery('缓存 category:solved');
    expect(parsed.text).toBe('缓存');
    expect([...parsed.categories]).toEqual(['solved']);
    expect(parseSearchQuery('foo:bar').text).toBe('foo:bar');
  });

  it('空查询没有任何过滤', () => {
    const parsed = parseSearchQuery('   ');
    expect(parsed.hasFilters).toBe(false);
    expect(parsed.text).toBe('');
  });
});

describe('searchMatches：category: 语法与 legacy 回退', () => {
  const nodes = [
    node('d1', { title: '设计甲', category: 'design', landed: 'proposed' }),
    node('d2', { title: '设计乙', category: 'design', landed: 'landed' }),
    node('s1', { title: '问题甲', category: 'solved' }),
    node('o1', { title: '旧页甲' }),
    node('o2', { title: '旧页乙', category: 'weird' }),
  ];

  it('category:design 只命中 design 节点', () => {
    expect([...searchMatches(nodes, 'category:design')].sort()).toEqual(['d1', 'd2']);
  });

  it('category:legacy 命中「字段缺失」与「未知值」两类旧页', () => {
    expect([...searchMatches(nodes, 'category:legacy')].sort()).toEqual(['o1', 'o2']);
  });

  it('预设只留未落地的设计方案（landed=proposed|partial）', () => {
    expect([...searchMatches(nodes, PRESET_UNLANDED_DESIGN)]).toEqual(['d1']);
  });

  it('无前缀时保持旧行为（标题子串）', () => {
    expect([...searchMatches(nodes, '设计')].sort()).toEqual(['d1', 'd2']);
    expect(searchMatches(nodes, '   ').size).toBe(0);
  });

  it('matchesQuery 对缺失字段不抛错', () => {
    const parsed = parseSearchQuery('category:open');
    expect(matchesQuery({ ...node('x'), category: undefined }, parsed)).toBe(false);
    expect(() => matchesQuery({ ...node('x'), category: undefined }, parsed)).not.toThrow();
    // nodeWeights 等既有入口也不受新字段影响
    expect(nodeWeights([node('x')], []).get('x')).toBe(0);
  });
});

describe('列表徽标：有 category 显示五类，字段缺失按 legacy 灰显', () => {
  const basePage = {
    scope: 'workspace' as const,
    workspace_id: 'A',
    revision: 1,
    status: 'active' as const,
    expires_at: null,
    body_md: '正文',
    sources: [],
    evidence: [],
    created_at: 1,
    updated_at: 1,
    slug: 'x',
  };

  function mountWith(items: unknown[]) {
    server.use(http.get('/api/knowledge/pages', () => HttpResponse.json({ items, next_offset: null })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <KnowledgePanel workspaceId="A" />
      </QueryClientProvider>,
    );
  }

  it('design + landed 显示「设计方案 / 未落地」；缺字段的页显示「旧页（未分类）」且不报错', async () => {
    mountWith([
      { ...basePage, id: 'p1', title: '设计页', category: 'design', landed: 'proposed' },
      { ...basePage, id: 'p2', title: '旧页' },
    ]);
    const designed = await screen.findByTestId('knowledge-item-p1');
    expect(designed).toHaveTextContent('设计方案');
    expect(designed).toHaveTextContent('未落地');
    const legacy = screen.getByTestId('knowledge-item-p2');
    expect(legacy).toHaveTextContent('旧页（未分类）');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('预设：只看未落地设计方案（0 命中时必须筛空，而不是看起来没生效）', () => {
  it('数据里没有 design 页时：可见节点 0 + 明确提示', async () => {
    server.use(
      http.get('/api/knowledge/graph', () =>
        HttpResponse.json({
          nodes: [
            { id: 'p1', title: '普通页甲', scope: 'workspace', workspace_id: 'A', revision: 1, degree: 1 },
            { id: 'p2', title: '普通页乙', scope: 'workspace', workspace_id: 'A', revision: 1, degree: 1 },
          ],
          edges: [{ source: 'p1', target: 'p2', kind: 'source', weight: 3, key: 'k' }],
          truncated: false,
          truncated_reason: null,
          pages_truncated: false,
          node_total: 2,
          edge_total: 1,
        }),
      ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <KnowledgeGraph workspaceId="A" scope="both" onSelect={() => undefined} />
      </QueryClientProvider>,
    );
    const preset = await screen.findByTestId('graph-preset-unlanded-design');
    preset.click();
    const root = screen.getByTestId('knowledge-graph');
    await screen.findByTestId('graph-empty-filter');
    expect(root.getAttribute('data-visible-nodes')).toBe('0');
    expect(root.getAttribute('data-focus-id')).toBe('');
    expect((screen.getByTestId('graph-search') as HTMLInputElement).value).toBe(PRESET_UNLANDED_DESIGN);
  });
});
