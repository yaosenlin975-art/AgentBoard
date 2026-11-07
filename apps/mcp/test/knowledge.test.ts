import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness } from './helpers.js';

const config = { baseUrl: 'http://127.0.0.1:8787', workspaceId: 'workspace-a', agentId: 'codex' };
const requestId = '00000000-0000-4000-8000-000000000031';
const source = {
  source_id: 'source-1', source_type: 'agent', locator: 'task:QA-01', captured_at: 1,
  content_hash: 'a'.repeat(64), snapshot: 'Source excerpt',
};
const evidence = { source_id: 'source-1', locator: 'task:QA-01', snapshot: 'Evidence excerpt' };
const page = {
  id: 'page-1', scope: 'workspace', workspace_id: 'workspace-a', slug: 'guide', title: 'Guide',
  body_md: 'Knowledge body', status: 'active', revision: 2, expires_at: null,
  created_by: 'codex', updated_by: 'codex', created_at: 1, updated_at: 2, sources: [source], evidence: [evidence],
};

describe('AgentBoard knowledge MCP tools', () => {
  const harnesses: Array<ReturnType<typeof createHarness>> = [];
  afterEach(async () => Promise.all(harnesses.splice(0).map((harness) => harness.close())));

  it('searches only the requested scope and current workspace', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/knowledge/search');
      expect(url.searchParams.get('scope')).toBe('both');
      expect(url.searchParams.get('workspace_id')).toBe('workspace-a');
      expect(url.searchParams.get('q')).toBe('cache');
      return Response.json([{ page_id: 'page-1', scope: 'workspace', workspace_id: 'workspace-a', revision: 2, title: 'Guide', snippet: 'cache', sources: [source], evidence: [evidence] }]);
    });
    const harness = createHarness(config, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const result = await harness.request('tools/call', {
      name: 'search_knowledge', arguments: { query: 'cache', scope: 'both' },
    });
    expect(result.result?.structuredContent?.data).toMatchObject({ items: [{ id: 'page-1', workspace_id: 'workspace-a' }] });
    expect(fetcher).toHaveBeenCalledTimes(1);

    const commonFetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('scope')).toBe('common');
      expect(url.searchParams.has('workspace_id')).toBe(false);
      return Response.json([]);
    });
    const commonHarness = createHarness(config, commonFetcher as typeof fetch);
    harnesses.push(commonHarness);
    await commonHarness.start();
    const common = await commonHarness.request('tools/call', {
      name: 'search_knowledge', arguments: { query: 'cache', scope: 'common' },
    });
    expect(common.result?.structuredContent?.data).toEqual({ items: [] });
    expect(commonFetcher).toHaveBeenCalledTimes(1);
  });

  it('requires page scope, rejects cross-workspace overrides, and requires explicit common scope', async () => {
    const fetcher = vi.fn(async () => Response.json(page));
    const harness = createHarness(config, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();

    const missingScope = await harness.request('tools/call', { name: 'read_knowledge', arguments: { page_id: 'page-1' } });
    expect(missingScope).toMatchObject({ jsonrpc: '2.0', result: { isError: true, content: [{ text: expect.stringContaining('Input validation error') }] } });
    const unknownField = await harness.request('tools/call', {
      name: 'read_knowledge', arguments: { page_id: 'page-1', scope: 'workspace', ignore_scope: true },
    });
    expect(unknownField).toMatchObject({ jsonrpc: '2.0', result: { isError: true, content: [{ text: expect.stringContaining('Input validation error') }] } });
    const wrongWorkspace = await harness.request('tools/call', {
      name: 'read_knowledge', arguments: { page_id: 'page-1', scope: 'workspace', workspace_id: 'workspace-b' },
    });
    expect(wrongWorkspace.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'WORKSPACE_BOUND' } });
    const commonWithWorkspace = await harness.request('tools/call', {
      name: 'read_knowledge', arguments: { page_id: 'page-1', scope: 'common', workspace_id: 'workspace-a' },
    });
    expect(commonWithWorkspace.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requires explicit common scope on create and sends request_id and actor to the shared API', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(requestId);
      return Response.json({ ...page, scope: 'common', workspace_id: null, body_md: 'Created common page' });
    });
    const harness = createHarness(config, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();

    const invalid = await harness.request('tools/call', {
      name: 'create_knowledge', arguments: { title: 'Guide', slug: 'guide', body_md: 'Body', sources: [source], evidence: [evidence], request_id: requestId },
    });
    expect(invalid).toMatchObject({ jsonrpc: '2.0', result: { isError: true, content: [{ text: expect.stringContaining('Input validation error') }] } });

    const created = await harness.request('tools/call', {
      name: 'create_knowledge', arguments: { scope: 'common', title: 'Guide', slug: 'guide', body_md: 'Body', sources: [source], evidence: [evidence], request_id: requestId },
    });
    const body = JSON.parse(String((fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit])[1].body));
    expect(body).toMatchObject({ scope: 'common', actor: 'codex', title: 'Guide', slug: 'guide' });
    expect(body).not.toHaveProperty('workspace_id');
    expect(created.result?.structuredContent?.data).toMatchObject({ scope: 'common', workspace_id: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('maps stale expected_revision to KNOWLEDGE_REVISION_CONFLICT with current revision metadata', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { code: 'KNOWLEDGE_REVISION_CONFLICT', details: { current_revision: 3 } } }, { status: 409 }));
    const harness = createHarness(config, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'revise_knowledge',
      arguments: { page_id: 'page-1', scope: 'workspace', expected_revision: 1, body_md: 'Stale body', request_id: requestId },
    });
    expect(response.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'KNOWLEDGE_REVISION_CONFLICT', current_revision: 3 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [input, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(new URL(String(input)).pathname).toBe('/api/knowledge/pages/page-1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toMatchObject({ scope: 'workspace', workspace_id: 'workspace-a', actor: 'codex', expected_revision: 1, body_md: 'Stale body' });
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe(requestId);
  });

  it('routes archive and restore to the shared action endpoint with CAS and idempotency', async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      return Response.json({ ...page, status: init?.body && JSON.parse(String(init.body)).action === 'archive' ? 'archived' : 'active' });
    });
    const harness = createHarness(config, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    for (const [name, revision, action] of [
      ['archive_knowledge', 2, 'archive'],
      ['restore_knowledge', 3, 'restore'],
    ] as const) {
      const response = await harness.request('tools/call', {
        name,
        arguments: { page_id: 'page-1', scope: 'workspace', expected_revision: revision, request_id: requestId },
      });
      expect(response.result?.structuredContent).toMatchObject({ ok: true, data: { status: action === 'archive' ? 'archived' : 'active' } });
    }
    expect(calls.map(({ url }) => url.pathname)).toEqual([
      '/api/knowledge/pages/page-1/actions', '/api/knowledge/pages/page-1/actions',
    ]);
    expect(calls.map(({ init }) => JSON.parse(String(init?.body)))).toEqual([
      { scope: 'workspace', workspace_id: 'workspace-a', action: 'archive', expected_revision: 2, actor: 'codex' },
      { scope: 'workspace', workspace_id: 'workspace-a', action: 'restore', expected_revision: 3, actor: 'codex' },
    ]);
    expect(calls.every(({ init }) => new Headers(init?.headers).get('Idempotency-Key') === requestId)).toBe(true);
  });

  it('windows page and history text, pages history by returned count, and keeps the tool result within 40,000 characters', async () => {
    const longBody = '🙂'.repeat(50000);
    const revisions = Array.from({ length: 3 }, (_, index) => ({
      id: `revision-${index}`, page_id: 'page-1', revision: 3 - index, title_snapshot: 'Guide',
      body_snapshot: 'H'.repeat(30000), sources: [source], evidence: [evidence],
      change_kind: 'update', status_snapshot: 'active', expires_at_snapshot: null, change_note: 'Updated', actor: 'codex', created_at: index,
    }));
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/revisions')) {
        if (url.searchParams.get('offset') === '2') {
          expect(url.searchParams.get('limit')).toBe('1');
          return Response.json({ items: revisions.slice(2), next_offset: null });
        }
        expect(url.searchParams.get('offset')).toBe('1');
        expect(url.searchParams.get('limit')).toBe('2');
        return Response.json({ items: revisions.slice(1), next_offset: 3 });
      }
      expect(url.pathname).toBe('/api/knowledge/pages/page-1');
      expect(url.searchParams.get('scope')).toBe('workspace');
      expect(url.searchParams.get('workspace_id')).toBe('workspace-a');
      return Response.json({ ...page, body_md: longBody });
    });
    const harness = createHarness(config, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'read_knowledge', arguments: {
        page_id: 'page-1', scope: 'workspace', offset_chars: 10, max_chars: 20000,
        include_history: true, history_offset: 1, history_limit: 2,
      },
    });
    const data = response.result?.structuredContent?.data;
    expect(Array.from(data.page.body_md).length).toBeLessThan(20000);
    expect(data.truncated).toBe(true);
    expect(data.next_offset_chars).toBe(10 + Array.from(data.page.body_md).length);
    expect(data.history_next_offset).toBe(2);
    expect(data.history.items).toHaveLength(1);
    expect(data.history.items[0].body_snapshot).toHaveLength(20000);
    expect(data.history.items[0].next_body_snapshot_offset_chars).toBe(20000);
    expect(JSON.stringify(response.result).length).toBeLessThanOrEqual(40000);

    const continuation = await harness.request('tools/call', {
      name: 'read_knowledge', arguments: {
        page_id: 'page-1', scope: 'workspace', max_chars: 1000,
        include_history: true, history_offset: 2, history_limit: 1, history_body_offset_chars: 15000,
      },
    });
    const continuationData = continuation.result?.structuredContent?.data;
    expect(continuationData.history.items[0].body_snapshot).toHaveLength(1000);
    expect(continuationData.history.items[0].next_body_snapshot_offset_chars).toBe(16000);
    expect(continuationData.history_next_offset).toBeNull();
    expect(JSON.stringify(continuation.result).length).toBeLessThanOrEqual(40000);
  });

  it('paginates large source and evidence arrays without losing records', async () => {
    const sources = Array.from({ length: 100 }, (_, index) => ({ ...source, source_id: `source-${index}`, snapshot: 's'.repeat(1000) }));
    const evidenceItems = Array.from({ length: 100 }, (_, index) => ({ ...evidence, source_id: `evidence-${index}`, snapshot: 'e'.repeat(1000) }));
    const fetcher = vi.fn(async () => Response.json({ ...page, body_md: 'small', sources, evidence: evidenceItems }));
    const harness = createHarness(config, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const readSlice = async (sourcesOffset: number, evidenceOffset: number) => {
      const response = await harness.request('tools/call', {
        name: 'read_knowledge', arguments: {
          page_id: 'page-1', scope: 'workspace', max_chars: 10,
          sources_offset: sourcesOffset, sources_limit: 10,
          evidence_offset: evidenceOffset, evidence_limit: 10,
        },
      });
      expect(JSON.stringify(response.result).length).toBeLessThanOrEqual(40000);
      return response.result?.structuredContent?.data;
    };
    const allSources: string[] = [];
    const allEvidence: string[] = [];
    for (let offset = 0; offset < 100; offset += 10) {
      const data = await readSlice(offset, offset);
      allSources.push(...data.page.sources.map((item: { source_id: string }) => item.source_id));
      allEvidence.push(...data.page.evidence.map((item: { source_id: string }) => item.source_id));
      expect(data.sources_next_offset).toBe(offset === 90 ? null : offset + 10);
      expect(data.evidence_next_offset).toBe(offset === 90 ? null : offset + 10);
    }
    expect(allSources).toEqual(sources.map((item) => item.source_id));
    expect(allEvidence).toEqual(evidenceItems.map((item) => item.source_id));
  });

  it('requires history_limit=1 to continue a history snapshot and requires an agent for writes', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const harness = createHarness(config, fetcher);
    harnesses.push(harness);
    await harness.start();
    const invalid = await harness.request('tools/call', {
      name: 'read_knowledge', arguments: { page_id: 'page-1', scope: 'workspace', include_history: true, history_limit: 2, history_body_offset_chars: 10 },
    });
    expect(invalid.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    const noActor = createHarness({ baseUrl: config.baseUrl, workspaceId: config.workspaceId }, fetcher);
    harnesses.push(noActor);
    await noActor.start();
    const missingActor = await noActor.request('tools/call', {
      name: 'archive_knowledge', arguments: { page_id: 'page-1', scope: 'workspace', expected_revision: 1, request_id: requestId },
    });
    expect(missingActor.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'AGENT_ID_REQUIRED' } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns KNOWLEDGE_UNAVAILABLE when the server has no knowledge API route', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { message: 'not found' } }, { status: 404 }));
    const harness = createHarness(config, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'search_knowledge', arguments: { query: 'cache', scope: 'workspace' },
    });
    expect(response.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'KNOWLEDGE_UNAVAILABLE' } });
  });

  it('lists knowledge pages with default paging and metadata-only summaries', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/knowledge/pages');
      expect(url.searchParams.get('scope')).toBe('workspace');
      expect(url.searchParams.get('workspace_id')).toBe('workspace-a');
      expect(url.searchParams.get('status')).toBe('active');
      expect(url.searchParams.get('include_expired')).toBe('false');
      expect(url.searchParams.get('offset')).toBe('0');
      expect(url.searchParams.get('limit')).toBe('20');
      return Response.json({
        items: [{
          ...page, body_md: 'should not leak', category: 'design', landed: 'landed', domain: 'board',
          link: `knowledge:${page.id}`, link_info: { ref: `knowledge:${page.id}`, markdown: '...', text: '...' },
        }],
        next_offset: 20,
      });
    });
    const harness = createHarness(config, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', { name: 'list_knowledge', arguments: {} });
    const data = response.result?.structuredContent?.data;
    expect(data).toMatchObject({
      scope: 'workspace',
      workspace_id: 'workspace-a',
      next_offset: 20,
      items: [{ id: 'page-1', slug: 'guide', status: 'active', revision: 2, category: 'design', domain: 'board', link: 'knowledge:page-1' }],
    });
    expect(data.items[0]).not.toHaveProperty('body_md');
    expect(data.items[0]).not.toHaveProperty('link_info');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('lists common knowledge without a workspace_id and enforces the 100-item limit', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('scope')).toBe('common');
      expect(url.searchParams.has('workspace_id')).toBe(false);
      return Response.json({ items: [], next_offset: null });
    });
    const harness = createHarness(config, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const common = await harness.request('tools/call', { name: 'list_knowledge', arguments: { scope: 'common' } });
    expect(common.result?.structuredContent?.data).toEqual({ scope: 'common', workspace_id: null, items: [], next_offset: null });
    expect(fetcher).toHaveBeenCalledTimes(1);

    const tooMany = await harness.request('tools/call', { name: 'list_knowledge', arguments: { limit: 101 } });
    expect(tooMany).toMatchObject({ jsonrpc: '2.0', result: { isError: true, content: [{ text: expect.stringContaining('Input validation error') }] } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('finds knowledge pages by source path and caps oversized result sets', async () => {
    const hit = { id: 'page-1', slug: 'guide', title: 'Guide', scope: 'workspace', workspace_id: 'workspace-a', revision: 2, status: 'active', link: 'knowledge:page-1', link_info: { ref: 'knowledge:page-1' } };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/knowledge/find-source');
      expect(url.searchParams.get('path')).toBe('apps/mcp/src/index.ts');
      expect(url.searchParams.get('scope')).toBe('both');
      expect(url.searchParams.get('workspace_id')).toBe('workspace-a');
      return Response.json({ path: 'apps/mcp/src/index.ts', items: Array.from({ length: 120 }, () => hit) });
    });
    const harness = createHarness(config, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'find_knowledge_sources', arguments: { path: 'apps/mcp/src/index.ts' },
    });
    const data = response.result?.structuredContent?.data;
    expect(data).toMatchObject({ path: 'apps/mcp/src/index.ts', total: 120, truncated: true });
    expect(data.items).toHaveLength(100);
    expect(data.items[0]).toMatchObject({ id: 'page-1', link: 'knowledge:page-1' });
    expect(data.items[0]).not.toHaveProperty('link_info');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects scope overflows on the knowledge browsing tools', async () => {
    const fetcher = vi.fn(async () => Response.json({ items: [], next_offset: null }));
    const harness = createHarness(config, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const commonWithWorkspace = await harness.request('tools/call', {
      name: 'list_knowledge', arguments: { scope: 'common', workspace_id: 'workspace-a' },
    });
    expect(commonWithWorkspace.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    const wrongWorkspace = await harness.request('tools/call', {
      name: 'find_knowledge_sources', arguments: { path: 'apps/mcp/src/index.ts', scope: 'workspace', workspace_id: 'workspace-b' },
    });
    expect(wrongWorkspace.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'WORKSPACE_BOUND' } });
    expect(fetcher).not.toHaveBeenCalled();

    const unbound = createHarness({ baseUrl: 'http://127.0.0.1:8787', agentId: 'codex' }, fetcher as typeof fetch);
    harnesses.push(unbound);
    await unbound.start();
    const missingWorkspace = await unbound.request('tools/call', { name: 'list_knowledge', arguments: { scope: 'workspace' } });
    expect(missingWorkspace.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'WORKSPACE_REQUIRED' } });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
