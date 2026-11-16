/**
 * P2-05：`kb knowledge rename` 的 CLI 侧用例（P2-04 M10 收口补测）。
 *
 * 覆盖：成功路径（POST /rename 请求体 + 全库重写清单输出）、409 冲突退出码 2、
 * 403 退出码 2、非冲突错误退出码 1、--help 关键口径（id 不变 / reconcile 提示）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

function io(): { out: string[]; err: string[]; write: (s: string) => void; writeErr: (s: string) => void } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, write: (s) => out.push(s), writeErr: (s) => err.push(s) };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('kb knowledge rename：成功路径', () => {
  it('POST /pages/:id/rename 带 expected_revision/new_slug/actor；文本输出 old_slug 与重写清单', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: '11111111-1111-4111-8111-111111111111', slug: 'cache-policy-v2', old_slug: 'cache-policy',
      scope: 'common', revision: 4, title: '缓存策略', link: '[[cache-policy-v2]]',
      rewritten: [
        { dir: 'C:/docs', file_name: 'other.md', page_id: '22222222-2222-4222-8222-222222222222', slug: 'other' },
      ],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'rename', '11111111-1111-4111-8111-111111111111', 'cache-policy-v2', '--scope', 'common', '--expected-revision', '3'], stream)).toBe(0);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toContain('/api/knowledge/pages/11111111-1111-4111-8111-111111111111/rename');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({ expected_revision: 3, new_slug: 'cache-policy-v2', scope: 'common' });
    const text = stream.out.join('');
    expect(text).toContain('cache-policy-v2');
    expect(text).toContain('原 slug：cache-policy');
    expect(text).toContain('已重写 1 个文件');
    expect(text).toContain('other.md');
  });

  it('rewritten 为空时明确输出「未改写任何文件」', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: '11111111-1111-4111-8111-111111111111', slug: 'solo-v2', old_slug: 'solo',
      scope: 'common', revision: 2, title: '孤立页', link: '[[solo-v2]]', rewritten: [],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'rename', '11111111-1111-4111-8111-111111111111', 'solo-v2', '--scope', 'common', '--expected-revision', '1'], stream)).toBe(0);
    expect(stream.out.join('')).toContain('未改写任何文件');
  });

  it('--json 输出原始报告', async () => {
    const report = { id: 'p1', slug: 'v2', old_slug: 'v1', scope: 'common', revision: 2, title: 't', link: '[[v2]]', rewritten: [] };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(report), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'rename', 'p1', 'v2', '--scope', 'common', '--expected-revision', '1', '--json'], stream)).toBe(0);
    expect(JSON.parse(stream.out.join(''))).toEqual(report);
  });
});

describe('kb knowledge rename：错误态', () => {
  it('409（revision 冲突 / slug 冲突 / 文件冲突）→ 退出码 2', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'KNOWLEDGE_FILE_CONFLICT', message: '外部编辑冲突' } }), { status: 409 }));
    vi.stubGlobal('fetch', fetch);
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'rename', 'p1', 'v2', '--scope', 'common', '--expected-revision', '1'], stream)).toBe(2);
    expect(stream.err.join('')).toContain('外部编辑冲突');
  });

  it('403 跨范围 → 退出码 2；404 → 退出码 1', async () => {
    const stream403 = io();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'KNOWLEDGE_SCOPE_FORBIDDEN', message: '跨范围' } }), { status: 403 })));
    expect(await main(['node', 'kb', 'knowledge', 'rename', 'p1', 'v2', '--scope', 'common', '--expected-revision', '1'], stream403)).toBe(2);

    const stream404 = io();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'KNOWLEDGE_NOT_FOUND', message: '不存在' } }), { status: 404 })));
    expect(await main(['node', 'kb', 'knowledge', 'rename', 'p1', 'v2', '--scope', 'common', '--expected-revision', '1'], stream404)).toBe(1);
  });

  it('缺 --expected-revision → 本地报错退出码 1', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'rename', 'p1', 'v2', '--scope', 'common'], stream)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('kb knowledge rename --help', () => {
  it('写清三件事：全库重写形态、id 不变、reconcile 兜底', async () => {
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'rename', '--help'], stream)).toBe(0);
    const text = stream.out.join('');
    expect(text).toContain('[[old]]→[[new]]');
    expect(text).toContain('id 不变');
    expect(text).toContain('reconcile');
  });
});
