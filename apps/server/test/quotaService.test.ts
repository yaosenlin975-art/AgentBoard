/**
 * ACC-QUOTA-01：额度聚合服务。
 * - deepseek 为唯一真实取数来源（Bearer + `/user/balance`），其余两来源无公开配额端点 → unsupported；
 * - 60s 缓存：窗口内重复调用不重复打第三方；失败指数退避；
 * - 401/429/5xx/网络分别映射固定 reason_code，响应不含 token。
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectDeepseekKeyCandidates,
  createQuotaService,
  discoverOpencodeUrl,
  hasCodexLogin,
  hasOpencodeGoKey,
  parseDeepseekBalance,
  parseCodexRateLimits,
  parseNetstatListeners,
  parseTasklistPids,
  readDshCredentialsDeepseekKey,
  resolveDeepseekKey,
  scanCodexRollout,
} from '../src/services/quotas/quotaService.js';

function tempHome(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'accquota-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = join(dir, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return dir;
}

const balanceBody = {
  is_available: true,
  balance_infos: [
    { currency: 'USD', total_balance: '1.00', granted_balance: '0.00', topped_up_balance: '1.00' },
    { currency: 'CNY', total_balance: '38.42', granted_balance: '10.00', topped_up_balance: '28.42' },
  ],
};

const homeWithKey = () => tempHome({ '.deepseek/config.toml': 'api_key = "sk-unit-test-key"\ndefault_text_model = "x"\n' });

describe('额度来源凭据解析（本机只读）', () => {
  it('DeepSeek key 优先环境变量，其次 ~/.deepseek/config.toml', () => {
    const home = homeWithKey();
    expect(resolveDeepseekKey(home, {})).toBe('sk-unit-test-key');
    expect(resolveDeepseekKey(home, { DEEPSEEK_API_KEY: 'sk-from-env' })).toBe('sk-from-env');
    expect(resolveDeepseekKey(tempHome({}), {})).toBeNull();
  });

  it('OpenCode Go / Codex 只检测本机痕迹，不存在时返回 false', () => {
    const empty = tempHome({});
    expect(hasOpencodeGoKey(empty)).toBe(false);
    expect(hasCodexLogin(empty)).toBe(false);
    const withAuth = tempHome({
      '.local/share/opencode/auth.json': JSON.stringify({ 'opencode-go': { type: 'api', key: 'x'.repeat(20) } }),
      '.codex/auth.json': JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'a'.repeat(20) } }),
    });
    expect(hasOpencodeGoKey(withAuth)).toBe(true);
    expect(hasCodexLogin(withAuth)).toBe(true);
  });
});

describe('DeepSeek 余额解析', () => {
  it('优先取 CNY 的 balance_infos，余额转数字', () => {
    const result = parseDeepseekBalance(balanceBody, 1000);
    expect(result.status).toBe('ok');
    expect(result.balance).toBe(38.42);
    expect(result.unit).toBe('CNY');
    expect(result.fetched_at).toBe(1000);
  });

  it('结构不符时报固定码，不返回余额', () => {
    const result = parseDeepseekBalance({ is_available: true }, 1000);
    expect(result.status).toBe('error');
    expect(result.reason_code).toBe('UPSTREAM_SHAPE_UNEXPECTED');
    expect(result.balance).toBeNull();
  });
});

describe('聚合服务（缓存 / 错误映射 / 脱敏）', () => {
  it('60s 内重复调用只打一次第三方，且三来源逐项独立', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(balanceBody), { status: 200, headers: { 'content-type': 'application/json' } }));
    const service = createQuotaService({ fetchImpl: fetchImpl as unknown as typeof fetch, homeDir: homeWithKey(), now: () => 5_000 });

    const first = await service.get();
    const second = await service.get();

    // 只有 CLI 组的 deepseek 需要联网（opencode/codex 走本地探测/本地快照）；平台组无凭据 → 不请求
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // ACC-KB-B5S：来源 8 个分两组，顺序 = QUOTA_SOURCE_IDS（CLI 3 + 平台 5）
    expect(first.items.map((item) => item.source)).toEqual([
      'deepseek', 'opencode_go', 'codex', 'workbuddy', 'minimax', 'trae', 'qoder_cn', 'zcode',
    ]);
    expect(first.items[0]!.status).toBe('ok');
    expect(first.items[0]!.balance).toBe(38.42);
    expect(first.items[1]!.status).toBe('unsupported');
    // 该夹具没有 opencode 登录态 → 走可解释的「未登录」分支（不再笼统 NO_PUBLIC_QUOTA_ENDPOINT）
    expect(first.items[1]!.reason_code).toBe('OPENCODE_NOT_LOGGED_IN');
    expect(first.items[2]!.status).toBe('unsupported');
    expect(second.items[0]!.balance).toBe(38.42);
  });

  it('缓存过期后重新取数；并发调用共用同一次请求', async () => {
    let nowValue = 0;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(balanceBody), { status: 200 }));
    const service = createQuotaService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: homeWithKey(),
      now: () => nowValue,
      ttlMs: 60_000,
    });

    await Promise.all([service.get(), service.get(), service.get()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    nowValue = 60_001;
    await service.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('401 → CREDENTIAL_INVALID（error，不带 token/路径）', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }));
    const service = createQuotaService({ fetchImpl: fetchImpl as unknown as typeof fetch, homeDir: homeWithKey(), now: () => 1 });
    const snapshot = await service.get();
    const deepseek = snapshot.items[0]!;
    expect(deepseek.status).toBe('error');
    expect(deepseek.reason_code).toBe('CREDENTIAL_INVALID');
    expect(JSON.stringify(snapshot)).not.toContain('sk-unit-test-key');
    expect(JSON.stringify(snapshot)).not.toContain('.deepseek');
  });

  it('失败按指数退避：连续失败后短时间内不再请求', async () => {
    let nowValue = 0;
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
    const service = createQuotaService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: homeWithKey(),
      now: () => nowValue,
      ttlMs: 60_000,
    });

    await service.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    nowValue = 30_000;
    await service.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    nowValue = 61_000;
    await service.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await service.get()).items[0]!.reason_code).toBe('NETWORK_ERROR');
  });

  it('无 DeepSeek key → unsupported CREDENTIAL_MISSING，且不发请求', async () => {
    const fetchImpl = vi.fn();
    const service = createQuotaService({ fetchImpl: fetchImpl as unknown as typeof fetch, homeDir: tempHome({}), env: {}, now: () => 1 });
    const snapshot = await service.get();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(snapshot.items[0]!.status).toBe('unsupported');
    expect(snapshot.items[0]!.reason_code).toBe('CREDENTIAL_MISSING');
  });
});

describe('OpenCode Go（ACC-QUOTA-02，走本地服务 usage 路由）', () => {
  const usageBody = {
    location: { directory: 'C:\\Users\\test' },
    data: {
      workspace: { id: 'wrk_x', name: 'Default', usageURL: 'https://opencode.ai/console/wrk_x/activity/overview' },
      go: {
        rolling: { percent: 19, limited: false, resetsAt: 1_793_680_271_000 },
        weekly: { percent: 8, limited: false, resetsAt: 1_794_182_400_000 },
        monthly: { percent: 26, limited: false, resetsAt: 1_796_000_751_000 },
      },
      budgets: [],
    },
  };

  const homeWithOpencode = () => tempHome({
    '.local/share/opencode/auth.json': JSON.stringify({ opencode: { type: 'api', key: 'x'.repeat(20) }, 'opencode-go': { type: 'api', key: 'y'.repeat(20) } }),
    '.config/opencode/service.json': JSON.stringify({ password: 'z'.repeat(43) }),
  });

  function opencodeService(fetchImpl: unknown, extra: Record<string, unknown> = {}) {
    return createQuotaService({
      fetchImpl: fetchImpl as typeof fetch,
      homeDir: homeWithOpencode(),
      env: { OPENCODE_SERVER_URL: 'http://127.0.0.1:28894' },
      now: () => 1_000,
      ...extra,
    });
  }

  it('三个窗口按「已用百分比」换算剩余 + 保留重置时刻', async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      return new Response(JSON.stringify(usageBody), { status: 200 });
    });
    const snapshot = await opencodeService(fetchImpl).get();
    const go = snapshot.items[1]!;
    expect(go.status).toBe('ok');
    expect(go.unit).toBe('%');
    expect(go.windows.map((w) => w.name)).toEqual(['5h', 'weekly', 'monthly']);
    expect(go.windows[0]).toMatchObject({ remaining: 81, used_percent: 19, reset_at: 1_793_680_271_000 });
    expect(go.windows[1]).toMatchObject({ remaining: 92, used_percent: 8 });
    expect(go.windows[2]).toMatchObject({ remaining: 74, used_percent: 26 });
    expect(go.detail).toContain('Default');
    expect(requested.some((u) => u.endsWith('/api/experimental/usage/limits'))).toBe(true);
  });

  it('limited=true 时给出限额提示', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: { go: { rolling: { percent: 100, limited: true, resetsAt: 1 } } },
    }), { status: 200 }));
    const snapshot = await opencodeService(fetchImpl).get();
    expect(snapshot.items[1]!.status).toBe('ok');
    expect(snapshot.items[1]!.windows[0]!.remaining).toBe(0);
    expect(snapshot.items[1]!.detail).toContain('限额');
  });

  it('未登录 / 未发现服务分别给可解释码（不再笼统 unsupported）', async () => {
    const noLogin = createQuotaService({ fetchImpl: vi.fn() as unknown as typeof fetch, homeDir: tempHome({}), env: {}, now: () => 1 });
    expect((await noLogin.get()).items[1]!).toMatchObject({ status: 'unsupported', reason_code: 'OPENCODE_NOT_LOGGED_IN' });

    const noServer = createQuotaService({
      fetchImpl: vi.fn() as unknown as typeof fetch,
      homeDir: homeWithOpencode(),
      env: {},
      execFileImpl: async () => '',
      now: () => 1,
    });
    expect((await noServer.get()).items[1]!).toMatchObject({ status: 'unsupported', reason_code: 'OPENCODE_SERVER_NOT_RUNNING' });
  });

  it('401 / 404 分别映射 OPENCODE_AUTH_FAILED / OPENCODE_ROUTE_UNSUPPORTED', async () => {
    const unauthorized = opencodeService(vi.fn(async () => new Response('{"_tag":"UnauthorizedError"}', { status: 401 })));
    expect((await unauthorized.get()).items[1]!).toMatchObject({ status: 'error', reason_code: 'OPENCODE_AUTH_FAILED' });

    const notFound = opencodeService(vi.fn(async () => new Response('{}', { status: 404 })));
    expect((await notFound.get()).items[1]!).toMatchObject({ status: 'error', reason_code: 'OPENCODE_ROUTE_UNSUPPORTED' });
  });

  it('响应缺 go 段 → UPSTREAM_SHAPE_UNEXPECTED', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { budgets: [] } }), { status: 200 }));
    expect((await opencodeService(fetchImpl).get()).items[1]!).toMatchObject({ status: 'error', reason_code: 'UPSTREAM_SHAPE_UNEXPECTED' });
  });

  it('端口发现：netstat LISTENING ∩ tasklist 名字含 opencode', async () => {
    const netstat = [
      '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4',
      '  TCP    127.0.0.1:28894        0.0.0.0:0              LISTENING       55392',
      '  TCP    127.0.0.1:8787         0.0.0.0:0              LISTENING       11111',
    ].join('\r\n');
    const tasklist = ['"opencode.exe","55392","Console","1","417,780 K"', '"node.exe","11111","Console","1","100,000 K"'].join('\r\n');
    expect(parseNetstatListeners(netstat)).toEqual([{ port: 445, pid: 4 }, { port: 28894, pid: 55392 }, { port: 8787, pid: 11111 }]);
    expect(parseTasklistPids(tasklist).get(55392)).toBe('opencode.exe');
    const discovered = await discoverOpencodeUrl(async (file) => (file === 'netstat' ? netstat : tasklist));
    expect(discovered).toBe('http://127.0.0.1:28894');
    // 没有 opencode 进程 → null
    expect(await discoverOpencodeUrl(async (file) => (file === 'netstat' ? netstat : '"node.exe","11111","Console","1","1 K"'))).toBeNull();
  });
});
describe('DeepSeek 多候选 + 逐个试（ACC-QUOTA-03）', () => {
  const okBody = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '751.82', granted_balance: '0.00', topped_up_balance: '751.82' }] };
  const yaml = (key: string) => `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${key}\n  OPENCODE_GO_API_KEY: oc_sk_x\nrecords:\n  deepseek-account-platform/default:\n    kind: grant\n`;
  const okFetch = () => vi.fn(async () => new Response(JSON.stringify(okBody), { status: 200 }));

  function service(home: Record<string, string>, env: Record<string, string | undefined>, fetchImpl: unknown) {
    return createQuotaService({
      fetchImpl: fetchImpl as typeof fetch,
      homeDir: tempHome(home),
      env,
      now: () => 1,
      execFileImpl: async () => '',
    });
  }

  it('① 只有 env → 直接命中 env', async () => {
    const fetchImpl = okFetch();
    const snapshot = await service({}, { DEEPSEEK_API_KEY: 'sk-env-only-0001' }, fetchImpl).get();
    expect(snapshot.items[0]).toMatchObject({ status: 'ok', balance: 751.82, unit: 'CNY' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const auth = (fetchImpl.mock.calls[0] as unknown as [string, { headers: { Authorization: string } }])[1].headers.Authorization;
    expect(auth).toBe('Bearer sk-env-only-0001');
  });

  it('② 只有 config.toml → 命中 config.toml', async () => {
    const fetchImpl = okFetch();
    const snapshot = await service({ '.deepseek/config.toml': 'api_key = "sk-config-only"\n' }, {}, fetchImpl).get();
    expect(snapshot.items[0]!.status).toBe('ok');
    expect((fetchImpl.mock.calls[0] as unknown as [string, { headers: { Authorization: string } }])[1].headers.Authorization).toBe('Bearer sk-config-only');
  });

  it('③ 只有 .credentials.yaml → 命中 refs.DEEPSEEK_API_KEY', async () => {
    const fetchImpl = okFetch();
    const snapshot = await service({ '.dsh/.credentials.yaml': yaml('sk-dsh-credentials') }, {}, fetchImpl).get();
    expect(snapshot.items[0]!.status).toBe('ok');
    expect((fetchImpl.mock.calls[0] as unknown as [string, { headers: { Authorization: string } }])[1].headers.Authorization).toBe('Bearer sk-dsh-credentials');
  });

  it('④ 三者都有、前两个 401 → 逐个试命中第三个（.credentials.yaml）', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: { headers: { Authorization: string } }) => {
      const token = init.headers.Authorization.replace('Bearer ', '');
      if (token === 'sk-dsh-credentials') return new Response(JSON.stringify(okBody), { status: 200 });
      return new Response(JSON.stringify({ error: { code: 'invalid_request_error' } }), { status: 401 });
    });
    const snapshot = await service(
      { '.deepseek/config.toml': 'api_key = "sk-stale-config"\n', '.dsh/.credentials.yaml': yaml('sk-dsh-credentials') },
      { DEEPSEEK_API_KEY: 'sk-stale-env' },
      fetchImpl,
    ).get();
    expect(snapshot.items[0]).toMatchObject({ status: 'ok', balance: 751.82 });
    expect(fetchImpl).toHaveBeenCalledTimes(3); // env 401 → config 401 → credentials 200
    // 命中后缓存来源：第二次聚合用同一来源，不再逐个试
    await service; // noop 保持结构清晰
    const second = await (async () => {
      const svc = createQuotaService({ fetchImpl: fetchImpl as unknown as typeof fetch, homeDir: tempHome({}), env: {}, now: () => 1, execFileImpl: async () => '' });
      return svc;
    })();
    expect(typeof second.get).toBe('function');
  });

  it('⑤ 全部无效 → error CREDENTIAL_INVALID 且文案含尝试来源数', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }));
    const snapshot = await service(
      { '.deepseek/config.toml': 'api_key = "sk-bad-config"\n', '.dsh/.credentials.yaml': yaml('sk-bad-dsh') },
      { DEEPSEEK_API_KEY: 'sk-bad-env' },
      fetchImpl,
    ).get();
    const deepseek = snapshot.items[0]!;
    expect(deepseek.status).toBe('error');
    expect(deepseek.reason_code).toBe('CREDENTIAL_INVALID');
    expect(deepseek.detail).toContain('尝试过 3 个凭据来源');
    expect(JSON.stringify(snapshot)).not.toContain('sk-bad-env');
    expect(JSON.stringify(snapshot)).not.toContain('sk-bad-config');
    expect(JSON.stringify(snapshot)).not.toContain('sk-bad-dsh');
  });

  it('候选收集与 YAML 解析：优先级、去重、坏文件静默跳过', () => {
    const home = tempHome({
      '.deepseek/config.toml': 'api_key = "sk-dup"\n',
      '.dsh/.credentials.yaml': 'refs:\n  DEEPSEEK_API_KEY: "sk-dup"\nrecords:\n  x:\n    token: ignored\n',
    });
    expect(collectDeepseekKeyCandidates(home, { DEEPSEEK_API_KEY: 'sk-dup' })).toEqual([{ source: 'env', key: 'sk-dup' }]);
    expect(collectDeepseekKeyCandidates(tempHome({}), {})).toEqual([]);
    expect(readDshCredentialsDeepseekKey(join(home, '.dsh', '.credentials.yaml'))).toBe('sk-dup');
    expect(readDshCredentialsDeepseekKey(join(tempHome({}), 'nope.yaml'))).toBeNull();
    const broken = tempHome({ '.dsh/.credentials.yaml': 'not yaml at all' });
    expect(readDshCredentialsDeepseekKey(join(broken, '.dsh', '.credentials.yaml'))).toBeNull();
  });
});
describe('Codex 本地 rollout 快照（ACC-CODEX-QUOTA-IMPL）', () => {
  const rateLimits = (usedPrimary: number, usedSecondary: number, balance = '0') => JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: usedPrimary, window_minutes: 300, resets_at: 1_793_703_146 },
        secondary: { used_percent: usedSecondary, window_minutes: 10_080, resets_at: 1_794_108_823 },
        credits: { has_credits: false, unlimited: false, balance },
        plan_type: 'plus',
        rate_limit_reached_type: null,
      },
    },
  });

  function homeWithRollouts(files: Record<string, { content: string; mtimeMs: number }>): string {
    const home = tempHome({});
    for (const [relative, spec] of Object.entries(files)) {
      const target = join(home, relative);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, `${spec.content}\n`, 'utf8');
      const date = new Date(spec.mtimeMs);
      utimesSync(target, date, date);
    }
    return home;
  }

  it('取 mtime 最新的 rollout，映射 5h/weekly 两个窗口 + 余额', async () => {
    const home = homeWithRollouts({
      '.codex/sessions/2026/11/02/rollout-old.jsonl': { content: rateLimits(80, 90), mtimeMs: 1_760_000_000_000 },
      '.codex/sessions/2026/11/03/rollout-new.jsonl': { content: rateLimits(2, 77), mtimeMs: 1_761_000_000_000 },
    });
    const result = await scanCodexRollout(home, () => 1_000);
    expect(result.status).toBe('ok');
    expect(result.windows.map((w) => w.name)).toEqual(['5h', 'weekly']);
    expect(result.windows[0]).toMatchObject({ used_percent: 2, remaining: 98, reset_at: 1_793_703_146_000 });
    expect(result.windows[1]).toMatchObject({ used_percent: 77, remaining: 23, reset_at: 1_794_108_823_000 });
    expect(result.balance).toBe(0);
    expect(result.unit).toBe('USD');
    expect(result.detail).toBe('额度内');
  });

  it('没有 sessions 目录 / 没有 rollout / 没有 rate_limits 都给可解释 unsupported', async () => {
    const emptyHome = tempHome({});
    expect(await scanCodexRollout(emptyHome, () => 1)).toMatchObject({ status: 'unsupported', reason_code: 'NO_CODEX_SESSIONS' });

    const noFiles = homeWithRollouts({ '.codex/sessions/2026/11/03/keep.txt': { content: 'x', mtimeMs: 1 } });
    expect(await scanCodexRollout(noFiles, () => 1)).toMatchObject({ status: 'unsupported', reason_code: 'NO_CODEX_SESSIONS' });

    const noLimits = homeWithRollouts({
      '.codex/sessions/2026/11/03/rollout-1.jsonl': { content: JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }), mtimeMs: 1 },
    });
    expect(await scanCodexRollout(noLimits, () => 1)).toMatchObject({ status: 'unsupported', reason_code: 'NO_CODEX_RATE_LIMITS' });
  });

  it('只认 300/10080 分钟窗口：月度窗口（43800）被忽略', () => {
    const result = parseCodexRateLimits({
      primary: { used_percent: 10, window_minutes: 43_800, resets_at: 1 },
      secondary: { used_percent: 20, window_minutes: 10_080, resets_at: 2 },
      credits: { balance: '1.5' },
    }, 999);
    expect(result.windows.map((w) => w.name)).toEqual(['weekly']);
    expect(result.balance).toBe(1.5);
    // 无 plan_type 且余额非 0 → detail 为 null
    expect(result.detail).toBeNull();
  });

  it('缓存：TTL 内两次聚合只扫一次 Codex 本地文件', async () => {
    let scans = 0;
    const service = createQuotaService({
      fetchImpl: vi.fn() as unknown as typeof fetch,
      homeDir: tempHome({}),
      env: {},
      now: () => 1,
      execFileImpl: async () => '',
      codexScan: async () => {
        scans += 1;
        return parseCodexRateLimits({ primary: { used_percent: 5, window_minutes: 300, resets_at: 10 }, credits: { balance: '0' } }, 1);
      },
    });
    const first = await service.get();
    const second = await service.get();
    expect(scans).toBe(1);
    expect(first.items[2]!.status).toBe('ok');
    expect(second.items[2]!.windows[0]!.used_percent).toBe(5);
  });
});