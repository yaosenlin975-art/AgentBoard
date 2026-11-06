import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';
const page = { id: 'p', scope: 'common', revision: 1, title: '缓存', body_md: '正文', sources: [{ source_id: 's' }], evidence: [{ locator: 'issue:1' }] };
function io(stdin = '正文') { const out: string[] = []; const err: string[] = []; return { out, err, write: (s: string) => out.push(s), writeErr: (s: string) => err.push(s), readStdin: async () => stdin }; }
afterEach(() => vi.unstubAllGlobals());

/**
 * KBGUIDE：--help 的内容口径必须存在（多数人只看 --help；只有技能文档写口径会写出状态页）。
 */
describe('knowledge CLI：help 内容口径（KBGUIDE）', () => {
  const helpOf = async (...args: string[]): Promise<{ code: number; text: string }> => {
    const stream = io();
    const code = await main(['node', 'kb', 'knowledge', ...args, '--help'], stream);
    return { code, text: stream.out.join('') };
  };

  it('create --help：内容口径（写什么 / 不写什么 / 按领域分页 / slug 语义化 / 禁用 handoff-<uuid> / 用 revise）', async () => {
    const { code, text } = await helpOf('create');
    expect(code).toBe(0);
    expect(text).toContain('内容口径（写什么 / 不写什么）');
    expect(text).toContain('设计点、技术点、注意点');
    expect(text).toContain('不写：完成情况、剩余待办、个人进度');
    expect(text).toContain('按领域分页');
    expect(text).toContain('slug 语义化');
    expect(text).toContain('禁用 handoff-<uuid>');
    expect(text).toContain('用 revise 演进');
  });

  it('revise --help：同主题演进 + CAS 旧值提示 + 指回技能', async () => {
    const { code, text } = await helpOf('revise');
    expect(code).toBe(0);
    expect(text).toContain('同主题内容演进用 revise');
    expect(text).toContain('--expected-revision 是 CAS');
    expect(text).toContain('知识页已更新，请重新读取');
  });

  it('list --help：--status all --include-expired 找同主题页 + 指回技能', async () => {
    const { code, text } = await helpOf('list');
    expect(code).toBe(0);
    expect(text).toContain('--status all --include-expired');
    expect(text).toContain('找同主题的既有页');
  });

  it('三处 help 末尾统一指回 skills/using-agentboard 的内容口径', async () => {
    const pointer = '详见 skills/using-agentboard 的「知识页写什么（内容口径）」';
    for (const command of ['create', 'revise', 'list']) {
      const { text } = await helpOf(command);
      expect(text, `${command} --help 缺少指回`).toContain(pointer);
    }
  });
});
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

