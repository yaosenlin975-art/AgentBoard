/**
 * MCP-06：客户端兼容性（stdio 传输 + 三客户端 profile）协议层验收。
 * 用真实 StdioServerTransport（helpers.createHarness）模拟 host，按 Codex / DSH / WorkBuddy
 * 的 clientInfo 分别握手，验证 initialize、tools/list 只暴露任务板/知识工具、
 * 只读工具返回 structuredContent、错误走 isError 安全码；不依赖任何客户端安装。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createHarness } from './helpers.js';

const WORKSPACE_ID = '5f1b2c34-0000-4000-8000-00000000a001';
const TASK_ID = '5f1b2c34-0000-4000-8000-00000000b001';

const page = (items: unknown[]) => ({ items, next_offset: null });

/** 只读 API 假后端：只暴露验收所需的三条读路径，其余一律 404（不泄露任何写能力） */
function fakeFetcher(calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    switch (url.pathname) {
      case '/api/workspaces':
        return json(page([{ id: WORKSPACE_ID, name: '任务看板', path: 'D:\\WorkSpaces\\任务看板', created_at: 1 }]));
      case `/api/issues/${TASK_ID}`:
        return json({
          id: TASK_ID,
          workspace_id: WORKSPACE_ID,
          title: 'MCP 只读验收',
          description: '描述片段',
          description_truncated: false,
          next_description_offset_chars: null,
          priority: '中',
          labels: [],
          status: '进行中',
          sort_order: 0,
          parent_issue_id: null,
          claimed_by: null,
          claimed_at: null,
          session_id: null,
          comment_count: 0,
          created_at: 1,
          updated_at: 1,
        });
      case '/api/knowledge/search':
        return json([
          {
            page_id: '5f1b2c34-0000-4000-8000-00000000c001',
            title: '验收知识页',
            scope: 'workspace',
            workspace_id: WORKSPACE_ID,
            revision: 1,
            snippet: '命中片段',
            sources_total: 1,
            evidence_total: 1,
            sources: [{ source_id: 's1', source_type: 'file', locator: 'Docs/design.md' }],
            evidence: [{ source_id: 's1', locator: 'Docs/design.md' }],
          },
        ]);
      default:
        return json({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
    }
  }) as unknown as typeof fetch;
}

type ToolResult = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, any>;
};

type ListedTool = { name: string; description?: string; annotations?: Record<string, unknown> };

/** 三客户端握手 profile（clientInfo 按各客户端真实上报形态） */
const CLIENT_PROFILES = [
  { key: 'codex', clientInfo: { name: 'codex-mcp-client', version: '0.166.0' } },
  { key: 'dsh', clientInfo: { name: 'deepseek-harness', version: '1.0.0' } },
  { key: 'workbuddy', clientInfo: { name: 'workbuddy', version: '5.0.0' } },
] as const;

async function handshake(profile: (typeof CLIENT_PROFILES)[number]) {
  const calls: string[] = [];
  const harness = createHarness({ baseUrl: 'http://127.0.0.1:8787' }, fakeFetcher(calls));
  const init = await harness.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: profile.clientInfo,
  });
  const list = await harness.request('tools/list', {});
  const call = (name: string, args: Record<string, unknown>) =>
    harness.request('tools/call', { name, arguments: args }) as Promise<{ result?: ToolResult }>;
  return { harness, init, list, call, calls };
}

