/**
 * S6：`decision_id` 前缀解析（P4-C5 同类第二处）。
 *
 * `apps/mcp/src/tools/decisions.ts` 的描述曾承诺「8+ 位唯一前缀也接受」，但服务端
 * `findDecision`（`apps/server/src/api/decisionRoutes.ts:322-331`）直接透传
 * `req.params.id` 给 `getDecisionDetail` → `getDecision` 精确查，前缀必然 404。
 *
 * 修法与 P4-C5 同（甲）：MCP 层补解析，且**与 task 族共用同一份实现**——
 * 判定骨架抽在 `idRef.ts`，`taskRef.ts` 与 `decisionRef.ts` 都只做族差异的薄封装。
 *
 * 口径（与 CLI `issueRef.ts` 逐字一致）：
 * - 只有 1-35 位纯十六进制才当前缀；非十六进制引用零成本透传
 * - <8 位本地拒绝，不发请求
 * - 唯一命中 → 真实 id；多命中 → INVALID_ARGUMENT + 候选；零命中 → DECISION_NOT_FOUND
 * - 未绑定工作区（这三个工具没有 workspace_id 参数）时无法列候选，按 P4-C7 口径原样透传
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness } from './helpers.js';

const baseConfig = { baseUrl: 'http://127.0.0.1:8787', workspaceId: 'workspace-a', agentId: 'codex' };
const DEC_A = 'aa11bb22-0000-4000-8000-00000000000a';
const DEC_B = 'bb22cc33-0000-4000-8000-00000000000b';

const DECISION_DETAIL = (id: string) => ({
  id,
  workspace_id: 'workspace-a',
  state: 'open',
  question: '选哪个',
  options: [],
  answers: [],
  capabilities: {},
});

describe('S6 decision_id 前缀解析', () => {
  const harnesses: Array<ReturnType<typeof createHarness>> = [];
  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(harness => harness.close()));
  });

  /** /decisions 列表 + /decisions/:id 详情 */
  const fetchMockFor = (ids: string[], capture: string[] = []): ReturnType<typeof vi.fn> => vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/decisions?') || url.endsWith('/decisions')) {
      return Response.json({
        decisions: ids.map(id => ({ id, state: 'open', question: `问题 ${id.slice(0, 2)}` })),
        counts: {},
        capabilities: {},
      });
    }
    const matched = ids.find(id => url.includes(id));
    capture.push(url);
    if (matched === undefined) {
      return Response.json({ error: { code: 'DECISION_NOT_FOUND', message: '决策不存在' } }, { status: 404 });
    }
    return Response.json({ decision: DECISION_DETAIL(matched) });
  });

  const start = async (fetchMock: ReturnType<typeof vi.fn>): Promise<ReturnType<typeof createHarness>> => {
    const harness = createHarness(baseConfig, fetchMock as unknown as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    return harness;
  };

  it('完整 UUID：零成本透传，不发列表请求', async () => {
    const fetchMock = fetchMockFor([DEC_A]);
    const harness = await start(fetchMock);
    const res = await harness.request('tools/call', { name: 'get_decision', arguments: { decision_id: DEC_A } });
    expect(res.result?.structuredContent).toMatchObject({ ok: true });
    const listCalls = fetchMock.mock.calls.filter(call => String(call[0]).includes('/decisions?'));
    expect(listCalls).toHaveLength(0);
  });

  it('8+ 位唯一前缀：解析成真实 id 后请求', async () => {
    const hits: string[] = [];
    const fetchMock = fetchMockFor([DEC_A, DEC_B], hits);
    const harness = await start(fetchMock);
    const res = await harness.request('tools/call', { name: 'get_decision', arguments: { decision_id: 'aa11bb22' } });
    expect(res.result?.structuredContent).toMatchObject({ ok: true });
    expect(hits.some(url => url.includes(DEC_A))).toBe(true);
    expect(hits.some(url => /\/decisions\/aa11bb22(\?|$)/.test(url))).toBe(false);
  });

  it('歧义前缀：报候选且错误码为 INVALID_ARGUMENT（与 task 族一致）', async () => {
    const a = 'aa11bb22-0000-4000-8000-00000000000a';
    const b = 'aa11bb22-0000-4000-8000-00000000000b';
    const fetchMock = fetchMockFor([a, b]);
    const harness = await start(fetchMock);
    const res = await harness.request('tools/call', { name: 'get_decision', arguments: { decision_id: 'aa11bb22' } });
    const payload = res.result?.structuredContent as { ok: boolean; error?: { code: string; message: string } };
    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe('INVALID_ARGUMENT');
    expect(payload.error?.message).toContain('ambiguous');
    expect(payload.error?.message).toContain(a);
    expect(payload.error?.message).toContain(b);
  });

  it('过短前缀（<8）：本地拒绝，零请求', async () => {
    const fetchMock = fetchMockFor([DEC_A]);
    const harness = await start(fetchMock);
    const res = await harness.request('tools/call', { name: 'get_decision', arguments: { decision_id: 'aa11bb' } });
    const payload = res.result?.structuredContent as { ok: boolean; error?: { message: string } };
    expect(payload.ok).toBe(false);
    expect(payload.error?.message).toContain('too short');
    expect(fetchMock.mock.calls).toHaveLength(0);
  });

  it('零命中前缀：DECISION_NOT_FOUND 并说明前缀', async () => {
    const fetchMock = fetchMockFor([DEC_A]);
    const harness = await start(fetchMock);
    const res = await harness.request('tools/call', { name: 'get_decision', arguments: { decision_id: 'deadbeef' } });
    const payload = res.result?.structuredContent as { ok: boolean; error?: { code: string; message: string } };
    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe('DECISION_NOT_FOUND');
    expect(payload.error?.message).toContain('deadbeef');
  });

  it('未绑定工作区：无法列候选，原样透传给服务端（不猜 id 有效性）', async () => {
    const fetchMock = fetchMockFor([DEC_A]);
    const harness = createHarness({ baseUrl: 'http://127.0.0.1:8787', agentId: 'codex' }, fetchMock as unknown as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const res = await harness.request('tools/call', { name: 'get_decision', arguments: { decision_id: 'deadbeef' } });
    // 未绑定时不做前缀解析：请求直接打到 /decisions/deadbeef，服务端 404
    const urls = fetchMock.mock.calls.map(call => String(call[0]));
    expect(urls.some(url => url.includes('/decisions/deadbeef'))).toBe(true);
    expect(urls.some(url => url.includes('/decisions?'))).toBe(false);
  });

  it('task 与 decision 共用同一份判定：非十六进制引用两边都零成本透传', async () => {
    // 'decision:abc' 含冒号 → 不匹配 HEX_REF → 直接透传，不拉列表
    const decFetch = fetchMockFor([DEC_A]);
    const decHarness = await start(decFetch);
    await decHarness.request('tools/call', { name: 'get_decision', arguments: { decision_id: 'decision:abc' } });
    const decListCalls = decFetch.mock.calls.filter(call => String(call[0]).includes('/decisions?'));
    expect(decListCalls).toHaveLength(0);

    // 同一引用形态在 task 族也不拉列表（共用 idRef 的 isShortIdRef 判定）
    const taskFetch = vi.fn(async () => Response.json({ id: 'x', title: 't', status: '进行中', workspace_id: 'workspace-a' }));
    const taskHarness = createHarness(baseConfig, taskFetch as unknown as typeof fetch);
    harnesses.push(taskHarness);
    await taskHarness.start();
    await taskHarness.request('tools/call', { name: 'get_task', arguments: { task_id: 'iss1' } });
    const taskListCalls = taskFetch.mock.calls.filter(call => {
      const url = String(call[0]);
      return url.includes('/issues?') || url.endsWith('/issues');
    });
    expect(taskListCalls).toHaveLength(0);
  });
});
