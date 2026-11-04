/**
 * ACC-KB-B2W：协议级「添加账号」向导（前端）。
 *
 * 覆盖卡面验收的每一条：
 * 1. **按平台分支**：五个平台各自的添加态按钮与文案正确（device code / 设备授权 / CLI / 浏览器登录 / 本地回调）；
 * 2. **不支持的平台不出现可点但必然失败的入口**：未装配协议的平台只给 reason 文案，**没有按钮**；
 * 3. **能力矩阵读取失败时不回退本地副本**：同样不给入口；
 * 4. **轮询与终态**：pending → authorized 时账号列表重新拉取（新账号出现在列表里）；failed/expired 给中文原因；
 * 5. **放弃授权**：DELETE 会话 → 状态 cancelled、不建账号。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { AccountCapability, PublicManagedAccount } from '@agentboard/shared';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { server } from './server';

const CAPS: AccountCapability[] = [
  { app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: true, capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived' },
  { app_id: 'minimax', capture: true, switch: false, checkin: true, capture_reason_code: 'OK', switch_reason_code: 'CLIENT_NOT_INSTALLED', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'CLIENT_NOT_INSTALLED', source: 'derived' },
  { app_id: 'trae', capture: false, switch: false, checkin: true, capture_reason_code: 'LOGIN_STATE_NOT_FILE_BASED', switch_reason_code: 'LOGIN_STATE_NOT_FILE_BASED', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'LOGIN_STATE_NOT_FILE_BASED', source: 'derived' },
  // qoder_cn / zcode 不在 APP_ORDER（面板走「其它平台」分区），但同样要有添加账号入口
  { app_id: 'qoder_cn', capture: false, switch: false, checkin: false, capture_reason_code: 'PROVIDER_NOT_IMPLEMENTED', switch_reason_code: 'PROVIDER_NOT_IMPLEMENTED', checkin_reason_code: 'CHECKIN_PROVIDER_UNVERIFIED', reason_code: 'PROVIDER_NOT_IMPLEMENTED', source: 'static' },
  { app_id: 'zcode', capture: false, switch: false, checkin: false, capture_reason_code: 'PROVIDER_NOT_IMPLEMENTED', switch_reason_code: 'PROVIDER_NOT_IMPLEMENTED', checkin_reason_code: 'CHECKIN_PROVIDER_UNVERIFIED', reason_code: 'PROVIDER_NOT_IMPLEMENTED', source: 'static' },
];

const SESSION_ID = '66666666-6666-4666-8666-666666666666';

function account(overrides: Partial<PublicManagedAccount> = {}): PublicManagedAccount & { is_current: boolean | null } {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    app_id: 'workbuddy_desktop',
    client_instance_id: 'wb-inst-1',
    service_region: 'cn',
    display_name: 'WorkBuddy 账号',
    identity_hint: 'a1b2c3d4',
    client_snapshot_version: 1,
    checkin_capability: 'supported',
    enabled: true,
    last_checkin_day: null,
    last_checkin_status: null,
    last_checkin_at: null,
    created_at: 1,
    updated_at: 2,
    is_current: false,
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    app_id: 'workbuddy_desktop',
    protocol: 'workbuddy_oneid',
    status: 'pending',
    service_region: 'cn',
    authorization_url: 'https://www.codebuddy.cn/auth?state=abc',
    user_code: null,
    account_id: null,
    safe_error_code: null,
    created_at: 1,
    updated_at: 2,
    expires_at: Date.now() + 300_000,
    ...overrides,
  };
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><AccountsPanel /></QueryClientProvider>);
}

/** 打开某平台的「添加账号」向导（入口在平台行展开层内，先展开再点） */
async function openWizard(app: string) {
  await userEvent.click(await screen.findByTestId(`accounts-toggle-${app}`));
  await userEvent.click(await screen.findByTestId(`accounts-add-${app}`));
  await screen.findByTestId(`accounts-add-panel-${app}`);
}

beforeEach(() => {
  server.resetHandlers();
  server.use(
    http.get('/api/managed-account-capabilities', () => HttpResponse.json(CAPS)),
    http.get('/api/managed-accounts', () => HttpResponse.json([])),
  );
});

