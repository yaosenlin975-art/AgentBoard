/**
 * 派发模板（前端副本）对账断言：
 * - 第 5 条「完成前必须写一条知识页」逐字存在，且 slug/workspace 变量正确替换；
 * - `{{workspace_id}}` 有值、渲染后无残留占位符；
 * - 渲染全文的 SHA-256 固定（与服务端 `dispatch.ts` 同一模板，逐字一致时哈希相等）。
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DISPATCH_PROMPT_TEMPLATE, renderDispatchPrompt } from '../lib/dispatchTemplate';

const vars = {
  issue_id: '8f3a1c2e-0000-4000-8000-123456789abc',
  title: '渲染对账样例',
  description: '用固定变量渲染整段文本，供前后端逐字对账',
  workspace_path: 'D:/WorkSpaces/demo',
  workspace_id: 'ws-8f3a1c2e-0000-4000-8000-123456789abc',
};

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase();

describe('派发模板第 5 条（KB-WRITE-NUDGE）', () => {
  it('模板含逐字的第 5 条：知识页 slug handoff-<issue> + scope workspace + --workspace <ws> --stdin', () => {
    expect(DISPATCH_PROMPT_TEMPLATE).toContain(
      '5. 完成前必须写一条知识页（`kb knowledge create --slug handoff-{{issue_id}} --scope workspace --workspace {{workspace_id}} --stdin`）：正文写本次任务的目标、关键决策与取舍、验证方式与结果、未验证项与剩余风险；不写流水账、不写变更日志式条目。同 slug 已存在时更新该页，不新建重复页。',
    );
    // 第 5 条是最后一条，模板以其句号收尾（无多余空行）
    expect(DISPATCH_PROMPT_TEMPLATE.trimEnd().endsWith('不新建重复页。')).toBe(true);
  });

  it('渲染后 issue_id 与 workspace_id 都落在正确位置，且无残留占位符', () => {
    const rendered = renderDispatchPrompt(DISPATCH_PROMPT_TEMPLATE, vars);
    expect(rendered).toContain('`kb knowledge create --slug handoff-8f3a1c2e-0000-4000-8000-123456789abc --scope workspace --workspace ws-8f3a1c2e-0000-4000-8000-123456789abc --stdin`');
    expect(rendered).not.toContain('{{');
    for (const value of [vars.issue_id, vars.title, vars.description, vars.workspace_path, vars.workspace_id]) {
      expect(rendered).toContain(value);
    }
  });

  it('渲染全文哈希固定（与服务端同一模板逐字一致）', () => {
    const rendered = renderDispatchPrompt(DISPATCH_PROMPT_TEMPLATE, vars);
    // 与服务端 apps/server/src/services/dispatch.ts 模板渲染结果逐字节一致
    expect(sha(rendered)).toBe('1B01B99DC5FBE4B0D4337866834F837F0949AD2497C9AEB64BCAFA5888E1340B');
  });

  it('前端副本仍与服务端模板逐字一致（跨包漂移检测）', () => {
    const web = readFileSync(resolve(process.cwd(), 'src/lib/dispatchTemplate.ts'), 'utf8');
    const server = readFileSync(resolve(process.cwd(), '../server/src/services/dispatch.ts'), 'utf8');
    const grab = (src: string): string => {
      const m = src.match(/export const DISPATCH_PROMPT_TEMPLATE = `([\s\S]*?)`;\n/);
      if (m === null || m[1] === undefined) throw new Error('template not found');
      return m[1];
    };
    expect(grab(web)).toBe(grab(server));
  });
});

