/**
 * CHAT-IMG-ADAPTER：`IMAGE_DELIVERY_UNVERIFIED` 的可执行文案。
 *
 * 400 必须告诉用户下一步做什么（升级 codebuddy / 升级 codex / 升级 opencode / 换执行方式），
 * 而不是只丢一个错误码。
 */
import { describe, expect, it } from 'vitest';
import { imageDeliveryHint } from '../src/services/imageDeliveryHint.js';

describe('imageDeliveryHint (CHAT-IMG-ADAPTER)', () => {
  it('codebuddy 指路到「升级到 2.179.2 且 model=minimax-m3.1-flash」', () => {
    const hint = imageDeliveryHint({ cliId: 'codebuddy', displayName: 'CodeBuddy', detectedVersion: '2.170.0', model: 'default' });
    expect(hint).toContain('2.179.2');
    expect(hint).toContain('minimax-m3.1-flash');
    expect(hint).toContain('2.170.0');
    expect(hint).toContain('codex');
  });

  it('codex 指路到「升级 codex-cli（0.166.0 支持 --image）」', () => {
    const hint = imageDeliveryHint({ cliId: 'codex', displayName: 'Codex', detectedVersion: '0.150.0' });
    expect(hint).toContain('--image');
    expect(hint).toContain('0.166.0');
    expect(hint).toContain('0.150.0');
  });

  it('opencode 指路到「升级 opencode（v2.2.5 支持 --file）」', () => {
    const hint = imageDeliveryHint({ cliId: 'opencode', displayName: 'OpenCode', detectedVersion: '2.1.0' });
    expect(hint).toContain('--file');
    expect(hint).toContain('2.2.5');
  });

  it('dsh 说明 asar 形态阻塞并建议换执行方式', () => {
    const hint = imageDeliveryHint({ cliId: 'dsh', displayName: 'DSH', detectedVersion: null });
    expect(hint).toContain('asar');
    expect(hint).toContain('codex / opencode / codebuddy');
  });

  it('未知执行方式给通用指路，且不谎称支持', () => {
    const hint = imageDeliveryHint({ cliId: 'nope', displayName: '未知 CLI', detectedVersion: null });
    expect(hint).toContain('不支持图片输入');
    expect(hint).toContain('codex / opencode / codebuddy');
  });
});
