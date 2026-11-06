import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../src/io.js';
import { createIssue } from '../src/commands/createIssue.js';
import { listTasks } from '../src/commands/listTasks.js';
import { moveIssue } from '../src/commands/moveIssue.js';
import { show } from '../src/commands/show.js';
import { main } from '../src/index.js';

const workspace = { id: 'workspace-1', name: 'Demo', path: 'D:\\demo', created_at: 1 };
function issue(id: string, title: string, parent_issue_id: string | null) {
  return {
    id, workspace_id: workspace.id, title, description: '', priority: '中' as const, labels: [], status: '待规划' as const,
    sort_order: 0, parent_issue_id, claimed_by: null, claimed_at: null, session_id: null, comment_count: 0, created_at: 1, updated_at: 1,
  };
}
function context(json = true) {
  let output = '';
  const ctx: Ctx = {
    base: 'http://agentboard.test', json, agentId: 'codex',
    io: { write: (line) => { output += line; }, writeErr: () => {}, readStdin: async () => '' },
  };
  return { ctx, get output() { return output; } };
}

afterEach(() => vi.unstubAllGlobals());

describe('CLI task hierarchy', () => {
  it('passes parent_issue_id when creating a child issue', async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      if (url.endsWith('/api/workspaces')) return Response.json([workspace], { headers: { 'x-agentboard-version': '0.1.0' } });
      if (url.includes('/statuses')) return Response.json([
        { id: 's1', workspace_id: workspace.id, name: '待规划', kind: 'open', sort_order: 0, is_builtin: 1 },
        { id: 's2', workspace_id: workspace.id, name: '进行中', kind: 'started', sort_order: 10, is_builtin: 1 },
      ], { headers: { 'x-agentboard-version': '0.1.0' } });
      // MOJI-GUARD 回读：卡面描述按提交原文落库
      if (url.endsWith('/api/issues/child-1')) return Response.json({ ...issue('child-1', 'Child', 'parent-1'), description: '子卡正文与验收' }, { headers: { 'x-agentboard-version': '0.1.0' } });
      return Response.json(issue('child-1', 'Child', 'parent-1'), { headers: { 'x-agentboard-version': '0.1.0' } });
    }));
    const { ctx } = context();
    await createIssue(ctx, { workspace: workspace.id, title: 'Child', description: '子卡正文与验收', parentIssueId: 'parent-1' });
    expect(calls[1]?.body).toMatchObject({ parent_issue_id: 'parent-1' });
    // 写入后各多一次回读 GET（MOJI-GUARD）
    expect(calls[2]?.url).toBe('http://agentboard.test/api/issues/child-1');
  });

  it('assembles the tree locally from one workspace read, keeping ancestors as context rows', async () => {
    const root = issue('root-1', 'Root', null);
    const child = { ...issue('child-1', 'Child', 'root-1'), status: '进行中' as const };
    const grand = { ...issue('grand-1', 'Grand', 'child-1'), status: '已关闭' as const };
    const orphan = issue('orphan-1', 'Orphan', 'deleted-1'); // 父卡已删除：与旧 BFS 一样不输出
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/api/workspaces')) return Response.json([workspace], { headers: { 'x-agentboard-version': '0.1.0' } });
      if (url.includes('/statuses')) return Response.json([
        { id: 's1', workspace_id: workspace.id, name: '待规划', kind: 'open', sort_order: 0, is_builtin: 1 },
        { id: 's2', workspace_id: workspace.id, name: '进行中', kind: 'started', sort_order: 10, is_builtin: 1 },
      ], { headers: { 'x-agentboard-version': '0.1.0' } });
      if (url === `http://agentboard.test/api/issues?workspace=${workspace.id}`) {
        return Response.json([root, child, grand, orphan], { headers: { 'x-agentboard-version': '0.1.0' } });
      }
      return Response.json({ error: { code: 'NOT_FOUND', message: 'mock 未匹配：' + url } }, { status: 404 });
    }));
    const harness = context();
    await listTasks(harness.ctx, { workspace: workspace.id, tree: true, status: '进行中' });
    // KB-CLI-4（CLI-19/20）：整区一次读取；不再逐父打 /api/issues/tree；内置状态免取字典
    expect(urls.filter((url) => url.includes('/api/issues?workspace='))).toHaveLength(1);
    expect(urls.filter((url) => url.includes('/api/issues/tree?'))).toHaveLength(0);
    expect(urls.filter((url) => url.includes('/statuses'))).toHaveLength(0);
    const rows = JSON.parse(harness.output) as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      expect.objectContaining({ id: 'root-1', tree_depth: 0, tree_context: true, child_count: 1, descendant_count: 2, descendants_closed_count: 1 }),
      expect.objectContaining({ id: 'child-1', tree_depth: 1, tree_context: false, child_count: 1, descendant_count: 1, descendants_closed_count: 1 }),
    ]);
  });

  it('reads the status dictionary once per workspace when a custom status is in play', async () => {
    const root = issue('root-1', 'Root', null);
    const done = { ...issue('done-1', 'Done', 'root-1'), status: '已完成' as const };
    const dictionary = [
      { id: 's1', workspace_id: workspace.id, name: '待规划', kind: 'open', sort_order: 0, is_builtin: 1 },
      { id: 's9', workspace_id: workspace.id, name: '已完成', kind: 'done', sort_order: 50, is_builtin: 0 },
    ];
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/api/workspaces')) return Response.json([workspace], { headers: { 'x-agentboard-version': '0.1.0' } });
      if (url.includes('/statuses')) return Response.json(dictionary, { headers: { 'x-agentboard-version': '0.1.0' } });
      if (url === `http://agentboard.test/api/issues?workspace=${workspace.id}`) {
        return Response.json([root, done], { headers: { 'x-agentboard-version': '0.1.0' } });
      }
      return Response.json({ error: { code: 'NOT_FOUND', message: 'mock 未匹配：' + url } }, { status: 404 });
    }));
    const harness = context();
    await listTasks(harness.ctx, { workspace: workspace.id, tree: true, status: '已完成' });
    // --status 校验与关闭态判定共用同一份进程内字典（CLI-20）
    expect(urls.filter((url) => url.includes('/statuses'))).toHaveLength(1);
    const rows = JSON.parse(harness.output) as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      expect.objectContaining({ id: 'root-1', tree_depth: 0, tree_context: true, descendant_count: 1, descendants_closed_count: 1 }),
      expect.objectContaining({ id: 'done-1', tree_depth: 1, tree_context: false, child_count: 0, descendants_closed_count: 0 }),
    ]);
  });

  it('moves an issue with CAS and can explicitly clear its parent', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push({ method, url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return Response.json(issue('child-1', 'Child', method === 'GET' ? 'parent-1' : null), { headers: { 'x-agentboard-version': '0.1.0' } });
    }));
    const { ctx } = context();
    await moveIssue(ctx, 'child-1', { root: true });
    expect(calls[1]).toMatchObject({
      method: 'PATCH',
      body: { workspace_id: workspace.id, expected_updated_at: 1, parent_issue_id: null },
    });
  });

  it('exposes hierarchy flags through create-issue and move-issue CLI commands', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/api/workspaces')) return Response.json([workspace], { headers: { 'x-agentboard-version': '0.1.0' } });
      if (url.includes('/statuses')) return Response.json([
        { id: 's1', workspace_id: workspace.id, name: '待规划', kind: 'open', sort_order: 0, is_builtin: 1 },
        { id: 's2', workspace_id: workspace.id, name: '进行中', kind: 'started', sort_order: 10, is_builtin: 1 },
      ], { headers: { 'x-agentboard-version': '0.1.0' } });
      if (init?.method === 'GET') return Response.json({ ...issue('child-1', 'Child', 'parent-1'), description: '子卡正文与验收' }, { headers: { 'x-agentboard-version': '0.1.0' } });
      return Response.json(issue('child-1', 'Child', null), { headers: { 'x-agentboard-version': '0.1.0' } });
    }));
    const { ctx } = context();
    expect(await main(['node', 'kb', 'create-issue', workspace.id, 'Child', '-d', '子卡正文与验收', '--parent', 'parent-1', '--request-id', '00000000-0000-4000-8000-000000000201'], ctx.io)).toBe(0);
    expect(await main(['node', 'kb', 'move-issue', 'child-1', '--root', '--expected-updated-at', '1', '--request-id', '00000000-0000-4000-8000-000000000202'], ctx.io)).toBe(0);
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ parent_issue_id: 'parent-1' });
    expect(new Headers(calls[1]?.init?.headers).get('Idempotency-Key')).toBe('00000000-0000-4000-8000-000000000201');
    // calls[2] 是 create 的 MOJI-GUARD 回读，move-issue 的请求因此后移到 3、4
    expect(JSON.parse(String(calls[4]?.init?.body))).toMatchObject({
      workspace_id: workspace.id, expected_updated_at: 1, parent_issue_id: null,
    });
    expect(new Headers(calls[4]?.init?.headers).get('Idempotency-Key')).toBe('00000000-0000-4000-8000-000000000202');
  });
});

