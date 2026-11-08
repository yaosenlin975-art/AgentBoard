/**
 * KB-CLI-IMPORT：`kb knowledge import <file>` 的 CLI 侧用例。
 *
 * 覆盖：md/txt/json 三种格式的推断与请求体、json 数组多页输出、409 冲突退出码 2、
 * 本地超限（>10MB / >200 万字符）拦截且**不发请求**、`--format` 覆盖、`--help` 三项口径。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

function io(): { out: string[]; err: string[]; write: (s: string) => void; writeErr: (s: string) => void } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, write: (s) => out.push(s), writeErr: (s) => err.push(s) };
}

let dir: string;
const fileOf = (name: string, content: string): string => {
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
};

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kb-cli-import-')); });
afterEach(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

describe('kb knowledge import：格式与请求体', () => {
  it('md：自动推断 format=md，filename 传绝对路径（sources 由服务端构造）', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ pages: [{ id: 'p1', scope: 'common', slug: 'md-slug', body_md: '# 标题\n正文', revision: 1 }] })));
    vi.stubGlobal('fetch', fetch);
    const path = fileOf('a.md', '# 标题\n正文');
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'import', path, '--scope', 'common'], stream)).toBe(0);
    const body = JSON.parse(String((fetch.mock.calls[0]![1] as { body: string }).body));
    expect(body).toMatchObject({ format: 'md', scope: 'common', filename: path });
    expect(String(stream.out.join(''))).toContain('p1');
    expect(String(stream.out.join(''))).toContain('md-slug');
  });

  it('txt：format=txt；--format 可覆盖扩展名推断', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ pages: [{ id: 'p2', scope: 'common', slug: 'txt-slug', body_md: '纯文本', revision: 1 }] })));
    vi.stubGlobal('fetch', fetch);
    const path = fileOf('a.txt', '纯文本');
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'import', path, '--scope', 'common'], stream)).toBe(0);
    expect(JSON.parse(String((fetch.mock.calls[0]![1] as { body: string }).body)).format).toBe('txt');

    const fetch2 = vi.fn().mockResolvedValue(new Response(JSON.stringify({ pages: [{ id: 'p3', scope: 'common', slug: 's', body_md: 'x', revision: 1 }] })));
    vi.stubGlobal('fetch', fetch2);
    const stream2 = io();
    expect(await main(['node', 'kb', 'knowledge', 'import', path, '--scope', 'common', '--format', 'md'], stream2)).toBe(0);
    expect(JSON.parse(String((fetch2.mock.calls[0]![1] as { body: string }).body)).format).toBe('md');
  });

  it('json 数组：多页逐行输出（id/slug/字符数），并透传 category/landed/labels', async () => {
    const pages = [
      { id: 'p4', scope: 'common', slug: 'arr-a', body_md: 'aaa', revision: 1 },
      { id: 'p5', scope: 'common', slug: 'arr-b', body_md: 'bb', revision: 1 },
    ];
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ pages })));
    vi.stubGlobal('fetch', fetch);
    const path = fileOf('a.json', JSON.stringify([{ title: 'A', body_md: 'aaa' }, { title: 'B', body_md: 'bb' }]));
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'import', path, '--scope', 'common', '--category', 'design', '--landed', 'proposed', '--labels', '缓存,导入'], stream)).toBe(0);
    const body = JSON.parse(String((fetch.mock.calls[0]![1] as { body: string }).body));
    expect(body).toMatchObject({ format: 'json', category: 'design', landed: 'proposed', labels: ['缓存', '导入'] });
    const text = stream.out.join('');
    expect(text).toContain('p4');
    expect(text).toContain('p5');
    expect(text.split('\n').filter((line) => line.includes('[common]')).length).toBe(2);
  });
});

describe('kb knowledge import：错误态', () => {
  it('409 KNOWLEDGE_EXISTS → 退出码 2，文案给改标题/改 slug 的处置', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'KNOWLEDGE_EXISTS', message: '范围内已存在 slug「x」' } }), { status: 409 })));
    const path = fileOf('c.md', '# x\n正文');
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'import', path, '--scope', 'common'], stream)).toBe(2);
    expect(stream.err.join('')).toContain('slug');
  });

  it('本地超限（>10MB）直接拦，不发请求', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const path = join(dir, 'big.md');
    writeFileSync(path, Buffer.alloc(11 * 1024 * 1024, 0x61));
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'import', path, '--scope', 'common'], stream)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(stream.err.join('')).toContain('文件过大');
  });

  it('不支持的扩展名 → 退出码 1，提示用 --format 或换扩展名', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const path = fileOf('a.pdf', 'x');
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'import', path, '--scope', 'common'], stream)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(stream.err.join('')).toContain('--format');
  });
});

describe('KB-SNAP-IMPORT（方案 3）：导入不落快照的显式信号', () => {
  const payload = {
    pages: [{ id: 'p9', scope: 'common', slug: 's9', body_md: 'x', revision: 1 }],
    page_commit: { path: '', relative_path: '', committed: false, commit: null, reason: '批量导入不落每页快照（BORROW-5.1 一次提交只含该页路径）', skipped: true },
  };

  it('文本模式：stderr 一行可见提示（不落快照），退出码 0（skipped=true 不是失败）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));
    const path = fileOf('a.md', '# 标题');
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'import', path, '--scope', 'common'], stream)).toBe(0);
    const err = String(stream.err.join(''));
    expect(err).toContain('批量导入不落每页快照');
    expect(err.split('\n').filter((line) => line.trim() !== '')).toHaveLength(1);
  });

  it('--json：page_commit 进 stdout 机器可读，stderr 不加提示', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));
    const path = fileOf('b.md', '# 标题');
    const stream = io();
    expect(await main(['node', 'kb', '--json', 'knowledge', 'import', path, '--scope', 'common'], stream)).toBe(0);
    const parsed = JSON.parse(String(stream.out.join('')));
    expect(parsed.page_commit).toMatchObject({ committed: false, skipped: true });
    expect(String(stream.err.join(''))).toBe('');
  });
});

describe('kb knowledge import --help', () => {
  it('写清三件事：支持格式、上限、slug 冲突处置', async () => {
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'import', '--help'], stream)).toBe(0);
    const text = stream.out.join('');
    expect(text).toContain('支持格式');
    expect(text).toContain('10 MB');
    expect(text).toContain('200 万字符');
    expect(text).toContain('slug 冲突');
    expect(text).toContain('KNOWLEDGE_EXISTS');
  });
});
describe('IMPORT-BOM（N-02）：导入前剥离 UTF-8 BOM', () => {
  it('带 BOM 的 md：请求体 content 不以 \\uFEFF 开头，标题行仍是首行', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ pages: [{ id: 'p-bom', scope: 'common', slug: 'bom-md', body_md: '# 标题\n正文', revision: 1 }] })));
    vi.stubGlobal('fetch', fetch);
    const path = join(dir, 'bom.md');
    writeFileSync(path, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('# 标题\n正文', 'utf8')]));
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'import', path, '--scope', 'common'], stream)).toBe(0);
    const body = JSON.parse(String((fetch.mock.calls[0]![1] as { body: string }).body));
    expect(body.content.startsWith('\uFEFF')).toBe(false);
    expect(body.content.split('\n')[0]).toBe('# 标题');
  });

  it('带 BOM 的 json：能正常 parse（content 首字符不是 U+FEFF）', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ pages: [{ id: 'p-bom-json', scope: 'common', slug: 'bom-json', body_md: 'x', revision: 1 }] })));
    vi.stubGlobal('fetch', fetch);
    const path = join(dir, 'bom.json');
    writeFileSync(path, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(JSON.stringify([{ title: 'BOM 数组', body_md: '正文' }]), 'utf8')]));
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'import', path, '--scope', 'common'], stream)).toBe(0);
    const body = JSON.parse(String((fetch.mock.calls[0]![1] as { body: string }).body));
    expect(body.content.charCodeAt(0)).not.toBe(0xfeff);
    expect(() => JSON.parse(body.content)).not.toThrow();
  });
});