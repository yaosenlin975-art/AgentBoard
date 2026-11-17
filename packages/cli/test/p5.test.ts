/**
 * P5：CLI 一致性六处。
 *
 * C3  知识页前缀：show / resolve / action / revise / rename 同一套行为（≥8 位唯一前缀，多命中 exit 2）
 * 小问题 6  changelog show / update / delete 同样认 ≥8 位前缀
 * C4  action 缺 --expected-revision 的报错要点明「--scope 可省略」
 * C11 下游关闭管道（EPIPE）→ 静默 exit 0，不打印栈
 * C12 `--status 待验收` 统一成一条可预测规则
 * C13 create-issue 位置参数被解析成工作区时给提示
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

interface IoHarness { out: string[]; err: string[]; write: (s: string) => void; writeErr: (s: string) => void; readStdin: () => Promise<string> }

function io(stdin = ''): IoHarness & { outText: () => string; errText: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out, err,
    write: (s: string) => out.push(s),
    writeErr: (s: string) => err.push(s),
    readStdin: async () => stdin,
    outText: () => out.join(''),
    errText: () => err.join(''),
  };
}

interface Call { url: string; method: string; body?: unknown }
let calls: Call[] = [];

/** 按 URL 前缀路由的 fetch 桩：返回最后一个匹配 handler 的响应 */
function stubFetch(handlers: Array<{ match: (url: string, method: string) => boolean; body?: unknown; status?: number }>): void {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url: String(url), method, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    const hit = handlers.find((handler) => handler.match(String(url), method));
    if (hit === undefined) throw new Error(`未预期请求: ${method} ${url}`);
    // 204 不能带 body（`new Response('', {status:204})` 会抛），delete 走这条
    const payload = hit.body === undefined ? null : JSON.stringify(hit.body);
    return new Response(payload, { status: hit.status ?? 200 });
  }));
}

afterEach(() => vi.unstubAllGlobals());

const WS = { id: 'w1', name: '项目', path: 'D:/project' };
const PAGE_ID = 'bcdb3a62-fd3e-4195-b52d-0d0093979273';
const PAGE = {
  id: PAGE_ID, scope: 'workspace', workspace_id: 'w1', revision: 3, title: '并行全量测试',
  slug: 'parallel', status: 'active', body_md: '正文', category: 'design', landed: 'landed', domain: 'infra',
  link: `knowledge:${PAGE_ID}`, link_info: { markdown: `[知识卡：并行全量测试](knowledge:${PAGE_ID})`, text: `知识卡《并行全量测试》 knowledge:${PAGE_ID}` },
};

// 只匹配工作区列表本体（不能吞 /api/workspaces/<id>/changelog 这类子路径）
const workspaceHandler = { match: (url: string) => /\/api\/workspaces(\?|$)/.test(url), body: [WS] };
const resolveHandler = (body: unknown, status = 200) => ({
  match: (url: string) => url.includes('/api/knowledge/resolve?'),
  body,
  status,
});