describe('CHILD-PROGRESS：子卡进度展示', () => {
  const root = { ...issue('root-1', '父卡', null), children_total: 3, children_closed: 1 };
  const closedChild = { ...issue('child-1', '已关子卡', 'root-1'), status: '已关闭' as const };
  const startedChild = { ...issue('child-2', '在飞子卡', 'root-1'), status: '进行中' as const };
  const reviewChild = { ...issue('child-3', '待验子卡', 'root-1'), status: '待验收' as const };

  it('kb show 文本为父卡追加三态计数行', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/api/issues/root-1')) return Response.json(root, { headers: { 'x-agentboard-version': '0.1.0' } });
      if (url.endsWith('/api/issues/root-1/comments')) return Response.json([], { headers: { 'x-agentboard-version': '0.1.0' } });
      if (url === `http://agentboard.test/api/issues?workspace=${workspace.id}`) {
        return Response.json([root, closedChild, startedChild, reviewChild], { headers: { 'x-agentboard-version': '0.1.0' } });
      }
      return Response.json({ error: { code: 'NOT_FOUND', message: 'mock 未匹配：' + url } }, { status: 404 });
    }));
    const harness = context(false);
    await show(harness.ctx, 'root-1');
    expect(harness.output).toContain('子卡：1/3 已完成（进行中 1，待验收 1，待规划 0）');
  });

  it('kb show 对无子卡卡不显示该行、也不多发整区列表请求', async () => {
    const urls: string[] = [];
    const leaf = { ...issue('leaf-1', '叶子', null), children_total: 0, children_closed: 0 };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/api/issues/leaf-1')) return Response.json(leaf, { headers: { 'x-agentboard-version': '0.1.0' } });
      if (url.endsWith('/api/issues/leaf-1/comments')) return Response.json([], { headers: { 'x-agentboard-version': '0.1.0' } });
      return Response.json({ error: { code: 'NOT_FOUND', message: 'mock 未匹配：' + url } }, { status: 404 });
    }));
    const harness = context(false);
    await show(harness.ctx, 'leaf-1');
    expect(harness.output).not.toContain('子卡：');
    expect(urls.some(url => url.includes('/api/issues?workspace='))).toBe(false);
  });

  it('list-tasks 文本父卡标题后追加 [N/M]，--json 原样带字段', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/workspaces')) return Response.json([workspace], { headers: { 'x-agentboard-version': '0.1.0' } });
      if (url === `http://agentboard.test/api/issues?workspace=${workspace.id}`) {
        return Response.json([root, closedChild, startedChild, { ...issue('leaf-1', '叶子', null), children_total: 0, children_closed: 0 }], { headers: { 'x-agentboard-version': '0.1.0' } });
      }
      return Response.json({ error: { code: 'NOT_FOUND', message: 'mock 未匹配：' + url } }, { status: 404 });
    }));
    const text = context(false);
    await listTasks(text.ctx, { workspace: workspace.id });
    expect(text.output).toContain('父卡 [1/3]');
    expect(text.output).toContain('叶子');

    const json = context(true);
    await listTasks(json.ctx, { workspace: workspace.id });
    const rows = JSON.parse(json.output) as Array<{ id: string; children_total?: number; children_closed?: number }>;
    expect(rows.find(row => row.id === 'root-1')).toMatchObject({ children_total: 3, children_closed: 1 });
    expect(rows.find(row => row.id === 'leaf-1')).toMatchObject({ children_total: 0, children_closed: 0 });
  });
});
