/**
 * 仅供 CDP 校验用的隔离 harness（KB-GRAPH-P1/P2）：真实 `pixiGraph.ts` + 真实 `index.css` 语义色，
 * 不含应用壳。P2 起额外提供 `__drive`（合成指针/滚轮/键盘事件 + 节点屏幕坐标换算），
 * 用来在真实 WebGL 环境里逐项核对交互，而不是靠 jsdom 猜。
 * 生产构建不引用这个文件（入口是 index.html）。
 */
import './index.css';
import { createPixiGraph, type PixiGraphEdge, type PixiGraphNode } from './components/knowledge/pixiGraph';

const host = document.getElementById('stage') as HTMLDivElement;
const CENTER = { x: 450, y: 300 };

const nodes: PixiGraphNode[] = [];
const edges: PixiGraphEdge[] = [];
const positions = new Map<string, { x: number; y: number }>();

// hub 连 8 个叶子 → weight 8 → getSize = 9 → fontSize 16.25（文档实测值）
nodes.push({ id: 'hub', title: '枢纽页（weight 8）', weight: 8 });
positions.set('hub', { ...CENTER });
for (let i = 1; i <= 8; i += 1) {
  const id = `leaf${i}`;
  nodes.push({ id, title: `叶子 ${i}`, weight: 1 });
  const angle = (Math.PI * 2 * i) / 8;
  positions.set(id, { x: CENTER.x + Math.cos(angle) * 220, y: CENTER.y + Math.sin(angle) * 220 });
  edges.push({ key: `hub-${id}`, source: 'hub', target: id, kind: 'source', weight: 3 });
}

// 双向边 A↔B（与 hub 无关，用作 hover 的「非邻居」样本）
nodes.push({ id: 'a', title: '双向 A', weight: 1 }, { id: 'b', title: '双向 B', weight: 1 });
positions.set('a', { x: CENTER.x + 120, y: CENTER.y - 250 });
positions.set('b', { x: CENTER.x + 320, y: CENTER.y - 250 });
edges.push({ key: 'a-b', source: 'a', target: 'b', kind: 'source', weight: 3 });
edges.push({ key: 'b-a', source: 'b', target: 'a', kind: 'source', weight: 3 });

const seen = {
  select: [] as string[],
  context: [] as Array<{ id: string; clientX: number; clientY: number }>,
  hover: [] as Array<string | null>,
  scale: [] as number[],
};

const graph = createPixiGraph(host, {
  onSelect: (id) => seen.select.push(id),
  onHover: (id) => seen.hover.push(id),
  onContextMenu: (target) => seen.context.push(target),
  onScaleChange: (scale) => seen.scale.push(scale),
});
graph.update({ nodes, edges, positions, highlight: null });

/** 世界坐标 → 客户端坐标（与渲染层同一套换算：screen = world*scale + pan，再加 host 偏移） */
function clientOf(id: string): { clientX: number; clientY: number } {
  const snap = graph.snapshot();
  const view = snap.nodes.find((node) => node.id === id);
  const point = view === undefined ? (positions.get(id) as { x: number; y: number }) : { x: view.x, y: view.y };
  const rect = host.getBoundingClientRect();
  const dpr = snap.dpr;
  return {
    clientX: rect.left + (point.x * snap.scale + snap.pan.x) / dpr,
    clientY: rect.top + (point.y * snap.scale + snap.pan.y) / dpr,
  };
}

function pointerEvent(type: string, clientX: number, clientY: number, extra: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, { clientX, clientY, pointerId: 1, bubbles: true, cancelable: true, ...extra });
}

const drive = {
  wheel(deltaY: number, clientX = CENTER.x, clientY = CENTER.y, deltaMode = 0): void {
    host.dispatchEvent(new WheelEvent('wheel', { deltaY, deltaMode, clientX, clientY, bubbles: true, cancelable: true }));
  },
  down(clientX: number, clientY: number): void {
    host.dispatchEvent(pointerEvent('pointerdown', clientX, clientY, { button: 0 }));
  },
  move(clientX: number, clientY: number): void {
    host.dispatchEvent(pointerEvent('pointermove', clientX, clientY));
  },
  up(clientX: number, clientY: number): void {
    host.dispatchEvent(pointerEvent('pointerup', clientX, clientY, { button: 0 }));
  },
  leave(): void {
    host.dispatchEvent(pointerEvent('pointerleave', 0, 0));
  },
  context(clientX: number, clientY: number): void {
    host.dispatchEvent(new MouseEvent('contextmenu', { clientX, clientY, bubbles: true, cancelable: true }));
  },
  key(type: 'keydown' | 'keyup', key: string, keyCode: number, shift = false): void {
    host.dispatchEvent(new KeyboardEvent(type, { key, keyCode, shiftKey: shift, bubbles: true, cancelable: true }));
  },
  clientOf,
  seen,
};

(globalThis as unknown as { __harness: unknown }).__harness = {
  snapshot: () => graph.snapshot(),
  changed: () => graph.changed(),
  zoomTo: (scale: number) => {
    const current = graph.snapshot().targetScale;
    graph.zoomBy(scale / current);
  },
  resetView: () => graph.resetView(),
  refreshColors: () => graph.refreshColors(),
  setDark: (on: boolean) => document.documentElement.classList.toggle('dark', on),
  setVar: (name: string, value: string) => document.documentElement.style.setProperty(name, value),
  positions: () => Object.fromEntries(positions),
};
(globalThis as unknown as { __drive: unknown }).__drive = drive;
(globalThis as unknown as { __harnessReady: boolean }).__harnessReady = true;
