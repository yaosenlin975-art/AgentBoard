/**
 * ACC-PANEL-03（`Docs/design-2026-11-04-accounts-unified-panel.md` §5/§6，布局方案 C）：
 * 六行总览的结构与排序、签到芯片三态、「今日 n/m」口径、仅额度行不可展开、折叠行点签到自动展开。
 *
 * 口径（拍板）：分子 = `last_checkin_day=今天` 且 `last_checkin_status ∈ {succeeded, already_done}`；
 * `unknown` 不计入分子、芯片加 `?` 角标；`authorized` 不算已完成；分母 = `checkinParticipation` 现有口径。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { AccountCapability, PublicManagedAccount } from '@agentboard/shared';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { localDayKey, summarizeCheckinToday, type CapabilityView } from '../components/settings/accountCapabilities';
import { server } from './server';

type AccountView = PublicManagedAccount & { is_current: boolean | null };

const TODAY = localDayKey(Date.now());
const BATCH_ID = '11111111-1111-4111-8111-111111111111';

function account(id: string, overrides: Partial<AccountView> = {}): AccountView {
  return {
    id, app_id: 'workbuddy_desktop', client_instance_id: `inst-${id}`, service_region: 'cn',
    display_name: `账号 ${id}`, identity_hint: 'a1b2c3d4', client_snapshot_version: 1, checkin_capability: 'supported',
    enabled: true, last_checkin_day: null, last_checkin_status: null, last_checkin_at: null,
    created_at: 1, updated_at: 2, is_current: false, ...overrides,
  };
}

const CAPS: AccountCapability[] = [
  { app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: true, capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived' },
  { app_id: 'minimax', capture: true, switch: false, checkin: true, capture_reason_code: 'OK', switch_reason_code: 'CLIENT_NOT_INSTALLED', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'CLIENT_NOT_INSTALLED', source: 'derived' },
  { app_id: 'trae', capture: false, switch: false, checkin: true, capture_reason_code: 'LOGIN_STATE_NOT_FILE_BASED', switch_reason_code: 'LOGIN_STATE_NOT_FILE_BASED', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'LOGIN_STATE_NOT_FILE_BASED', source: 'derived' },
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

const CHECKIN_OK: CapabilityView = { app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: true, capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived' };

function mockBase(accounts: AccountView[], caps: AccountCapability[] = CAPS) {
  server.use(
    http.get('/api/managed-account-capabilities', () => HttpResponse.json(caps)),
    http.get('/api/managed-accounts', () => HttpResponse.json(accounts)),
    http.get('/api/managed-account-quotas', () => HttpResponse.json(QUOTA)),
  );
}

/** 批次接口：创建 + 查询 + operation 列表（面板展开层里的批次面板要读这三处） */
function mockBatch(appId: string, accountIds: string[]) {
  server.use(
    http.get('/api/account-operations', () => HttpResponse.json([])),
    http.post('/api/checkin-runs', async ({ request }) => {
      const body = await request.json() as { app_id: string };
      return HttpResponse.json({
        batch: { id: BATCH_ID, app_id: body.app_id, status: 'queued', total: accountIds.length, profile_local_day: TODAY, created_at: 1, finished_at: null, items: [] },
        replayed: false,
      }, { status: 202 });
    }),
    http.get('/api/checkin-runs/:id', () => HttpResponse.json({
      id: BATCH_ID, app_id: appId, status: 'queued', total: accountIds.length, profile_local_day: TODAY, created_at: 1, finished_at: null,
      items: accountIds.map((id, seq) => ({ batch_id: BATCH_ID, account_id: id, seq, state: 'queued', operation_id: null, safe_error_code: null, updated_at: 2 })),
    })),
  );
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><AccountsPanel /></QueryClientProvider>);
}

beforeEach(() => server.resetHandlers());

