/**
 * ACC-KB-B1W：`APP_ORDER` 之外的平台不静默丢卡。
 *
 * 覆盖三件事：
 * 1. 新增平台（qoder_cn / zcode，服务端能力矩阵已返回但 provider 未实现）进「其它平台」分区，显示名/图标走映射表；
 * 2. 完全未知的 app id 也要渲染出来，显示为「未识别平台」+ `?`，页面文本里不出现裸 id；
 * 3. 已知三平台分区（APP_ORDER）与六行总览不受影响。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { AccountCapability, PublicManagedAccount } from '@agentboard/shared';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { server } from './server';

type AccountView = PublicManagedAccount & { is_current: boolean | null };

function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: 'acc-x',
    app_id: 'workbuddy_desktop',
    client_instance_id: 'inst-x',
    service_region: 'cn',
    display_name: '账号',
    identity_hint: 'aaaa1111',
    client_snapshot_version: 1,
    checkin_capability: 'unsupported',
    enabled: true,
    last_checkin_day: null,
    last_checkin_status: null,
    last_checkin_at: null,
    created_at: 1,
    updated_at: 1,
    is_current: false,
    ...overrides,
  };
}

const CAPABILITIES: AccountCapability[] = [
  { app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: true, capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived' },
  { app_id: 'minimax', capture: true, switch: false, checkin: true, capture_reason_code: 'OK', switch_reason_code: 'CLIENT_NOT_INSTALLED', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'CLIENT_NOT_INSTALLED', source: 'derived' },
  { app_id: 'trae', capture: false, switch: false, checkin: true, capture_reason_code: 'LOGIN_STATE_NOT_FILE_BASED', switch_reason_code: 'LOGIN_STATE_NOT_FILE_BASED', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'LOGIN_STATE_NOT_FILE_BASED', source: 'derived' },
  { app_id: 'qoder_cn', capture: false, switch: false, checkin: false, capture_reason_code: 'PROVIDER_NOT_IMPLEMENTED', switch_reason_code: 'PROVIDER_NOT_IMPLEMENTED', checkin_reason_code: 'PROVIDER_NOT_IMPLEMENTED', reason_code: 'PROVIDER_NOT_IMPLEMENTED', source: 'static' },
  { app_id: 'zcode', capture: false, switch: false, checkin: false, capture_reason_code: 'PROVIDER_NOT_IMPLEMENTED', switch_reason_code: 'PROVIDER_NOT_IMPLEMENTED', checkin_reason_code: 'PROVIDER_NOT_IMPLEMENTED', reason_code: 'PROVIDER_NOT_IMPLEMENTED', source: 'static' },
];

function mount(accounts: AccountView[], capabilities: AccountCapability[] = CAPABILITIES): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  server.use(
    http.get('/api/managed-accounts', () => HttpResponse.json(accounts)),
    http.get('/api/managed-account-capabilities', () => HttpResponse.json(capabilities)),
    http.get('/api/quota-sources', () => HttpResponse.json([])),
  );
  render(
    <QueryClientProvider client={qc}>
      <AccountsPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('其它平台分区（ACC-KB-B1W）', () => {
  it('新增平台账号进「其它平台」分区，显示名走映射表（Qoder CN / ZCode）', async () => {
    mount([
      account({ id: 'acc-wb', app_id: 'workbuddy_desktop' }),
      account({ id: 'acc-qoder', app_id: 'qoder_cn', display_name: 'Qoder 账号' }),
      account({ id: 'acc-zcode', app_id: 'zcode', display_name: 'ZCode 账号' }),
    ]);
    const extra = await screen.findByTestId('accounts-extra-platforms');
    // 按 id 字典序：qoder_cn < zcode
    const rows = [...extra.querySelectorAll('[data-testid^="accounts-app-"]')].map((el) => el.getAttribute('data-testid'));
    expect(rows).toEqual(['accounts-app-qoder_cn', 'accounts-app-zcode']);
    expect(within(extra).getByText('Qoder CN')).toBeInTheDocument();
    expect(within(extra).getByText('ZCode')).toBeInTheDocument();
    // 图标字形来自 platformMeta
    expect(within(extra).getByTestId('accounts-glyph-qoder_cn')).toHaveTextContent('Q');
    expect(within(extra).getByTestId('accounts-glyph-zcode')).toHaveTextContent('Z');
    // 已知平台仍在 APP_ORDER 分区里
    expect(screen.getByTestId('accounts-app-workbuddy_desktop')).toBeInTheDocument();
  });

  it('完全未知的 app id 也渲染：显示「未识别平台」+ ?，页面上不出现裸 id', async () => {
    mount([
      account({ id: 'acc-wb', app_id: 'workbuddy_desktop' }),
      account({ id: 'acc-fixture', app_id: 'some_future_app' as PublicManagedAccount['app_id'], display_name: '夹具账号' }),
    ]);
    const extra = await screen.findByTestId('accounts-extra-platforms');
    expect(within(extra).getByTestId('accounts-app-some_future_app')).toBeInTheDocument();
    expect(within(extra).getByTestId('accounts-glyph-some_future_app')).toHaveTextContent('?');
    expect(within(extra).getByText('未识别平台')).toBeInTheDocument();
    // 账号本身可见（不再静默丢卡）
    expect(screen.getByText('夹具账号')).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain('some_future_app');
  });

  it('能力矩阵只有已知三平台且没有额外账号时，不出「其它平台」分区', async () => {
    mount([account({ id: 'acc-wb', app_id: 'workbuddy_desktop' })], CAPABILITIES.slice(0, 3));
    await screen.findByTestId('accounts-app-workbuddy_desktop');
    expect(screen.queryByTestId('accounts-extra-platforms')).toBeNull();
  });
});
