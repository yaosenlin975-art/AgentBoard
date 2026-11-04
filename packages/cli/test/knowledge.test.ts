import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(await main(['node', 'kb', 'knowledge', 'create', '--scope', 'common', '--slug', 'cache', '--title', '缓存', '--stdin', '--sources', JSON.stringify([{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1763000000000, content_hash: 'a'.repeat(64) }]), '--evidence', JSON.stringify([{ source_id: 'file:README.md', locator: 'issue:1' }])], stream)).toBe(0);
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
  it('sources 缺字段：字段级中文提示指明字段名与期望格式', async () => {
    vi.stubGlobal('fetch', vi.fn()); const stream = io();
    const code = await main(['node', 'kb', 'knowledge', 'create', '--scope', 'common', '--slug', 's', '--title', 't', '--stdin', '--sources', JSON.stringify([{ source_id: 'x' }]), '--evidence', JSON.stringify([{ source_id: 'x', locator: 'issue:1' }])], stream);
    expect(code).toBe(1);
    const err = stream.err.join('');
    expect(err).toContain('--sources[0].source_type');
    // 断言不是 zod 英文串（报错必须是中文 + 字段名）
    expect(err).toContain('file | url | agent');
  });

  it('sources 的 content_hash 非法：提示期望 64 位十六进制', async () => {
    vi.stubGlobal('fetch', vi.fn()); const stream = io();
    const code = await main(['node', 'kb', 'knowledge', 'create', '--scope', 'common', '--slug', 's', '--title', 't', '--stdin', '--sources', JSON.stringify([{ source_id: 'a', source_type: 'file', locator: 'l', captured_at: 1, content_hash: 'abc' }]), '--evidence', JSON.stringify([{ source_id: 'a', locator: 'issue:1' }])], stream);
    expect(code).toBe(1);
    expect(stream.err.join('')).toContain('--sources[0].content_hash');
    expect(stream.err.join('')).toContain('64 位十六进制');
  });

  it('sources 不是合法 JSON：给出中文提示并推荐 --sources-file', async () => {
    vi.stubGlobal('fetch', vi.fn()); const stream = io();
    const code = await main(['node', 'kb', 'knowledge', 'create', '--scope', 'common', '--slug', 's', '--title', 't', '--stdin', '--sources', '[{"source_id":', '--evidence', '[]'], stream);
    expect(code).toBe(1);
    expect(stream.err.join('')).toContain('--sources 不是合法 JSON');
    expect(stream.err.join('')).toContain('--sources-file');
  });

  it('create 缺 --stdin/--sources/--evidence：逐项列出必填', async () => {
    vi.stubGlobal('fetch', vi.fn()); const stream = io();
    const code = await main(['node', 'kb', 'knowledge', 'create', '--scope', 'common', '--slug', 's', '--title', 't'], stream);
    expect(code).toBe(1);
    const err = stream.err.join('');
    expect(err).toContain('create 缺少必填项');
    expect(err).toContain('--stdin');
    expect(err).toContain('--sources');
    expect(err).toContain('--evidence');
    expect(err).toContain('kb knowledge create --help');
  });

  it('--sources-file / --evidence-file 读文件成功（避开引号转义）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-knowledge-'));
    const sources = join(dir, 'sources.json');
    const evidence = join(dir, 'evidence.json');
    writeFileSync(sources, JSON.stringify([{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: 'b'.repeat(64) }]), 'utf8');
    writeFileSync(evidence, JSON.stringify([{ source_id: 'file:README.md', locator: 'file:1-20' }]), 'utf8');
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(page))); vi.stubGlobal('fetch', fetch); const stream = io('正文');
    const code = await main(['node', 'kb', 'knowledge', 'create', '--scope', 'common', '--slug', 's', '--title', 't', '--stdin', '--sources-file', sources, '--evidence-file', evidence], stream);
    expect(code).toBe(0);
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(body.sources[0].source_type).toBe('file');
    expect(body.evidence[0].locator).toBe('file:1-20');
    rmSync(dir, { recursive: true, force: true });
  });

  it('--sources 与 --sources-file 同时给：明确报错不静默取一个', async () => {
    vi.stubGlobal('fetch', vi.fn()); const stream = io();
    const code = await main(['node', 'kb', 'knowledge', 'create', '--scope', 'common', '--slug', 's', '--title', 't', '--stdin', '--sources', '[]', '--sources-file', 'x.json', '--evidence', '[]'], stream);
    expect(code).toBe(1);
    expect(stream.err.join('')).toContain('只能给一个');
  });

  it('action 非法值：列出合法动作而不是只报错', async () => {
    vi.stubGlobal('fetch', vi.fn()); const stream = io();
    const code = await main(['node', 'kb', 'knowledge', 'action', 'p', 'archive2', '--scope', 'common', '--expected-revision', '1'], stream);
    expect(code).toBe(1);
    expect(stream.err.join('')).toContain('archive | restore | delete');
  });

  it('list 非 --json：每页一行，有 next_offset 时提示下一页', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [{ id: 'p1', scope: 'common', revision: 2, title: '缓存' }], next_offset: 20 })));
    vi.stubGlobal('fetch', fetch); const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'list', '--scope', 'common'], stream)).toBe(0);
    expect(stream.out.join('')).toBe('p1 [common] rev:2 缓存\n下一页：--offset 20\n');
  });

  it('stdin 带 UTF-8 BOM（PowerShell 5.1 管道）时剥离，正文首字符不被污染', async () => {
    const { Readable } = await import('node:stream');
    const { readAllStdin } = await import('../src/io.js');
    expect(await readAllStdin(Readable.from([Buffer.from('\uFEFF# 标题', 'utf8')]))).toBe('# 标题');
    expect(await readAllStdin(Readable.from(['# 标题']))).toBe('# 标题');
  });
});

describe('knowledge CLI：B 缺省 cwd 解析', () => {
  it('workspace 范围缺省按 cwd 解析当前工作区', async () => {
    const ws = { id: 'w1', name: '项目', path: process.cwd(), created_at: 1 };
    // 按 URL 回包（不依赖调用次数）：/api/workspaces → [ws]，其余（知识页列表）→ []
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes('/api/workspaces') ? [ws] : [])));
    vi.stubGlobal('fetch', fetch);
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'list', '--scope', 'workspace'], stream)).toBe(0);
    const urls = fetch.mock.calls.map(call => String(call[0]));
    expect(urls[0]).toContain('/api/workspaces');
    const pagesUrl = urls.find(url => url.includes('/api/knowledge/pages'));
    expect(pagesUrl).toBeDefined();
    expect(pagesUrl).toContain('workspace_id=w1');
  });

  it('cwd 解析不到工作区时报可读错误（不静默空列表）', async () => {
    const ws = { id: 'w1', name: '项目', path: 'Z:/not-here', created_at: 1 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([ws]))));
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'list', '--scope', 'workspace'], stream)).toBe(1);
    expect(stream.err.join('')).toContain('--workspace');
  });
});
