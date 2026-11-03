/**
 * 仅供 CDP 校验用的隔离 harness（KB-GRAPH-P1）：真实 `pixiGraph.ts` + 真实 `index.css` 语义色，
 * 不含应用壳（路由/侧栏/登录）。数据是构造出来的，用于逐值核对半径/字号/textAlpha/线宽/双向边/11 色。
 * 生产构建不引用这个文件（入口是 index.html）。
 */
import './index.css';
import { createPixiGraph, type PixiGraphData } from './components/knowledge/pixiGraph';

const host = document.getElementById('stage') as HTMLDivElement;

const nodes: PixiGraphData['nodes'] = [];
const edges: PixiGraphData['edges'] = [];
const positions = new Map<string, { x: number; y: number }>();

// hub 连 8 个叶子 → weight 8 → getSize = 9 → fontSize 16.25（文档实测值）
nodes.push({ id: 'hub', title: '枢纽页（weight 8）', weight: 8 });
positions.set('hub', { x: 0, y: 0 });
for (let i = 1; i <= 8; i += 1) {
  const id = `leaf${i}`;
  nodes.push({ id, title: `叶子 ${i}`, weight: 1 });
  const angle = (Math.PI * 2 * i) / 8;
  positions.set(id, { x: Math.cos(angle) * 220, y: Math.sin(angle) * 220 });
  edges.push({ key: `hub-${id}`, source: 'hub', target: id, kind: 'source', weight: 3 });
}

// 双向边 A↔B：只画字典序大的那条（文档 A6）
nodes.push({ id: 'a', title: '双向 A', weight: 1 }, { id: 'b', title: '双向 B', weight: 1 });
positions.set('a', { x: 420, y: 0 });
positions.set('b', { x: 620, y: 0 });
edges.push({ key: 'a-b', source: 'a', target: 'b', kind: 'source', weight: 3 });
edges.push({ key: 'b-a', source: 'b', target: 'a', kind: 'source', weight: 3 });

const graph = createPixiGraph(host, {});
graph.update({ nodes, edges, positions, highlight: null });
graph.zoomBy(1);

interface HarnessApi {
  snapshot: () => ReturnType<typeof graph.snapshot>;
  zoomTo: (scale: number) => void;
  changed: () => void;
  refreshColors: () => void;
  setDark: (on: boolean) => void;
  setVar: (name: string, value: string) => void;
  resetVar: (name: string) => void;
}

const api: HarnessApi = {
  snapshot: () => graph.snapshot(),
  zoomTo: (scale) => {
    const current = graph.snapshot().targetScale;
    graph.zoomBy(scale / current);
  },
  changed: () => graph.changed(),
  refreshColors: () => graph.refreshColors(),
  setDark: (on) => {
    document.documentElement.classList.toggle('dark', on);
  },
  setVar: (name, value) => {
    document.documentElement.style.setProperty(name, value);
  },
  resetVar: (name) => {
    document.documentElement.style.removeProperty(name);
  },
};

(globalThis as unknown as { __harness: HarnessApi }).__harness = api;
(globalThis as unknown as { __harnessReady: boolean }).__harnessReady = true;
