/**
 * ACC-UI-01 账号管理页重设计：平台折叠分区 + 能力图标徽标 + DeepSeek 一行 + 平台级签到。
 * 设计：Docs/design-2026-11-03-accounts-panel-redesign.md（D1/D2/D3/D4/D5）。
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
  it('平台分区可折叠：默认第一个展开、其余折叠；点头部可展开/收起', async () => {
    renderPanel();

    const wbBody = await screen.findByTestId('accounts-body-workbuddy_desktop');
    const mmBody = screen.getByTestId('accounts-body-minimax');
    const trBody = screen.getByTestId('accounts-body-trae');
    expect(wbBody).not.toHaveAttribute('hidden');
    expect(mmBody).toHaveAttribute('hidden');
    expect(trBody).toHaveAttribute('hidden');

    // 头部 toggle 的 aria-expanded 与 body 的 hidden 一致
    expect(screen.getByTestId('accounts-toggle-workbuddy_desktop')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('accounts-toggle-minimax')).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(screen.getByTestId('accounts-toggle-minimax'));
    expect(screen.getByTestId('accounts-body-minimax')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('accounts-toggle-minimax')).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(screen.getByTestId('accounts-toggle-workbuddy_desktop'));
    expect(screen.getByTestId('accounts-body-workbuddy_desktop')).toHaveAttribute('hidden');
  });

  it('能力徽标三态：✓ / ✗ / ?，徽标文本不含原因码，原因只进 tooltip', async () => {
    renderPanel();
    await screen.findByTestId('accounts-app-workbuddy_desktop');

    // workbuddy：capture ✓ switch ✓ checkin ✓（derived）
    for (const action of ['capture', 'switch', 'checkin']) {
      const badge = screen.getByTestId(`accounts-badge-workbuddy_desktop-${action}`);
      expect(badge).toHaveAttribute('data-state', 'available');
      // UNSLOP：三态改为线性图标，状态由 data-state + 图标 + aria-label 三重表达（不再用 ✓ 字形）
      expect(badge.querySelector('svg')).not.toBeNull();
      expect(badge.getAttribute('aria-label')).toContain('可用');
      expect(badge.textContent ?? '').not.toContain('OK');
    }

    // minimax：capture ✓ switch ✗（CLIENT_NOT_INSTALLED 原因只进 tooltip）
    const mmSwitch = screen.getByTestId('accounts-badge-minimax-switch');
    expect(mmSwitch).toHaveAttribute('data-state', 'unavailable');
    expect(mmSwitch.querySelector('svg')).not.toBeNull();
    expect(mmSwitch.getAttribute('aria-label')).toContain('不可用');
    expect(mmSwitch.getAttribute('title')).toContain('本机未安装该客户端');
    expect(mmSwitch.getAttribute('title')).toContain('CLIENT_NOT_INSTALLED');
    expect(mmSwitch.textContent ?? '').not.toContain('CLIENT_NOT_INSTALLED');

    // trae：capture ✗ 原因在 tooltip
    const trCapture = screen.getByTestId('accounts-badge-trae-capture');
    expect(trCapture).toHaveAttribute('data-state', 'unavailable');
    expect(trCapture.getAttribute('title')).toContain('LOGIN_STATE_NOT_FILE_BASED');
  });

  it('能力未知时徽标为 ?（能力矩阵未取到）', async () => {
    server.use(http.get('/api/managed-account-capabilities', () => HttpResponse.json({ error: { code: 'INTERNAL', message: '能力矩阵不可用' } }, { status: 500 })));
    renderPanel();

    const badge = await screen.findByTestId('accounts-badge-workbuddy_desktop-capture');
    expect(badge).toHaveAttribute('data-state', 'unknown');
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(badge.getAttribute('aria-label')).toContain('能力未知');
    expect(badge.getAttribute('title')).toContain('能力未知');
    expect(await screen.findByTestId('accounts-capabilities-error')).toBeInTheDocument();
  });

  it('DeepSeek 压成一行：inline 布局且不出窗口列表；opencode-go / Codex 仍是卡片', async () => {
    renderPanel();

    const deepseek = await screen.findByTestId('quota-card-deepseek');
    expect(deepseek).toHaveAttribute('data-layout', 'inline');
    expect(within(deepseek).getByTestId('quota-balance-deepseek')).toHaveTextContent('¥751.81');
    expect(within(deepseek).queryByTestId('quota-window-deepseek-0')).toBeNull();
    // DeepSeek 行不套卡片边框（只保留其他两块的卡片）
    expect(deepseek.className).not.toContain('rounded-lg');

    const go = screen.getByTestId('quota-card-opencode_go');
    expect(go.className).toContain('rounded-lg');
    expect(within(go).getByTestId('quota-window-opencode_go-0')).toBeInTheDocument();
  });

  it('平台头部「仅此平台签到」：只提交该平台启用账号', async () => {
    const posts: Array<{ body: { app_id: string; account_ids: string[] }; key: string | null }> = [];
    server.use(
      http.post('/api/checkin-runs', async ({ request }) => {
        posts.push({ body: await request.json() as { app_id: string; account_ids: string[] }, key: request.headers.get('Idempotency-Key') });
        return HttpResponse.json({
          batch: { id: '11111111-1111-4111-8111-111111111111', app_id: 'workbuddy_desktop', status: 'queued', total: 1, profile_local_day: '2026-11-03', created_at: 1, finished_at: null, items: [] },
          replayed: false,
        }, { status: 202 });
      }),
      http.get('/api/checkin-runs/:id', () => HttpResponse.json({
        id: '11111111-1111-4111-8111-111111111111', app_id: 'workbuddy_desktop', status: 'queued', total: 1,
        profile_local_day: '2026-11-03', created_at: 1, finished_at: null,
        items: [{ batch_id: '11111111-1111-4111-8111-111111111111', account_id: 'wb-1', seq: 0, state: 'queued', operation_id: null, safe_error_code: null, updated_at: 2 }],
      })),
    );
    renderPanel();

    const wbButton = await screen.findByTestId('accounts-checkin-all-workbuddy_desktop');
    expect(wbButton).toHaveTextContent('仅此平台签到');
    await userEvent.click(wbButton);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ app_id: 'workbuddy_desktop', account_ids: ['wb-1'] });
    expect(posts[0]!.key).toBeTruthy();
  });

  it('既有 testid 映射：accounts-capability-* / accounts-capability-source-* 收进「技术信息」details，accounts-summary-* 仍在平台体内', async () => {
    renderPanel();
    await screen.findByTestId('accounts-app-workbuddy_desktop');

    const details = screen.getByTestId('accounts-capability-details-workbuddy_desktop');
    expect(details.tagName).toBe('DETAILS');
    expect(within(details).getByTestId('accounts-capability-workbuddy_desktop')).toHaveTextContent('捕获 OK');
    expect(within(details).getByTestId('accounts-capability-workbuddy_desktop')).toHaveTextContent('签到 OK');
    expect(within(details).getByTestId('accounts-capability-source-workbuddy_desktop')).toHaveTextContent('由已验证 provider 推导');
    expect(screen.getByTestId('accounts-summary-workbuddy_desktop')).toHaveTextContent('共 1 个账号');
  });
});