describe('六行总览（ACC-PANEL-03）', () => {
  it('结构与排序：三个可签到平台在前、三个仅额度来源在后；已下线平台仍不出现', async () => {
    mockBase([
      account('wb-1'),
      account('mm-1', { app_id: 'minimax' }),
      account('tr-1', { app_id: 'trae' }),
      account('cb-1', { app_id: 'codebuddy_desktop' }),
    ]);
    renderPanel();

    const overview = await screen.findByTestId('accounts-overview');
    // 额度行组来自独立查询，等它落地后再断言文档顺序
    await screen.findByTestId('quota-row-deepseek');
    const rows = within(overview)
      .getAllByTestId(/^(accounts-app-(workbuddy_desktop|minimax|trae)|quota-row-(deepseek|opencode_go|codex))$/)
      .map((row) => row.getAttribute('data-testid'));
    expect(rows).toEqual([
      'accounts-app-workbuddy_desktop',
      'accounts-app-minimax',
      'accounts-app-trae',
      'quota-row-deepseek',
      'quota-row-opencode_go',
      'quota-row-codex',
    ]);
    expect(screen.queryByTestId('accounts-app-codebuddy_desktop')).not.toBeInTheDocument();

    // 每个可签到行头部都有「积分 未接入」灰芯片（设计 §5：位置与余额/进度条同栏）
    for (const app of ['workbuddy_desktop', 'minimax', 'trae']) {
      const chip = screen.getByTestId(`accounts-credit-${app}`);
      expect(chip).toHaveTextContent('积分 未接入');
      expect(chip.className).toContain('bg-surface-raised');
    }
  });

  it('默认全折叠：三行都没有展开，头部今日 n/m 与额度行不需要展开即可见', async () => {
    mockBase([account('wb-1'), account('mm-1', { app_id: 'minimax' })]);
    renderPanel();

    const overview = await screen.findByTestId('accounts-overview');
    // 额度行来自 /api/managed-account-quotas，与账号列表是两个查询，各自等到
    await screen.findByTestId('quota-row-deepseek');
    expect(screen.getByTestId('accounts-toggle-workbuddy_desktop')).toHaveAttribute('aria-expanded', 'false');
    for (const app of ['workbuddy_desktop', 'minimax', 'trae']) {
      expect(screen.getByTestId(`accounts-body-${app}`)).toHaveAttribute('hidden');
    }
    // 折叠态也能读到签到结果与额度（一屏全见，不滚动、不展开）
    expect(within(overview).getByTestId('accounts-checkin-chip-workbuddy_desktop')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('accounts-today-summary')).toHaveTextContent('今日 0/2'));
    expect(screen.getByTestId('quota-row-deepseek')).toBeInTheDocument();
  });

  it('仅额度行不可展开、无账号操作', async () => {
    mockBase([account('wb-1')]);
    renderPanel();
    await screen.findByTestId('quota-row-codex');

    // 只有三个平台行有展开控件
    expect(screen.getAllByTestId(/accounts-toggle-/)).toHaveLength(3);
    for (const source of ['deepseek', 'opencode_go', 'codex']) {
      const row = screen.getByTestId(`quota-row-${source}`);
      expect(within(row).queryByTestId(`accounts-toggle-${source}`)).toBeNull();
      expect(within(row).queryByTestId(`accounts-checkin-all-${source}`)).toBeNull();
      expect(within(row).queryByTestId(`accounts-capture-${source}`)).toBeNull();
      expect(screen.queryByTestId(`accounts-body-${source}`)).toBeNull();
    }
    // 数据仍来自 /api/managed-account-quotas（行内画余额与迷你进度条）
    expect(screen.getByTestId('quota-row-balance-deepseek')).toHaveTextContent('¥751.81');
    expect(screen.getByTestId('quota-row-bar-opencode_go-0')).toHaveAttribute('data-width', '1');
  });

  it('签到芯片三态：全完成绿 ✓ n/n、部分琥珀 n/m、能力不可用灰「签到不可用」', async () => {
    mockBase([
      account('wb-1', { last_checkin_day: TODAY, last_checkin_status: 'succeeded' }),
      account('wb-2'),
      account('mm-1', { app_id: 'minimax', last_checkin_day: TODAY, last_checkin_status: 'succeeded' }),
      account('tr-1', { app_id: 'trae', last_checkin_day: TODAY, last_checkin_status: 'already_done' }),
    ], [
      CAPS[0]!,
      { ...CAPS[1]!, checkin: false, checkin_reason_code: 'CLIENT_NOT_INSTALLED' },
      CAPS[2]!,
    ]);
    renderPanel();
    await screen.findByTestId('accounts-overview');
    const wb = screen.getByTestId('accounts-checkin-chip-workbuddy_desktop');
    await waitFor(() => expect(wb).toHaveTextContent('1/2'));
    expect(wb).toHaveAttribute('data-tone', 'partial');

    const tr = screen.getByTestId('accounts-checkin-chip-trae');
    expect(tr).toHaveAttribute('data-tone', 'done');
    expect(tr).toHaveTextContent('✓ 1/1');

    // MiniMax：该平台签到能力不可用 → 灰档，原因走服务端 reason_code
    const mm = screen.getByTestId('accounts-checkin-chip-minimax');
    expect(mm).toHaveAttribute('data-tone', 'unavailable');
    expect(mm).toHaveTextContent('签到不可用');
    expect(mm.getAttribute('title') ?? '').toContain('本机未安装该客户端');
    expect(mm.getAttribute('title') ?? '').toContain('CLIENT_NOT_INSTALLED');
  });

  it('能力可用但没有可参与账号：灰档「未纳入签到」，不虚报完成', async () => {
    mockBase([], [CAPS[0]!, CAPS[1]!, CAPS[2]!]);
    renderPanel();
    await screen.findByTestId('accounts-overview');

    const chip = screen.getByTestId('accounts-checkin-chip-workbuddy_desktop');
    await waitFor(() => expect(chip).toHaveTextContent('未纳入签到'));
    expect(chip).toHaveAttribute('data-tone', 'unavailable');
    await waitFor(() => expect(screen.getByTestId('accounts-today-summary')).toHaveTextContent('今日 0/0'));
  });

  it('头部「今日 n/m」= 跨平台可参与账号的今日完成合计（本地记录）', async () => {
    mockBase([
      account('wb-1', { last_checkin_day: TODAY, last_checkin_status: 'succeeded' }),
      account('wb-2', { last_checkin_day: TODAY, last_checkin_status: 'already_done' }),
      account('wb-3', { last_checkin_day: TODAY, last_checkin_status: 'failed' }),
      account('wb-4', { last_checkin_day: '2000-01-01', last_checkin_status: 'succeeded' }),
      account('mm-1', { app_id: 'minimax', last_checkin_day: TODAY, last_checkin_status: 'succeeded' }),
      account('mm-2', { app_id: 'minimax' }),
      account('tr-1', { app_id: 'trae', last_checkin_day: TODAY, last_checkin_status: 'succeeded', enabled: false }),
      account('tr-2', { app_id: 'trae', last_checkin_day: TODAY, last_checkin_status: 'succeeded', checkin_capability: 'unsupported' }),
    ]);
    renderPanel();

    await screen.findByTestId('accounts-overview');
    const head = screen.getByTestId('accounts-today-summary');
    // 分母 = 6（wb 4 + minimax 2；停用的 tr-1 与不支持签到的 tr-2 不进分母，即便它们今日有成功记录）
    // 分子 = 3（wb-1 succeeded、wb-2 already_done、mm-1 succeeded；wb-3 failed、wb-4 是昨天）
    await waitFor(() => expect(head).toHaveTextContent('今日 3/6'));
    expect(head.getAttribute('title') ?? '').toContain('本地记录');
  });

  it('unknown 不计入分子并加 ? 角标；authorized 不算已完成', async () => {
    mockBase([
      account('wb-1', { last_checkin_day: TODAY, last_checkin_status: 'succeeded' }),
      account('wb-2', { last_checkin_day: TODAY, last_checkin_status: 'unknown' }),
      account('wb-3', { last_checkin_day: TODAY, last_checkin_status: 'authorized' }),
    ]);
    renderPanel();

    await screen.findByTestId('accounts-overview');
    const chip = screen.getByTestId('accounts-checkin-chip-workbuddy_desktop');
    await waitFor(() => expect(chip).toHaveTextContent('1/3 ?'));
    expect(chip.getAttribute('title') ?? '').toContain('结果未知，未自动重发');
    expect(screen.getByTestId('accounts-today-summary')).toHaveTextContent('今日 1/3');
    // 展开层里的平台小结同一口径
    await userEvent.click(screen.getByTestId('accounts-toggle-workbuddy_desktop'));
    expect(screen.getByTestId('accounts-summary-workbuddy_desktop')).toHaveTextContent('今日已完成 1/3');
  });

  it('折叠行点 [签到] 自动展开：批次面板出现在展开层内', async () => {
    mockBase([account('wb-1'), account('wb-2')]);
    mockBatch('workbuddy_desktop', ['wb-1', 'wb-2']);
    renderPanel();

    const body = await screen.findByTestId('accounts-body-workbuddy_desktop');
    expect(body).toHaveAttribute('hidden');
    expect(screen.getByTestId('accounts-toggle-workbuddy_desktop')).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(await screen.findByTestId('accounts-checkin-all-workbuddy_desktop'));

    await waitFor(() => expect(screen.getByTestId('accounts-body-workbuddy_desktop')).not.toHaveAttribute('hidden'));
    expect(screen.getByTestId('accounts-toggle-workbuddy_desktop')).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(within(screen.getByTestId('accounts-body-workbuddy_desktop')).getByTestId('checkin-batch-panel')).toBeInTheDocument());
    // 别的平台行不受影响
    expect(screen.getByTestId('accounts-body-minimax')).toHaveAttribute('hidden');
  });
});

