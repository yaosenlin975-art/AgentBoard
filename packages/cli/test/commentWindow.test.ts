/** OPT-04：kb show / claim 评论限量（未读优先）、单条窗口截断与 `--comments all` 全量回退。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../src/io.js';
import { claim } from '../src/commands/claim.js';
import { show } from '../src/commands/show.js';
import { main } from '../src/index.js';
import {
  COMMENT_DEFAULT_LIMIT,
  COMMENT_PREVIEW_CHARS,
  commentLines,
  parseCommentLimit,
  selectRecentComments,
} from '../src/render.js';

const workspace = { id: 'workspace-1', name: 'Demo', path: 'D:\\demo', created_at: 1 };

function issue(id: string) {
  return {
    id, workspace_id: workspace.id, title: '卡', description: '正文', priority: '中' as const, labels: [], status: '进行中' as const,
    sort_order: 0, parent_issue_id: null, claimed_by: 'codex', claimed_at: 1, session_id: null, comment_count: 12, created_at: 1, updated_at: 1,
  };
}

function comment(index: number, extra: { is_new?: boolean; content?: string } = {}) {
  return {
    id: `c${index}`, issue_id: 'card-1', author: 'agent:kb-cli', ts: index,
    content: extra.content ?? `评论正文 ${index}`, ...(extra.is_new === undefined ? {} : { is_new: extra.is_new }),
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

afterEach(() => vi.unstubAllGlobals());

describe('OPT-04 评论选择与截断（纯函数）', () => {
  it('parseCommentLimit：缺省 undefined、all 原样、正整数才通过', () => {
    expect(parseCommentLimit(undefined)).toBeUndefined();
    expect(parseCommentLimit('all')).toBe('all');
    expect(parseCommentLimit('3')).toBe(3);
    expect(() => parseCommentLimit('0')).toThrow(/正整数或 all/);
    expect(() => parseCommentLimit('abc')).toThrow(/正整数或 all/);
  });

  it('默认只留最近 5 条并给出隐藏条数', () => {
    const comments = Array.from({ length: 12 }, (_, i) => comment(i + 1));
    const picked = selectRecentComments(comments, COMMENT_DEFAULT_LIMIT);
    expect(picked.visible.map((c) => c.id)).toEqual(['c8', 'c9', 'c10', 'c11', 'c12']);
    expect(picked.hidden).toBe(7);
    expect(picked.total).toBe(12);
  });

  it('未读优先占位，其余名额用最近已读补满，输出仍按时间序', () => {
    const comments = Array.from({ length: 12 }, (_, i) => comment(i + 1));
    comments[1]!.is_new = true; // c2 未读
    const picked = selectRecentComments(comments, COMMENT_DEFAULT_LIMIT);
    expect(picked.visible.map((c) => c.id)).toEqual(['c2', 'c9', 'c10', 'c11', 'c12']);
    expect(picked.hidden).toBe(7);
  });

  it('all / 总数不超限时原样返回', () => {
    const comments = Array.from({ length: 12 }, (_, i) => comment(i + 1));
    expect(selectRecentComments(comments, 'all')).toMatchObject({ hidden: 0, total: 12 });
    expect(selectRecentComments(comments, 'all').visible).toHaveLength(12);
    expect(selectRecentComments(comments.slice(0, 3), COMMENT_DEFAULT_LIMIT)).toMatchObject({ hidden: 0, total: 3 });
  });

  it('commentLines 缺省不截断（与改造前逐字一致）', () => {
    const long = 'x'.repeat(COMMENT_PREVIEW_CHARS + 100);
    const lines = commentLines([comment(1, { content: long })]);
    expect(lines[0]).toBe('评论（1）:');
    expect(lines[1]).toContain(long);
    expect(lines[1]).not.toContain('已截断');
    expect(lines[1]).toContain('[agent:kb-cli] ');
  });

  it('--comments all 传入 totalComments 时与旧渲染逐字一致', () => {
    const comments = Array.from({ length: 12 }, (_, i) => comment(i + 1, { content: `${'y'.repeat(600)}-${i}` }));
    expect(commentLines(comments, { totalComments: comments.length })).toEqual(commentLines(comments));
  });

  it('给出 previewChars 时超长评论按窗口截断并带续读参数', () => {
    const long = '中'.repeat(COMMENT_PREVIEW_CHARS + 100);
    const lines = commentLines([comment(7, { content: long })], { issueId: 'card-1', previewChars: COMMENT_PREVIEW_CHARS });
    expect(lines.join('\n')).toContain(`…（已截断，全文 ${COMMENT_PREVIEW_CHARS + 100} 字符；`);
    expect(lines.join('\n')).toContain(`GET /api/issues/card-1/comments/c7?content_offset_chars=${COMMENT_PREVIEW_CHARS}`);
    // 窗口按码位而非 UTF-16 单元：截断后的正文正好是 500 个中文字符
    const shown = lines[1]!.split('] ')[1]!.split('…')[0]!;
    expect(Array.from(shown)).toHaveLength(COMMENT_PREVIEW_CHARS);
  });
});

describe('OPT-04 kb show / kb claim 接线', () => {
  function stubFetch(comments: ReturnType<typeof comment>[]) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = { 'x-agentboard-version': '0.1.0' };
      if (init?.method === 'POST' && url.endsWith('/api/issues/card-1/claim')) return Response.json(issue('card-1'), { headers });
      if (url.endsWith('/api/issues/card-1')) return Response.json(issue('card-1'), { headers });
      if (url.endsWith('/api/issues/card-1/comments')) return Response.json(comments, { headers });
      if (url.endsWith('/api/workspaces')) return Response.json([workspace], { headers });
      return Response.json({ error: { code: 'NOT_FOUND', message: `mock 未匹配：${url}` } }, { status: 404 });
    }));
  }

  const twelve = () => Array.from({ length: 12 }, (_, i) => comment(i + 1));

  it('show 默认只渲染最近 5 条并提示 --comments all', async () => {
    stubFetch(twelve());
    const harness = context();
    await show(harness.ctx, 'card-1');
    expect(harness.output).toContain('评论（5/12）:');
    for (const id of ['c8', 'c9', 'c10', 'c11', 'c12']) expect(harness.output).toContain(`评论正文 ${Number(id.slice(1))}`);
    expect(harness.output).not.toContain('评论正文 7');
    expect(harness.output).toContain('另有 7 条，--comments all 查看');
  });

  it('show --comments all 输出全量原文且无截断/另有提示', async () => {
    stubFetch(twelve());
    const harness = context();
    await show(harness.ctx, 'card-1', { comments: 'all' });
    expect(harness.output).toContain('评论（12）:');
    for (let index = 1; index <= 12; index += 1) expect(harness.output).toContain(`评论正文 ${index}`);
    expect(harness.output).not.toContain('另有');
    expect(harness.output).not.toContain('已截断');
  });

  it('claim 默认同样收敛，且保留状态/占用/工作空间路径等判定字段', async () => {
    stubFetch(twelve());
    const harness = context();
    await claim(harness.ctx, 'card-1');
    expect(harness.output).toContain('领取成功（agent: codex）');
    expect(harness.output).toContain('状态: 进行中');
    expect(harness.output).toContain('占用者: codex');
    expect(harness.output).toContain('工作空间路径: D:\\demo');
    expect(harness.output).toContain('评论（5/12）:');
    expect(harness.output).toContain('另有 7 条，--comments all 查看');
  });

  it('CLI 入口接通 --comments：kb show --comments 2 生效，非法值 exit 1', async () => {
    stubFetch(twelve());
    const harness = context();
    expect(await main(['node', 'kb', 'show', 'card-1', '--comments', '2'], harness.ctx.io)).toBe(0);
    expect(harness.output).toContain('评论（2/12）:');
    expect(harness.output).toContain('另有 10 条，--comments all 查看');
    expect(harness.output).not.toContain('评论正文 10');

    const invalid = context();
    expect(await main(['node', 'kb', 'show', 'card-1', '--comments', 'zero'], invalid.ctx.io)).toBe(1);
  });

  it('CLI 入口接通 kb claim --comments 2', async () => {
    stubFetch(twelve());
    const harness = context();
    expect(await main(['node', 'kb', 'claim', 'card-1', '--comments', '2', '--no-knowledge'], harness.ctx.io)).toBe(0);
    expect(harness.output).toContain('领取成功（agent: ');
    expect(harness.output).toContain('状态: 进行中');
    expect(harness.output).toContain('评论（2/12）:');
    expect(harness.output).toContain('另有 10 条，--comments all 查看');
  });
});
