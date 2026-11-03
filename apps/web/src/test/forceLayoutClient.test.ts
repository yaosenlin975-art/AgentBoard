/**
 * KB-GRAPH-P3 布局客户端：D6 报文（已存在节点 false 占位）、只在结构变化时 re-alpha、收敛即停。
 */
import { describe, expect, it, vi } from 'vitest';
import { createForceLayoutClient } from '../lib/forceLayoutClient';
import type { SimMessage } from '../lib/forceLayout';

class FakeWorker {
  messages: SimMessage[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  postMessage(message: SimMessage): void {
    this.messages.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(positions: Array<[string, number, number]>, idle: boolean, ticks: number): void {
    this.onmessage?.({ data: { positions, alpha: idle ? 0.0005 : 0.2, idle, ticks } } as MessageEvent);
  }
}

const initial = new Map([
  ['a', { x: 0, y: 0 }],
  ['b', { x: 100, y: 0 }],
]);

describe('D6 报文与 re-alpha 条件', () => {
  it('首次 apply：带初始坐标、links、alpha .3 与 run', () => {
    const worker = new FakeWorker();
    const client = createForceLayoutClient({ workerFactory: () => worker as unknown as Worker, onPositions: vi.fn() });
    const result = client.apply(
      { ids: ['a', 'b'], neighbours: new Map([['a', new Set(['b'])], ['b', new Set(['a'])]]), links: [['a', 'b']] },
      initial,
    );
    expect(result.structural).toBe(true);
    expect(worker.messages).toHaveLength(1);
    const message = worker.messages[0]!;
    expect(message.alpha).toBe(0.3);
    expect(message.run).toBe(true);
    expect(message.nodes).toEqual({ a: [0, 0], b: [100, 0] });
    expect(message.links).toEqual([['a', 'b']]);
    client.destroy();
    expect(worker.terminated).toBe(true);
  });

  it('增量：已存在节点用 false 占位保持原坐标，只有新节点带坐标', () => {
    const worker = new FakeWorker();
    const client = createForceLayoutClient({ workerFactory: () => worker as unknown as Worker, onPositions: vi.fn() });
    const neighbours = new Map([['a', new Set(['b'])], ['b', new Set(['a'])]]);
    client.apply({ ids: ['a', 'b'], neighbours, links: [['a', 'b']] }, initial);
    worker.reply([['a', 0, 0], ['b', 100, 0]], true, 248);
    client.apply(
      {
        ids: ['a', 'b', 'c'],
        neighbours: new Map([...neighbours, ['c', new Set(['a'])]]),
        links: [['a', 'b'], ['a', 'c']],
      },
      initial,
    );
    const incremental = worker.messages.at(-1)!;
    expect(incremental.nodes?.a).toBe(false);
    expect(incremental.nodes?.b).toBe(false);
    expect(Array.isArray(incremental.nodes?.c)).toBe(true);
    expect(incremental.alpha).toBe(0.3);
    expect(incremental.run).toBe(true);
  });

  it('结构未变（仅样式/权重变化）→ 不发 alpha/run，不重新激活布局', () => {
    const worker = new FakeWorker();
    const client = createForceLayoutClient({ workerFactory: () => worker as unknown as Worker, onPositions: vi.fn() });
    const graph = { ids: ['a', 'b'], neighbours: new Map([['a', new Set(['b'])], ['b', new Set(['a'])]]), links: [['a', 'b']] as Array<[string, string]> };
    client.apply(graph, initial);
    worker.reply([['a', 0, 0], ['b', 100, 0]], true, 248);
    const tickBefore = client.ticks();
    client.apply(graph, initial);
    const second = worker.messages.at(-1)!;
    expect(second.alpha).toBeUndefined();
    expect(second.run).toBeUndefined();
    expect(client.ticks()).toBe(tickBefore);
  });

  it('worker 回 idle 后 running()=false 且触发 onIdle（收敛即停）', () => {
    const worker = new FakeWorker();
    const onIdle = vi.fn();
    const client = createForceLayoutClient({ workerFactory: () => worker as unknown as Worker, onPositions: vi.fn(), onIdle });
    client.apply({ ids: ['a', 'b'], neighbours: new Map(), links: [['a', 'b']] }, initial);
    expect(client.running()).toBe(true);
    worker.reply([['a', 0, 0], ['b', 100, 0]], true, 248);
    expect(client.running()).toBe(false);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(client.ticks()).toBe(248);
  });

  it('无 Worker（jsdom）走同线程 tick：跑到收敛后停，位置回调至少一次', () => {
    const seen: Array<Map<string, { x: number; y: number }>> = [];
    const client = createForceLayoutClient({
      workerFactory: () => null,
      onPositions: (positions) => seen.push(positions),
      // 同步让出点：测试里一次跑完，不用真等 16.67ms
      scheduler: (run) => run(),
    });
    client.apply({ ids: ['a', 'b'], neighbours: new Map(), links: [['a', 'b']] }, initial);
    expect(client.running()).toBe(false);
    expect(client.ticks()).toBe(248);
    expect(seen.length).toBeGreaterThan(0);
    const last = seen.at(-1)!;
    expect(last.has('a')).toBe(true);
    expect(last.has('b')).toBe(true);
    client.destroy();
  });
});

describe('GRAPH-WEIGHT-DRAG 任务5：拖拽期间持续 simulate', () => {
  it('dragStart 发 fx/fy + alpha .3 + alphaTarget .3 + run；dragMove 续发；dragEnd 清 fx/fy', () => {
    const worker = new FakeWorker();
    const client = createForceLayoutClient({ workerFactory: () => worker as unknown as Worker, onPositions: vi.fn() });
    client.apply({ ids: ['a', 'b'], neighbours: new Map(), links: [['a', 'b']] }, initial);
    worker.reply([['a', 0, 0], ['b', 100, 0]], true, 248);
    worker.messages.length = 0;

    client.dragStart('a', { x: 10, y: 20 });
    const start = worker.messages.at(-1)!;
    expect(start.forceNode).toEqual({ id: 'a', x: 10, y: 20 });
    expect(start.alpha).toBe(0.3);
    expect(start.alphaTarget).toBe(0.3);
    expect(start.run).toBe(true);
    expect(client.dragging()).toBe('a');
    expect(client.running()).toBe(true);

    client.dragMove('a', { x: 40, y: 60 });
    const move = worker.messages.at(-1)!;
    expect(move.forceNode).toEqual({ id: 'a', x: 40, y: 60 });
    expect(move.alphaTarget).toBe(0.3);

    client.dragEnd('a');
    const end = worker.messages.at(-1)!;
    expect(end.forceNode).toEqual({ id: 'a', x: null, y: null });
    expect(end.alphaTarget).toBe(0);
    expect(client.dragging()).toBe(null);
  });

  it('拖拽期间 worker 每 tick 回传位置 → 布局不冻结（其它节点坐标会变）', () => {
    const worker = new FakeWorker();
    const seen: Array<Map<string, { x: number; y: number }>> = [];
    const client = createForceLayoutClient({
      workerFactory: () => worker as unknown as Worker,
      onPositions: (positions) => seen.push(positions),
    });
    client.apply({ ids: ['a', 'b'], neighbours: new Map(), links: [['a', 'b']] }, initial);
    worker.reply([['a', 0, 0], ['b', 100, 0]], true, 248);
    client.dragStart('a', { x: 0, y: 0 });
    // 模拟拖拽期间 worker 连续 tick 回传：b 被牵动
    worker.reply([['a', 0, 0], ['b', 140, 30]], false, 10);
    worker.reply([['a', 0, 0], ['b', 170, 55]], false, 20);
    const last = seen.at(-1)!;
    expect(last.get('b')).toEqual({ x: 170, y: 55 });
    expect(client.ticks()).toBe(20);
  });
});
