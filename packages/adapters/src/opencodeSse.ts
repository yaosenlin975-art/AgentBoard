import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnLineChild, type SpawnForm } from './spawn.js';

interface OpenCodeEvent {
  type: string;
  data: Record<string, unknown>;
}

interface SseTurn {
  cwd: string;
  prompt: string;
  model?: string;
  sessionId?: string;
  signal: AbortSignal;
  onSubmitted: (sessionId: string) => void;
  onEvent: (event: OpenCodeEvent) => void;
}

const READY_MS = 8_000;

function directServeForm(form: SpawnForm): SpawnForm {
  if (process.platform !== 'win32' || form.prefix.length === 0) return form;
  const shim = form.prefix.at(-1);
  if (form.cmd.toLowerCase() === 'cmd.exe' && shim) {
    const relative = /^\s*"(?:%dp0%|%~dp0)[\\/]([^"\r\n]+\.exe)"\s+%\*\s*$/im.exec(readFileSync(shim, 'utf8'))?.[1];
    if (relative) {
      const cmd = resolve(dirname(shim), relative);
      if (statSync(cmd).isFile()) return { cmd, prefix: [] };
    }
  }
  throw new Error('OpenCode serve requires a directly managed executable on Windows');
}

export async function* readOpenCodeEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<OpenCodeEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let data: string[] = [];
  let frameSize = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true });
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
        if (line.startsWith('data:')) {
          frameSize += line.length;
          if (frameSize > 1_000_000) throw new Error('OpenCode sent an oversized SSE frame');
          data.push(line.slice(5).replace(/^ /, ''));
        }
        if (line !== '' || data.length === 0) continue;
        const event = JSON.parse(data.join('\n')) as OpenCodeEvent;
        data = [];
        frameSize = 0;
        if (typeof event?.type === 'string' && event.data && typeof event.data === 'object') yield event;
      }
      if (pending.length > 1_000_000) throw new Error('OpenCode sent an oversized SSE line');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function modelReference(value: string | undefined): { providerID: string; id: string; variant?: string } | undefined {
  if (!value) return undefined;
  const match = /^([^/#]+)\/([^#]+)(?:#([^#]+))?$/.exec(value);
  if (!match) throw new Error('OpenCode model must use provider/model[#variant]');
  return { providerID: match[1]!, id: match[2]!, ...(match[3] ? { variant: match[3] } : {}) };
}

/** onSubmitted fires immediately before POST; callers may only fall back prior to that point. */
export async function runOpenCodeSse(form: SpawnForm, turn: SseTurn): Promise<void> {
  turn.signal.throwIfAborted();
  const model = modelReference(turn.model);
  const executable = directServeForm(form);
  const password = randomBytes(24).toString('hex');
  const credentials = Buffer.from(`opencode:${password}`).toString('base64');
  const child = spawnLineChild(executable.cmd, [...executable.prefix, 'serve', '--hostname', '127.0.0.1', '--port', '0'], turn.cwd, {
    env: { OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password, OPENCODE_PASSWORD: password },
  });
  const lifetime = new AbortController();
  const signal = AbortSignal.any([turn.signal, lifetime.signal]);
  const readyTimer = setTimeout(() => lifetime.abort(new Error('OpenCode streaming startup timed out')), READY_MS);
  let stream: AsyncGenerator<OpenCodeEvent> | undefined;
  let sessionPath: string | undefined;
  let submitted = false;
  let base = '';
  const request = async (path: string, body?: object, requestSignal = signal): Promise<Response> => {
    const response = await fetch(base + path, {
      signal: requestSignal,
      redirect: 'error',
      headers: { Authorization: `Basic ${credentials}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`OpenCode streaming API returned HTTP ${response.status}`);
    }
    return response;
  };
  try {
    const port = await new Promise<number>((resolvePort, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      child.onLine((source, line) => {
        if (source !== 'stdout') return;
        const value = Number(/listening on http:\/\/127\.0\.0\.1:(\d+)\b/i.exec(line)?.[1]);
        if (value > 0 && value <= 65535) resolvePort(value);
      });
      child.onClose(() => lifetime.abort(new Error('OpenCode serve exited')));
    });
    base = `http://127.0.0.1:${port}`;
    const response = await request('/api/event');
    if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
      await response.body?.cancel();
      throw new Error('OpenCode streaming API did not open an event stream');
    }
    stream = readOpenCodeEvents(response.body);
    const ready = await stream.next();
    if (ready.value?.type !== 'server.connected') throw new Error('OpenCode streaming event protocol unavailable');
    let sessionId = turn.sessionId;
    if (!sessionId) {
      const response = await request('/api/session', { title: 'AgentBoard', ...(model ? { model } : {}) });
      const session = await response.json() as { data?: { id?: unknown } };
      if (typeof session.data?.id !== 'string' || !session.data.id) throw new Error('OpenCode did not create a session');
      sessionId = session.data.id;
    }
    sessionPath = `/api/session/${encodeURIComponent(sessionId)}`;
    if (turn.sessionId) {
      const session = await request(sessionPath);
      await session.body?.cancel();
      if (model) {
        const selected = await request(sessionPath + '/model', { model });
        await selected.body?.cancel();
      }
    }
    clearTimeout(readyTimer);
    signal.throwIfAborted();
    turn.onSubmitted(sessionId);
    submitted = true;
    const receive = async () => {
      for await (const event of stream!) {
        if (event.data.sessionID !== sessionId) continue;
        turn.onEvent(event);
        if (event.type === 'session.execution.succeeded') return;
        if (event.type === 'session.execution.failed') throw new Error('OpenCode execution failed');
        if (event.type === 'session.execution.interrupted') throw new Error('OpenCode execution interrupted');
      }
      throw new Error('OpenCode event stream ended before execution finished');
    };
    await Promise.all([
      request(sessionPath + '/prompt', { text: turn.prompt }).then(response => response.json()),
      receive(),
    ]);
  } finally {
    clearTimeout(readyTimer);
    lifetime.abort();
    if (submitted && turn.signal.aborted && sessionPath) {
      await request(sessionPath + '/interrupt', {}, AbortSignal.timeout(1_000))
        .then(response => response.body?.cancel()).catch(() => {});
    }
    await stream?.return(undefined).catch(() => {});
    await child.kill();
  }
}
