/**
 * ACC-KB-A2W 纯数据契约：能力徽标三态互斥 + 启停可点判定。
 *
 * 这两个判定原本散在 `AccountCard.tsx` 的条件表达式里（且蓝标/灰标曾可能同时出现），
 * 这里收敛成纯函数，用纯数据把矩阵钉死，UI 侧只负责渲染（接线等 `ba6252f5` 交付后进行）。
 */
import { describe, expect, it } from 'vitest';
import type { AccountCapability, AccountOperation } from '@agentboard/shared';
import {
  ACCOUNT_BUSY_REASON,
  canToggleEnabled,
  capabilityBadge,
  type CapabilityView,
} from '../components/settings/accountCapabilities';

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

function operation(overrides: Partial<Pick<AccountOperation, 'account_id' | 'state'>> = {}) {
  return { account_id: 'acc-1', state: 'running' as AccountOperation['state'], ...overrides };
}

describe('能力徽标三态互斥（ACC-KB-A2W）', () => {
  it('能力未取到 → 只有灰标「能力未知」，没有蓝标', () => {
    const badge = capabilityBadge(null);
    expect(badge).toMatchObject({ state: 'unknown', tone: 'gray', showBlue: false, showGray: true, label: '能力未知' });
    expect(badge.title).toContain('能力矩阵未取到该平台');
  });

  it('任一维度可用 → 只有蓝标「能力可用」，没有灰标', () => {
    const badge = capabilityBadge(capability());
    expect(badge).toMatchObject({ state: 'supported', tone: 'blue', showBlue: true, showGray: false, label: '能力可用' });
    expect(badge.title).toBe('捕获可用 · 切换可用 · 签到可用');
  });

  it('全部维度不可用 → 只有灰标「能力不可用」，title 带逐维度原因与码', () => {
    const badge = capabilityBadge(capability({
      capture: false, switch: false, checkin: false,
      capture_reason_code: 'PROVIDER_NOT_IMPLEMENTED',
      switch_reason_code: 'PROVIDER_NOT_IMPLEMENTED',
      checkin_reason_code: 'PROVIDER_NOT_IMPLEMENTED',
      reason_code: 'PROVIDER_NOT_IMPLEMENTED',
      source: 'static',
      app_id: 'qoder_cn',
    }));
    expect(badge).toMatchObject({ state: 'unsupported', tone: 'gray', showBlue: false, showGray: true, label: '能力不可用' });
    expect(badge.title).toContain('捕获不可用');
    expect(badge.title).toContain('PROVIDER_NOT_IMPLEMENTED');
  });

  it('矩阵钉死：任何组合都不会同时出蓝标与灰标', () => {
    const combos: CapabilityView[] = [
      capability(),
      capability({ capture: false }),
      capability({ capture: false, switch: false }),
      capability({ capture: false, switch: false, checkin: false }),
      capability({ capture: true, switch: false, checkin: false }),
      capability({ capture: false, switch: true, checkin: false }),
      capability({ capture: false, switch: false, checkin: true }),
    ];
    for (const row of [null, ...combos]) {
      const badge = capabilityBadge(row);
      expect(badge.showBlue && badge.showGray).toBe(false);
      expect(badge.showBlue || badge.showGray).toBe(true);
      expect(badge.tone).toBe(badge.showBlue ? 'blue' : 'gray');
    }
  });
});

describe('启用/停用可点判定（ACC-KB-A2W，与服务端 409 同口径）', () => {
  it('没有操作 → 可点，目标状态是取反', () => {
    expect(canToggleEnabled({ id: 'acc-1', enabled: true }, [])).toEqual({ allowed: true, code: null, reason: null, nextEnabled: false });
    expect(canToggleEnabled({ id: 'acc-1', enabled: false }, [])).toEqual({ allowed: true, code: null, reason: null, nextEnabled: true });
  });

  it('该账号有进行中/排队操作 → 不可点，ACCOUNT_BUSY + 可读原因', () => {
    for (const state of ['running', 'queued'] as AccountOperation['state'][]) {
      const verdict = canToggleEnabled({ id: 'acc-1', enabled: true }, [operation({ state })]);
      expect(verdict.allowed).toBe(false);
      expect(verdict.code).toBe('ACCOUNT_BUSY');
      expect(verdict.reason).toBe(ACCOUNT_BUSY_REASON);
    }
  });

  it('别的账号在忙 / 本账号只有终态操作 → 仍可点', () => {
    expect(canToggleEnabled({ id: 'acc-1', enabled: true }, [operation({ account_id: 'acc-2', state: 'running' })]).allowed).toBe(true);
    for (const state of ['succeeded', 'already_done', 'failed', 'unknown', 'recovery_required'] as AccountOperation['state'][]) {
      const verdict = canToggleEnabled({ id: 'acc-1', enabled: true }, [operation({ state })]);
      expect(verdict.allowed, `state=${state} 应视为终态`).toBe(true);
    }
  });
});
