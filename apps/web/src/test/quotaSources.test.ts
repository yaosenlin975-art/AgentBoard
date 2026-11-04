/**
 * ACC-KB-A4：额度来源的单一事实源漂移闸。
 *
 * 收敛前 server（`quotaService.ts`）与 web（`QuotaCards.tsx`）各持一份
 * `'deepseek' | 'opencode_go' | 'codex'` 字面量 union 与一份来源标签，靠人肉同步。
 * 现在只有 `packages/shared` 一份；本测试钉住「清单与标签同步」——新增来源时若漏写标签，
 * 界面会渲染出 `undefined`，这里先红。
 */
import { describe, expect, it } from 'vitest';
import { QUOTA_SOURCE_IDS, QUOTA_SOURCE_LABEL } from '@agentboard/shared';
import { QUOTA_ROW_ORDER } from '../components/settings/QuotaCards';

describe('额度来源单一事实源（ACC-KB-A4）', () => {
  it('来源清单固定在 packages/shared，且前端展示顺序直接复用它', () => {
    expect([...QUOTA_SOURCE_IDS]).toEqual(['deepseek', 'opencode_go', 'codex']);
    expect([...QUOTA_ROW_ORDER]).toEqual([...QUOTA_SOURCE_IDS]);
  });

  it('每个来源都有非空中文标签（新增来源忘记加标签会在这里红）', () => {
    for (const source of QUOTA_SOURCE_IDS) {
      expect(QUOTA_SOURCE_LABEL[source], `缺少 ${source} 的标签`).toBeTruthy();
      expect(QUOTA_SOURCE_LABEL[source].trim()).not.toBe('');
    }
  });
});
