import { describe, expect, it } from 'vitest';
import type { IssueStatus, Priority } from '../src/types.js';
import { AGENT_IDS, CLI_NAME, PRODUCT_NAME } from '../src/constants.js';

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

describe('shared 契约类型', () => {
  it('IssueStatus 字面量逐字一致', () => {
    const all: IssueStatus[] = ['待规划', '进行中', '待验收', '已关闭'];
    expect(all).toEqual(['待规划', '进行中', '待验收', '已关闭']);
    const exact: Expect<Equal<IssueStatus, '待规划' | '进行中' | '待验收' | '已关闭'>> = true;
    expect(exact).toBe(true);
  });

  it("Priority 默认值 '中' 属于 Priority 且字面量逐字一致", () => {
    const defaultValue: Priority = '中';
    expect(defaultValue).toBe('中');
    const exact: Expect<Equal<Priority, '低' | '中' | '高'>> = true;
    expect(exact).toBe(true);
  });

  it('常量导出 PRODUCT_NAME / CLI_NAME / AGENT_IDS', () => {
    expect(PRODUCT_NAME).toBe('AgentBoard');
    expect(CLI_NAME).toBe('kb');
    expect([...AGENT_IDS]).toEqual(['codebuddy', 'codex', 'opencode', 'dsh']);
  });
});
