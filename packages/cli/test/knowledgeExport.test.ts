/** P2-02 export-legacy CLI：参数校验、dry-run 文本清单、409 冲突退出码 2、--json 透传。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

afterEach(() => vi.unstubAllGlobals());

function io(stdin = ''): { out: string[]; err: string[]; write: (s: string) => void; writeErr: (s: string) => void; readStdin: () => Promise<string> } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, write: (s: string) => out.push(s), writeErr: (s: string) => err.push(s), readStdin: async () => stdin };
}

const report = {
  format: 'agentboard.knowledge-export/1',
  dry_run: true,
  scope: 'all',
  workspace_id: null,
  exported_at: '2026-11-15T00:00:00.000Z',
  sources: [
    { source_db: 'workspace#1', path: 'D:/tmp/ws2/.agentboard/agentboard.db', pages: 1 },
    { source_db: 'center', path: 'D:/tmp/center.db', pages: 2 },
  ],
  targets: [
    { dir: 'D:/tmp/home/.agentboard/Docs', create: 1, unchanged: 0, conflicts: 0, skipped: 1 },
    { dir: 'D:/tmp/ws2/.agentboard/Docs', create: 1, unchanged: 0, conflicts: 0, skipped: 0 },
  ],
  pages: [
    { id: '11111111-0000-4000-8000-000000000001', slug: 'common-a', title: '公共页A', scope: 'common', workspace_id: null, status: 'active', revision: 1, source_db: 'center', target_dir: 'D:/tmp/home/.agentboard/Docs', file: 'common-a.md', action: 'create' },
    { id: '11111111-0000-4000-8000-000000000002', slug: 'gone', title: '软删页', scope: 'common', workspace_id: null, status: 'deleted', revision: 2, source_db: 'center', target_dir: '', file: '', action: 'skip-deleted', reason: '软删页不落盘（撤文件语义，N5）；旧行保留不动' },
    { id: '22222222-0000-4000-8000-000000000003', slug: 'w2-page', title: 'W2区页', scope: 'workspace', workspace_id: '22222222-0000-4000-8000-00000000w2id', status: 'active', revision: 3, source_db: 'workspace#1', target_dir: 'D:/tmp/ws2/.agentboard/Docs', file: 'w2-page.md', action: 'create' },
  ],
  conflicts: [],
  manifests: [],
  summary: { total: 3, create: 2, unchanged: 0, conflicts: 0, skipped: 1 },
};

describe('kb knowledge export-legacy（P2-02）', () => {
  it('参数校验：--scope workspace 缺 --workspace、非法 scope、--workspace 误用都本地拒绝（不发请求）', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const a = io();
    expect(await main(['node', 'kb', 'knowledge', 'export-legacy', '--scope', 'workspace'], a)).toBe(1);
    expect(a.err.join('')).toContain('--scope workspace 必须配 --workspace');
    const b = io();
    expect(await main(['node', 'kb', 'knowledge', 'export-legacy', '--scope', 'bogus'], b)).toBe(1);
    expect(b.err.join('')).toContain('--scope 只能是 all | center | workspace');
    const c = io();
    expect(await main(['node', 'kb', 'knowledge', 'export-legacy', '--workspace', 'x'], c)).toBe(1);
    expect(c.err.join('')).toContain('--workspace 只在 --scope workspace 时接受');
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
  });

  it('dry-run 文本：待导出清单 + 源库分布 + 目标分布，末行是汇总', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(report)));
    vi.stubGlobal('fetch', fetch);
    const stream = io();
    const code = await main(['node', 'kb', 'knowledge', 'export-legacy', '--dry-run'], stream);
    expect(code).toBe(0);
    const text = stream.out.join('');
    expect(text).toContain('源库分布：');
    expect(text).toContain('workspace#1');
    expect(text).toContain('center');
    expect(text).toContain('：2 行');
    expect(text).toContain('待导出清单：');
    expect(text).toContain('11111111 [common] rev:1 common-a');
    expect(text).toContain('common-a.md');
    expect(text).toContain('（软删跳过：软删页不落盘');
    expect(text).toContain('（dry-run 预览，未写入任何文件）');
    const last = text.trimEnd().split('\n').pop()!;
    expect(last).toContain('行集 3 页');
    expect(last).toContain('新增 2');
    expect(last).toContain('跳过 1');
    // 请求体：dry_run + 缺省 scope=all
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(body).toEqual({ scope: 'all', dry_run: true });
  });

  it('--json 透传服务端报告；--to 解析为绝对路径随请求体发送', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(report)));
    vi.stubGlobal('fetch', fetch);
    const stream = io();
    expect(await main(['node', 'kb', '--json', 'knowledge', 'export-legacy', '--to', 'D:/tmp/staging'], stream)).toBe(0);
    const parsed = JSON.parse(stream.out.join(''));
    expect(parsed.summary).toEqual(report.summary);
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(body.to).toBe('D:\\tmp\\staging');
  });

  it('409 冲突：退出码 2，stderr 列冲突文件与备份路径，且报告汇总也照常输出', async () => {
    const conflicted = {
      ...report,
      dry_run: false,
      conflicts: [{ dir: 'D:/tmp/home/.agentboard/Docs', file: 'common-a.md', page_id: '11111111-0000-4000-8000-000000000001', source_db: 'center', existing_sha256: 'a'.repeat(64), incoming_sha256: 'b'.repeat(64), backup_path: 'D:/tmp/home/.agentboard/Docs/.export-backup/20261115-000000/common-a.md' }],
      summary: { total: 3, create: 0, unchanged: 0, conflicts: 1, skipped: 1 },
      pages: [report.pages[0]!, { ...report.pages[0]!, action: 'conflict', reason: '目标文件已存在且内容不同（不静默覆盖，暂停导出）' }],
      targets: [{ dir: 'D:/tmp/home/.agentboard/Docs', create: 0, unchanged: 0, conflicts: 1, skipped: 1 }],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(conflicted))));
    const stream = io();
    const code = await main(['node', 'kb', 'knowledge', 'export-legacy'], stream);
    expect(code).toBe(2);
    expect(stream.err.join('')).toContain('1 个冲突');
    expect(stream.err.join('')).toContain('common-a.md');
    expect(stream.err.join('')).toContain('.export-backup');
  });

  it('409 冲突（服务端拒绝）：CliHttpError 路径同样退出码 2 并透出 details.conflicts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'KNOWLEDGE_EXPORT_CONFLICT', message: 'export-legacy 检测到 1 个目标文件冲突（已备份，未写入任何文件）', details: { conflicts: [{ dir: 'D:/d', file: 'x.md', page_id: 'p1', source_db: 'center', existing_sha256: 'a'.repeat(64), incoming_sha256: 'b'.repeat(64), backup_path: 'D:/d/.export-backup/20261115-000000/x.md' }] } },
    }), { status: 409 })));
    const stream = io();
    const code = await main(['node', 'kb', 'knowledge', 'export-legacy'], stream);
    expect(code).toBe(2);
    expect(stream.err.join('')).toContain('检测到 1 个目标文件冲突');
    expect(stream.err.join('')).toContain('x.md');
    expect(stream.err.join('')).toContain('已备份');
  });

  it('其它服务端错误：退出码 1', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: '参数不合法' } }), { status: 400 })));
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'export-legacy', '--scope', 'workspace', '--workspace', 'ws'], stream)).toBe(1);
    expect(stream.err.join('')).toContain('参数不合法');
  });
});
