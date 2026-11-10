import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { AgentBoardApiClient } from './apiClient.js';
import type { McpConfig } from './config.js';
import { loadMcpConfig } from './config.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerBoardViewTools } from './tools/boardViews.js';
import { registerDependencyTools } from './tools/dependencies.js';
import { registerStatusTools } from './tools/statuses.js';
import { registerKnowledgeTools } from './tools/knowledge.js';
import { registerDecisionTools } from './tools/decisions.js';
import { registerChangelogTools } from './tools/changelog.js';

// MCP 握手版本：createRequire 按模块 URL 定位本包 package.json（src/ 与打包后 dist/ 均在其上一级）
const require = createRequire(import.meta.url);
const MCP_VERSION = (require('../package.json') as { version?: string }).version ?? '0.0.0';

/**
 * 握手时下发的使用说明：空白 agent 只有 tools/list 时容易乱序调用（先 claim 后看卡、写完不 request_id）。
 * 这里只写顺序与硬约束，字段语义由各工具 inputSchema 的 description 承担。
 */
const MCP_INSTRUCTIONS = [
  'AgentBoard 任务看板。每个工具都有一个 agentboard_<name> 别名，行为完全相同，用其中一个即可，不要两个都调。',
  '典型顺序：list_tasks / next_tasks 找卡 → get_task 读卡面与评论 → claim_task 领取 → 干活 → add_task_comment 汇报 → complete_task 收尾（待验收）。',
  '写工具（claim/release/update/comment/complete/fail/close/reopen/accept/dependency/knowledge/changelog/ask 等）必须带 request_id（UUID 幂等键）；重复同一 request_id 返回同一结果。',
  '例外：delete_task 与 remove_dependency 是 DELETE 调用，没有幂等键，不要传 request_id。',
  '占用是排他的：claim_task 冲突（409）不要重试，换一张卡。带 fence 的写操作若收到 409 STALE_FENCE 说明卡已被别人重新领取，重新 get_task 后决定是否继续。',
  '决策只有人类能回答：ask_decision 落锁后 agent 只能等待，或用 withdraw_decision 撤回；不要尝试 answer_decision（会被 409/403 拒绝）。',
  '收尾前自检：写一条 create_changelog；有可复用结论时写 create_knowledge（新建需 scope+domain+category 与各 ≥1 条 sources/evidence）。complete_task 会被服务端变更日志门禁拦截（400 CHANGELOG_ACK_REQUIRED）——本次确实没有用户可见变更时传 skip_changelog=true。',
].join('\n');

export function createTaskMcpServer(config: McpConfig, fetcher: typeof fetch = fetch): McpServer {
  const server = new McpServer({ name: 'agentboard', version: MCP_VERSION }, { instructions: MCP_INSTRUCTIONS });
  const api = new AgentBoardApiClient(config, fetcher);
  registerTaskTools(server, config, api);
  registerBoardViewTools(server, config, api);
  registerDependencyTools(server, config, api);
  registerStatusTools(server, config, api);
  registerKnowledgeTools(server, config, api);
  registerDecisionTools(server, config, api);
  registerChangelogTools(server, config, api);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = loadMcpConfig();
    serveStdio(() => createTaskMcpServer(config));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid MCP configuration.'}\n`);
    process.exitCode = 1;
  }
}
