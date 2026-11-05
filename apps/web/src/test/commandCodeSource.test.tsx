/**
 * ACC-CC-2 / ACC-CC-3：Command Code 接入账号管理（CLI 来源区）。
 *
 * 验收口径：
 * - Command Code 出现在 CLI 来源区（不是 ManagedAppId 的六平台分区），计数用真实值；
 * - 能力来自 GET /api/cli-accounts/commandcode/capability：未安装 / 无凭据文件 / 格式未识别分别展示，
 *   技术码可展开；不出现写死的「可用」，也不出现假按钮；
 * - 导入入口开放，成功 / 重复 / 失败都有可见反馈，凭据明文不回显；
 * - 切换与签到只给原因，不渲染按钮。
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { CliAppCapability, PublicCliAccount } from '@agentboard/shared';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { server } from './server';

const CC_KEY = 'cc-studio-key-abcdef';

function capability(overrides: Partial<CliAppCapability> = {}): CliAppCapability {
  return {
    app_id: 'commandcode',
    installed: false,
    capture: false,
    capture_reason_code: 'CLI_NOT_INSTALLED',
    capture_reason: '本机未安装 Command Code CLI',
    switch: false,
    switch_reason_code: 'AUTH_WRITE_UNVERIFIED',
    switch_reason: '写回 auth.json 是否等价于有效登录态未验证，暂不支持切换',
    checkin: false,
    checkin_reason_code: 'CHECKIN_NOT_APPLICABLE',
    checkin_reason: 'Command Code 没有签到功能',
    auth_file_state: 'missing',
    ...overrides,
  };
}

function mockPanel(options: {
  items?: PublicCliAccount[];
  capabilityBody?: CliAppCapability;
  capabilityStatus?: number;
} = {}): void {
  server.use(
    http.get('/api/managed-accounts', () => HttpResponse.json([])),
    http.get('/api/managed-account-capabilities', () => HttpResponse.json([])),
    http.get('/api/cli-accounts', () => HttpResponse.json({ items: options.items ?? [] })),
    http.get('/api/cli-accounts/commandcode/capability', () =>
      options.capabilityStatus !== undefined && options.capabilityStatus !== 200
        ? HttpResponse.json({ code: 'INTERNAL_ERROR', message: '探测失败' }, { status: options.capabilityStatus })
        : HttpResponse.json({ capability: options.capabilityBody ?? capability() })),
  );
}

function renderPanel(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><AccountsPanel /></QueryClientProvider>);
}

async function openCommandCode(): Promise<HTMLElement> {
  await screen.findByTestId('accounts-index');
  await userEvent.click(screen.getByTestId('accounts-index-item-commandcode'));
  return screen.getByTestId('accounts-detail');
}

describe('Command Code（ACC-CC-2 / ACC-CC-3）', () => {
  it('CLI 来源区出现 Command Code 条目，未登记账号时计数为 0', async () => {
    mockPanel();
    renderPanel();

    await screen.findByTestId('accounts-index');
    expect(screen.getByTestId('accounts-index-item-commandcode')).toHaveTextContent('Command Code');
    expect(screen.getByTestId('accounts-index-count-commandcode')).toHaveTextContent('0');
  });

  it('未安装：capture=CLI_NOT_INSTALLED、switch/checkin 只给原因与技术码，导入入口可用', async () => {
    mockPanel();
    renderPanel();
    const detail = await openCommandCode();

    for (const dimension of ['capture', 'switch', 'checkin']) {
      expect(within(detail).getByTestId(`accounts-source-cap-commandcode-${dimension}`))
        .toHaveAttribute('data-available', 'false');
    }

    const capture = within(detail).getByTestId('accounts-source-cap-commandcode-capture');
    expect(capture).toHaveTextContent('本机未安装该 CLI');
    expect(within(capture).getByText('CLI_NOT_INSTALLED')).toBeInTheDocument();

    const switchItem = within(detail).getByTestId('accounts-source-cap-commandcode-switch');
    expect(switchItem).toHaveTextContent('写回路径未验证，暂不可切换');
    expect(within(switchItem).getByText('AUTH_WRITE_UNVERIFIED')).toBeInTheDocument();

    const checkin = within(detail).getByTestId('accounts-source-cap-commandcode-checkin');
    expect(checkin).toHaveTextContent('该来源没有签到功能');
    expect(within(checkin).getByText('CHECKIN_NOT_APPLICABLE')).toBeInTheDocument();

    // 空态如实说明未安装，不伪造账号
    expect(within(detail).getByTestId('accounts-source-empty-commandcode'))
      .toHaveTextContent('本机未安装 Command Code CLI，也未发现凭据');
    expect(within(detail).queryByTestId('quota-row-commandcode')).toBeNull();

    // 导入入口开放；切换 / 签到没有按钮
    expect(within(detail).getByTestId('accounts-source-import-commandcode')).toBeEnabled();
    expect(within(detail).queryByRole('button', { name: /切换/ })).toBeNull();
    expect(within(detail).queryByRole('button', { name: /签到/ })).toBeNull();
  });

  it('已安装但无凭据文件 → AUTH_FILE_MISSING，空态与原因一致', async () => {
    mockPanel({
      capabilityBody: capability({ installed: true, capture_reason_code: 'AUTH_FILE_MISSING', auth_file_state: 'missing' }),
    });
    renderPanel();
    const detail = await openCommandCode();
    const capture = within(detail).getByTestId('accounts-source-cap-commandcode-capture');
    expect(capture).toHaveTextContent('本机没有该来源的凭据文件');
    expect(within(capture).getByText('AUTH_FILE_MISSING')).toBeInTheDocument();
    expect(within(detail).getByTestId('accounts-source-empty-commandcode'))
      .toHaveTextContent('本机已安装 Command Code，但未找到凭据文件');
  });

  it('auth.json 格式未识别 → AUTH_SCHEMA_UNSUPPORTED，不猜字段也不产账号', async () => {
    mockPanel({
      capabilityBody: capability({ installed: true, capture_reason_code: 'AUTH_SCHEMA_UNSUPPORTED', auth_file_state: 'unrecognized' }),
    });
    renderPanel();
    const detail = await openCommandCode();
    const capture = within(detail).getByTestId('accounts-source-cap-commandcode-capture');
    expect(capture).toHaveTextContent('凭据文件格式不在支持范围');
    expect(within(capture).getByText('AUTH_SCHEMA_UNSUPPORTED')).toBeInTheDocument();
    expect(within(detail).getByTestId('accounts-source-empty-commandcode'))
      .toHaveTextContent('auth.json，但格式未识别');
  });

  it('凭据可读：capture 展示可用，计数与列表用真实发现结果', async () => {
    const item: PublicCliAccount = {
      id: 'cli-cc-1',
      app_id: 'commandcode',
      identity_hint: 'abc12345',
      created_at: 1000,
      last_seen_at: 2000,
    };
    mockPanel({
      items: [item],
      capabilityBody: capability({ installed: true, capture: true, capture_reason_code: 'OK', auth_file_state: 'readable' }),
    });
    renderPanel();

    await screen.findByTestId('accounts-index');
    expect(screen.getByTestId('accounts-index-count-commandcode')).toHaveTextContent('1');

    const detail = await openCommandCode();
    const capture = within(detail).getByTestId('accounts-source-cap-commandcode-capture');
    expect(capture).toHaveAttribute('data-available', 'true');
    expect(capture).toHaveTextContent('可用');
    expect(within(detail).getByTestId('accounts-source-list-commandcode')).toHaveTextContent('abc12345');
  });

  it('导入：成功清空明文、重复提示刷新、失败可见', async () => {
    let postCount = 0;
    const bodies: Array<{ app_id: string; credential: string }> = [];
    server.use(
      http.get('/api/managed-accounts', () => HttpResponse.json([])),
      http.get('/api/managed-account-capabilities', () => HttpResponse.json([])),
      http.get('/api/cli-accounts', () => HttpResponse.json({ items: [] })),
      http.get('/api/cli-accounts/commandcode/capability', () => HttpResponse.json({ capability: capability() })),
      http.post('/api/cli-accounts/import', async ({ request }) => {
        const body = await request.json() as { app_id: string; credential: string };
        bodies.push(body);
        postCount += 1;
        if (body.credential === 'bad-key') {
          return HttpResponse.json({ code: 'VALIDATION_ERROR', message: '凭据格式不合法' }, { status: 400 });
        }
        return HttpResponse.json({
          app_id: 'commandcode',
          action: postCount === 1 ? 'created' : 'updated',
          account: { id: 'cli-cc-1', app_id: 'commandcode', identity_hint: 'abc12345', created_at: 1, last_seen_at: 2 },
        });
      }),
    );

    renderPanel();
    const detail = await openCommandCode();
    await userEvent.click(within(detail).getByTestId('accounts-source-import-commandcode'));
    const textarea = within(detail).getByTestId('accounts-source-import-text-commandcode');
    await userEvent.type(textarea, CC_KEY);
    await userEvent.click(within(detail).getByTestId('accounts-source-import-submit-commandcode'));

    expect(await within(detail).findByTestId('accounts-source-import-success-commandcode')).toHaveTextContent('导入成功');
    expect(textarea).toHaveValue('');
    expect(bodies[0]).toEqual({ app_id: 'commandcode', credential: CC_KEY });
    expect(detail.textContent).not.toContain(CC_KEY);

    // 重复导入同一凭据 → updated，提示已存在并刷新
    await userEvent.type(textarea, CC_KEY);
    await userEvent.click(within(detail).getByTestId('accounts-source-import-submit-commandcode'));
    expect(await within(detail).findByTestId('accounts-source-import-duplicate-commandcode')).toHaveTextContent('已存在');

    // 失败可见，且不回显凭据
    await userEvent.type(textarea, 'bad-key');
    await userEvent.click(within(detail).getByTestId('accounts-source-import-submit-commandcode'));
    const errorNotice = await within(detail).findByTestId('accounts-source-import-error-commandcode');
    expect(errorNotice).toBeInTheDocument();
    expect(errorNotice.textContent).not.toContain('bad-key');
  });

  it('能力查询失败 → 显示能力未知，不回退成伪造的可用状态', async () => {
    mockPanel({ capabilityStatus: 500 });
    renderPanel();
    const detail = await openCommandCode();

    expect(within(detail).getByTestId('accounts-source-cap-error-commandcode')).toHaveTextContent('能力状态读取失败');
    for (const dimension of ['capture', 'switch', 'checkin']) {
      const item = within(detail).getByTestId(`accounts-source-cap-commandcode-${dimension}`);
      expect(item).toHaveAttribute('data-available', 'false');
      expect(item).toHaveTextContent('能力状态未取到');
    }
  });
});
