/**
 * P4：MCP 契约三处与 CLI 不一致（C5 前缀 / C6 状态枚举 / C7 未绑定文案）。
 *
 * 三条都是盲测实证 + 代码核对：
 * - C5：`task_id` 描述说「8+ 位前缀也接受」，实际直接 `encodeURIComponent` 拼 URL。
 *       CLI 在客户端做前缀解析（`issueRef.ts`），MCP 层此前完全没有。
 * - C6：`list_tasks.status` 写死 4 个枚举，拦掉「已废弃」与一切自定义状态；
 *       而服务端 `requireWorkspaceStatus` 按工作区状态字典动态校验。
 * - C7：所有工具未绑定时共用一句 `for this task operation`，知识页/统计/协作类也被叫成任务操作。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness } from './helpers.js';

const baseConfig = { baseUrl: 'http://127.0.0.1:8787', workspaceId: 'workspace-a', agentId: 'codex' };
const FULL_ID = '5f1b2c34-0000-4000-8000-00000000ffff';
const OTHER_ID = '5f1b2c34-0000-4000-8000-000000000001';

describe('P4-02 未绑定工作区时按工具族报文案', () => {
  const harnesses: Array<ReturnType<typeof createHarness>> = [];
  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(harness => harness.close()));
  });

  const unbound = async (): Promise<void> => {
    const harness = createHarness({ baseUrl: 'http://127.0.0.1:8787', agentId: 'codex' }, vi.fn() as unknown as typeof fetch);
    harnesses.push(harness);
    await harness.start();
  };

  const callAndReadError = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const harness = harnesses[harnesses.length - 1]!;
    const response = await harness.request('tools/call', { name, arguments: args });
    const payload = response.result?.structuredContent as { ok?: boolean; error?: { code: string; message: string } } | undefined;
    expect(payload?.ok).toBe(false);
    expect(payload?.error?.code).toBe('WORKSPACE_REQUIRED');
    return payload!.error!.message;
  };

  it('任务族 / 知识页族 / 统计族 / 协作族各说各的，不再一律 task operation', async () => {
    await unbound();

    const task = await callAndReadError('get_task', { task_id: FULL_ID });
    const knowledge = await callAndReadError('list_knowledge', {});
    const stats = await callAndReadError('workspace_stats', {});
    const collab = await callAndReadError('stop_check', { task_id: FULL_ID });
    const board = await callAndReadError('next_tasks', {});

    // 各族文案互不相同，且不再把知识页/统计/协作叫成 task operation
    expect(task).toContain('a task operation');
    expect(knowledge).toContain('a knowledge-page operation');
    expect(knowledge).not.toContain('task operation');
    expect(stats).toContain('a board statistics operation');
    expect(stats).not.toContain('task operation');
    expect(collab).toContain('a collaboration operation');
    expect(board).toContain('a collaboration operation');

    // 每条都给出可执行指引，并说明「绑定前无法校验 id」
    for (const message of [task, knowledge, stats, collab]) {
      expect(message).toContain('AGENTBOARD_WORKSPACE_ID');
      expect(message).toContain('cannot be validated');
    }
  });
});

describe('P4-01 task_id 前缀解析（与 CLI 同口径）', () => {
  const harnesses: Array<ReturnType<typeof createHarness>> = [];
  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(harness => harness.close()));
  });

  /** 列表响应 + 详情响应：前缀解析要先 GET /issues 找 id，再 GET /issues/:id */
  const prefixFetch = (ids: string[]): ReturnType<typeof vi.fn> => vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/issues?') || url.endsWith('/issues')) {
      return Response.json({
        items: ids.map(id => ({ id, title: `卡 ${id.slice(0, 4)}`, status: '进行中', workspace_id: 'workspace-a' })),
        next_offset: null,
      });
    }
    const matched = ids.find(id => url.includes(id)) ?? ids[0];
    return Response.json({ id: matched, title: '卡', status: '进行中', workspace_id: 'workspace-a', description: '' });
  });

  const start = async (fetchMock: ReturnType<typeof vi.fn>): Promise<void> => {
    const harness = createHarness(baseConfig, fetchMock as unknown as typeof fetch);
    harnesses.push(harness);
    await harness.start();
  };

  it('完整 UUID：零成本透传，不发列表请求', async () => {
    const fetchMock = prefixFetch([FULL_ID]);
    await start(fetchMock);
    const response = await harnesses[0]!.request('tools/call', { name: 'get_task', arguments: { task_id: FULL_ID } });
    expect(response.result?.structuredContent).toMatchObject({ ok: true });
    const listCalls = fetchMock.mock.calls.filter(call => {
      const url = String(call[0]);
      return url.includes('/issues?') || url.endsWith('/issues');
    });
    expect(listCalls).toHaveLength(0);
  });

  it('8+ 位唯一前缀：解析成真实 id 后请求', async () => {
    // OTHER_ID 前缀不同，确保 '5f1b2c34' 唯一命中 FULL_ID
    const fetchMock = prefixFetch([FULL_ID, 'abc00000-0000-4000-8000-000000000002']);
    await start(fetchMock);
    const response = await harnesses[0]!.request('tools/call', { name: 'get_task', arguments: { task_id: '5f1b2c34' } });
    expect(response.result?.structuredContent).toMatchObject({ ok: true });
    // 详情请求用的是真实 id，不是前缀
    const urls = fetchMock.mock.calls.map(call => String(call[0]));
    const detail = urls.find(url => url.includes(`/issues/${FULL_ID}`));
    expect(detail).toBeDefined();
    expect(urls.some(url => /\/issues\/5f1b2c34(\?|$)/.test(url))).toBe(false);
  });

  it('歧义前缀：报候选而不是静默挑一个', async () => {
    // 两个 id 共享前缀
    const a = '5f1b2c34-0000-4000-8000-00000000000a';
    const b = '5f1b2c34-0000-4000-8000-00000000000b';
    const fetchMock = prefixFetch([a, b]);
    await start(fetchMock);
    const response = await harnesses[0]!.request('tools/call', { name: 'get_task', arguments: { task_id: '5f1b2c34' } });
    const payload = response.result?.structuredContent as { ok: boolean; error?: { code: string; message: string } };
    expect(payload.ok).toBe(false);
    expect(payload.error?.message).toContain('ambiguous');
    expect(payload.error?.message).toContain(a);
    expect(payload.error?.message).toContain(b);
  });

  it('过短前缀（<8）：本地拒绝，不发请求', async () => {
    const fetchMock = prefixFetch([FULL_ID]);
    await start(fetchMock);
    const response = await harnesses[0]!.request('tools/call', { name: 'get_task', arguments: { task_id: '5f1b2c' } });
    const payload = response.result?.structuredContent as { ok: boolean; error?: { message: string } };
    expect(payload.ok).toBe(false);
    expect(payload.error?.message).toContain('too short');
    expect(fetchMock.mock.calls).toHaveLength(0);
  });

  it('零命中前缀：报 TASK_NOT_FOUND 并说明前缀', async () => {
    const fetchMock = prefixFetch([OTHER_ID]);
    await start(fetchMock);
    const response = await harnesses[0]!.request('tools/call', { name: 'get_task', arguments: { task_id: 'deadbeef' } });
    const payload = response.result?.structuredContent as { ok: boolean; error?: { code: string; message: string } };
    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe('TASK_NOT_FOUND');
    expect(payload.error?.message).toContain('deadbeef');
  });

  it('非十六进制引用（iss1 这类）零成本透传，与 CLI 同口径', async () => {
    const fetchMock = prefixFetch(['iss1']);
    await start(fetchMock);
    const response = await harnesses[0]!.request('tools/call', { name: 'get_task', arguments: { task_id: 'iss1' } });
    expect(response.result?.structuredContent).toMatchObject({ ok: true });
    const listCalls = fetchMock.mock.calls.filter(call => String(call[0]).includes('/issues?'));
    expect(listCalls).toHaveLength(0);
  });
});