describe('C3：知识页 ≥8 位 id 前缀在四个命令上口径一致（P5）', () => {
  it('revise <前缀> --scope：先 resolve 成完整 id，再 PUT 到该 id', async () => {
    stubFetch([workspaceHandler, resolveHandler(PAGE), { match: (url: string, method: string) => method === 'PUT' && url.includes('/api/knowledge/pages/'), body: { ...PAGE, revision: 4 } }]);
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'revise', 'bcdb3a62', '--scope', 'workspace', '--workspace', 'w1', '--expected-revision', '3', '--landed', 'landed'], stream)).toBe(0);
    expect(calls.some((call) => call.url.includes('ref=bcdb3a62'))).toBe(true);
    const put = calls.find((call) => call.method === 'PUT')!;
    // 前缀必须被替换成完整 id，不能原样透传（服务端只认完整 uuid）
    expect(put.url).toContain(encodeURIComponent(PAGE_ID));
    expect(put.body).toMatchObject({ expected_revision: 3, landed: 'landed' });
  });

  it('rename <前缀>：resolve 后 POST 到完整 id', async () => {
    stubFetch([
      workspaceHandler, resolveHandler(PAGE),
      { match: (url: string, method: string) => method === 'POST' && url.includes('/rename'), body: { id: PAGE_ID, slug: 'parallel-v2', old_slug: 'parallel', scope: 'workspace', revision: 4, title: '并行全量测试', link: `knowledge:${PAGE_ID}`, rewritten: [] } },
    ]);
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'rename', 'bcdb3a62', 'parallel-v2', '--workspace', 'w1', '--expected-revision', '3'], stream)).toBe(0);
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.url).toContain(encodeURIComponent(PAGE_ID));
    expect(stream.outText()).toContain('parallel-v2（原 slug：parallel；id 不变）');
  });

  it('show <前缀> --scope：显式 scope 也要 resolve（改前直接 404）', async () => {
    stubFetch([workspaceHandler, resolveHandler(PAGE), { match: (url: string, method: string) => method === 'GET' && url.includes('/api/knowledge/pages/'), body: PAGE }]);
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'show', 'bcdb3a62', '--scope', 'workspace', '--workspace', 'w1'], stream)).toBe(0);
    expect(calls.some((call) => call.url.includes('ref=bcdb3a62'))).toBe(true);
    expect(calls.at(-1)!.url).toContain(encodeURIComponent(PAGE_ID));
  });

  it('完整 UUID + 显式 --scope：不发 resolve（旧路径保持不变）', async () => {
    stubFetch([{ match: (url: string, method: string) => method === 'GET' && url.includes('/api/knowledge/pages/'), body: PAGE }]);
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'show', PAGE_ID, '--scope', 'common'], stream)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/api/knowledge/pages/');
  });

  it('多命中前缀 → exit 2 并列出候选（不猜第一条）', async () => {
    stubFetch([
      workspaceHandler,
      resolveHandler({ error: { code: 'KNOWLEDGE_REF_AMBIGUOUS', message: `id 前缀 bcdb3a62 命中 2 页，请用完整 id`, details: { candidates: ['bcdb3a62-0000-4000-8000-000000000001', 'bcdb3a62-0000-4000-8000-000000000002'] } } }, 409),
    ]);
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'revise', 'bcdb3a62', '--scope', 'workspace', '--workspace', 'w1', '--expected-revision', '1'], stream)).toBe(2);
    expect(stream.errText()).toContain('bcdb3a62-0000-4000-8000-000000000001');
    expect(stream.errText()).toContain('bcdb3a62-0000-4000-8000-000000000002');
    // 歧义时不得继续发写请求
    expect(calls.filter((call) => call.method === 'PUT' || call.method === 'POST')).toHaveLength(0);
  });

  it('前缀解析不到 → 文案说「引用无法唯一解析」，不误报「页不存在」把人引向「是不是删了」', async () => {
    stubFetch([workspaceHandler, resolveHandler({ error: { code: 'KNOWLEDGE_NOT_FOUND', message: '知识页不存在' } }, 404)]);
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'revise', 'deadbeef', '--scope', 'workspace', '--workspace', 'w1', '--expected-revision', '1'], stream)).toBe(1);
    expect(stream.errText()).toContain('无法唯一解析');
    // 8 位前缀本身合法，只说没命中，不说「请给 ≥8 位」
    expect(stream.errText()).toContain('该前缀没有任何命中');
  });

  it('前缀位数不足 → 文案给出「请给 ≥8 位（当前 N 位）」', async () => {
    stubFetch([workspaceHandler, resolveHandler({ error: { code: 'KNOWLEDGE_NOT_FOUND', message: '知识页不存在' } }, 404)]);
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'revise', 'abcd', '--scope', 'workspace', '--workspace', 'w1', '--expected-revision', '1'], stream)).toBe(1);
    expect(stream.errText()).toContain('请给 ≥8 位（当前 4 位）');
  });

  it('slug 不存在的「知识页不存在」保持原样（那句话本就准确，且不发 resolve）', async () => {
    stubFetch([
      workspaceHandler,
      { match: (url: string, method: string) => method === 'PUT' && url.includes('/api/knowledge/pages/'), status: 404, body: { error: { code: 'KNOWLEDGE_NOT_FOUND', message: '知识页不存在' } } },
    ]);
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'revise', 'no-such-slug', '--scope', 'common', '--expected-revision', '1'], stream)).toBe(1);
    expect(stream.errText().trim()).toBe('知识页不存在');
    // 显式 --scope + 非前缀引用：保持旧路径，不发 resolve
    expect(calls.some((call) => call.url.includes('/api/knowledge/resolve'))).toBe(false);
  });
});

