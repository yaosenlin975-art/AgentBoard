import { describe, expect, it } from 'vitest';
import { createHarness } from './helpers.js';

const WORKSPACE_ID = '5f1b2c34-0000-4000-8000-00000000a001';
const TASK_ID = '5f1b2c34-0000-4000-8000-00000000b001';
const DECISION_ID = '5f1b2c34-0000-4000-8000-00000000d001';

type Call = { method: string; path: string; headers: Headers; body?: Record<string, unknown> };

function decision(overrides: Record<string, unknown> = {}) {
  return {
    id: DECISION_ID,
    workspace_id: WORKSPACE_ID,
    workspace_name: '任务看板',
    issue_id: TASK_ID,
    issue_title: '待决策验收',
    issue_status: '进行中',
    issue_priority: '高',
    state: 'grace',
    question: '要不要继续？',
    context_md: '背景上下文'.repeat(3000),
    trigger: 'blocked',
    created_by: 'codex',
    created_fence: 3,
    grace_seconds: 180,
    grace_until: 1_700_000_180_000,
    remaining_grace_seconds: 120,
    waiting_seconds: 60,
    answer_revision: 0,
    current_answer_id: null,
    current_answer_by: null,
    option_count: 2,
    options: [
      { id: 'o1', ord: 1, label: '继续', consequence: '继续执行', is_default: true },
      { id: 'o2', ord: 2, label: '停止', consequence: '停下来等人', is_default: false },
    ],
    blocked_downstream_count: 1,
    checkpoint_json: '{"stash":"abc"}',
    answers: [],
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    expires_at: 1_700_000_180_000,
    on_expire: 'stay_locked',
    ...overrides,
  };
}

function fakeFetcher(calls: Call[], overrides: { status?: number; body?: unknown } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers,
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
    });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (overrides.status) return json(overrides.body, overrides.status);
    switch (`${init?.method ?? 'GET'} ${url.pathname}`) {
      case 'GET /api/decisions':
        return json({ decisions: [decision()], counts: { grace: 1, open: 0, answered: 0, withdrawn: 0 }, capabilities: { answer: true } });
      case `GET /api/decisions/${DECISION_ID}`:
        return json({ decision: decision() });
      case `GET /api/issues/${TASK_ID}/stop`:
        return json({ task_id: TASK_ID, stop_requested: true, decision_id: DECISION_ID, reason: 'user_ask' });
      case `POST /api/issues/${TASK_ID}/ask`:
        return json({ decision: decision({ state: 'open', grace_until: null, remaining_grace_seconds: 0 }) });
      default:
        return json({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
    }
  }) as unknown as typeof fetch;
}

async function harnessWith(calls: Call[], overrides: { status?: number; body?: unknown } = {}) {
  const harness = createHarness({ baseUrl: 'http://127.0.0.1:8787', workspaceId: WORKSPACE_ID, agentId: 'codex' }, fakeFetcher(calls, overrides));
  await harness.start();
  const call = (name: string, args: Record<string, unknown>) => harness.request('tools/call', { name, arguments: args });
  return { harness, call };
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, any>; content?: Array<{ text?: string }> };

