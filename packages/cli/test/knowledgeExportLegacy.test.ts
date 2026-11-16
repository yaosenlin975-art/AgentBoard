/**
 * P2-05：`kb knowledge export-legacy` 的 CLI 侧用例（P2-02 收口补测）。
 *
 * 覆盖：dry-run 预览输出（不写入声明）、实跑输出（源库分布/目标统计/manifest）、
 * 冲突清单走 stderr 且退出码 2、--scope 非法值本地拦截不发请求、
 * --scope workspace 缺 --workspace 拦截、--workspace 误配 all 拦截、--help 关键口径。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

function io(): { out: string[]; err: string[]; write: (s: string) => void; writeErr: (s: string) => void } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, write: (s) => out.push(s), writeErr: (s) => err.push(s) };
}

const baseReport = {
  dry_run: false,
  scope: 'all',
  workspace_id: null,
  sources: [{ source_db: 'center', path: 'C:/appdata/AgentBoard/agentboard.db', pages: 2 }],
  targets: [{ dir: 'C:/docs', create: 1, unchanged: 1, conflicts: 0, skipped: 0 }],
  pages: [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'cache-policy', title: '缓存策略', scope: 'common', workspace_id: null, status: 'active', revision: 2, source_db: 'center', target_dir: 'C:/docs', file: 'cache-policy.md', action: 'create' },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', slug: 'old-note', title: '旧笔记', scope: 'common', workspace_id: null, status: 'active', revision: 1, source_db: 'center', target_dir: 'C:/docs', file: 'old-note.md', action: 'skip-unchanged' },
  ],
  conflicts: [],
  manifests: [{ dir: 'C:/docs', file: '.export-manifest.json', files: 2, written: true }],
  summary: { total: 2, create: 1, unchanged: 1, conflicts: 0, skipped: 0 },
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('kb knowledge export-legacy：输出形态', () => {
  it('dry-run：POST dry_run=true，输出「未写入任何文件」与清单', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...baseReport, dry_run: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'export-legacy', '--dry-run'], stream)).toBe(0);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toContain('/api/knowledge/export-legacy');
    expect(JSON.parse(init.body)).toMatchObject({ scope: 'all', dry_run: true });
    const text = stream.out.join('');
    expect(text).toContain('dry-run 预览，未写入任何文件');
    expect(text).toContain('cache-policy.md');
    expect(text).toContain('已一致');
  });

  it('实跑：源库分布 / 目标统计 / manifest 落盘声明', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(baseReport), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'export-legacy'], stream)).toBe(0);
    expect(JSON.parse(String((fetch.mock.calls[0]![1] as { body: string }).body)).dry_run).toBe(false);
    const text = stream.out.join('');
    expect(text).toContain('已写入');
    expect(text).toContain('agentboard.db：2 行');
    expect(text).toContain('新增 1 / 已一致 1');
    expect(text).toContain('.export-manifest.json');
  });

  it('409 KNOWLEDGE_EXPORT_CONFLICT：stderr 列冲突清单（含页 id 与备份路径），退出码 2', async () => {
    const conflicts = [{ dir: 'C:/docs', file: 'cache-policy.md', page_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', source_db: 'center', existing_sha256: 'e3b0c44298fc1c149afbf4c8996fb924', incoming_sha256: 'ca3d2ff0d1e0f8a24f8ba3f4a2c2b7d1', backup_path: 'C:/docs/.export-backup/2026-11-15/' }];
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'KNOWLEDGE_EXPORT_CONFLICT', message: '导出冲突，已整体暂停', details: { conflicts } } }), { status: 409 }));
    vi.stubGlobal('fetch', fetch);
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'export-legacy'], stream)).toBe(2);
    expect(stream.err.join('')).toContain('cache-policy.md');
    expect(stream.err.join('')).toContain('aaaaaaaa-aaaa');
    expect(stream.err.join('')).toContain('.export-backup');
  });
});

describe('kb knowledge export-legacy：参数守卫', () => {
  it('--scope 非法值 → 本地报错退出码 1，不发请求', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'export-legacy', '--scope', 'bogus'], stream)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('--scope workspace 缺 --workspace → 本地报错退出码 1', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'export-legacy', '--scope', 'workspace'], stream)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(stream.err.join('')).toContain('--workspace');
  });

  it('--workspace 配 all/center → 本地报错退出码 1（all/center 源库由服务端 fan-out）', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'export-legacy', '--workspace', 'e41eb0fb'], stream)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('kb knowledge export-legacy --help', () => {
  it('写清 fan-out、manifest、幂等与冲突不静默覆盖四点口径', async () => {
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'export-legacy', '--help'], stream)).toBe(0);
    const text = stream.out.join('');
    expect(text).toContain('fan-out');
    expect(text).toContain('manifest');
    expect(text).toContain('幂等');
    expect(text).toContain('静默覆盖');
  });
});