describe('今日签到芯片口径（summarizeCheckinToday）', () => {
  const rows = (overrides: Array<Partial<PublicManagedAccount>>): Array<Pick<PublicManagedAccount, 'enabled' | 'checkin_capability' | 'last_checkin_day' | 'last_checkin_status'>> =>
    overrides.map((o) => ({ enabled: true, checkin_capability: 'supported' as const, last_checkin_day: null, last_checkin_status: null, ...o }));

  it('全部完成→绿 ✓；分母只算可参与账号（停用/不支持/无能力都不进分母）', () => {
    const all = summarizeCheckinToday(rows([
      { last_checkin_day: TODAY, last_checkin_status: 'succeeded' },
      { last_checkin_day: TODAY, last_checkin_status: 'already_done' },
      { enabled: false, last_checkin_day: TODAY, last_checkin_status: 'succeeded' },
      { checkin_capability: 'unsupported' },
    ]), CHECKIN_OK, TODAY);
    expect(all).toMatchObject({ total: 2, done: 2, unknown: 0, chip: { tone: 'done', text: '✓ 2/2' } });
  });

  it('昨日完成不算今日；failed 不算；结果未知单独计数', () => {
    const partial = summarizeCheckinToday(rows([
      { last_checkin_day: '2000-01-01', last_checkin_status: 'succeeded' },
      { last_checkin_day: TODAY, last_checkin_status: 'failed' },
      { last_checkin_day: TODAY, last_checkin_status: 'unknown' },
      { last_checkin_day: TODAY, last_checkin_status: 'authorized' },
    ]), CHECKIN_OK, TODAY);
    expect(partial).toMatchObject({ total: 4, done: 0, unknown: 1, chip: { tone: 'partial', text: '0/4 ?' } });
    expect(partial.chip.title).toContain('本地记录');
    expect(partial.chip.title).toContain('结果未知，未自动重发');
  });

  it('能力未取到时给灰档「签到能力未知」，不假装全完成', () => {
    const unknown = summarizeCheckinToday(rows([{ last_checkin_day: TODAY, last_checkin_status: 'succeeded' }]), null, TODAY);
    expect(unknown.chip).toMatchObject({ tone: 'unavailable', text: '签到能力未知' });
  });

  it('localDayKey 用本地日期（跨年不串天）', () => {
    expect(localDayKey(new Date('2026-11-04T23:30:00+08:00').getTime())).toMatch(/^2026-11-0/);
    expect(localDayKey(new Date('2026-11-04T00:10:00+08:00').getTime())).toBe('2026-11-04');
  });
});
