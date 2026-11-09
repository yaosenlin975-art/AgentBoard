/**
 * OPT-12：`kb decisions --issue` 必须由服务端按 issue_id 过滤，不能依赖 200 条前缀窗口。
 *
 * 这里直接压仓储层：构造 205 条他卡决策 + 1 条目标卡决策（created_at 最旧，落在默认 200 条窗口之外），
 * 断言「不过滤时查不到目标卡决策、按 issue_id 过滤时能查到」——即过滤发生在 LIMIT 之前。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { insertDecision, listDecisions } from '../src/db/repos/decision.js';

const OPTIONS = [
  { label: '继续', consequence: '继续执行' },
  { label: '停止', consequence: '停在检查点' },
];

let t: TestDb;
let wsId: string;
let targetIssueId: string;

beforeEach(() => {
  t = createTestDb();
  wsId = createWorkspace(t.db, { name: 'ws', path: 'D:\\ws-window' }).id;
  const noisy = createIssue(t.db, { workspace_id: wsId, title: '噪音卡' });
  const target = createIssue(t.db, { workspace_id: wsId, title: '目标卡' });
  targetIssueId = target.id;
  const now = Date.now();
  // 205 条他卡决策，created_at 全部晚于目标卡决策 → 默认 200 条窗口只装得下它们的一部分
  for (let index = 0; index < 205; index += 1) {
    insertDecision(t.db, {
      workspace_id: wsId, issue_id: noisy.id, question: `噪音决策 ${index}`,
      created_by: 'agent-1', grace_seconds: 180, grace_until: now + 180_000,
      state: 'answered', locked_at: now, now: now + 1_000 + index * 10, options: OPTIONS,
    });
  }
  // 目标卡决策：created_at 最旧，未过滤时排在第 206 位，必然落在 200 条窗口之外
  insertDecision(t.db, {
    workspace_id: wsId, issue_id: target.id, question: '目标卡决策',
    created_by: 'agent-1', grace_seconds: 180, grace_until: now + 180_000,
    state: 'answered', locked_at: now, now: now - 10_000, options: OPTIONS,
  });
});

afterEach(() => {
  t.cleanup();
});

describe('decisions 按 issue_id 服务端过滤（OPT-12）', () => {
  it('默认 200 条窗口装不下最旧的目标卡决策（证明存在被窗口截掉的场景）', () => {
    const unfiltered = listDecisions(t.db, { workspace_id: wsId, states: ['answered'] });
    expect(unfiltered).toHaveLength(200);
    expect(unfiltered.some(row => row.issue_id === targetIssueId)).toBe(false);
  });

  it('带 issue_id 时过滤发生在 LIMIT 之前：窗口外的目标卡决策仍能查到', () => {
    const filtered = listDecisions(t.db, { workspace_id: wsId, issue_id: targetIssueId, states: ['answered'] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.question).toBe('目标卡决策');
  });

  it('issue_id 过滤只返回该卡决策，不混入他卡', () => {
    const filtered = listDecisions(t.db, { workspace_id: wsId, issue_id: targetIssueId, states: ['answered'] });
    expect(filtered.every(row => row.issue_id === targetIssueId)).toBe(true);
  });
});
