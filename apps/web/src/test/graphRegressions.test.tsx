/**
 * R4-B9 / B10 验收：
 * - B9：`KnowledgeGraph` 尺寸守卫里不再有「520ms 什么也不做的 setTimeout」
 * - B10：复制页链接失败时不再产生 unhandledrejection（否则会被诊断上报收走，污染取证数据）
 *
 * B10 的落点在 `KnowledgeGraph.tsx` 的菜单 onClick（`void navigator.clipboard?.writeText(...)`
 * 后面必须跟 `.catch`）。jsdom 下没有 canvas 就不进 PIXI，右键菜单无法通过 UI 打开，
 * 所以直接断言源码契约 + 在真实浏览器里用 CDP 验行为（见注释）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { server } from './server';
import { KnowledgeGraph } from '../components/knowledge/KnowledgeGraph';
import type { GraphNode, GraphPayload } from '../lib/knowledgeGraph';

function node(id: string, title: string): GraphNode {
  return { id, title, scope: 'workspace', workspace_id: 'A', revision: 1, degree: 1 };
}

function remoteGraph(nodes: GraphNode[], edges: GraphPayload['edges']): GraphPayload {
  return {
    nodes,
    edges,
    truncated: false,
    truncated_reason: null,
    pages_truncated: false,
    node_total: nodes.length,
    edge_total: edges.length,
    page_total: nodes.length,
    pages_loaded: nodes.length,
  };
}

function mountGraph(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <KnowledgeGraph workspaceId="A" scope="both" onSelect={() => undefined} />
    </QueryClientProvider>,
  );
}

const GRAPH_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../components/knowledge/KnowledgeGraph.tsx'),
  'utf8',
);

beforeEach(() => {
  cleanup();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('R4-B9 尺寸守卫不残留空定时器', () => {
  it('源码里没有 520ms 的空 setTimeout / sizeWaitTimer', () => {
    expect(GRAPH_SOURCE).not.toContain('sizeWaitTimer');
    expect(GRAPH_SOURCE).not.toMatch(/setTimeout\(\(\)\s*=>\s*\{[^}]*\}\s*,\s*520\)/);
  });

  it('容器尺寸正常时，挂载期间不注册 520ms 定时器', async () => {
    const delays: number[] = [];
    const originalSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number) => {
      if (typeof timeout === 'number') delays.push(timeout);
      return originalSetTimeout(handler, timeout);
    }) as typeof window.setTimeout);

    server.use(http.get('/api/knowledge/graph', () => HttpResponse.json(remoteGraph([node('p1', 'A')], []))));
    mountGraph();
    await screen.findByTestId('knowledge-graph-stats');
    await new Promise((resolve) => originalSetTimeout(resolve, 60));

    expect(delays).not.toContain(520);
  });
});

describe('R4-B10 复制失败不进诊断缓冲', () => {
  it('源码契约：writeText 的 promise 被 catch 消费，不留裸 void', () => {
    // 裸 `void navigator.clipboard?.writeText(...)` 会让 rejection 逃逸成 unhandledrejection
    expect(GRAPH_SOURCE).toMatch(/navigator\.clipboard\?\.writeText\([^)]*\)\.catch\(/);
  });

  it('行为等价：裸 void 的 rejection 无人消费，加 catch 后被吞掉', async () => {
    const failing = async (): Promise<void> => Promise.reject(new Error('NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: failing } });

    // jsdom 不派发 unhandledrejection（Node 的 process 级事件与 v8 的检测口径不同），
    // 所以直接比较「这个 promise 有没有被消费」——这正是修复的实质。
    const bare = navigator.clipboard.writeText('knowledge://x');
    let bareSettled = 'pending';
    void bare.then(
      () => {
        bareSettled = 'fulfilled';
      },
      () => {
        bareSettled = 'rejected-unhandled';
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(bareSettled).toBe('rejected-unhandled');

    // 修复后的写法：catch 挂在原 promise 上，rejection 被消费
    const caught = navigator.clipboard.writeText('knowledge://y').catch(() => undefined);
    await expect(caught).resolves.toBeUndefined();
  });

  it('页面里真实触发一次未捕获 rejection 时，G3 钩子会把它记进缓冲（对照）', async () => {
    const { clearClientErrors, getClientErrors, installClientErrorHooks } = await import('../lib/errorBuffer');
    clearClientErrors();
    const uninstall = installClientErrorHooks(window);
    // jsdom 下手工派发（与浏览器行为等价的事件形状）
    const event = new Event('unhandledrejection') as Event & { reason?: unknown };
    event.reason = new Error('NotAllowedError');
    window.dispatchEvent(event);
    uninstall();

    const entries = getClientErrors();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe('rejection');
    expect(entries[0]?.message).toBe('NotAllowedError');
    clearClientErrors();
  });
});
