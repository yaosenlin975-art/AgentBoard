/**
 * ACC-CLI-MULTI：CLI 来源行的真实计数与只读详情。
 *
 * 验收口径（ADD-FLOW-2 口径 A）：
 * - 零账号普通来源行隐藏；Codex 行持续可见并说明未读取到有效本机登录账号；
 * - 左栏计数 = `/api/cli-accounts` 里该来源的条数；
 * - 右侧详情列出与计数相同数量的条目，且只有脱敏身份指纹；
 * - 不提供可点但必失败的切换按钮，只给原因文案。
 */
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { PublicCliAccount } from '@agentboard/shared';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { server } from './server';

function cliAccount(id: string, app_id: PublicCliAccount['app_id'], hint: string): PublicCliAccount {
  return { id, app_id, identity_hint: `sha256:${hint}`, created_at: 1, last_seen_at: 2 };
}

const CC1 = '11111111-1111-4111-8111-111111111111';
const CC2 = '22222222-2222-4222-8222-222222222222';

function commandCodeQuota(balance: number | null, status: string = 'ok', reason_code: string | null = null, detail: string | null = null, windows: unknown[] = []) {
  return {
    items: [{ source: 'commandcode', status, balance, unit: status === 'ok' ? 'USD' : null, windows, fetched_at: 3, reason_code, detail }],
    fetched_at: 3,
  };
}

function renderPanel(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><AccountsPanel /></QueryClientProvider>);
}

function mockCli(items: PublicCliAccount[]): void {
  server.use(
    http.get('/api/managed-accounts', () => HttpResponse.json([])),
    http.get('/api/managed-account-capabilities', () => HttpResponse.json([])),
    http.get('/api/cli-accounts', () => HttpResponse.json({ items })),
  );
}

describe('CLI 来源（ACC-CLI-MULTI）', () => {
  it('计数取真实登记结果：两个 DeepSeek key → 2；零账号来源不占行；详情与计数一致', async () => {
    mockCli([
      cliAccount('d-1', 'deepseek', 'aaaaaaaaaaaa'),
      cliAccount('d-2', 'deepseek', 'bbbbbbbbbbbb'),
    ]);
    renderPanel();

    await screen.findByTestId('accounts-index');
    // accounts-redesign 方向 B：左栏行改指标形态（额度来源指标取共享额度快照，默认夹具 deepseek ¥12.34）；
    // 登记计数语义由下方详情列表条数承载
    expect(screen.getByTestId('accounts-index-metric-deepseek')).toHaveTextContent('¥12.34');
    // 普通来源零账号时隐藏；Codex 保留来源行以展示本机登录状态。
    expect(screen.queryByTestId('accounts-index-item-opencode_go')).toBeNull();
    expect(screen.getByTestId('accounts-index-item-codex')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('accounts-index-item-codex'));
    const codexDetail = screen.getByTestId('accounts-detail');
    expect(await within(codexDetail).findByTestId('accounts-source-empty-codex')).toHaveTextContent('未读取到有效的本机登录账号');

    await userEvent.click(screen.getByTestId('accounts-index-item-deepseek'));
    const detail = screen.getByTestId('accounts-detail');
    const list = within(detail).getByTestId('accounts-source-list-deepseek');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(detail).getByText('sha256:aaaaaaaaaaaa')).toBeInTheDocument();
    expect(within(detail).getByText('sha256:bbbbbbbbbbbb')).toBeInTheDocument();
    // 详情只含哈希前缀，不含 credential_ref
    expect(detail.textContent).not.toContain('credential_ref');
  });

  it('Codex 登录列表请求失败显示错误，不误报为空账号', async () => {
    server.use(
      http.get('/api/managed-accounts', () => HttpResponse.json([])),
      http.get('/api/managed-account-capabilities', () => HttpResponse.json([])),
      http.get('/api/cli-accounts', () => HttpResponse.json({ error: 'offline' }, { status: 503 })),
    );
    renderPanel();

    await userEvent.click(await screen.findByTestId('accounts-index-item-codex'));
    const detail = screen.getByTestId('accounts-detail');
    expect(await within(detail).findByTestId('accounts-source-error-codex')).toHaveAttribute('role', 'alert');
    expect(within(detail).getByTestId('accounts-source-error-codex')).toHaveTextContent('读取本机 CLI 凭据失败');
    expect(within(detail).queryByTestId('accounts-source-empty-codex')).toBeNull();
  });

  it('Codex 行只给切换原因文案；导入入口禁用并给出可见原因', async () => {
    // Codex 行始终存在；补一条已发现账号后断言详情业务口径
    mockCli([cliAccount('cx-1', 'codex', 'eeeeeeeeeeee')]);
    renderPanel();

    await screen.findByTestId('accounts-index');
    await userEvent.click(screen.getByTestId('accounts-index-item-codex'));
    const detail = screen.getByTestId('accounts-detail');
    expect(within(detail).getByTestId('accounts-source-switch-note-codex')).toHaveTextContent(
      '需先支持导入与写入校验（见 CLI-IMPORT / CLI-SWITCH）',
    );
    expect(within(detail).getByTestId('accounts-source-import-codex')).toBeDisabled();
    expect(within(detail).getByTestId('accounts-source-import-reason-codex')).toHaveTextContent(
      'Codex 导入对象尚未确定',
    );
  });

  it('同一个 key 只在详情出现一次（服务端已按 identity 去重，前端不重复渲染）', async () => {
    mockCli([cliAccount('d-1', 'deepseek', 'cccccccccccc')]);
    renderPanel();

    await screen.findByTestId('accounts-index');
    expect(screen.getByTestId('accounts-index-metric-deepseek')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('accounts-index-item-deepseek'));
    expect(within(screen.getByTestId('accounts-detail')).getAllByRole('listitem')).toHaveLength(1);
  });
});

