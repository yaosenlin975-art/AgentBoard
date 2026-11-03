import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { AgentBoardApiClient } from './apiClient.js';
import type { McpConfig } from './config.js';
import { loadMcpConfig } from './config.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerDependencyTools } from './tools/dependencies.js';
import { registerKnowledgeTools } from './tools/knowledge.js';

// MCP 握手版本：createRequire 按模块 URL 定位本包 package.json（src/ 与打包后 dist/ 均在其上一级）
const require = createRequire(import.meta.url);
const MCP_VERSION = (require('../package.json') as { version?: string }).version ?? '0.0.0';

export function createTaskMcpServer(config: McpConfig, fetcher: typeof fetch = fetch): McpServer {
  const server = new McpServer({ name: 'agentboard', version: MCP_VERSION });
  const api = new AgentBoardApiClient(config, fetcher);
  registerTaskTools(server, config, api);
  registerDependencyTools(server, config, api);
  registerKnowledgeTools(server, config, api);
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