describe('knowledge CLI：C category/landed', () => {
  const page = { id: 'p1', scope: 'workspace', revision: 1, title: 't', body_md: 'b', category: 'design', landed: 'proposed' };
  const ws = { id: 'w1', name: '项目', path: 'D:/project', created_at: 1 };

  it('create 传 --category/--landed 时进请求体', async () => {
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes('/api/workspaces') ? [ws] : page)));
    vi.stubGlobal('fetch', fetch);
    const stream = io('正文');
    const code = await main(['node', 'kb', 'knowledge', 'create', '--scope', 'workspace', '--workspace', 'w1', '--slug', 's', '--title', 't', '--stdin', '--sources', JSON.stringify([{ source_id: 'a', source_type: 'file', locator: 'x', captured_at: 1, content_hash: 'a'.repeat(64) }]), '--evidence', JSON.stringify([{ source_id: 'a', locator: 'x' }]), '--category', 'design', '--landed', 'partial'], stream);
    expect(code).toBe(0);
    const body = JSON.parse(String(fetch.mock.calls.at(-1)![1].body)) as Record<string, unknown>;
    expect(body.category).toBe('design');
    expect(body.landed).toBe('partial');
  });

  it('KB-LANDED：open 分类也接受 --landed（不再被客户端拦截）', async () => {
    const openPage = { ...page, category: 'open', landed: 'partial' };
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes('/api/workspaces') ? [ws] : openPage)));
    vi.stubGlobal('fetch', fetch);
    const stream = io('正文');
    const code = await main(['node', 'kb', 'knowledge', 'create', '--scope', 'workspace', '--workspace', 'w1', '--slug', 's', '--title', 't', '--stdin', '--sources', JSON.stringify([{ source_id: 'a', source_type: 'file', locator: 'x', captured_at: 1, content_hash: 'a'.repeat(64) }]), '--evidence', JSON.stringify([{ source_id: 'a', locator: 'x' }]), '--category', 'open', '--landed', 'partial'], stream);
    expect(code).toBe(0);
    const body = JSON.parse(String(fetch.mock.calls.at(-1)![1].body)) as Record<string, unknown>;
    expect(body.category).toBe('open');
    expect(body.landed).toBe('partial');
  });

  it('非法 --category 在客户端失败并列出可用值（不发请求）', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const stream = io('正文');
    const code = await main(['node', 'kb', 'knowledge', 'create', '--scope', 'workspace', '--workspace', 'w1', '--slug', 's', '--title', 't', '--stdin', '--sources', JSON.stringify([{ source_id: 'a', source_type: 'file', locator: 'x', captured_at: 1, content_hash: 'a'.repeat(64) }]), '--evidence', JSON.stringify([{ source_id: 'a', locator: 'x' }]), '--category', 'nope'], stream);
    expect(code).toBe(1);
    expect(stream.err.join('')).toContain('design | solved | pinned | open');
  });

  it('非法 --landed 同样客户端失败并列出可用值', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const stream = io('正文');
    const code = await main(['node', 'kb', 'knowledge', 'create', '--scope', 'workspace', '--workspace', 'w1', '--slug', 's', '--title', 't', '--stdin', '--sources', JSON.stringify([{ source_id: 'a', source_type: 'file', locator: 'x', captured_at: 1, content_hash: 'a'.repeat(64) }]), '--evidence', JSON.stringify([{ source_id: 'a', locator: 'x' }]), '--landed', 'maybe'], stream);
    expect(code).toBe(1);
    expect(stream.err.join('')).toContain('landed | partial | proposed');
  });

  it('show 带出 category 与 landed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(page))));
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'show', 'p1', '--scope', 'common'], stream)).toBe(0);
    const out = stream.out.join('');
    expect(out).toContain('category: design');
    expect(out).toContain('landed: proposed');
  });
});

/**
 * KB-PAGE-2：`kb knowledge resolve <ref>` / `kb knowledge link <page-id>`。
 * 退出码沿用既有约定（dep 那套）：404 → 1；409（歧义）/403 → 2；成功 0。
 */
describe('knowledge CLI：resolve / link（KB-PAGE-2）', () => {
  const resolved = {
    state: 'resolved', id: 'p-1', title: '缓存策略', scope: 'common', workspace_id: null,
    status: 'active', revision: 3, redirect_to: null,
    // BORROW-3.1（D10）：link 为引用串；旧对象字段移入 link_info（D9 知识卡前缀）
    link: 'knowledge:p-1',
    link_info: { id: 'p-1', scope: 'common', workspace_id: null, slug: 'cache-policy', ref: 'knowledge:p-1', markdown: '[知识卡：缓存策略](knowledge:p-1)', text: '知识卡《缓存策略》 knowledge:p-1 · rev:3' },
  };

  it('resolve 成功：打印 id/scope/revision/title + link', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(resolved))));
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'resolve', 'p-1', '--scope', 'common'], stream)).toBe(0);
    const out = stream.out.join('');
    expect(out).toContain('p-1 [common] rev:3 缓存策略');
    expect(out).toContain('link: knowledge:p-1');
  });

  it('resolve --json：原样输出服务端对象（link 为引用串 + link_info 对象）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(resolved))));
    const stream = io();
    expect(await main(['node', 'kb', '--json', 'knowledge', 'resolve', 'p-1', '--scope', 'common'], stream)).toBe(0);
    const parsed = JSON.parse(stream.out.join(''));
    expect(parsed.link).toBe('knowledge:p-1');
    expect(parsed.link_info).toMatchObject({ ref: 'knowledge:p-1', markdown: '[知识卡：缓存策略](knowledge:p-1)' });
  });

  it('link：token / markdown / plain 三形态', async () => {
    for (const [format, expected] of [['token', 'knowledge:p-1'], ['markdown', '[知识卡：缓存策略](knowledge:p-1)'], ['plain', '知识卡《缓存策略》 knowledge:p-1 · rev:3']] as const) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(resolved))));
      const stream = io();
      expect(await main(['node', 'kb', 'knowledge', 'link', 'p-1', '--scope', 'common', '--format', format], stream)).toBe(0);
      expect(stream.out.join('').trim()).toBe(expected);
    }
  });

  it('resolve 404 → exit 1；409 歧义 → exit 2（沿用既有约定）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'KNOWLEDGE_NOT_FOUND', message: '知识页不存在' } }), { status: 404 })));
    const notFound = io();
    expect(await main(['node', 'kb', 'knowledge', 'resolve', 'nope', '--scope', 'common'], notFound)).toBe(1);
    expect(notFound.err.join('')).toContain('知识页不存在');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'KNOWLEDGE_REF_AMBIGUOUS', message: 'slug「dup」命中 2 页' } }), { status: 409 })));
    const ambiguous = io();
    expect(await main(['node', 'kb', 'knowledge', 'resolve', 'dup', '--scope', 'common'], ambiguous)).toBe(2);
    expect(ambiguous.err.join('')).toContain('命中 2 页');
  });
});

