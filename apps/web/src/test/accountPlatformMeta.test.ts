/**
 * ACC-KB-B1W：平台展示映射的单一来源 + 未知平台兜底。
 *
 * 背景：服务端 `ManagedAppId` 已扩到六值（含 `qoder_cn` / `zcode`），但 B1S 的能力矩阵/路由尚未落地，
 * 前端不能写死新枚举到版式（分区仍按 APP_ORDER 三栏）；但显示名/图标必须有兜底，
 * 任何未知 id 都不得以裸 id 或白屏形式出现。
 */
import { describe, expect, it } from 'vitest';
import type { ManagedAppId } from '@agentboard/shared';
import {
  APP_LABEL,
  APP_ORDER,
  UNKNOWN_PLATFORM_LABEL,
  appLabel,
  isOfflineApp,
  platformMeta,
} from '../components/settings/accountCapabilities';

describe('平台展示映射（ACC-KB-B1W）', () => {
  it('新增平台有稳定显示名与图标字形（qoder_cn / zcode）', () => {
    expect(platformMeta('qoder_cn')).toEqual({ app: 'qoder_cn', label: 'Qoder CN', glyph: 'Q', offline: false });
    expect(platformMeta('zcode')).toEqual({ app: 'zcode', label: 'ZCode', glyph: 'Z', offline: false });
    expect(appLabel('qoder_cn' as ManagedAppId)).toBe('Qoder CN');
    expect(appLabel('zcode' as ManagedAppId)).toBe('ZCode');
  });

  it('未知平台走兜底：不返回裸 id、不抛错', () => {
    const meta = platformMeta('some_future_app');
    expect(meta.label).toBe(UNKNOWN_PLATFORM_LABEL);
    expect(meta.glyph).toBe('?');
    expect(meta.offline).toBe(false);
    expect(appLabel('some_future_app' as ManagedAppId)).toBe(UNKNOWN_PLATFORM_LABEL);
    expect(appLabel('some_future_app' as ManagedAppId)).not.toBe('some_future_app');
  });

  it('版式不变：分区仍只有三栏，新增平台不擅自加栏位', () => {
    expect(APP_ORDER).toEqual(['workbuddy_desktop', 'minimax', 'trae']);
    expect(Object.keys(APP_LABEL)).toEqual(['workbuddy_desktop', 'minimax', 'trae']);
  });

  it('下线平台仍按映射表识别（不出栏位，但显示名可读）', () => {
    expect(isOfflineApp('codebuddy_desktop')).toBe(true);
    expect(isOfflineApp('zcode')).toBe(false);
    expect(appLabel('codebuddy_desktop')).toBe('CodeBuddy Desktop');
  });
});
