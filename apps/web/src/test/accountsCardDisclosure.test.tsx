/**
 * ACC-B2：账号卡三级信息披露（口径：`Docs/prototypes/accounts-redesign-2026-11-04/b-console.html` `.acard`）。
 *
 * 覆盖：
 * ① 负向信息不渲染——客户端非当前 / 客户端当前未知 / 不参与签到 / 区域未知 / 签到能力未知不出卡面，退到 title 或技术信息；
 * ② 正向芯片（客户端当前 / 签到当前 / 已停用）按状态渲染；
 * ③ 技术信息 `<details>` 默认折叠，展开后可见 实例 / 快照 / 区域 / 签到能力 / 平台能力徽标；
 * ④ 最近签到中文化对照（succeeded→签到成功 …）与原始枚举并列；
 * ⑤ 长 display_name 截断 + title 全文；
 * ⑥ identity_hint 恒为前 8 位等宽。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  it('非当前 / 不参与 / 区域未知 / 签到能力未知不出卡面，原因退到 title 或技术信息', () => {
    mount(
      account({ service_region: 'unknown', checkin_capability: 'unknown' }),
      capability({ checkin: false, checkin_reason_code: 'CHECKIN_PROVIDER_UNVERIFIED' }),
    );
    const card = screen.getByTestId('accounts-card-acc-1');
    const face = within(card).getByTestId('accounts-card-face-acc-1');

    // 卡面（三级之外的部分）没有负向文案
    for (const text of ['客户端非当前', '客户端当前未知', '不参与签到', '区域未知', '签到能力未知']) {
      expect(within(face).queryByText(text)).toBeNull();
    }
    // 两个「当前」容器都是空的（正向芯片也不存在）
    expect(within(face).getByTestId('accounts-client-current-acc-1')).toBeEmptyDOMElement();
    expect(within(face).getByTestId('accounts-checkin-current-acc-1')).toBeEmptyDOMElement();
    // 负向信息退到 tooltip
    expect(within(face).getByTestId('accounts-client-current-acc-1')).toHaveAttribute('title', '客户端非当前');
    expect(within(face).getByTestId('accounts-checkin-current-acc-1'))
      .toHaveAttribute('title', expect.stringContaining('不参与一键签到'));
    expect(within(face).getByTestId('accounts-checkin-current-acc-1'))
      .toHaveAttribute('title', expect.stringContaining('签到能力未验证'));

    // 区域未知 / 签到能力未知收进技术信息
    const tech = screen.getByTestId('accounts-tech-acc-1');
    expect(within(tech).getByText('区域未知')).toBeInTheDocument();
    expect(within(tech).getByText('签到能力未知')).toBeInTheDocument();
  });

  it('is_current=null：客户端当前未知不出卡面，退到 title', () => {
    mount(account({ is_current: null }));
    const face = screen.getByTestId('accounts-card-face-acc-1');
    expect(within(face).queryByText('客户端当前未知')).toBeNull();
    expect(within(face).getByTestId('accounts-client-current-acc-1')).toHaveAttribute('title', '客户端当前未知');
  });
});

describe('正向芯片（ACC-B2 ②）', () => {
  it('客户端当前 + 签到当前按状态渲染', () => {
    mount(account({ is_current: true }));
    const face = screen.getByTestId('accounts-card-face-acc-1');
    expect(within(face).getByTestId('accounts-client-current-acc-1')).toHaveTextContent('客户端当前');
    expect(within(face).getByTestId('accounts-checkin-current-acc-1')).toHaveTextContent('签到当前');
    expect(within(face).getByTestId('accounts-checkin-current-acc-1')).toHaveAttribute('title', '一键签到会提交该账号');
    expect(within(face).queryByText('已停用')).toBeNull();
  });

  it('已停用账号出「已停用」芯片，且不参与签到（原因进 title）', () => {
    mount(account({ enabled: false, is_current: true }));
    const face = screen.getByTestId('accounts-card-face-acc-1');
    expect(within(face).getByText('已停用')).toBeInTheDocument();
    expect(within(face).queryByText('签到当前')).toBeNull();
    expect(within(face).getByTestId('accounts-checkin-current-acc-1'))
      .toHaveAttribute('title', expect.stringContaining('账号已停用'));
    // 停用卡整体降透明（原型 .acard.is-off 口径）
    expect(screen.getByTestId('accounts-card-acc-1').className).toContain('opacity-60');
  });
});

describe('技术信息三级披露（ACC-B2 ③）', () => {
  it('默认折叠；展开后可见实例 / 快照 / 区域 / 签到能力 / 平台能力徽标', async () => {
    mount(account({ service_region: 'global' }));
    const tech = screen.getByTestId('accounts-tech-acc-1');
    expect(tech.tagName).toBe('DETAILS');
    expect(tech).not.toHaveAttribute('open');

    await userEvent.click(within(tech).getByText('技术信息'));
    expect(tech).toHaveAttribute('open');
    expect(within(tech).getByText('inst-0123456789abcdef')).toBeInTheDocument();
    expect(within(tech).getByText('v3')).toBeInTheDocument();
    expect(within(tech).getByText('国际')).toBeInTheDocument();
    expect(within(tech).getByText('签到可用')).toBeInTheDocument();
    // 平台能力徽标收进技术信息（三态契约不变）
    const badge = within(tech).getByTestId('accounts-capability-badge-acc-1');
    expect(badge).toHaveAttribute('data-state', 'supported');
    expect(within(badge).getByText('能力可用')).toBeInTheDocument();
  });
});

describe('最近签到中文化对照（ACC-B2 ④）', () => {
  const CASES: Array<[NonNullable<AccountView['last_checkin_status']>, string]> = [
    ['succeeded', '签到成功'],
    ['already_done', '今日已完成'],
    ['unknown', '结果未知'],
    ['failed', '签到失败'],
    ['authorized', '授权中'],
  ];

  for (const [status, label] of CASES) {
    it(`${status} → ${label}`, () => {
      const { unmount } = mount(account({ last_checkin_day: '2026-11-04', last_checkin_status: status }));
      const tech = screen.getByTestId('accounts-tech-acc-1');
      expect(within(tech).getByText(`2026-11-04 · ${status}（${label}）`)).toBeInTheDocument();
      unmount();
    });
  }

  it('未签过到不虚构状态', () => {
    mount(account({ last_checkin_day: null, last_checkin_status: null }));
    expect(within(screen.getByTestId('accounts-tech-acc-1')).getByText('未签到')).toBeInTheDocument();
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

  it('ACC-UI-2：高频动作留主行，停用/删除收进 ⋯ 菜单；当前账号不给灰切换按钮', () => {
    mount(account({ is_current: true }));
    const more = screen.getByTestId('accounts-more-acc-1');
    expect(more.tagName).toBe('DETAILS');
    expect(within(more).getByTestId('accounts-enabled-toggle-acc-1')).toHaveTextContent('停用');
    expect(within(more).getByTestId('accounts-delete-acc-1')).toBeInTheDocument();
    // 主行只保留签到与溢出菜单
    expect(screen.getByTestId('accounts-checkin-acc-1')).toBeInTheDocument();
    expect(screen.queryByTestId('accounts-switch-acc-1')).toBeNull();
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