describe('C4：action 缺 --expected-revision 的报错要点明 --scope 可省略（P5）', () => {
  it('缺 revision → exit 1，文案同时给 --scope 可省略', async () => {
    stubFetch([workspaceHandler]);
    const stream = io();
    expect(await main(['node', 'kb', 'knowledge', 'action', 'bcdb3a62', 'archive'], stream)).toBe(1);
    expect(stream.errText()).toContain('--expected-revision');
    expect(stream.errText()).toContain('--scope 可省略');
    expect(calls).toHaveLength(0);
  });
});

describe('小问题 6：changelog show/update/delete 支持 ≥8 位前缀（P5）', () => {
  const LOG_ID = '1ae7ccb1-90fa-497c-a20c-a7016283cfcf';
  const LOG = {
    id: LOG_ID, workspace_id: 'w1', origin_workspace_id: 'w1', origin_workspace_name: '项目', origin_workspace_path: 'D:/project',
    title: '修复', body_md: '正文', change_type: '修复', occurred_at: 1793000000000, created_by: 'u', updated_by: 'u',
    created_at: 1793000000000, updated_at: 1793000000000, revision: 1, legacy_source_key: null, issue_id: null,
  };
  // 列表端点形如 /api/workspaces/w1/changelog?limit=100；详情形如 .../changelog/<id>（带 / 才是详情）
  const listHandler = { match: (url: string, method: string) => method === 'GET' && /\/changelog(\?|$)/.test(url), body: { items: [LOG], next_offset: null } };
  const detailHandler = (body: unknown) => ({ match: (url: string, method: string) => method === 'GET' && /\/changelog\/[^?]+$/.test(url), body });

  it('show <前缀> → 先列一页定位，再按完整 id 取详情', async () => {
    stubFetch([workspaceHandler, listHandler, detailHandler(LOG)]);
    const stream = io();
    expect(await main(['node', 'kb', 'changelog', 'show', '1ae7ccb1', '--workspace', 'w1'], stream)).toBe(0);
    expect(calls.at(-1)!.url).toContain(LOG_ID);
    expect(stream.outText()).toContain(LOG_ID);
  });

  it('delete <前缀> → DELETE 打到完整 id，回执也回完整 id', async () => {
    stubFetch([workspaceHandler, listHandler, { match: (url: string, method: string) => method === 'DELETE', status: 204 }]);
    const stream = io();
    expect(await main(['node', 'kb', 'changelog', 'delete', '1ae7ccb1', '--workspace', 'w1', '--expected-revision', '1'], stream)).toBe(0);
    expect(calls.at(-1)!.url).toContain(LOG_ID);
    expect(stream.outText()).toContain(`已删除变更日志: ${LOG_ID}`);
  });

  it('前缀不足 8 位 → exit 1，文案点名位数', async () => {
    stubFetch([workspaceHandler, listHandler]);
    const stream = io();
    expect(await main(['node', 'kb', 'changelog', 'delete', '1ae7ccb', '--workspace', 'w1', '--expected-revision', '1'], stream)).toBe(1);
    expect(stream.errText()).toContain('至少 8 位');
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  });

  it('前缀零命中 → 文案说「前缀无法解析」，不说「不存在」', async () => {
    stubFetch([workspaceHandler, listHandler]);
    const stream = io();
    expect(await main(['node', 'kb', 'changelog', 'show', 'deadbeef', '--workspace', 'w1'], stream)).toBe(1);
    expect(stream.errText()).toContain('前缀无法解析');
    expect(stream.errText()).not.toContain('变更日志不存在');
  });

  it('前缀多命中 → exit 2 并列候选', async () => {
    const twin = { ...LOG, id: '1ae7ccb1-0000-4000-8000-000000000002', title: '另一条' };
    stubFetch([workspaceHandler, { match: (url: string, method: string) => method === 'GET' && url.includes('/changelog'), body: { items: [LOG, twin], next_offset: null } }]);
    const stream = io();
    expect(await main(['node', 'kb', 'changelog', 'show', '1ae7ccb1', '--workspace', 'w1'], stream)).toBe(2);
    expect(stream.errText()).toContain('命中 2 条');
    expect(stream.errText()).toContain('1ae7ccb1-0000-4000-8000-000000000002');
  });
});