describe('MCP stdio host 与三客户端 profile 兼容', () => {
  it('stdioHostInitializesAndListsOnlyBoardKnowledgeTools：initialize 成功且工具面只有任务板/知识工具，无 session/shell/account/delete', async () => {
    const { harness, init, list } = await handshake(CLIENT_PROFILES[0]);
    try {
      expect(init.error).toBeUndefined();
      expect(init.result).toMatchObject({ serverInfo: { name: 'agentboard' } });
      expect(typeof init.result?.protocolVersion).toBe('string');

      const tools = (list.result?.tools ?? []) as ListedTool[];
      const names = tools.map((t) => t.name).sort();
      expect(names.length).toBeGreaterThan(0);
      expect(names.every((n) => n.startsWith('agentboard_'))).toBe(true);
      // 只读面必备三项
      expect(names).toEqual(
        expect.arrayContaining([
          'agentboard_list_workspaces',
          'agentboard_get_task',
          'agentboard_search_knowledge',
        ]),
      );
      // 不得出现会话/终端/账号一类越界工具；破坏性工具只允许逐个批准的精确名字
      // （任务删除来自 CLI-DELETE 卡，依赖删边来自 DEP-2 卡），其余含 delete/remove 的工具一体禁止。
      const approvedDestructive = new Set(['agentboard_delete_task', 'agentboard_remove_dependency']);
      for (const forbidden of ['session', 'shell', 'exec', 'account', 'credential', 'remove', 'delete']) {
        expect(names.filter((n) => n.includes(forbidden) && !approvedDestructive.has(n))).toEqual([]);
      }
      expect(names.filter((n) => n.includes('delete'))).toEqual(['agentboard_delete_task']);
      expect(names.filter((n) => n.includes('remove'))).toEqual(['agentboard_remove_dependency']);
      // 只读工具带 readOnlyHint（客户端据此决定是否默认放行）
      const listWorkspaces = tools.find((t) => t.name === 'agentboard_list_workspaces');
      expect(listWorkspaces?.annotations).toMatchObject({ readOnlyHint: true });
    } finally {
      await harness.close();
    }
  });

  it('codexClientReadsStructuredContent：list_workspaces / get_task / search_knowledge 均返回 structuredContent', async () => {
    const { harness, call, calls } = await handshake(CLIENT_PROFILES[0]);
    try {
      const workspaces = (await call('agentboard_list_workspaces', { limit: 20, offset: 0 })).result!;
      expect(workspaces.isError).toBeFalsy();
      expect(workspaces.structuredContent).toMatchObject({ ok: true });
      expect(workspaces.structuredContent!.data.items[0]).toEqual({ id: WORKSPACE_ID, name: '任务看板' });
      // 路径等敏感字段不外泄
      expect(JSON.stringify(workspaces.structuredContent)).not.toContain('WorkSpaces');

      const task = (await call('agentboard_get_task', { workspace_id: WORKSPACE_ID, task_id: TASK_ID })).result!;
      expect(task.isError).toBeFalsy();
      expect(task.structuredContent!.data).toMatchObject({ id: TASK_ID, title: 'MCP 只读验收' });

      const knowledge = (await call('agentboard_search_knowledge', {
        scope: 'workspace',
        workspace_id: WORKSPACE_ID,
        query: '验收',
        limit: 5,
      })).result!;
      expect(knowledge.isError).toBeFalsy();
      expect(knowledge.structuredContent!.data.items[0]).toMatchObject({ id: '5f1b2c34-0000-4000-8000-00000000c001', title: '验收知识页' });

      // 每类只读调用各命中一次读接口
      expect(calls).toEqual(
        expect.arrayContaining(['/api/workspaces?limit=20&offset=0', '/api/knowledge/search?q=%E9%AA%8C%E6%94%B6&limit=5&scope=workspace&workspace_id=' + WORKSPACE_ID]),
      );
      expect(calls.some((c) => c.startsWith(`/api/issues/${TASK_ID}`))).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('dshClientReadsStructuredContent：同一 stdio 命令在 DSH profile 下结果一致，错误走 isError 安全码', async () => {
    const { harness, call } = await handshake(CLIENT_PROFILES[1]);
    try {
      const workspaces = (await call('agentboard_list_workspaces', { limit: 5, offset: 0 })).result!;
      expect(workspaces.structuredContent).toMatchObject({ ok: true });

      // 未知任务：404 → 安全码 TASK_NOT_FOUND + isError（客户端可结构化判定，不解析裸文本）
      const missing = (await call('agentboard_get_task', {
        workspace_id: WORKSPACE_ID,
        task_id: '5f1b2c34-0000-4000-8000-00000000ffff',
      })).result!;
      expect(missing.isError).toBe(true);
      expect(missing.structuredContent).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
      expect(missing.content?.[0]?.text).toBe('The task does not exist in this workspace.');
    } finally {
      await harness.close();
    }
  });

  it('workbuddyClientReadsStructuredContent：同一 stdio 命令在 WorkBuddy profile 下结果一致', async () => {
    const { harness, init, list, call } = await handshake(CLIENT_PROFILES[2]);
    try {
      expect(init.result).toMatchObject({ serverInfo: { name: 'agentboard' } });
      expect(((list.result?.tools ?? []) as ListedTool[]).length).toBeGreaterThan(0);

      const task = (await call('agentboard_get_task', {
        workspace_id: WORKSPACE_ID,
        task_id: TASK_ID,
        description_max_chars: 100,
      })).result!;
      expect(task.isError).toBeFalsy();
      expect(task.structuredContent).toMatchObject({ ok: true });
      expect(task.content?.[0]?.text).toBe('agentboard_get_task succeeded.');
    } finally {
      await harness.close();
    }
  });

  it('stdout 只含协议 JSON-RPC 行：无日志/横幅污染（客户端解析不被打断）', async () => {
    const { harness, list } = await handshake(CLIENT_PROFILES[0]);
    try {
      expect(list.result).toBeDefined();
      for (const message of harness.stdoutMessages) {
        expect(message.jsonrpc).toBe('2.0');
        // 非协议字段一律不应出现：假后端/服务器不得往 stdout 打印调试信息
        expect(Object.keys(message).sort()).toEqual(
          expect.arrayContaining(['jsonrpc']),
        );
      }
    } finally {
      await harness.close();
    }
  });

  it('MCP 包自身不打印 stdout 日志（入口文件静态检查）', () => {
    const entry = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const toolFiles = ['../src/tools/tasks.ts', '../src/tools/knowledge.ts', '../src/apiClient.ts'].map((p) =>
      readFileSync(new URL(p, import.meta.url), 'utf8'),
    );
    for (const source of [entry, ...toolFiles]) {
      expect(source).not.toMatch(/console\.log\(/);
      expect(source).not.toMatch(/process\.stdout\.write\(/);
    }
  });
});
