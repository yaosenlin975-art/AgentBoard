/** OPT-05：kb show 描述窗口（--description-max-chars / --description-offset）与续读拼接。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../src/io.js';
import { DESCRIPTION_WINDOW_CHARS, show } from '../src/commands/show.js';
import { main } from '../src/index.js';
import { issueLines } from '../src/render.js';

const FULL = `${'A'.repeat(DESCRIPTION_WINDOW_CHARS)}${'B'.repeat(500)}`;

function windowed(offset: number, max: number) {
  const chars = Array.from(FULL);
  const content = chars.slice(offset, offset + max).join('');
  const next = offset + max < chars.length ? offset + max : null;
  return { description: content, description_truncated: next !== null, next_description_offset_chars: next };
}

function baseIssue(description: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'card-1', workspace_id: 'workspace-1', title: '卡', description, priority: '中' as const, labels: [], status: '待规划' as const,
    sort_order: 0, parent_issue_id: null, claimed_by: null, claimed_at: null, session_id: null, comment_count: 0, created_at: 1, updated_at: 1, ...extra,
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

function stubFetch() {
  urls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const headers = { 'x-agentboard-version': '0.1.0' };
    if (url.includes('/api/issues/card-1/comments')) return Response.json([], { headers });
    if (url.includes('/api/issues/card-1')) {
      const parsed = new URL(url);
      const max = Number(parsed.searchParams.get('description_max_chars') ?? FULL.length);
      const offset = Number(parsed.searchParams.get('description_offset_chars') ?? 0);
      const hasWindow = parsed.searchParams.has('description_max_chars') || parsed.searchParams.has('description_offset_chars');
      return Response.json(hasWindow ? baseIssue(windowed(offset, max).description, windowed(offset, max)) : baseIssue(FULL), { headers });
    }
    return Response.json({ error: { code: 'NOT_FOUND', message: `mock 未匹配：${url}` } }, { status: 404 });
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('OPT-05 kb show 描述窗口', () => {
  it('默认按 12000 窗口读描述，截断时给续读偏移', async () => {
    stubFetch();
    const harness = context();
    await show(harness.ctx, 'card-1');
    expect(urls[0]).toContain('description_offset_chars=0');
    expect(urls[0]).toContain(`description_max_chars=${DESCRIPTION_WINDOW_CHARS}`);
    expect(harness.output).toContain('描述已截断，续读：kb show card-1 --description-offset 12000');
    expect(harness.output).toContain('A'.repeat(100));
  });

  it('续读偏移拼回全文，且与 --json 全量描述逐字一致', async () => {
    stubFetch();
    const details = () => urls.filter((url) => !url.endsWith('/comments'));
    const first = context();
    await show(first.ctx, 'card-1');
    const second = context();
    await show(second.ctx, 'card-1', { descriptionOffset: DESCRIPTION_WINDOW_CHARS });
    expect(details()[1]).toContain(`description_offset_chars=${DESCRIPTION_WINDOW_CHARS}`);

    const descriptionOf = (output: string) => output.split('\n').find((line) => line.startsWith('描述: '))!.slice('描述: '.length);
    expect(descriptionOf(first.output) + descriptionOf(second.output)).toBe(FULL);
    expect(second.output).not.toContain('描述已截断');

    const json = context(true);
    await show(json.ctx, 'card-1');
    expect(details()[2]).not.toContain('description_max_chars');
    expect(JSON.parse(json.output.replace(/\n$/, '')).description).toBe(FULL);
  });

  it('短描述卡输出与改造前一致（不多提示、不截断）', async () => {
    stubFetch();
    const short = baseIssue('短描述');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const headers = { 'x-agentboard-version': '0.1.0' };
      if (url.includes('/comments')) return Response.json([], { headers });
      return Response.json(short, { headers });
    }));
    const harness = context();
    await show(harness.ctx, 'card-1');
    expect(harness.output).toBe(`${[...issueLines(short), '评论（0）:（无）'].join('\n')}\n`);
  });

  it('CLI 入口接通 --description-max-chars，非法值 exit 1', async () => {
    stubFetch();
    const harness = context();
    expect(await main(['node', 'kb', 'show', 'card-1', '--description-max-chars', '5'], harness.ctx.io)).toBe(0);
    expect(urls[0]).toContain('description_max_chars=5');
    expect(harness.output).toContain('描述已截断，续读：kb show card-1 --description-offset 5');

    const invalid = context();
    expect(await main(['node', 'kb', 'show', 'card-1', '--description-max-chars', '0'], invalid.ctx.io)).toBe(1);
  });
});
