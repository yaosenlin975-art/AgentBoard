/**
 * ACC-KB-A4 / ACC-KB-B5S：额度来源的单一事实源漂移闸。
 *
 * 收敛前 server 与 web 各持一份字面量 union 与来源标签，靠人肉同步；现在只有 `packages/shared` 一份。
 * B5S 起来源分成两组（CLI 额度 3 + 平台账号 5），所以这里**不照抄实现清单**，而是断言结构语义：
 * 分组存在且组内非空、两组拼起来恰好等于展示清单、清单顺序即展示顺序、每个来源都有非空标签。
 * 这样「新增来源但忘了加标签 / 忘了进分组 / 顺序被改乱」都会红。
 */
import { describe, expect, it } from 'vitest';
import { QUOTA_GROUPS, QUOTA_SOURCE_IDS, QUOTA_SOURCE_LABEL } from '@agentboard/shared';
import { QUOTA_ROW_ORDER } from '../components/settings/QuotaCards';

describe('额度来源单一事实源（分组语义）', () => {
  it('两组：CLI 额度 3 项 + 平台账号 5 项，组内非空且无重复', () => {
    expect(QUOTA_GROUPS.map((group) => group.id)).toEqual(['cli', 'platform']);
    const cli = QUOTA_GROUPS[0]!;
    const platform = QUOTA_GROUPS[1]!;

    // CLI 额度组：三个既有 CLI 来源，一个都不能少（与 B5S 裁决一致）
    expect(cli.sources).toHaveLength(3);
    expect([...cli.sources]).toEqual(['deepseek', 'opencode_go', 'codex']);

    // 平台账号组：五平台账号侧来源（不写死具体顺序之外的东西，只钉集合与下界）
    expect(platform.sources.length).toBeGreaterThanOrEqual(5);
    for (const source of ['workbuddy', 'minimax', 'trae', 'qoder_cn', 'zcode'] as const) {
      expect(platform.sources).toContain(source);
    }

    // 组内非空 + 全局无重复
    for (const group of QUOTA_GROUPS) expect(group.sources.length).toBeGreaterThan(0);
    const flat = QUOTA_GROUPS.flatMap((group) => [...group.sources]);
    expect(new Set(flat).size).toBe(flat.length);
  });

  it('展示清单 == 分组拼接，且界面展示顺序直接复用清单顺序', () => {
    const flat = QUOTA_GROUPS.flatMap((group) => [...group.sources]);
    expect([...QUOTA_SOURCE_IDS]).toEqual(flat);
    expect([...QUOTA_ROW_ORDER]).toEqual([...QUOTA_SOURCE_IDS]);
  });

  it('每个来源都有非空中文标签（新增来源忘记加标签会在这里红）', () => {
    expect(QUOTA_SOURCE_IDS.length).toBe(QUOTA_GROUPS.reduce((sum, group) => sum + group.sources.length, 0));
    for (const source of QUOTA_SOURCE_IDS) {
      expect(QUOTA_SOURCE_LABEL[source], `缺少 ${source} 的标签`).toBeTruthy();
      expect(QUOTA_SOURCE_LABEL[source].trim()).not.toBe('');
    }
  });
});