/**
 * KB-PAGE-2b：show 省略 --scope（内部 resolve）/ find-source / create-revise 文本 link。
 */
describe('knowledge CLI：show 省略 scope / find-source / create-revise link（KB-PAGE-2b）', () => {
  const ws = { id: 'w1', name: '项目', path: process.cwd(), created_at: 1 };
  const resolved = {
    state: 'resolved', id: 'p-ws', title: '工作区页', scope: 'workspace', workspace_id: 'w1', status: 'active', revision: 2,
    link: { id: 'p-ws', scope: 'workspace', workspace_id: 'w1', slug: 'ws-page', ref: 'knowledge:p-ws', markdown: '[工作区页](knowledge:p-ws)' },
  };
  const pageWs = { id: 'p-ws', scope: 'workspace', workspace_id: 'w1', revision: 2, title: '工作区页', body_md: '正文', link: { ref: 'knowledge:p-ws' } };

  it('show 省略 --scope：先 resolve（both + 当前工作区）再按解析结果取页', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/api/workspaces')) return new Response(JSON.stringify([ws]));
      if (String(url).includes('/api/knowledge/resolve')) return new Response(JSON.stringify(resolved));
      return new Response(JSON.stringify(pageWs));
    });
    vi.stubGlobal('fetch', fetch); const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'show', 'p-ws'], stream)).toBe(0);
    const urls = fetch.mock.calls.map(call => String(call[0]));
    const resolveUrl = urls.find(url => url.includes('/api/knowledge/resolve'));
    expect(resolveUrl).toBeDefined();
    expect(resolveUrl).toContain('workspace_id=w1');
    expect(resolveUrl).toContain('scope=both');
    expect(urls.at(-1)).toContain('/api/knowledge/pages/p-ws');
    expect(urls.at(-1)).toContain('workspace_id=w1');
    expect(stream.out.join('')).toContain('link: knowledge:p-ws');
  });

  it('show 显式 --scope：行为与旧版一致，不发 resolve 请求', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(pageWs)));
    vi.stubGlobal('fetch', fetch); const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'show', 'p-ws', '--scope', 'common'], stream)).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toBe('http://127.0.0.1:8787/api/knowledge/pages/p-ws?scope=common');
  });

  it('show 省略 --scope 且 resolve 409：exit 2（不猜第一条）', async () => {
    const fetch = vi.fn(async (url: string) => String(url).includes('/api/workspaces')
      ? new Response(JSON.stringify([ws]))
      : new Response(JSON.stringify({ error: { code: 'KNOWLEDGE_REF_AMBIGUOUS', message: '命中 2 页' } }), { status: 409 }));
    vi.stubGlobal('fetch', fetch); const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'show', 'dup'], stream)).toBe(2);
    expect(stream.err.join('')).toContain('命中 2 页');
  });

  it('create 文本输出在标题后补 link 行', async () => {
    const created = { ...pageWs, link: { ref: 'knowledge:p-ws' } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(created)))); const stream = io('正文');
    const code = await main(['node', 'kb', 'knowledge', 'create', '--scope', 'common', '--slug', 's', '--title', '标题', '--stdin', '--sources', JSON.stringify([{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: 'a'.repeat(64) }]), '--evidence', JSON.stringify([{ source_id: 'file:README.md', locator: 'file:1-20' }])], stream);
    expect(code).toBe(0);
    expect(stream.out.join('')).toContain('link: knowledge:p-ws');
  });

  it('find-source：每页一行 id/scope/revision/slug + link，path 走查询参数', async () => {
    const res = { path: 'Docs/api.md', items: [{ id: 'p-1', slug: 'api-doc', title: 'API 文档', scope: 'common', revision: 3, status: 'active', link: { ref: 'knowledge:p-1' } }] };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(res))); vi.stubGlobal('fetch', fetch); const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'find-source', 'Docs/api.md', '--scope', 'common'], stream)).toBe(0);
    expect(String(fetch.mock.calls[0]![0])).toContain('/api/knowledge/find-source?');
    expect(stream.out.join('')).toContain('p-1 [common] rev:3 api-doc');
    expect(stream.out.join('')).toContain('link: knowledge:p-1');
  });

  // KB-CLI-3a（CLI-06/L-04）：--history 文本模式逐条 rev 行，不再倒整包 JSON
  it('show --history：详情后逐条 rev 行（每页 1 行），--json 仍整包', async () => {
    const detail = { id: 'p-h', scope: 'common', revision: 3, title: '历史页', body_md: '正文', category: 'design', landed: 'landed', domain: 'board', link: 'knowledge:p-h' };
    const revisions = { items: [
      { revision: 3, title_snapshot: '历史页', change_kind: 'edit', actor: 'agent:t', created_at: Date.UTC(2026, 10, 6, 1, 2, 3) },
      { revision: 2, title_snapshot: '历史页（旧）', change_kind: 'create', actor: 'agent:t', created_at: Date.UTC(2026, 10, 5, 0, 0, 0) },
    ] };
    const fetch = vi.fn(async (url: string) => String(url).includes('/revisions')
      ? new Response(JSON.stringify(revisions))
      : new Response(JSON.stringify(detail)));
    vi.stubGlobal('fetch', fetch); const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'show', 'p-h', '--scope', 'common', '--history'], stream)).toBe(0);
    const out = stream.out.join('');
    expect(out).toContain('p-h [common] rev:3 历史页');
    expect(out).toContain('rev:3  edit  agent:t  2026-11-06T01:02:03.000Z  历史页');
    expect(out).toContain('rev:2  create  agent:t  2026-11-05T00:00:00.000Z  历史页（旧）');
    expect(out).not.toContain('"history"');

    const json = io();
    expect(await main(['node', 'kb', '--json', 'knowledge', 'show', 'p-h', '--scope', 'common', '--history'], json)).toBe(0);
    const parsed = JSON.parse(json.out.join('')) as { page: { id: string }; history: { items: unknown[] } };
    expect(parsed.page.id).toBe('p-h');
    expect(parsed.history.items).toHaveLength(2);
  });

  // KB-CLI-3a（CLI-10）：snippet 截 120 字，多命中一屏可读
  it('search snippet 超 120 字截断为单行省略；5 条命中各占 2 行内', async () => {
    const longSnippet = '长'.repeat(200);
    const rows = Array.from({ length: 5 }, (_, i) => ({ page_id: `s-${i}`, scope: 'common', workspace_id: null, revision: 1, title: `命中 ${i}`, snippet: longSnippet, score: 1, link: `knowledge:s-${i}` }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(rows)))); const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'search', '长', '--scope', 'common'], stream)).toBe(0);
    const out = stream.out.join('');
    expect(out).toContain(`${'长'.repeat(120)}…`);
    expect(out).not.toContain('长'.repeat(121));
    // 每条命中 = 标题行 + snippet 行（snippet 截断后单行）
    const lines = out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(10);
  });
});

