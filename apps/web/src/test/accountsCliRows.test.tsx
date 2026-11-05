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

  it('三来源都没有切换按钮，只给原因文案', async () => {
    mockCli([]);
    renderPanel();

    await screen.findByTestId('accounts-index');
    await userEvent.click(screen.getByTestId('accounts-index-item-codex'));
    const detail = screen.getByTestId('accounts-detail');
    expect(within(detail).getByTestId('accounts-source-switch-note-codex')).toHaveTextContent(
      '需先支持导入与写入校验（见 CLI-IMPORT / CLI-SWITCH）',
    );
    expect(within(detail).queryByRole('button')).toBeNull();
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
