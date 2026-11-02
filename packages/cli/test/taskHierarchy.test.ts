import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../src/io.js';
import { createIssue } from '../src/commands/createIssue.js';
import { listTasks } from '../src/commands/listTasks.js';
import { moveIssue } from '../src/commands/moveIssue.js';
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
      return Response.json(issue('child-1', 'Child', 'parent-1'), { headers: { 'x-agentboard-version': '0.1.0' } });
    }));
    const { ctx } = context();
    await createIssue(ctx, { workspace: workspace.id, title: 'Child', parentIssueId: 'parent-1' });
    expect(calls[1]?.body).toMatchObject({ parent_issue_id: 'parent-1' });
  });

  it('reads all tree pages and displays matching descendants with their ancestors', async () => {
    const root = { ...issue('root-1', 'Root', null), child_count: 1, descendant_count: 1, descendants_closed_count: 0 };
    const child = { ...issue('child-1', 'Child', 'root-1'), status: '进行中' as const, child_count: 0, descendant_count: 0, descendants_closed_count: 0 };
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/api/workspaces')) return Response.json([workspace], { headers: { 'x-agentboard-version': '0.1.0' } });
      const parsed = new URL(url);
      const parentId = parsed.searchParams.get('parent_issue_id');
      const page = parentId === null
        ? { items: [root], ancestors: [], next_cursor: null }
        : parentId === 'root-1'
          ? { items: [child], ancestors: [issue('root-1', 'Root', null)], next_cursor: null }
          : { items: [], ancestors: [root, child], next_cursor: null };
      return Response.json(page, { headers: { 'x-agentboard-version': '0.1.0' } });
    }));
    const harness = context();
    await listTasks(harness.ctx, { workspace: workspace.id, tree: true, status: '进行中' });
    expect(urls.some((url) => url.includes('/api/issues/tree?'))).toBe(true);
    const rows = JSON.parse(harness.output) as Array<{ id: string; tree_depth: number; tree_context: boolean }>;
    expect(rows).toEqual([
      expect.objectContaining({ id: 'root-1', tree_depth: 0, tree_context: true }),
      expect.objectContaining({ id: 'child-1', tree_depth: 1, tree_context: false }),
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
      if (init?.method === 'GET') return Response.json(issue('child-1', 'Child', 'parent-1'), { headers: { 'x-agentboard-version': '0.1.0' } });
      return Response.json(issue('child-1', 'Child', null), { headers: { 'x-agentboard-version': '0.1.0' } });
    }));
    const { ctx } = context();
    expect(await main(['node', 'kb', 'create-issue', workspace.id, 'Child', '--parent', 'parent-1', '--request-id', '00000000-0000-4000-8000-000000000201'], ctx.io)).toBe(0);
    expect(await main(['node', 'kb', 'move-issue', 'child-1', '--root', '--expected-updated-at', '1', '--request-id', '00000000-0000-4000-8000-000000000202'], ctx.io)).toBe(0);
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ parent_issue_id: 'parent-1' });
    expect(new Headers(calls[1]?.init?.headers).get('Idempotency-Key')).toBe('00000000-0000-4000-8000-000000000201');
    expect(JSON.parse(String(calls[3]?.init?.body))).toMatchObject({
      workspace_id: workspace.id, expected_updated_at: 1, parent_issue_id: null,
    });
    expect(new Headers(calls[3]?.init?.headers).get('Idempotency-Key')).toBe('00000000-0000-4000-8000-000000000202');
  });
});