describe('KB-CREATE-ERGO：JSON 文件 BOM、--hash-from-file、domain/scope 说明', () => {
  const BOM = '\ufeff';
  const sourceRow = { source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1763000000000, content_hash: 'b'.repeat(64) };

  it('--sources-file / --evidence-file 带 UTF-8 BOM 仍能创建，stderr 提示已剥离', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-ergo-'));
    const sources = join(dir, 'sources.json');
    const evidence = join(dir, 'evidence.json');
    writeFileSync(sources, `${BOM}${JSON.stringify([{ ...sourceRow, content_hash: 'a'.repeat(64) }])}`, 'utf8');
    writeFileSync(evidence, `${BOM}${JSON.stringify([{ source_id: 'file:README.md', locator: 'README.md:1-20' }])}`, 'utf8');
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(page))); vi.stubGlobal('fetch', fetch); const stream = io('正文');
    const code = await main(['node', 'kb', 'knowledge', 'create', '--scope', 'common', '--slug', 's', '--title', 't', '--stdin', '--sources-file', sources, '--evidence-file', evidence], stream);
    expect(code).toBe(0);
    expect(stream.err.join('')).toContain('检测到 UTF-8 BOM，已剥离');
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(body.sources[0].content_hash).toBe('a'.repeat(64));
    expect(body.evidence[0].locator).toBe('README.md:1-20');
    rmSync(dir, { recursive: true, force: true });
  });

  it('--hash-from-file 按 source_id 回填文件 sha256（脚本计算值比对）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-ergo-'));
    const target = join(dir, 'README.md');
    writeFileSync(target, 'hello 知识\n', 'utf8');
    const sources = join(dir, 'sources.json');
    // 故意不写 content_hash：回填发生在校验之前
    writeFileSync(sources, JSON.stringify([{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1763000000000 }]), 'utf8');
    const evidence = join(dir, 'evidence.json');
    writeFileSync(evidence, JSON.stringify([{ source_id: 'file:README.md', locator: 'README.md:1-20' }]), 'utf8');
    const expected = createHash('sha256').update(readFileSync(target)).digest('hex');
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(page))); vi.stubGlobal('fetch', fetch); const stream = io('正文');
    const code = await main(['node', 'kb', 'knowledge', 'create', '--scope', 'common', '--slug', 's', '--title', 't', '--stdin', '--sources-file', sources, '--evidence-file', evidence, '--hash-from-file', `file:README.md=${target}`], stream);
    expect(code).toBe(0);
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(body.sources[0].content_hash).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('--hash-from-file 未匹配 source_id：exit 1 并点名，不发请求', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const stream = io();
    const code = await main(['node', 'kb', 'knowledge', 'create', '--scope', 'common', '--slug', 's', '--title', 't', '--stdin',
      '--sources', JSON.stringify([sourceRow]),
      '--evidence', JSON.stringify([{ source_id: 'file:README.md', locator: 'README.md:1-20' }]),
      '--hash-from-file', 'file:missing.md=README.md'], stream);
    expect(code).toBe(1);
    expect(stream.err.join('')).toContain('未匹配到 source_id：「file:missing.md」');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('--hash-from-file 文件不存在：exit 1 并点名路径', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const stream = io();
    const missing = join(tmpdir(), 'kb-ergo-not-exist.md');
    const code = await main(['node', 'kb', 'knowledge', 'create', '--scope', 'common', '--slug', 's', '--title', 't', '--stdin',
      '--sources', JSON.stringify([sourceRow]),
      '--evidence', JSON.stringify([{ source_id: 'file:README.md', locator: 'README.md:1-20' }]),
      '--hash-from-file', `file:README.md=${missing}`], stream);
    expect(code).toBe(1);
    expect(stream.err.join('')).toContain(missing);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('create --help 讲清 domain 与 scope 是两个维度并给示例', async () => {
    const stream = io();
    const code = await main(['node', 'kb', 'knowledge', 'create', '--help'], stream);
    expect(code).toBe(0);
    const text = stream.out.join('');
    expect(text).toContain('--domain 与 --scope 是两个正交维度');
    expect(text).toContain('知识领域：accounts | knowledge | board | chat | ui | infra');
    expect(text).toContain('页归属范围：workspace');
    expect(text).toContain('--scope common --domain infra');
    expect(text).toContain('--hash-from-file');
  });
});