describe('协议级添加账号入口（ACC-KB-B2W）', () => {
  it('已装配协议的平台给出「添加账号」按钮；未装配的平台只给 reason 文案、没有按钮', async () => {
    server.use(http.get('/api/add-account-protocols', () => HttpResponse.json({
      items: [
        { app_id: 'workbuddy_desktop', protocol: 'workbuddy_oneid', provider_version: 'v1', requires_browser: true, regions: ['cn', 'global'] },
      ],
    })));
    renderPanel();

    await screen.findByTestId('accounts-overview');
    // workbuddy 装配了协议 → 有入口按钮
    await userEvent.click(await screen.findByTestId('accounts-toggle-workbuddy_desktop'));
    expect(screen.getByTestId('accounts-add-workbuddy_desktop')).toBeInTheDocument();
    // minimax / trae 没装配 → 只有 reason 文案，**没有按钮**（不出现点了必然失败的入口）
    await userEvent.click(screen.getByTestId('accounts-toggle-minimax'));
    await userEvent.click(screen.getByTestId('accounts-toggle-trae'));
    expect(screen.getByTestId('accounts-add-unsupported-minimax')).toHaveTextContent('该平台不支持协议级添加账号');
    expect(screen.getByTestId('accounts-add-unsupported-trae')).toHaveTextContent('该平台不支持协议级添加账号');
    expect(screen.queryByTestId('accounts-add-minimax')).not.toBeInTheDocument();
    expect(screen.queryByTestId('accounts-add-trae')).not.toBeInTheDocument();
  });

  it('协议清单读取失败时不给入口（不回退本地副本），只给失败说明', async () => {
    server.use(http.get('/api/add-account-protocols', () =>
      HttpResponse.json({ error: { code: 'INTERNAL', message: '协议清单读取失败' } }, { status: 500 })));
    renderPanel();

    await screen.findByTestId('accounts-overview');
    await userEvent.click(await screen.findByTestId('accounts-toggle-workbuddy_desktop'));
    expect(screen.getByTestId('accounts-add-unsupported-workbuddy_desktop')).toHaveTextContent('添加账号能力读取失败');
    expect(screen.queryByTestId('accounts-add-workbuddy_desktop')).not.toBeInTheDocument();
  });

  it('五平台各自的添加态文案正确：设备码 / 设备授权 / CLI / 浏览器登录 / 本地回调', async () => {
    server.use(http.get('/api/add-account-protocols', () => HttpResponse.json({
      items: [
        { app_id: 'minimax', protocol: 'minimax_device', provider_version: 'v1', requires_browser: true, regions: ['cn', 'global'] },
        { app_id: 'qoder_cn', protocol: 'qoder_device', provider_version: 'v1', requires_browser: true, regions: ['cn'] },
        { app_id: 'zcode', protocol: 'zcode_cli', provider_version: 'v1', requires_browser: true, regions: ['cn', 'global'] },
        { app_id: 'workbuddy_desktop', protocol: 'workbuddy_oneid', provider_version: 'v1', requires_browser: true, regions: ['cn', 'global'] },
        { app_id: 'trae', protocol: 'trae_oauth', provider_version: 'v1', requires_browser: true, regions: ['cn'] },
      ],
    })));
    renderPanel();

    await screen.findByTestId('accounts-overview');
    // qoder_cn / zcode 在「其它平台」分区里（不在 APP_ORDER），同样要有入口
    await userEvent.click(await screen.findByTestId('accounts-toggle-minimax'));
    expect(screen.getByTestId('accounts-add-flow-minimax')).toHaveTextContent('设备码');
    await userEvent.click(screen.getByTestId('accounts-toggle-trae'));
    expect(screen.getByTestId('accounts-add-flow-trae')).toHaveTextContent('本地回调');

    await userEvent.click(screen.getByTestId('accounts-toggle-workbuddy_desktop'));
    expect(screen.getByTestId('accounts-add-flow-workbuddy_desktop')).toHaveTextContent('浏览器登录');
    await userEvent.click(screen.getByTestId('accounts-toggle-qoder_cn'));
    expect(screen.getByTestId('accounts-add-flow-qoder_cn')).toHaveTextContent('设备授权');
    await userEvent.click(screen.getByTestId('accounts-toggle-zcode'));
    expect(screen.getByTestId('accounts-add-flow-zcode')).toHaveTextContent('CLI 授权');

    // 引导文案在展开的向导里（Trae 强调「同一台机器的浏览器」）
    await userEvent.click(screen.getByTestId('accounts-add-trae'));
    expect(await screen.findByTestId('accounts-add-instruction-trae')).toHaveTextContent('同一台机器');
  });

  it('只有一个区的平台不显示区域选择；多区平台可选中国区/国际区', async () => {
    server.use(http.get('/api/add-account-protocols', () => HttpResponse.json({
      items: [
        { app_id: 'minimax', protocol: 'minimax_device', provider_version: 'v1', requires_browser: true, regions: ['cn', 'global'] },
        { app_id: 'trae', protocol: 'trae_oauth', provider_version: 'v1', requires_browser: true, regions: ['cn'] },
      ],
    })));
    renderPanel();
    await screen.findByTestId('accounts-overview');

    await userEvent.click(await screen.findByTestId('accounts-toggle-trae'));
    await userEvent.click(await screen.findByTestId('accounts-add-trae'));
    // trae 只有中国区 → 不给区域选择
    expect(screen.queryByTestId('accounts-add-region-trae-cn')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('accounts-add-close-trae'));
    await userEvent.click(screen.getByTestId('accounts-toggle-minimax'));
    await userEvent.click(await screen.findByTestId('accounts-add-minimax'));
    expect(screen.getByTestId('accounts-add-region-minimax-cn')).toBeInTheDocument();
    expect(screen.getByTestId('accounts-add-region-minimax-global')).toBeInTheDocument();
  });
});

