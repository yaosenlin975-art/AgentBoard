/**
 * ACC-UI-01 账号管理页重设计（能力图标徽标 + 主从布局）。
 * ACC-UI-PRUNE：平台级签到行头与「技术信息」折叠已删，签到统一走一键签到。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { AccountCapability, PublicManagedAccount } from '@agentboard/shared';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { server } from './server';

type AccountView = PublicManagedAccount & { is_current: boolean | null };

function account(id: string, app: AccountView['app_id'], name: string, overrides: Partial<AccountView> = {}): AccountView {
  return {
    id, app_id: app, client_instance_id: `inst-${id}`, service_region: 'cn', display_name: name,
    identity_hint: 'a1b2c3d4', client_snapshot_version: 1, checkin_capability: 'supported', enabled: true,
    last_checkin_day: null, last_checkin_status: null, last_checkin_at: null, created_at: 1, updated_at: 2,
    is_current: false, ...overrides,
  };
}

const CAPABILITIES: AccountCapability[] = [
  { app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: true, capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived' },
  { app_id: 'minimax', capture: true, switch: false, checkin: true, capture_reason_code: 'OK', switch_reason_code: 'CLIENT_NOT_INSTALLED', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'CLIENT_NOT_INSTALLED', source: 'derived' },
  { app_id: 'trae', capture: false, switch: false, checkin: true, capture_reason_code: 'LOGIN_STATE_NOT_FILE_BASED', switch_reason_code: 'LOGIN_STATE_NOT_FILE_BASED', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'LOGIN_STATE_NOT_FILE_BASED', source: 'derived' },
];

const ACCOUNTS: AccountView[] = [
  account('wb-1', 'workbuddy_desktop', 'WB 主号', { is_current: true }),
  account('mm-1', 'minimax', 'MM 账号', { is_current: null }),
  account('tr-1', 'trae', 'TRAE 账号', { is_current: null }),
];

const QUOTA = {
  workspace_id: null,
  fetched_at: 1_700_000_000_000,
  items: [
    { source: 'deepseek', status: 'ok', balance: 751.81, unit: 'CNY', windows: [], fetched_at: 1_700_000_000_000, reason_code: null, detail: null },
    { source: 'opencode_go', status: 'ok', balance: null, unit: '%', windows: [{ name: '5h', remaining: 99, used_percent: 1, reset_at: 1_793_700_257_000 }], fetched_at: 1_700_000_000_000, reason_code: null, detail: '工作区：Default' },
    { source: 'codex', status: 'unsupported', balance: null, unit: null, windows: [], fetched_at: 1_700_000_000_000, reason_code: 'NO_PUBLIC_QUOTA_ENDPOINT', detail: null },
  ],
};

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><AccountsPanel /></QueryClientProvider>);
}

beforeEach(() => {
  server.resetHandlers();
  server.use(
    http.get('/api/managed-account-capabilities', () => HttpResponse.json(CAPABILITIES)),
    http.get('/api/managed-accounts', () => HttpResponse.json(ACCOUNTS)),
    http.get('/api/managed-account-quotas', () => HttpResponse.json(QUOTA)),
  );
});

describe('账号页重设计（ACC-UI-01）', () => {
  it('主从布局：默认选中第一个平台且右栏展开；切平台后只渲染该平台（再无六行折叠）', async () => {
    renderPanel();

    // 默认选中第一个平台，右栏 body 直接可见（不再是「全折叠」）
    const wbBody = await screen.findByTestId('accounts-body-workbuddy_desktop');
    expect(wbBody).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('accounts-index-item-workbuddy_desktop')).toHaveAttribute('aria-selected', 'true');
    // 未选中的平台整体不渲染（结构上消除六平台同屏）
    expect(screen.queryByTestId('accounts-body-minimax')).toBeNull();
    expect(screen.queryByTestId('accounts-body-trae')).toBeNull();

    // 切到 MiniMax：左栏选中态切换，右栏换成 MiniMax 且 WorkBuddy 消失
    await userEvent.click(screen.getByTestId('accounts-index-item-minimax'));
    const mmBody = await screen.findByTestId('accounts-body-minimax');
    expect(mmBody).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('accounts-index-item-minimax')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('accounts-index-item-workbuddy_desktop')).toHaveAttribute('aria-selected', 'false');
    expect(screen.queryByTestId('accounts-body-workbuddy_desktop')).toBeNull();
  });

  it('能力徽标已整行删除（accounts-redesign 方向 B）：右栏不再渲染三图标，异常以文字提示', async () => {
    renderPanel();
    await screen.findByTestId('accounts-app-workbuddy_desktop');

    // workbuddy 三项全可用：正常态不占像素，不渲染任何能力徽标
    for (const action of ['capture', 'switch', 'checkin']) {
      expect(screen.queryByTestId(`accounts-badge-workbuddy_desktop-${action}`)).toBeNull();
    }

    // minimax：switch 不可用（CLIENT_NOT_INSTALLED）→ 异常仍可见，落平台级文字提示
    await userEvent.click(screen.getByTestId('accounts-index-item-minimax'));
    const mmBody = await screen.findByTestId('accounts-body-minimax');
    expect(within(mmBody).queryByTestId('accounts-badge-minimax-switch')).toBeNull();
    const switchReason = within(mmBody).getByTestId('accounts-switch-unavailable-minimax');
    expect(switchReason).toHaveTextContent('切换不可用');
    expect(switchReason).toHaveAttribute('title', expect.stringContaining('CLIENT_NOT_INSTALLED'));

    // trae：capture 不可用同理，不给徽标（异常提示只承载可操作的出路）
    await userEvent.click(screen.getByTestId('accounts-index-item-trae'));
    const trBody = await screen.findByTestId('accounts-body-trae');
    expect(within(trBody).queryByTestId('accounts-badge-trae-capture')).toBeNull();
  });

  it('能力矩阵未取到：错误提示可见，徽标不渲染（不再有 ? 态）', async () => {
    server.use(http.get('/api/managed-account-capabilities', () => HttpResponse.json({ error: { code: 'INTERNAL', message: '能力矩阵不可用' } }, { status: 500 })));
    renderPanel();

    await screen.findByTestId('accounts-app-workbuddy_desktop');
    expect(await screen.findByTestId('accounts-capabilities-error')).toBeInTheDocument();
    expect(screen.queryByTestId('accounts-badge-workbuddy_desktop-capture')).toBeNull();
  });

  it('额度面板整块移除；CLI 三来源有登记账号时改为紧凑平台行并入列表', async () => {
    // ADD-FLOW-2（口径 A）：来源行只在有登记账号时出现，先给三来源各一条登记结果
    server.use(http.get('/api/cli-accounts', () => HttpResponse.json({
      items: [
        { id: 'd-1', app_id: 'deepseek', identity_hint: 'sha256:aaaaaaaaaaaa', created_at: 1, last_seen_at: 2 },
        { id: 'o-1', app_id: 'opencode_go', identity_hint: 'sha256:bbbbbbbbbbbb', created_at: 1, last_seen_at: 2 },
        { id: 'c-1', app_id: 'codex', identity_hint: 'sha256:cccccccccccc', created_at: 1, last_seen_at: 2 },
      ],
    })));
    renderPanel();
    await screen.findByTestId('accounts-index');

    // 图1 的额度段（CLI 额度 / 平台账号额度 / 缓存脚注）不再渲染
    expect(screen.queryByTestId('quota-rows')).toBeNull();
    expect(screen.queryByTestId('accounts-quota-rows')).toBeNull();
    expect(screen.queryByTestId('quota-row-deepseek')).toBeNull();
    expect(screen.queryByText(/服务端 60s 缓存/)).toBeNull();

    // 三来源以与平台一致的索引行出现，点击进入右侧只读详情（ACC-CLI-MULTI 后不再是占位文案）
    for (const app of ['deepseek', 'opencode_go', 'codex']) {
      expect(screen.getByTestId(`accounts-index-item-${app}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('accounts-index-item-deepseek')).toHaveTextContent('DeepSeek');
    expect(screen.getByTestId('accounts-index-item-opencode_go')).toHaveTextContent('OpenCode-Go');
    expect(screen.getByTestId('accounts-index-item-codex')).toHaveTextContent('Codex');
    // 无登记账号的来源不占行
    expect(screen.queryByTestId('accounts-index-item-commandcode')).toBeNull();

    await userEvent.click(screen.getByTestId('accounts-index-item-deepseek'));
    expect(await screen.findByTestId('accounts-source-switch-note-deepseek')).toBeInTheDocument();
  });

  it('ACC-UI-PRUNE/TOPBAR：「技术信息」折叠与积分徽标已删，「其中 N 个参与一键签到」摘要也已删', async () => {
    renderPanel();
    await screen.findByTestId('accounts-app-workbuddy_desktop');

    expect(screen.queryByTestId('accounts-capability-details-workbuddy_desktop')).toBeNull();
    expect(screen.queryByTestId('accounts-capability-workbuddy_desktop')).toBeNull();
    expect(screen.queryByTestId('accounts-capability-source-workbuddy_desktop')).toBeNull();
    expect(screen.queryByText('技术信息')).toBeNull();
    expect(screen.queryByTestId('accounts-summary-workbuddy_desktop')).toBeNull();
    expect(screen.queryByText('共 1 个账号')).toBeNull();
  });
});
