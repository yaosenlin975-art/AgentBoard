/**
 * KB-CLI-3c：`--json` 形状断言（契约 knowledge:bb929054-1d44-4542-bb96-4530e42b0546）。
 *
 * 两条硬断言：
 * 1. 列表类命令 → `{ items, next_offset }`（空结果也两个字段齐全）；
 * 2. 单对象命令 → 对象直出，不套 `items`。
 * 用真本地 HTTP server + `main()` 真实装配，不 mock fetch。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/index.js';

const WS = { id: 'ws1', name: '信封区', path: 'D:/ws/env', created_at: 1 };
const ISSUE = {
  id: 'iss1', workspace_id: 'ws1', title: '形状卡', description: '', status: '待规划',
  priority: '中', labels: [], sort_order: 0, created_at: 1, updated_at: 1,
};

let server: Server;
let base = '';

beforeEach(async () => {
  server = createServer((req, res) => {
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? '';
    if (url === '/api/workspaces') return json([WS]);
    if (url.startsWith('/api/issues?')) return json([ISSUE]);
    if (url.includes('/statuses')) return json([]);
    if (url.startsWith('/api/issues/iss1')) return json(ISSUE);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'mock 未匹配 ' + url } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function makeIo() {
  const out: string[] = [];
  return { io: { write: (s: string) => { out.push(s); }, writeErr: () => {}, readStdin: async () => '' }, out: () => out.join('') };
}

const run = async (args: string[]) => {
  const t = makeIo();
  const code = await main(['node', 'kb', '--server', base, ...args], t.io);
  return { code, out: t.out() };
};

describe('KB-CLI-3c：--json 形状', () => {
  it('列表命令 → { items, next_offset }（list-spaces / list-tasks 都带两字段）', async () => {
    for (const args of [['list-spaces'], ['list-tasks', '--workspace', 'ws1']]) {
      const result = await run(['--json', ...args]);
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.out) as { items: unknown[]; next_offset: number | null };
      expect(Array.isArray(parsed)).toBe(false);
      expect(Array.isArray(parsed.items)).toBe(true);
      expect(parsed.next_offset).toBeNull();
      expect(parsed.items.length).toBeGreaterThan(0);
    }
  });

  it('空结果也是信封（不省略字段）', async () => {
    const empty = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([]));
    });
    await new Promise<void>(resolve => empty.listen(0, '127.0.0.1', resolve));
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', `http://127.0.0.1:${(empty.address() as AddressInfo).port}`, '--json', 'list-spaces'], t.io);
    await new Promise<void>(resolve => empty.close(() => resolve()));
    expect(code).toBe(0);
    expect(JSON.parse(t.out())).toEqual({ items: [], next_offset: null });
  });

  it('单对象命令 → 对象直出，不套 items', async () => {
    const result = await run(['--json', 'show', 'iss1']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out) as Record<string, unknown>;
    expect(Array.isArray(parsed)).toBe(false);
    expect(parsed.items).toBeUndefined();
    expect(parsed.id).toBe('iss1');
  });
});