describe('Command Code 每账号额度', () => {
  it('两行独立查询并沿用 USD、真实零值、5h/weekly 与 reset 文案', async () => {
    const first = cliAccount(CC1, 'commandcode', '111111111111');
    const second = cliAccount(CC2, 'commandcode', '222222222222');
    const requestedIds: string[] = [];
    mockCli([first, second]);
    server.use(
      http.get('/api/cli-account-quotas', ({ request }) => {
        const accountId = new URL(request.url).searchParams.get('account_id') ?? '';
        requestedIds.push(accountId);
        if (accountId === CC1) {
          return HttpResponse.json(commandCodeQuota(0, 'ok', null, null, [
            { name: '5h', kind: 'rolling', total: 100, used: 0, remaining: 100, used_percent: 0, reset_at: null },
          ]));
        }
        return HttpResponse.json(commandCodeQuota(12.5, 'ok', null, null, [
          { name: 'weekly', kind: 'weekly', total: 35, used: 9.6445, remaining: 25.3555, used_percent: 27.55, reset_at: Date.now() + 2 * 24 * 60 * 60_000 },
        ]));
      }),
    );
    renderPanel();

    await userEvent.click(await screen.findByTestId('accounts-index-item-commandcode'));
    await waitFor(() => expect(requestedIds).toHaveLength(2));
    const firstRow = screen.getByTestId(`cli-account-quota-${CC1}`);
    const secondRow = screen.getByTestId(`cli-account-quota-${CC2}`);
    await waitFor(() => {
      expect(firstRow).toHaveAttribute('data-status', 'ok');
      expect(secondRow).toHaveAttribute('data-status', 'ok');
    });

    expect(requestedIds).toEqual(expect.arrayContaining([CC1, CC2]));
    expect(firstRow).toHaveTextContent('$0.00');
    expect(firstRow).not.toHaveTextContent('额度内');
    expect(within(firstRow).getByTestId('quota-row-window-commandcode-0')).toHaveAttribute('data-kind', 'rolling');
    expect(within(firstRow).getByTestId('quota-row-window-commandcode-0').getAttribute('title')).toContain('Reset time unknown');
    expect(secondRow).toHaveTextContent('$12.50');
    expect(within(secondRow).getByTestId('quota-row-window-commandcode-0')).toHaveAttribute('data-kind', 'weekly');
    expect(within(secondRow).getByTestId('quota-row-used-commandcode-0')).toHaveTextContent('$9.64/$35.00');
    expect(within(secondRow).getByTestId('quota-row-window-commandcode-0').getAttribute('title')).toContain('Resets in');
  });

  it('缺少凭据与额度查询错误明确显示非零状态', async () => {
    const missing = cliAccount(CC1, 'commandcode', '333333333333');
    const failed = cliAccount(CC2, 'commandcode', '444444444444');
    mockCli([missing, failed]);
    server.use(
      http.get('/api/cli-account-quotas', ({ request }) => {
        const accountId = new URL(request.url).searchParams.get('account_id');
        return HttpResponse.json(accountId === CC1
          ? commandCodeQuota(null, 'unsupported', 'CREDENTIAL_MISSING', '缺少 Command Code 凭据')
          : commandCodeQuota(null, 'error', 'NETWORK_ERROR', '网络失败'));
      }),
    );
    renderPanel();

    await userEvent.click(await screen.findByTestId('accounts-index-item-commandcode'));
    const missingRow = screen.getByTestId(`cli-account-quota-${CC1}`);
    const failedRow = screen.getByTestId(`cli-account-quota-${CC2}`);
    await waitFor(() => {
      expect(missingRow).toHaveAttribute('data-status', 'unsupported');
      expect(failedRow).toHaveAttribute('data-status', 'error');
    });

    expect(missingRow).toHaveTextContent('缺少 Command Code 凭据');
    expect(failedRow).toHaveTextContent('网络不可用或超时');
    expect(within(missingRow).queryByTestId('quota-row-balance-commandcode')).toBeNull();
    expect(within(failedRow).queryByTestId('quota-row-balance-commandcode')).toBeNull();
  });

  it('Command Code 凭据导入与顶栏刷新都会刷新额度查询', async () => {
    const codeAccount = cliAccount(CC1, 'commandcode', '555555555555');
    let quotaReads = 0;
    mockCli([codeAccount]);
    server.use(
      http.get('/api/cli-account-quotas', () => {
        quotaReads += 1;
        return HttpResponse.json(commandCodeQuota(quotaReads === 1 ? 100 : quotaReads === 2 ? 200 : 300));
      }),
      http.post('/api/cli-accounts/import', () => HttpResponse.json({ app_id: 'commandcode', action: 'updated', account: codeAccount })),
      http.post('/api/accounts/import-credentials', () => HttpResponse.json({
        batch_id: 'local-refresh', actor: 'web', duration_ms: 0, platforms: [], accounts: [], error: null,
      })),
    );
    renderPanel();

    await userEvent.click(await screen.findByTestId('accounts-index-item-commandcode'));
    const quotaRow = screen.getByTestId(`cli-account-quota-${CC1}`);
    await waitFor(() => expect(quotaRow).toHaveTextContent('$100.00'));

    await userEvent.click(screen.getByTestId('accounts-source-import-commandcode'));
    await userEvent.type(screen.getByTestId('accounts-source-import-text-commandcode'), 'test-api-key');
    await userEvent.click(screen.getByTestId('accounts-source-import-submit-commandcode'));
    await waitFor(() => {
      expect(screen.getByTestId('accounts-source-import-duplicate-commandcode')).toBeInTheDocument();
      expect(quotaRow).toHaveTextContent('$200.00');
      expect(quotaReads).toBe(2);
    });

    await userEvent.click(screen.getByTestId('accounts-import-local'));
    await waitFor(() => {
      expect(quotaRow).toHaveTextContent('$300.00');
      expect(quotaReads).toBe(3);
    });
  });
});