describe('C12：--status 待验收 一条可预测规则（P5）', () => {
  const okHandler = (body: unknown) => [
    workspaceHandler,
    { match: (url: string, method: string) => method === 'POST' && url.endsWith('/api/issues'), body },
    { match: (url: string, method: string) => method === 'GET' && url.includes('/api/issues/'), body },
  ];

  it('有 -d 且描述非空（不含「验收」关键词）→ 建卡成功', async () => {
    stubFetch(okHandler({ id: 'iss1', workspace_id: 'w1', title: 'X', description: '这条描述里没有那两个字。', priority: '中', labels: [], status: '待验收', sort_order: 0, claimed_by: null, claimed_at: null, session_id: null, comment_count: 0, created_at: 1, updated_at: 1 }));
    const stream = io();
    expect(await main(['node', 'kb', 'create-issue', '项目', 'X', '-d', '这条描述里没有那两个字。', '--status', '待验收'], stream)).toBe(0);
    expect(calls.find((call) => call.method === 'POST')!.body).toMatchObject({ status: '待验收' });
  });

  it('--allow-empty --status 待验收 → exit 1（不豁免），文案点明判定口径', async () => {
    stubFetch([workspaceHandler]);
    const stream = io();
    expect(await main(['node', 'kb', 'create-issue', '项目', 'X', '--allow-empty', '--status', '待验收'], stream)).toBe(1);
    expect(stream.errText()).toContain('验收标准');
    expect(stream.errText()).toContain('--allow-empty');
    expect(stream.errText()).toContain('不检查是否含「验收」关键词');
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('-d 只有模板骨架（无实质内容）→ exit 1', async () => {
    stubFetch([workspaceHandler]);
    const stream = io();
    expect(await main(['node', 'kb', 'create-issue', '项目', 'X', '-d', '验收标准：', '--status', '待验收'], stream)).toBe(1);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });
});

describe('C13：位置参数被解析成工作区时给提示（P5）', () => {
  it('位置参数第 1 项命中工作区 → stderr 提示解析结果', async () => {
    stubFetch([
      workspaceHandler,
      { match: (url: string, method: string) => method === 'POST' && url.endsWith('/api/issues'), body: { id: 'iss1', workspace_id: 'w1', title: '标题', description: '正文', priority: '中', labels: [], status: '待规划', sort_order: 0, claimed_by: null, claimed_at: null, session_id: null, comment_count: 0, created_at: 1, updated_at: 1 } },
      { match: (url: string, method: string) => method === 'GET' && url.includes('/api/issues/'), body: { id: 'iss1', title: '标题', description: '正文' } },
    ]);
    const stream = io();
    expect(await main(['node', 'kb', 'create-issue', '项目', '标题', '-d', '正文'], stream)).toBe(0);
    expect(stream.errText()).toContain('已按位置参数第 1 项解析为工作区');
    expect(stream.errText()).toContain('项目');
    // 提示不得改变行为：仍建到解析出的工作区
    expect(calls.find((call) => call.method === 'POST')!.body).toMatchObject({ workspace_id: 'w1', title: '标题' });
  });

  it('--workspace 显式给出时不提示（没有歧义）', async () => {
    stubFetch([
      workspaceHandler,
      { match: (url: string, method: string) => method === 'POST' && url.endsWith('/api/issues'), body: { id: 'iss1', workspace_id: 'w1', title: '标题', description: '正文', priority: '中', labels: [], status: '待规划', sort_order: 0, claimed_by: null, claimed_at: null, session_id: null, comment_count: 0, created_at: 1, updated_at: 1 } },
      { match: (url: string, method: string) => method === 'GET' && url.includes('/api/issues/'), body: { id: 'iss1', title: '标题', description: '正文' } },
    ]);
    const stream = io();
    expect(await main(['node', 'kb', 'create-issue', '--workspace', '项目', '标题', '-d', '正文'], stream)).toBe(0);
    expect(stream.errText()).toBe('');
  });
});
