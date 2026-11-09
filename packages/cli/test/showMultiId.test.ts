/** OPT-06：kb show 多 id 摘要视图、部分失败继续与 --json items 信封。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../src/io.js';
import { show } from '../src/commands/show.js';
import { main } from '../src/index.js';

function issue(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, workspace_id: 'workspace-1', title: `标题 ${id}`, description: `描述 ${id}`, priority: '中' as const, labels: [], status: '待规划' as const,
    sort_order: 0, parent_issue_id: null, claimed_by: null, claimed_at: null, session_id: null, comment_count: 3, created_at: 1, updated_at: 1, ...extra,
  };
}

function context(json = false) {
  let output = '';
  const ctx: Ctx = {
    base: 'http://agentboard.test', json, agentId: 'codex',
    io: { write: (line) => { output += line; }, writeErr: () => {}, readStdin: async () => '' },
  };
  return { ctx, get output() { return output; } };
}

const urls: string[] = [];

function stubFetch(known: Record<string, ReturnType<typeof issue>>) {
  urls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const headers = { 'x-agentboard-version': '0.1.0' };
    const path = new URL(url).pathname;
    if (path.endsWith('/comments')) return Response.json([], { headers });
    const id = decodeURIComponent(path.split('/').pop()!);
    const found = known[id];
    return found === undefined
      ? Response.json({ error: { code: 'NOT_FOUND', message: '任务不存在' } }, { status: 404, headers })
      : Response.json(found, { headers });
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('OPT-06 kb show 多 id', () => {
  it('多 id 每块给摘要（id/标题/状态/占用者/评论数），不渲染描述与评论', async () => {
    stubFetch({ 'card-a': issue('card-a'), 'card-b': issue('card-b', { claimed_by: 'codex' }) });
    const harness = context();
    expect(await show(harness.ctx, ['card-a', 'card-b'])).toBe(0);
    expect(harness.output).toContain('【1/2】card-a');
    expect(harness.output).toContain('【2/2】card-b');
    expect(harness.output).toContain('id: card-a');
    expect(harness.output).toContain('标题: 标题 card-a');
    expect(harness.output).toContain('状态: 待规划');
    expect(harness.output).toContain('占用者: （未占用）');
    expect(harness.output).toContain('占用者: codex');
    expect(harness.output).toContain('评论数: 3');
    expect(harness.output).not.toContain('描述');
    expect(urls.some((url) => url.endsWith('/comments'))).toBe(false);
  });

  it('缺失 id 只标该块并继续其余，退出码 1', async () => {
    stubFetch({ 'card-a': issue('card-a') });
    const harness = context();
    expect(await show(harness.ctx, ['card-a', 'missing', 'card-a'])).toBe(1);
    expect(harness.output).toContain('【1/3】card-a');
    expect(harness.output).toContain('【2/3】missing\n错误: ');
    expect(harness.output).toContain('【3/3】card-a');
  });

  it('--json 返回 items 数组信封（成功带 issue、失败带 error）', async () => {
    stubFetch({ 'card-a': issue('card-a') });
    const harness = context(true);
    expect(await show(harness.ctx, ['card-a', 'missing'])).toBe(1);
    const payload = JSON.parse(harness.output.replace(/\n$/, ''));
    expect(Array.isArray(payload.items)).toBe(true);
    expect(payload.items[0]).toMatchObject({ id: 'card-a', issue: { id: 'card-a' } });
    expect(payload.items[1].id).toBe('missing');
    expect(typeof payload.items[1].error).toBe('string');
  });

  it('单 id 仍走详细视图（描述与评论段都在）', async () => {
    stubFetch({ 'card-a': issue('card-a') });
    const harness = context();
    expect(await show(harness.ctx, ['card-a'])).toBe(0);
    expect(harness.output).toContain('描述: 描述 card-a');
    expect(harness.output).toContain('评论（0）:（无）');
  });

  it('20 个 id 各自一次请求、无评论请求、不丢块', async () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`card-${i}`, issue(`card-${i}`)]));
    stubFetch(many);
    const harness = context();
    expect(await show(harness.ctx, Object.keys(many))).toBe(0);
    expect(urls.filter((url) => url.endsWith('/comments'))).toHaveLength(0);
    for (let i = 0; i < 20; i += 1) expect(harness.output).toContain(`【${i + 1}/20】card-${i}`);
    expect(harness.output.match(/评论数: 3/g)).toHaveLength(20);
  });

  it('CLI 入口接通多 id（变参）', async () => {
    stubFetch({ 'card-a': issue('card-a'), 'card-b': issue('card-b') });
    const harness = context();
    expect(await main(['node', 'kb', 'show', 'card-a', 'card-b'], harness.ctx.io)).toBe(0);
    expect(harness.output).toContain('【1/2】card-a');
    expect(harness.output).toContain('【2/2】card-b');
  });
});
