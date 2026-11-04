/**
 * CHIP-CLICK：标签 chip **点击**（不是预设 store）是否翻转选中态。
 *
 * 复审留的分水岭：jsdom 里 `chip.click()` → `aria-pressed` 变 `true` → 再点回 `false`。
 * 这里用 userEvent / fireEvent 真实派发点击，断言 `aria-pressed`、`data-active` 与
 * `selectedLabelsByWorkspace` 三处同步翻转（旧测试只预设 store 后断言，没覆盖点击链路）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LabelFilterBar } from '../components/board/LabelFilterBar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAppStore } from '../state/appStore';
import { server } from './server';
import { HttpResponse, http } from 'msw';

const WS = 'ws-1';

function mockLabels(labels: string[]): void {
  // chip 集合来自 GET /api/issues?workspace=…（聚合 labels）
  server.use(http.get('/api/issues', () => HttpResponse.json(labels.map((label, i) => ({
    id: `i-${i}`, workspace_id: WS, title: 't', description: '', priority: '中', labels: [label],
    status: '待规划', sort_order: i, claimed_by: null, claimed_at: null, session_id: null,
    last_seen_comment_id: null, created_at: 1, updated_at: 1,
  })))));
}

function renderBar(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <LabelFilterBar workspaceId={WS} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAppStore.setState({ workspaceId: WS, selectedLabelsByWorkspace: {} });
});

describe('标签 chip 点击翻转（CHIP-CLICK）', () => {
  it('点击一次 → aria-pressed=true，再点一次 → 回 false（store 同步）', async () => {
    mockLabels(['缺陷', '功能']);
    renderBar();

    const chip = await screen.findByTestId('label-filter-缺陷');
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(chip).toHaveAttribute('data-active', 'false');

    // 第一次点击：必须变 true
    fireEvent.click(chip);
    await waitFor(() => {
      expect(screen.getByTestId('label-filter-缺陷')).toHaveAttribute('aria-pressed', 'true');
    });
    expect(screen.getByTestId('label-filter-缺陷')).toHaveAttribute('data-active', 'true');
    expect(useAppStore.getState().selectedLabelsByWorkspace[WS]).toEqual(['缺陷']);

    // 第二次点击：必须翻回 false
    fireEvent.click(screen.getByTestId('label-filter-缺陷'));
    await waitFor(() => {
      expect(screen.getByTestId('label-filter-缺陷')).toHaveAttribute('aria-pressed', 'false');
    });
    expect(useAppStore.getState().selectedLabelsByWorkspace[WS]).toEqual([]);
  });

  it('userEvent.click 同样翻转（另一条派发路径，排除 fireEvent 特例）', async () => {
    mockLabels(['缺陷']);
    renderBar();
    const chip = await screen.findByTestId('label-filter-缺陷');
    await userEvent.click(chip);
    await waitFor(() => expect(screen.getByTestId('label-filter-缺陷')).toHaveAttribute('aria-pressed', 'true'));
    await userEvent.click(screen.getByTestId('label-filter-缺陷'));
    await waitFor(() => expect(screen.getByTestId('label-filter-缺陷')).toHaveAttribute('aria-pressed', 'false'));
  });
});
