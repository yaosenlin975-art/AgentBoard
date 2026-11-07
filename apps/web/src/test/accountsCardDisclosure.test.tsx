/**
 * ACC-B2：账号卡信息披露（ACC-UI-PRUNE 后为两级；三级「技术信息」、「签到当前」芯片与单账号「签到」按钮已删）。
 *
 * 覆盖：
 * ① 负向信息不渲染——客户端非当前 / 客户端当前未知不出卡面，退到 title；
 * ② 正向芯片（客户端当前 / 已停用）按状态渲染；
 * ③ 技术信息 `<details>`、区域 / 实例 / 快照 / 最近签到行均不再渲染；
 * ④ 长 display_name 截断 + title 全文；
 * ⑤ identity_hint 恒为前 8 位等宽。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AccountCapability } from '@agentboard/shared';
import { AccountCard, type AccountView } from '../components/settings/AccountCard';
import type { CapabilityView } from '../components/settings/accountCapabilities';

function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: 'acc-1',
    app_id: 'workbuddy_desktop',
    client_instance_id: 'inst-0123456789abcdef',
    service_region: 'cn',
    display_name: '主账号',
    identity_hint: 'a1b2c3d4',
    client_snapshot_version: 3,
    checkin_capability: 'supported',
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

function capability(overrides: Partial<AccountCapability> = {}): CapabilityView {
  return {
    app_id: 'workbuddy_desktop',
    capture: true,
    switch: true,
    checkin: true,
    capture_reason_code: 'OK',
    switch_reason_code: 'OK',
    checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE',
    reason_code: 'CHECKIN_PROVIDER_AVAILABLE',
    source: 'derived',
    ...overrides,
  };
}

function mount(card: AccountView, cap: CapabilityView | null = capability()): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AccountCard account={card} capability={cap} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('负向信息不渲染（ACC-B2 ①）', () => {
  it('非当前不出卡面，原因退到 title；区域未知 / 签到能力未知不再有任何展示位', () => {
    mount(
      account({ service_region: 'unknown', checkin_capability: 'unknown' }),
      capability({ checkin: false, checkin_reason_code: 'CHECKIN_PROVIDER_UNVERIFIED' }),
    );
    const card = screen.getByTestId('accounts-card-acc-1');
    const face = within(card).getByTestId('accounts-card-face-acc-1');

    // 卡面没有负向文案
    for (const text of ['客户端非当前', '客户端当前未知', '区域未知', '签到能力未知']) {
      expect(within(face).queryByText(text)).toBeNull();
    }
    // 「客户端当前」容器为空（正向芯片也不存在），负向信息退到 tooltip
    expect(within(face).getByTestId('accounts-client-current-acc-1')).toBeEmptyDOMElement();
    expect(within(face).getByTestId('accounts-client-current-acc-1')).toHaveAttribute('title', '客户端非当前');

    // ACC-UI-PRUNE：技术信息折叠已删，区域 / 签到能力 / 实例 / 快照不再渲染
    expect(screen.queryByTestId('accounts-tech-acc-1')).toBeNull();
    expect(screen.queryByText('技术信息')).toBeNull();
    expect(screen.queryByText('inst-0123456789abcdef')).toBeNull();
    expect(screen.queryByText('签到可用')).toBeNull();
    expect(screen.queryByTestId('accounts-capability-badge-acc-1')).toBeNull();
  });

  it('is_current=null：客户端当前未知不出卡面，退到 title', () => {
    mount(account({ is_current: null }));
    const face = screen.getByTestId('accounts-card-face-acc-1');
    expect(within(face).queryByText('客户端当前未知')).toBeNull();
    expect(within(face).getByTestId('accounts-client-current-acc-1')).toHaveAttribute('title', '客户端当前未知');
  });
});

describe('正向芯片（ACC-B2 ②）', () => {
  it('客户端当前按状态渲染；「签到当前」芯片已删（ACC-UI-PRUNE）', () => {
    mount(account({ is_current: true }));
    const face = screen.getByTestId('accounts-card-face-acc-1');
    expect(within(face).getByTestId('accounts-client-current-acc-1')).toHaveTextContent('客户端当前');
    expect(within(face).queryByTestId('accounts-checkin-current-acc-1')).toBeNull();
    expect(within(face).queryByText('签到当前')).toBeNull();
    expect(within(face).queryByText('已停用')).toBeNull();
  });

  it('已停用账号出「已停用」芯片', () => {
    mount(account({ enabled: false, is_current: true }));
    const face = screen.getByTestId('accounts-card-face-acc-1');
    expect(within(face).getByText('已停用')).toBeInTheDocument();
    // 停用卡整体降透明（原型 .acard.is-off 口径）
    expect(screen.getByTestId('accounts-card-acc-1').className).toContain('opacity-60');
  });
});

describe('一级身份（ACC-B2 ⑤⑥）', () => {
  it('长 display_name 截断展示，title 保留全文', () => {
    const longName = '超长账号名称测试'.repeat(10);
    mount(account({ display_name: longName }));
    const nameEl = screen.getByTitle(longName);
    expect(nameEl).toHaveClass('truncate');
    expect(nameEl).toHaveTextContent(longName);
    expect(nameEl.closest(`[data-testid="accounts-card-acc-1"]`)).not.toBeNull();
  });

  it('ACC-UI-2 / ACC-UI-PRUNE：主行只留切换与 ⋯ 菜单，单账号签到按钮已删', () => {
    mount(account({ is_current: false }));
    const more = screen.getByTestId('accounts-more-acc-1');
    expect(more.tagName).toBe('DETAILS');
    expect(within(more).getByTestId('accounts-enabled-toggle-acc-1')).toHaveTextContent('停用');
    expect(within(more).getByTestId('accounts-delete-acc-1')).toBeInTheDocument();
    expect(screen.getByTestId('accounts-switch-acc-1')).toBeInTheDocument();
    expect(screen.queryByTestId('accounts-checkin-acc-1')).toBeNull();
  });

  it('identity_hint 恒为前 8 位等宽（服务端超长也截断），缺失时不渲染占位', () => {
    const first = mount(account({ identity_hint: 'a1b2c3d4efgh' }));
    const hint = screen.getByTestId('accounts-hint-acc-1');
    expect(hint.textContent).toBe('a1b2c3d4');
    expect(hint).toHaveClass('font-mono');
    first.unmount();
    // 8 位原样透传
    const second = mount(account({ identity_hint: 'deadbeef' }));
    expect(screen.getByTestId('accounts-hint-acc-1').textContent).toBe('deadbeef');
    second.unmount();
    // ACC-UI-2：缺失不渲染「未提供」占位（无信息量），也不虚构 8 位
    mount(account({ identity_hint: null }));
    expect(screen.queryByTestId('accounts-hint-acc-1')).toBeNull();
  });
});
