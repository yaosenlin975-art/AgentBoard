/**
 * ACC-CC-2：Command Code 接入账号管理（CLI 来源区）的保守能力表。
 *
 * 验收口径（依据 CC-1 调研 `Docs/design-2026-11-05-commandcode-capability.md` §4）：
 * - Command Code 出现在 CLI 来源区（不是 ManagedAppId 的六平台分区）；
 * - 三项能力一律不可用：capture=CLI_NOT_INSTALLED、switch=AUTH_WRITE_UNVERIFIED、
 *   checkin=CHECKIN_NOT_APPLICABLE（未实测的写回不得标可用）；
 * - 中文主文案可见，技术码在可展开区；不渲染任何写操作按钮（不许「点按无反应」）；
 * - 界面不含凭据/token（本卡无捕获实现，详情只列脱敏哈希前缀）。
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import { server } from './server';

function renderPanel(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><AccountsPanel /></QueryClientProvider>);
}

function mockEmpty(): void {
  server.use(
    http.get('/api/managed-accounts', () => HttpResponse.json([])),
    http.get('/api/managed-account-capabilities', () => HttpResponse.json([])),
    http.get('/api/cli-accounts', () => HttpResponse.json({ items: [] })),
  );
}

describe('Command Code（ACC-CC-2）', () => {
  it('CLI 来源区出现 Command Code 条目，未登记账号时计数为 0', async () => {
    mockEmpty();
    renderPanel();

    await screen.findByTestId('accounts-index');
    expect(screen.getByTestId('accounts-index-item-commandcode')).toHaveTextContent('Command Code');
    expect(screen.getByTestId('accounts-index-count-commandcode')).toHaveTextContent('0');
  });

  it('三项能力均不可用：中文原因 + 可展开技术码，且不渲染写操作按钮', async () => {
    mockEmpty();
    renderPanel();

    await screen.findByTestId('accounts-index');
    await userEvent.click(screen.getByTestId('accounts-index-item-commandcode'));
    const detail = screen.getByTestId('accounts-detail');

    for (const dimension of ['capture', 'switch', 'checkin']) {
      const item = within(detail).getByTestId(`accounts-source-cap-commandcode-${dimension}`);
      expect(item).toHaveAttribute('data-available', 'false');
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

    // 不出现可点的导入/切换按钮（避免「点了没反应」或「点了必失败」）
    expect(within(detail).queryByTestId('accounts-source-import-commandcode')).toBeNull();
    expect(within(detail).queryByTestId('accounts-source-import-form-commandcode')).toBeNull();

    // 不出现凭据相关字段名
    expect(detail.textContent).not.toContain('credential_ref');
    expect(detail.textContent).not.toContain('auth.json 内容');
  });

  it('详情只给未发现提示，不伪造账号或额度数字', async () => {
    mockEmpty();
    renderPanel();
    await screen.findByTestId('accounts-index');
    await userEvent.click(screen.getByTestId('accounts-index-item-commandcode'));
    const detail = screen.getByTestId('accounts-detail');
    expect(within(detail).getByTestId('accounts-source-empty-commandcode')).toHaveTextContent('本机未发现该来源的凭据');
    expect(within(detail).queryByTestId('quota-row-commandcode')).toBeNull();
  });
});