describe('MCP 待决策工具', () => {
  it('list_decisions 返回摘要且不回 context/checkpoint', async () => {
    const calls: Call[] = [];
    const { harness, call } = await harnessWith(calls);
    try {
      const result = (await call('list_decisions', { limit: 20 })).result as ToolResult;
      expect(result.isError).toBeFalsy();
      const data = result.structuredContent!.data;
      expect(data.counts).toMatchObject({ grace: 1 });
      expect(data.items[0]).toMatchObject({ id: DECISION_ID, state: 'grace', issue_id: TASK_ID });
      expect(data.items[0].context_md).toBeUndefined();
      expect(data.items[0].checkpoint_json).toBeUndefined();
      expect(calls[0].path).toBe(`/api/decisions?workspace_id=${WORKSPACE_ID}&limit=20`);
    } finally {
      await harness.close();
    }
  });

  it('get_decision 回窗口化 context 与 checkpoint', async () => {
    const calls: Call[] = [];
    const { harness, call } = await harnessWith(calls);
    try {
      const result = (await call('get_decision', { decision_id: DECISION_ID })).result as ToolResult;
      expect(result.isError).toBeFalsy();
      const data = result.structuredContent!.data.decision;
      expect(data.context_truncated).toBe(true);
      expect(data.context_md.length).toBe(12_000);
      expect(data.checkpoint_json).toBe('{"stash":"abc"}');
      expect(calls[0].path).toBe(`/api/decisions/${DECISION_ID}`);
    } finally {
      await harness.close();
    }
  });

  it('get_decision 拒绝跨绑定工作区的决策', async () => {
    const calls: Call[] = [];
    const { harness, call } = await harnessWith(calls, {
      status: 200,
      body: { decision: decision({ workspace_id: '5f1b2c34-0000-4000-8000-0000000000ff' }) },
    });
    try {
      const result = (await call('get_decision', { decision_id: DECISION_ID })).result as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'WORKSPACE_BOUND' } });
    } finally {
      await harness.close();
    }
  });

  it('stop_check 透传停止状态', async () => {
    const calls: Call[] = [];
    const { harness, call } = await harnessWith(calls);
    try {
      const result = (await call('stop_check', { task_id: TASK_ID })).result as ToolResult;
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent!.data).toMatchObject({ stop_requested: true, decision_id: DECISION_ID });
      expect(calls[0].path).toBe(`/api/issues/${TASK_ID}/stop`);
    } finally {
      await harness.close();
    }
  });

  it('ask_decision 带 agent_id、幂等键与 fence，并返回 locked', async () => {
    const calls: Call[] = [];
    const { harness, call } = await harnessWith(calls);
    try {
      const requestId = '5f1b2c34-0000-4000-8000-00000000e001';
      const result = (await call('ask_decision', {
        task_id: TASK_ID,
        request_id: requestId,
        question: '选哪个？',
        options: [
          { label: 'A', consequence: '走 A' },
          { label: 'B', consequence: '走 B' },
        ],
        grace_seconds: 0,
        fence: 7,
      })).result as ToolResult;
      expect(result.isError).toBeFalsy();
      const data = result.structuredContent!.data;
      expect(data).toMatchObject({ locked: true, stop_requested: true });
      expect(calls[0].method).toBe('POST');
      expect(calls[0].path).toBe(`/api/issues/${TASK_ID}/ask`);
      expect(calls[0].headers.get('Idempotency-Key')).toBe(requestId);
      expect(calls[0].headers.get('x-claim-fence')).toBe('7');
      expect(calls[0].body).toMatchObject({
        agent_id: 'codex',
        question: '选哪个？',
        grace_seconds: 0,
        fence: 7,
        options: [
          { label: 'A', consequence: '走 A' },
          { label: 'B', consequence: '走 B' },
        ],
      });
    } finally {
      await harness.close();
    }
  });

  it('ask_decision 缺 AGENTBOARD_AGENT_ID 时结构化失败', async () => {
    const harness = createHarness({ baseUrl: 'http://127.0.0.1:8787', workspaceId: WORKSPACE_ID }, fakeFetcher([]));
    await harness.start();
    try {
      const result = (await harness.request('tools/call', {
        name: 'ask_decision',
        arguments: {
          task_id: TASK_ID,
          request_id: '5f1b2c34-0000-4000-8000-00000000e002',
          question: 'q',
          options: [{ label: 'A', consequence: 'a' }, { label: 'B', consequence: 'b' }],
        },
      })).result as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'AGENT_ID_REQUIRED' } });
    } finally {
      await harness.close();
    }
  });

  it('409 DECISION_ALREADY_OPEN 映射为安全错误码', async () => {
    const calls: Call[] = [];
    const { harness, call } = await harnessWith(calls, {
      status: 409,
      body: { error: { code: 'DECISION_ALREADY_OPEN', message: 'raw server text' } },
    });
    try {
      const result = (await call('ask_decision', {
        task_id: TASK_ID,
        request_id: '5f1b2c34-0000-4000-8000-00000000e003',
        question: 'q',
        options: [{ label: 'A', consequence: 'a' }, { label: 'B', consequence: 'b' }],
      })).result as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'DECISION_ALREADY_OPEN' } });
      expect(result.content?.[0]?.text).not.toContain('raw server text');
    } finally {
      await harness.close();
    }
  });

  it('alias 与主名一一对应且可调用', async () => {
    const calls: Call[] = [];
    const { harness, call } = await harnessWith(calls);
    try {
      const listed = (await harness.request('tools/list', {})).result as { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> };
      const names = listed.tools.map((tool) => tool.name);
      for (const name of ['list_decisions', 'get_decision', 'stop_check', 'ask_decision']) {
        expect(names).toContain(name);
        expect(names).toContain(`agentboard_${name}`);
      }
      expect(listed.tools.find((tool) => tool.name === 'list_decisions')?.annotations).toMatchObject({ readOnlyHint: true });
      expect(listed.tools.find((tool) => tool.name === 'ask_decision')?.annotations).toMatchObject({ readOnlyHint: false });

      const result = (await call('agentboard_stop_check', { task_id: TASK_ID })).result as ToolResult;
      expect(result.isError).toBeFalsy();
    } finally {
      await harness.close();
    }
  });
});
