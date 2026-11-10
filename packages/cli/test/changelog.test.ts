import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

/**
 * LOG02：`kb changelog` 命令层。
 * 全部走 HTTP（LOG01 活动/归档端点 + LOG02 新增的导入端点），测试用 stub fetch 断言方法/路径/body/退出码。
 */

const WS = { id: 'w1', name: '项目', path: 'D:/project', created_at: 1 };
const RECORD = {
  id: 'log-1',
  workspace_id: 'w1',
  origin_workspace_id: 'w1',
  origin_workspace_name: '项目',
  origin_workspace_path: 'D:/project',
  title: '缓存失效修复',
  body_md: '正文内容',
  change_type: '修复',
  occurred_at: 1793000000000,
  created_by: 'user',
  updated_by: 'user',
  created_at: 1793000000000,
  updated_at: 1793000000000,
  revision: 1,
  legacy_source_key: null,
};

const PREVIEW = {
  workspace_id: 'w1',
  source_path: 'D:/project/Docs/CHANGELOG.md',
  source_sha256: 'a'.repeat(64),
  entry_count: 2,
  parsed: [],
  unparsable: [],
  added: [
    { source_key: 'k1', occurred_at: 1793000000000, title: '历史一', body_md: '正文' },
    { source_key: 'k2', occurred_at: 1792900000000, title: '历史二', body_md: '正文' },
  ],
  already_imported: [],
  conflicting: [],
};

interface Stub { status?: number; body?: unknown }
interface Call { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }

let calls: Call[];

function stubFetch(queue: Stub[]): void {
  calls = [];
  const remaining = [...queue];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: Call['init']) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = remaining.shift();
      if (!next) throw new Error(`未预期请求: ${url}`);
      const text = next.body === undefined ? '' : JSON.stringify(next.body);
      return new Response(next.status === 204 ? null : text, { status: next.status ?? 200 });
    }),
  );
}

function io(stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, write: (line: string) => out.push(line), writeErr: (line: string) => err.push(line), readStdin: async () => stdin };
}

const withWorkspaces = (rest: Stub[]): Stub[] => [{ body: [WS] }, ...rest];

beforeEach(() => {
  process.env.KB_AGENT = 'codex-test';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.KB_AGENT;
});

describe('kb changelog help 与 create 回归（卡 881f3824）', () => {
  it('help 冒烟：changelog 与 create 的 --help 退 0 且含可复制示例（含 PowerShell）', async () => {
    const stream = io();
    expect(await main(['node', 'kb', 'changelog', '--help'], stream)).toBe(0);
    expect(stream.out.join('')).toContain('示例（Git Bash）');
    expect(stream.out.join('')).toContain('PowerShell');

    const stream2 = io();
    expect(await main(['node', 'kb', 'changelog', 'create', '--help'], stream2)).toBe(0);
    expect(stream2.out.join('')).toContain('Get-Content body.md');
    expect(stream2.out.join('')).toContain('--request-id');
  });

  it('create 成功路径回归：stdin 正文 + actor + 幂等键全链可用（修复前 dist 抛 ReferenceError）', async () => {
    stubFetch(withWorkspaces([{ body: RECORD }]));
    const stream = io('正文内容');
    const code = await main(
      ['node', 'kb', 'changelog', 'create', '--workspace', 'w1', '--title', '标题', '--type', '修复', '--stdin', '--request-id', 'uuid-1'],
      stream,
    );
    expect(code).toBe(0);
    expect(calls[1]!.init.method).toBe('POST');
    expect(calls[1]!.url).toContain('/api/workspaces/w1/changelog');
    const body = JSON.parse(calls[1]!.init.body as string);
    expect(body).toMatchObject({ title: '标题', change_type: '修复', body_md: '正文内容', actor: 'codex-test' });
    expect(calls[1]!.init.headers?.['Idempotency-Key']).toBe('uuid-1');
    expect(stream.out.join('')).toContain('log-1');
  });
});