describe('CLI-IMPORT：手动导入 UI', () => {
  function mockImport(
    handler: (body: { app_id: string; credential: string }) => { status: number; body: Record<string, unknown> },
  ) {
    let requestBody: { app_id: string; credential: string } | null = null;
    server.use(
      http.get('/api/managed-accounts', () => HttpResponse.json([])),
      http.get('/api/managed-account-capabilities', () => HttpResponse.json([])),
      // DeepSeek 与 Codex 均有登记账号；Codex 无账号时也会保留空态行。
      http.get('/api/cli-accounts', () => HttpResponse.json({
        items: [cliAccount('d-new', 'deepseek', 'dddddddddddd'), cliAccount('cx-1', 'codex', 'eeeeeeeeeeee')],
      })),
      http.post('/api/cli-accounts/import', async ({ request }) => {
        requestBody = (await request.json()) as { app_id: string; credential: string };
        const result = handler(requestBody);
        return HttpResponse.json(result.body, { status: result.status });
      }),
    );
    return () => requestBody;
  }

  async function openDeepseekImport() {
    renderPanel();
    await screen.findByTestId('accounts-index');
    await userEvent.click(screen.getByTestId('accounts-index-item-deepseek'));
    const detail = screen.getByTestId('accounts-detail');
    await userEvent.click(within(detail).getByTestId('accounts-source-import-deepseek'));
    return detail;
  }

  it('导入成功：带 app_id + 凭据提交，成功反馈可见，成功后清空输入不回显明文', async () => {
    const lastBody = mockImport(() => ({
      status: 200,
      body: { app_id: 'deepseek', action: 'created', account: cliAccount('d-new', 'deepseek', 'dddddddddddd') },
    }));
    const detail = await openDeepseekImport();
    const field = within(detail).getByTestId('accounts-source-import-text-deepseek');
    await userEvent.type(field, 'sk-manual-aaaa');
    await userEvent.click(within(detail).getByTestId('accounts-source-import-submit-deepseek'));

    expect(await within(detail).findByTestId('accounts-source-import-success-deepseek')).toHaveTextContent('导入成功');
    expect(field).toHaveValue('');
    expect(detail.textContent).not.toContain('sk-manual-aaaa');
    expect(lastBody()).toEqual({ app_id: 'deepseek', credential: 'sk-manual-aaaa' });
  });

  it('重复导入：明确反馈「已存在，已刷新最近发现时间」', async () => {
    mockImport(() => ({
      status: 200,
      body: { app_id: 'deepseek', action: 'updated', account: cliAccount('d-new', 'deepseek', 'dddddddddddd') },
    }));
    const detail = await openDeepseekImport();
    await userEvent.type(within(detail).getByTestId('accounts-source-import-text-deepseek'), 'sk-manual-aaaa');
    await userEvent.click(within(detail).getByTestId('accounts-source-import-submit-deepseek'));

    expect(await within(detail).findByTestId('accounts-source-import-duplicate-deepseek')).toHaveTextContent(
      '已存在，已刷新最近发现时间',
    );
  });

  it('格式非法：展示服务端可读原因（脱敏），且不提示成功', async () => {
    mockImport(() => ({
      status: 400,
      body: { error: { code: 'INVALID_CREDENTIAL', message: '无法从输入中解析出凭据：请粘贴单个 API key，不要包含多余文字' } },
    }));
    const detail = await openDeepseekImport();
    await userEvent.type(within(detail).getByTestId('accounts-source-import-text-deepseek'), '随便一段文字');
    await userEvent.click(within(detail).getByTestId('accounts-source-import-submit-deepseek'));

    const error = await within(detail).findByTestId('accounts-source-import-error-deepseek');
    expect(error).toHaveAttribute('role', 'alert');
    expect(error).toHaveTextContent('无法从输入中解析出凭据');
    expect(within(detail).queryByTestId('accounts-source-import-success-deepseek')).toBeNull();
  });

  it('Codex 导入按钮禁用，点击不发起请求', async () => {
    const lastBody = mockImport(() => ({ status: 200, body: { app_id: 'codex', action: 'created', account: {} } }));
    renderPanel();
    await screen.findByTestId('accounts-index');
    await userEvent.click(screen.getByTestId('accounts-index-item-codex'));
    const detail = screen.getByTestId('accounts-detail');
    const button = within(detail).getByTestId('accounts-source-import-codex');
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(within(detail).queryByTestId('accounts-source-import-form-codex')).toBeNull();
    expect(lastBody()).toBeNull();
  });
});
