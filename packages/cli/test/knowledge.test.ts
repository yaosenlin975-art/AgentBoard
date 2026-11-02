import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';
const page = { id: 'p', scope: 'common', revision: 1, title: '缓存', body_md: '正文', sources: [{ source_id: 's' }], evidence: [{ locator: 'issue:1' }] };
function io(stdin = '正文') { const out: string[] = []; const err: string[] = []; return { out, err, write: (s: string) => out.push(s), writeErr: (s: string) => err.push(s), readStdin: async () => stdin }; }
afterEach(() => vi.unstubAllGlobals());
describe('knowledge CLI', () => {
  it('knowledgeCliJsonIncludesEvidence', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([page]))); vi.stubGlobal('fetch', fetch); const stream = io();
    expect(await main(['node', 'kb', '--json', 'knowledge', 'search', '缓存', '--scope', 'common'], stream)).toBe(0);
    expect(JSON.parse(stream.out.join(''))[0]).toMatchObject({ scope: 'common', revision: 1, sources: page.sources, evidence: page.evidence });
  });
  it('create reads UTF8 stdin with explicit scope', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(page))); vi.stubGlobal('fetch', fetch); const stream = io('中文\n多行');
    expect(await main(['node', 'kb', 'knowledge', 'create', '--scope', 'common', '--slug', 'cache', '--title', '缓存', '--stdin', '--sources', '[{"source_id":"s"}]', '--evidence', '[{"source_id":"s","locator":"issue:1"}]'], stream)).toBe(0);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({ scope: 'common', body_md: '中文\n多行' });
    expect(stream.out.join('')).toContain('缓存');
  });
  it('network errors return failure and show requires scope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline'))); const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'show', 'p', '--scope', 'common'], stream)).toBe(1);
    expect(stream.err.join('')).toContain('offline');
  });
  it('knowledge revision conflict is not reported as a claimed task', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'KNOWLEDGE_REVISION_CONFLICT', message: '当前 revision=2' } }), { status: 409 })));
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'action', 'p', 'archive', '--scope', 'common', '--expected-revision', '1'], stream)).toBe(2);
    expect(stream.err.join('')).toContain('当前 revision=2');
    expect(stream.err.join('')).not.toContain('已被占用');
  });
  it('claim JSON includes server knowledge and --no-knowledge explicitly disables it', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'task', knowledge: { enabled: true, query: '缓存', items: [page] } })));
    vi.stubGlobal('fetch', fetch); const stream = io();
    expect(await main(['node', 'kb', '--json', 'claim', 'task', '--no-knowledge'], stream)).toBe(0);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({ knowledge_enabled: false });
  });
});
