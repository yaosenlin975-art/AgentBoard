import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { readOpenCodeEvents, runOpenCodeSse } from '../src/opencodeSse.js';
import { setSpawnFn } from '../src/spawn.js';
import { asChild, closeChild, makeFakeChild } from './helpers.js';

const form = { cmd: 'opencode', prefix: [] };
const encoder = new TextEncoder();

afterEach(() => {
  setSpawnFn(spawn);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('reads SSE across a UTF-8 split, CRLF and multiple data lines', async () => {
  const bytes = encoder.encode(': ping\r\ndata: {"type":"delta",\r\ndata: "data":{"text":"地球"}}\r\n\r\n');
  const split = bytes.indexOf(0xe5) + 1;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, split));
      controller.enqueue(bytes.slice(split));
      controller.close();
    },
  });
  const events = [];
  for await (const event of readOpenCodeEvents(stream)) events.push(event);
  expect(events).toEqual([{ type: 'delta', data: { text: '地球' } }]);
});

it.each(['success', 'stream closed', 'cancelled'] as const)('tracks submission and cleans up on %s', async outcome => {
  const child = makeFakeChild();
  child.kill.mockImplementation(() => { closeChild(child, null); return true; });
  let password = '';
  setSpawnFn((_cmd, args, options) => {
    expect(args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '0']);
    password = options.env!.OPENCODE_PASSWORD!;
    expect(password).toHaveLength(48);
    queueMicrotask(() => child.stdout.emit('data', Buffer.from('opencode server listening on http://127.0.0.1:12234\n')));
    return asChild(child);
  });
  const abort = new AbortController();
  const submitted = vi.fn();
  const onEvent = vi.fn();
  const requestPaths: string[] = [];
  let events: ReadableStreamDefaultController<Uint8Array>;
  const send = (type: string, data: object = {}) => events.enqueue(encoder.encode(`data: ${JSON.stringify({ type, data })}\n\n`));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    expect(parsed.host).toBe('127.0.0.1:12234');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`);
    expect(init.redirect).toBe('error');
    requestPaths.push(parsed.pathname);
    if (parsed.pathname === '/api/event') {
      return new Response(new ReadableStream({
        start(controller) {
          events = controller;
          send('server.connected');
          init.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (parsed.pathname === '/api/session') {
      expect(JSON.parse(init.body as string)).toEqual({ title: 'AgentBoard', model: { providerID: 'p', id: 'm', variant: 'v' } });
      return Response.json({ data: { id: 'ses_1' } });
    }
    if (parsed.pathname.endsWith('/prompt')) {
      expect(submitted).toHaveBeenCalledExactlyOnceWith('ses_1');
      expect(JSON.parse(init.body as string)).toEqual({ text: 'test' });
      if (outcome === 'cancelled') abort.abort();
      else if (outcome === 'stream closed') events!.close();
      else {
        send('session.text.delta', { sessionID: 'other', delta: 'ignore' });
        send('session.text.delta', { sessionID: 'ses_1', delta: 'hi' });
        send('session.execution.succeeded', { sessionID: 'ses_1' });
      }
    }
    return Response.json({ data: {} });
  }));
  const turn = runOpenCodeSse(form, { cwd: '.', prompt: 'test', model: 'p/m#v', signal: abort.signal, onSubmitted: submitted, onEvent });
  if (outcome === 'success') {
    await turn;
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(['session.text.delta', 'session.execution.succeeded']);
  } else {
    await expect(turn).rejects.toThrow(outcome === 'cancelled' ? /abort/i : /stream ended/i);
  }
  expect(requestPaths).toEqual(['/api/event', '/api/session', '/api/session/ses_1/prompt',
    ...(outcome === 'cancelled' ? ['/api/session/ses_1/interrupt'] : [])]);
  expect(child.kill).toHaveBeenCalledTimes(1);
});

it('times out before submission if the process never reports a listener', async () => {
  vi.useFakeTimers();
  const child = makeFakeChild();
  child.kill.mockImplementation(() => { closeChild(child, null); return true; });
  setSpawnFn(() => asChild(child));
  const submitted = vi.fn();
  const turn = runOpenCodeSse(form, { cwd: '.', prompt: 'test', signal: new AbortController().signal, onSubmitted: submitted, onEvent: vi.fn() });
  const rejected = expect(turn).rejects.toThrow('startup timed out');
  await vi.advanceTimersByTimeAsync(8_000);
  await rejected;
  expect(submitted).not.toHaveBeenCalled();
  expect(child.kill).toHaveBeenCalledTimes(1);
});