describe('P4-03 list_tasks.status 不再被客户端枚举拦截', () => {
  const harnesses: Array<ReturnType<typeof createHarness>> = [];
  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(harness => harness.close()));
  });

  const start = async (fetchMock: ReturnType<typeof vi.fn>): Promise<void> => {
    const harness = createHarness(baseConfig, fetchMock as unknown as typeof fetch);
    harnesses.push(harness);
    await harness.start();
  };

  const listWithStatus = async (status: string): Promise<{ sent: string | null; ok: boolean; message?: string }> => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      return Response.json({ items: [], next_offset: null });
    });
    await start(fetchMock);
    const response = await harnesses[harnesses.length - 1]!.request('tools/call', {
      name: 'list_tasks', arguments: { workspace_id: 'workspace-a', status },
    });
    const payload = response.result?.structuredContent as { ok?: boolean; error?: { message: string } } | undefined;
    const url = fetchMock.mock.calls.map(call => String(call[0])).find(item => item.includes('/issues')) ?? '';
    const sent = /[?&]status=([^&]*)/.exec(url)?.[1] ?? null;
    return { sent: sent === null ? null : decodeURIComponent(sent), ok: payload?.ok === true, message: payload?.error?.message };
  };

  it('「已废弃」不再被 schema 拦（原枚举漏了它）', async () => {
    const result = await listWithStatus('已废弃');
    expect(result.ok).toBe(true);
    expect(result.sent).toBe('已废弃');
  });

  it('自定义状态也能透传（add_status 建的状态必须可查）', async () => {
    const result = await listWithStatus('等评审');
    expect(result.ok).toBe(true);
    expect(result.sent).toBe('等评审');
  });

  it('内置四态照常', async () => {
    for (const status of ['待规划', '进行中', '待验收', '已关闭']) {
      const result = await listWithStatus(status);
      expect(result.ok).toBe(true);
      expect(result.sent).toBe(status);
    }
  });
});