describe('添加账号流程（ACC-KB-B2W）', () => {
  it('发起授权 → 展示授权地址与设备码 → 轮询成功后账号列表重新拉取', async () => {
    const starts: unknown[] = [];
    let accountLists = 0;
    server.use(
      http.get('/api/managed-accounts', () => {
        accountLists += 1;
        // 第二次拉取时新账号已经在列表里
        return HttpResponse.json(accountLists === 1 ? [] : [account({ display_name: '新加的账号' })]);
      }),
      http.post('/api/add-account-sessions', async ({ request }) => {
        starts.push(await request.json());
        return HttpResponse.json({ session: session({ protocol: 'minimax_device', app_id: 'minimax', authorization_url: 'https://account.minimax.cn/device?code=X', user_code: 'ABCD-1234' }) }, { status: 202 });
      }),
      http.post('/api/add-account-sessions/:id/poll', () => HttpResponse.json({
        session: session({ protocol: 'minimax_device', app_id: 'minimax', status: 'authorized', account_id: '88888888-8888-4888-8888-888888888888' }),
        account: account({ id: '88888888-8888-4888-8888-888888888888', display_name: '新加的账号' }),
      })),
    );
    renderPanel();
    await screen.findByTestId('accounts-overview');
    await userEvent.click(await screen.findByTestId('accounts-toggle-minimax'));
    await userEvent.click(await screen.findByTestId('accounts-add-minimax'));

    // 发起授权：请求体带 app_id + region
    await userEvent.click(await screen.findByTestId('accounts-add-start-minimax'));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]).toEqual({ app_id: 'minimax', region: 'cn' });

    // 授权地址 + 设备码都展示出来
    const url = await screen.findByTestId('accounts-add-url-minimax');
    expect(url).toHaveAttribute('href', 'https://account.minimax.cn/device?code=X');
    expect(await screen.findByTestId('accounts-add-code-minimax')).toHaveTextContent('ABCD-1234');

    // 轮询 → authorized → 账号列表重新拉取，新账号出现
    await userEvent.click(await screen.findByTestId('accounts-add-check-minimax'));
    await waitFor(() => expect(accountLists).toBeGreaterThan(1));
    expect(await screen.findByText('新加的账号')).toBeInTheDocument();
  });

  it('轮询失败（平台拒绝授权）给中文原因，裸码只进可展开技术码', async () => {
    server.use(
      http.post('/api/add-account-sessions', () => HttpResponse.json({ session: session() }, { status: 202 })),
      http.post('/api/add-account-sessions/:id/poll', () => HttpResponse.json({
        session: session({ status: 'failed', safe_error_code: 'MINIMAX_ACCESS_DENIED' }),
        account: null,
      })),
    );
    renderPanel();
    await screen.findByTestId('accounts-overview');
    await openWizard('workbuddy_desktop');

    await userEvent.click(await screen.findByTestId('accounts-add-start-workbuddy_desktop'));
    await userEvent.click(await screen.findByTestId('accounts-add-check-workbuddy_desktop'));

    const reason = await screen.findByTestId('accounts-add-notice-reason-workbuddy_desktop');
    expect(reason).toHaveTextContent('授权被拒绝，未添加账号');
    // 裸码不进主文案，只在可展开技术码里
    expect(reason.textContent ?? '').not.toContain('MINIMAX_ACCESS_DENIED');
    const details = await screen.findByTestId('accounts-add-notice-code-workbuddy_desktop');
    expect(details.tagName).toBe('DETAILS');
    expect(details.textContent).toContain('MINIMAX_ACCESS_DENIED');
  });

  it('发起授权被拒（503 设备身份缺失）时给中文原因，不静默失败', async () => {
    server.use(
      http.post('/api/add-account-sessions', () => HttpResponse.json({
        error: { code: 'TRAE_DEVICE_IDENTITY_UNAVAILABLE', message: '读不到本机 Trae 客户端的设备身份，Trae 加号不可用' },
      }, { status: 503 })),
    );
    renderPanel();
    await screen.findByTestId('accounts-overview');
    await openWizard('trae');

    await userEvent.click(await screen.findByTestId('accounts-add-start-trae'));
    const reason = await screen.findByTestId('accounts-add-notice-reason-trae');
    expect(reason).toHaveTextContent('读不到本机客户端设备身份，无法添加账号');
    expect(reason.textContent ?? '').not.toContain('TRAE_DEVICE_IDENTITY_UNAVAILABLE');
  });

  it('取消授权：会话置 cancelled，不建账号、不轮询', async () => {
    let polls = 0;
    let deletes = 0;
    server.use(
      http.post('/api/add-account-sessions', () => HttpResponse.json({ session: session() }, { status: 202 })),
      http.post('/api/add-account-sessions/:id/poll', () => {
        polls += 1;
        return HttpResponse.json({ session: session(), account: null });
      }),
      http.delete('/api/add-account-sessions/:id', () => {
        deletes += 1;
        return HttpResponse.json({ session: session({ status: 'cancelled', safe_error_code: 'AUTHORIZATION_CANCELLED' }) });
      }),
    );
    renderPanel();
    await screen.findByTestId('accounts-overview');
    await openWizard('workbuddy_desktop');

    await userEvent.click(await screen.findByTestId('accounts-add-start-workbuddy_desktop'));
    await userEvent.click(await screen.findByTestId('accounts-add-cancel-workbuddy_desktop'));

    await waitFor(() => expect(deletes).toBe(1));
    expect(await screen.findByTestId('accounts-add-status-workbuddy_desktop')).toHaveTextContent('已取消添加账号，未创建任何账号');
    expect(polls).toBe(0);
  });

  it('向导在平台行的展开层内：折叠时不可见', async () => {
    renderPanel();
    await screen.findByTestId('accounts-overview');
    expect(screen.getByTestId('accounts-body-workbuddy_desktop')).toHaveAttribute('hidden');
    await userEvent.click(await screen.findByTestId('accounts-toggle-workbuddy_desktop'));
    const body = screen.getByTestId('accounts-body-workbuddy_desktop');
    expect(body).not.toHaveAttribute('hidden');
    expect(within(body).getByTestId('accounts-add-workbuddy_desktop')).toBeInTheDocument();
  });
});
