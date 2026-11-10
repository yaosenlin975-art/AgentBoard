/**
 * 派发模板（前端副本）对账断言：
 * - 第 5 条「有可复用结论才写知识页」逐字存在，且 workspace 变量正确替换；
 * - 不再出现 `handoff-<issue>` 这类被技能明令禁用的 slug；
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

describe('派发模板第 5 条（知识页口径）', () => {
  it('模板含逐字的第 5 条，且不再要求 handoff-<issue> slug', () => {
    expect(DISPATCH_PROMPT_TEMPLATE).toContain(
      '5. 有可复用结论（踩坑、验证方法、接口事实、口径裁决）时写或更新一条工作区知识页（`kb knowledge create --scope workspace --workspace {{workspace_id}} --domain knowledge --stdin`；`--domain` 必填，取值 accounts|knowledge|board|chat|ui|infra，按任务所属域替换，不确定用 knowledge）：正文写可复用的设计与坑，不写进度与流水账；同主题已存在时用 `kb knowledge revise` 更新，不新建重复页。无可复用结论时在 `kb done --notes` 声明原因。',
    );
    expect(DISPATCH_PROMPT_TEMPLATE).not.toContain('handoff-');
    // 第 5 条是最后一条，模板以其句号收尾（无多余空行）
    expect(DISPATCH_PROMPT_TEMPLATE.trimEnd().endsWith('声明原因。')).toBe(true);
  });

  it('渲染后 issue_id 与 workspace_id 都落在正确位置，且无残留占位符', () => {
    const rendered = renderDispatchPrompt(DISPATCH_PROMPT_TEMPLATE, vars);
    expect(rendered).toContain('`kb knowledge create --scope workspace --workspace ws-8f3a1c2e-0000-4000-8000-123456789abc --domain knowledge --stdin`');
    expect(rendered).not.toContain('{{');
    for (const value of [vars.issue_id, vars.title, vars.description, vars.workspace_path, vars.workspace_id]) {
      expect(rendered).toContain(value);
    }
  });

  it('渲染全文哈希固定（与服务端同一模板逐字一致）', () => {
    const rendered = renderDispatchPrompt(DISPATCH_PROMPT_TEMPLATE, vars);
    // 与服务端 apps/server/src/services/dispatch.ts 模板渲染结果逐字节一致
    expect(sha(rendered)).toBe('E4442270FE6EEBA5F64B1988CB3A0405FAE92D780602B57EC3963BA254BFC0E6');
  });

  it('前端副本仍与服务端模板逐字一致（跨包漂移检测）', () => {
    const web = readFileSync(resolve(process.cwd(), 'src/lib/dispatchTemplate.ts'), 'utf8');
    // ARCH-05 之后模板落在 dispatchTemplate.ts（dispatch.ts 只做 re-export），漂移检测必须读真源
    const server = readFileSync(resolve(process.cwd(), '../server/src/services/dispatchTemplate.ts'), 'utf8');
    const grab = (src: string, name: string): string => {
      const m = src.match(new RegExp(`export const ${name} = \`([\\s\\S]*?)\`;\\n`));
      if (m === null || m[1] === undefined) throw new Error('template not found');
      return m[1];
    };
    expect(grab(web, 'DISPATCH_PROMPT_TEMPLATE')).toBe(grab(server, 'DEFAULT_DISPATCH_PROMPT_TEMPLATE'));
  });
});