describe('kb changelog 活动日志', () => {
  it('list 解析 workspace 名称并带类型/搜索/分页参数，--json 原样输出', async () => {
    stubFetch(withWorkspaces([{ body: { items: [RECORD], next_offset: 50 } }]));
    const stream = io();
    expect(
      await main(['node', 'kb', '--json', 'changelog', 'list', '--workspace', '项目', '--type', '修复', '--query', '缓存', '--limit', '10'], stream),
    ).toBe(0);
    expect(calls[0]!.url).toContain('/api/workspaces');
    expect(calls[1]!.url).toContain('/api/workspaces/w1/changelog?');
    expect(calls[1]!.url).toContain('change_type=%E4%BF%AE%E5%A4%8D');
    expect(calls[1]!.url).toContain('q=%E7%BC%93%E5%AD%98');
    expect(calls[1]!.url).toContain('limit=10');
    expect(JSON.parse(stream.out.join('')).items[0]).toMatchObject({ id: 'log-1', revision: 1 });
  });

  it('B：缺省按 cwd 解析当前工作区（不再强制 --workspace）', async () => {
    // cwd 命中：WS.path 换成真实目录，解析器等值优先命中 w1
    stubFetch([{ body: [{ ...WS, path: process.cwd() }] }, { body: { items: [], total: 0, offset: 0, limit: 50 } }]);
    const stream = io();
    expect(await main(['node', 'kb', 'changelog', 'list'], stream)).toBe(0);
    expect(calls[0]!.url).toContain('/api/workspaces');
    expect(calls[1]!.url).toContain('/api/workspaces/w1/changelog');
  });

  it('B：cwd 解析不到工作区时报可读错误（不静默空列表）', async () => {
    stubFetch([{ body: [WS] }]);
    const stream = io();
    expect(await main(['node', 'kb', 'changelog', 'list'], stream)).not.toBe(0);
    expect(stream.err.join('')).toContain('--workspace');
  });

  it('show 打单条路径；非 --json 输出含标题与正文', async () => {
    stubFetch(withWorkspaces([{ body: RECORD }]));
    const stream = io();
    expect(await main(['node', 'kb', 'changelog', 'show', 'log-1', '--workspace', 'w1'], stream)).toBe(0);
    expect(calls[1]!.url).toContain('/api/workspaces/w1/changelog/log-1');
    expect(stream.out.join('')).toContain('缓存失效修复');
    expect(stream.out.join('')).toContain('正文内容');
  });

  it('N4-03：list/show 文本模式显示归属（无归属显示 -）', async () => {
    const issueId = '11111111-1111-4111-8111-111111111111';
    stubFetch(withWorkspaces([{ body: { items: [{ ...RECORD, issue_id: issueId }], next_offset: null } }]));
    const listStream = io();
    expect(await main(['node', 'kb', 'changelog', 'list', '--workspace', 'w1'], listStream)).toBe(0);
    expect(listStream.out.join('')).toContain(`归属:${issueId}`);

    stubFetch(withWorkspaces([{ body: RECORD }]));
    const showStream = io();
    expect(await main(['node', 'kb', 'changelog', 'show', 'log-1', '--workspace', 'w1'], showStream)).toBe(0);
    expect(showStream.out.join('')).toContain('归属:-');
  });

  it('create 从 stdin 读正文，actor 取 KB_AGENT，--request-id 透传幂等键', async () => {
    stubFetch(withWorkspaces([{ body: { ...RECORD, revision: 1 } }]));
    const stream = io('多行\n正文');
    expect(
      await main(
        [
          'node', 'kb', 'changelog', 'create',
          '--workspace', 'w1', '--title', '新日志', '--type', '新增', '--stdin',
          '--request-id', '00000000-0000-4000-8000-000000000001',
        ],
        stream,
      ),
    ).toBe(0);
    expect(calls[1]!.init.method).toBe('POST');
    expect(JSON.parse(calls[1]!.init.body!)).toEqual({
      title: '新日志',
      body_md: '多行\n正文',
      change_type: '新增',
      actor: 'codex-test',
    });
    expect(calls[1]!.init.headers?.['Idempotency-Key']).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('update 只提交给出的字段并带数字 expected_revision；无字段时报错不发请求', async () => {
    stubFetch(withWorkspaces([{ body: { ...RECORD, revision: 2, title: '改后标题' } }]));
    const stream = io();
    expect(
      await main(['node', 'kb', 'changelog', 'update', 'log-1', '--workspace', 'w1', '--expected-revision', '1', '--title', '改后标题'], stream),
    ).toBe(0);
    expect(calls[1]!.init.method).toBe('PATCH');
    expect(JSON.parse(calls[1]!.init.body!)).toEqual({ expected_revision: 1, actor: 'codex-test', title: '改后标题' });

    stubFetch(withWorkspaces([]));
    const empty = io();
    expect(await main(['node', 'kb', 'changelog', 'update', 'log-1', '--workspace', 'w1', '--expected-revision', '1'], empty)).not.toBe(0);
    expect(calls).toHaveLength(1); // 只有 workspace 解析
    expect(empty.err.join('')).toContain('至少提供一个可修改字段');
  });

  it('delete 带 CAS revision 与幂等键，成功输出已删除', async () => {
    stubFetch(withWorkspaces([{ status: 204 }]));
    const stream = io();
    expect(
      await main(
        ['node', 'kb', 'changelog', 'delete', 'log-1', '--workspace', 'w1', '--expected-revision', '3', '--request-id', '00000000-0000-4000-8000-000000000002'],
        stream,
      ),
    ).toBe(0);
    expect(calls[1]!.init.method).toBe('DELETE');
    expect(JSON.parse(calls[1]!.init.body!)).toEqual({ expected_revision: 3, actor: 'codex-test' });
    expect(calls[1]!.init.headers?.['Idempotency-Key']).toBe('00000000-0000-4000-8000-000000000002');
    expect(stream.out.join('')).toContain('已删除变更日志: log-1');
  });

  it('CAS 冲突：原样输出 CHANGELOG_REVISION_CONFLICT 且不误报「已被占用」，退出码 2', async () => {
    stubFetch(
      withWorkspaces([
        { status: 409, body: { error: { code: 'CHANGELOG_REVISION_CONFLICT', message: '变更日志已更新，请重新读取' } } },
      ]),
    );
    const stream = io();
    expect(await main(['node', 'kb', 'changelog', 'update', 'log-1', '--workspace', 'w1', '--expected-revision', '1', '--title', 'x'], stream)).toBe(2);
    expect(stream.err.join('')).toContain('变更日志已更新，请重新读取');
    expect(stream.err.join('')).not.toContain('已被占用');
  });

  it('跨工作区/不存在记录：服务端 CHANGELOG_NOT_FOUND 原文输出，退出码 1', async () => {
    stubFetch(withWorkspaces([{ status: 404, body: { error: { code: 'CHANGELOG_NOT_FOUND', message: '变更日志不存在' } } }]));
    const stream = io();
    expect(await main(['node', 'kb', 'changelog', 'show', 'other', '--workspace', 'w1'], stream)).toBe(1);
    expect(stream.err.join('')).toContain('变更日志不存在');
  });
});

describe('kb changelog 归档只读', () => {
  it('archived-workspaces 分页列出；list-archived 必须显式 --origin-workspace-id', async () => {
    stubFetch([
      {
        body: {
          items: [{ origin_workspace_id: 'w0', origin_workspace_name: '旧项目', origin_workspace_path: 'D:/old', entry_count: 3, last_occurred_at: 1793000000000 }],
          next_offset: null,
        },
      },
    ]);
    const stream = io();
    expect(await main(['node', 'kb', 'changelog', 'archived-workspaces'], stream)).toBe(0);
    expect(calls[0]!.url).toContain('/api/changelog/archived-workspaces?offset=0&limit=50');
    expect(stream.out.join('')).toContain('旧项目');

    stubFetch([
      { body: { items: [{ ...RECORD, workspace_id: null }], next_offset: null } },
    ]);
    expect(await main(['node', 'kb', 'changelog', 'list-archived', '--origin-workspace-id', 'w0'], io())).toBe(0);
    expect(calls[0]!.url).toContain('/api/changelog/archived-workspaces/w0/entries?');

    stubFetch([
      { body: { ...RECORD, workspace_id: null } },
    ]);
    const shown = io();
    expect(await main(['node', 'kb', 'changelog', 'show-archived', 'log-1', '--origin-workspace-id', 'w0'], shown)).toBe(0);
    expect(calls[0]!.url).toContain('/api/changelog/archived-workspaces/w0/entries/log-1');
    expect(shown.out.join('')).toContain('归档');
  });

  it('写命令不接受 --origin-workspace-id（归档只读）', async () => {
    stubFetch([]);
    const stream = io();
    expect(await main(['node', 'kb', 'changelog', 'list', '--origin-workspace-id', 'w0'], stream)).not.toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('kb changelog 导入与退役复核', () => {
  it('import preview 输出 SHA 与分类计数，并在提示里给出 apply 命令', async () => {
    stubFetch(withWorkspaces([{ body: PREVIEW }]));
    const stream = io();
    expect(await main(['node', 'kb', 'changelog', 'import', 'preview', '--workspace', 'w1', '--source', PREVIEW.source_path], stream)).toBe(0);
    expect(calls[1]!.url).toContain('/api/workspaces/w1/changelog/import/preview');
    expect(JSON.parse(calls[1]!.init.body!)).toEqual({ source_path: PREVIEW.source_path, actor: 'codex-test' });
    const text = stream.out.join('');
    expect(text).toContain(PREVIEW.source_sha256);
    expect(text).toContain('新增 2');
    expect(text).toContain('--sha');
  });

  it('import apply 必须带 --sha，并把它作为 preview_sha256 提交（含幂等键）', async () => {
    stubFetch([]);
    const missing = io();
    expect(await main(['node', 'kb', 'changelog', 'import', 'apply', '--workspace', 'w1', '--source', 'x.md'], missing)).not.toBe(0);
    expect(calls).toHaveLength(0);

    stubFetch(withWorkspaces([{ body: { imported: 2, receipt_id: 'rcpt-1', source_sha256: PREVIEW.source_sha256 } }]));
    const stream = io();
    expect(
      await main(
        [
          'node', 'kb', 'changelog', 'import', 'apply',
          '--workspace', 'w1', '--source', PREVIEW.source_path, '--sha', PREVIEW.source_sha256,
          '--request-id', '00000000-0000-4000-8000-000000000003',
        ],
        stream,
      ),
    ).toBe(0);
    expect(JSON.parse(calls[1]!.init.body!)).toEqual({
      source_path: PREVIEW.source_path,
      preview_sha256: PREVIEW.source_sha256,
      actor: 'codex-test',
    });
    expect(calls[1]!.init.headers?.['Idempotency-Key']).toBe('00000000-0000-4000-8000-000000000003');
    expect(stream.out.join('')).toContain('导入完成：新增 2 条');
  });

  it('apply 时源文件变化：CHANGELOG_SOURCE_CHANGED 原文输出，退出码 2', async () => {
    stubFetch(
      withWorkspaces([
        { status: 409, body: { error: { code: 'CHANGELOG_SOURCE_CHANGED', message: '源文件已变化，请重新预览后再应用' } } },
      ]),
    );
    const stream = io();
    expect(
      await main(['node', 'kb', 'changelog', 'import', 'apply', '--workspace', 'w1', '--source', 'x.md', '--sha', PREVIEW.source_sha256], stream),
    ).toBe(2);
    expect(stream.err.join('')).toContain('源文件已变化');
    expect(stream.err.join('')).not.toContain('已被占用');
  });

  it('verify-retire 不可退役时打印结论并退出码 1；可退役退出码 0', async () => {
    stubFetch(
      withWorkspaces([
        {
          body: {
            can_retire: false,
            reason: '未找到与该源文件 SHA-256 匹配的成功导入回执，需重新预览并应用',
            source_sha256: PREVIEW.source_sha256,
            receipt: null,
            entry_count: 2,
            added: PREVIEW.added,
            already_imported: [],
            conflicting: [],
            unparsable: [],
          },
        },
      ]),
    );
    const blocked = io();
    expect(await main(['node', 'kb', 'changelog', 'verify-retire', '--workspace', 'w1', '--source', 'x.md'], blocked)).toBe(1);
    expect(blocked.out.join('')).toContain('可退役: 否');
    expect(blocked.out.join('')).toContain('对账: 新增 2');
    expect(blocked.err.join('')).toContain('不可退役');

    stubFetch(
      withWorkspaces([
        {
          body: {
            can_retire: true,
            reason: '源文件 SHA-256 与成功导入回执一致，全部条目已完成对账',
            source_sha256: PREVIEW.source_sha256,
            receipt: { id: 'rcpt-1', entry_count: 2, imported_at: 1793000000000 },
            entry_count: 2,
            added: [],
            already_imported: PREVIEW.added,
            conflicting: [],
            unparsable: [],
          },
        },
      ]),
    );
    const ok = io();
    expect(await main(['node', 'kb', 'changelog', 'verify-retire', '--workspace', 'w1', '--source', 'x.md'], ok)).toBe(0);
    expect(ok.out.join('')).toContain('可退役: 是');
    expect(ok.out.join('')).toContain('rcpt-1');
  });
});
