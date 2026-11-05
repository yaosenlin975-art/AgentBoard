/**
 * ACC-CLI-MULTI：CLI 三来源行的真实计数与只读详情。
 *
 * 验收口径：
 * - 左栏计数 = `/api/cli-accounts` 里该来源的条数（不再固定 0）；
 * - 右侧详情列出与计数相同数量的条目，且只有脱敏身份指纹；
 * - 不提供可点但必失败的切换按钮，只给原因文案。
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { PublicCliAccount } from '@agentboard/shared';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { server } from './server';

function cliAccount(id: string, app_id: PublicCliAccount['app_id'], hint: string): PublicCliAccount {
  return { id, app_id, identity_hint: `sha256:${hint}`, created_at: 1, last_seen_at: 2 };
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

describe('CLI 三来源（ACC-CLI-MULTI）', () => {
  it('计数取真实登记结果：两个 DeepSeek key → 2，OpenCode/Codex 为 0；详情与计数一致', async () => {
    mockCli([
      cliAccount('d-1', 'deepseek', 'aaaaaaaaaaaa'),
      cliAccount('d-2', 'deepseek', 'bbbbbbbbbbbb'),
    ]);
    renderPanel();

    await screen.findByTestId('accounts-index');
    expect(screen.getByTestId('accounts-index-count-deepseek')).toHaveTextContent('2');
    expect(screen.getByTestId('accounts-index-count-opencode_go')).toHaveTextContent('0');
    expect(screen.getByTestId('accounts-index-count-codex')).toHaveTextContent('0');

    await userEvent.click(screen.getByTestId('accounts-index-item-deepseek'));
    const detail = screen.getByTestId('accounts-detail');
    const list = within(detail).getByTestId('accounts-source-list-deepseek');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(detail).getByText('sha256:aaaaaaaaaaaa')).toBeInTheDocument();
    expect(within(detail).getByText('sha256:bbbbbbbbbbbb')).toBeInTheDocument();
    // 详情只含哈希前缀，不含 credential_ref
    expect(detail.textContent).not.toContain('credential_ref');
  });

  it('三来源都没有切换按钮；Codex 导入入口禁用并给出可见原因', async () => {
    mockCli([]);
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
    expect(screen.getByTestId('accounts-index-count-deepseek')).toHaveTextContent('1');
    await userEvent.click(screen.getByTestId('accounts-index-item-deepseek'));
    expect(within(screen.getByTestId('accounts-detail')).getAllByRole('listitem')).toHaveLength(1);
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
      http.get('/api/cli-accounts', () => HttpResponse.json({ items: [cliAccount('d-new', 'deepseek', 'dddddddddddd')] })),
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
