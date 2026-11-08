/**
 * CR-3：CLI HTTP 客户端统一 15s 超时 + 可读报错。
 * 真实用例：假服务端只接受连接不回包（模拟服务进程存活但卡死），list-spaces 须在 15s 档位内非零退出、
 * stderr 含「服务无响应」与服务地址，且不触发 GET 重试（请求数 = 1）。
 * 快速用例：mock fetch 直接以 TimeoutError 拒绝，验证超时错误 → 可读文案的映射（含写请求幂等重试指引）。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REQUEST_TIMEOUT_MS, request } from '../src/api.js';
import { main } from '../src/index.js';

let server: Server;
let base = '';
/** 假服务端收到的请求数（验证超时不重试） */
let hits = 0;

beforeEach(async () => {
  hits = 0;
  server = createServer(() => {
    hits += 1;
    // 永不回包：模拟同步 SQLite 长事务 / 事件循环阻塞的服务进程
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeIo(stdinText = '') {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { write: (s: string) => { out.push(s); }, writeErr: (s: string) => { err.push(s); }, readStdin: async () => stdinText },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

describe('CR-3 请求超时', () => {
  it('真实假服务（只收连接不回包）：list-spaces 在超时档位内 exit 1，stderr 含「服务无响应」与服务地址，且不重试', async () => {
    const t = makeIo();
    const started = Date.now();
    const code = await main(['node', 'kb', '--server', base, 'list-spaces'], t.io);
    const elapsed = Date.now() - started;
    expect(code).toBe(1);
    // 档位核对：≥ REQUEST_TIMEOUT_MS（真等到超时），≤ 档位 + 调度余量（15s 内非零退出）
    expect(elapsed).toBeGreaterThanOrEqual(REQUEST_TIMEOUT_MS - 200);
    expect(elapsed).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS + 2000);
    expect(t.err()).toContain('服务无响应');
    expect(t.err()).toContain(base);
    expect(hits).toBe(1);
  }, 25_000);

  it('写请求超时：文案含「服务无响应」与幂等重试指引（mock fetch 以 TimeoutError 拒绝，直接调 request 层）', async () => {
    const reason = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(reason);
    try {
      await expect(request(base, 'POST', '/api/issues', { title: '超时文案' })).rejects.toThrow(/服务无响应/);
      await expect(request(base, 'POST', '/api/issues', { title: '超时文案' })).rejects.toThrow(new RegExp(base.replaceAll('.', '\\.')));
      await expect(request(base, 'POST', '/api/issues', { title: '超时文案' })).rejects.toThrow(/重试请复用 --request-id/);
    } finally {
      spy.mockRestore();
    }
  });

  it('AbortError（旧版 undici 包装形态）同样映射为可读超时文案', async () => {
    const reason = new DOMException('This operation was aborted', 'AbortError');
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(reason);
    try {
      const t = makeIo();
      const code = await main(['node', 'kb', '--server', base, 'list-spaces'], t.io);
      expect(code).toBe(1);
      expect(t.err()).toContain('服务无响应');
      expect(t.err()).toContain(base);
    } finally {
      spy.mockRestore();
    }
  });
});
