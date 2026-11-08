/** GET /api/system/mcp-info 契约：字段形状、entry 解析、真实 spawn 拉 tools/list 与未构建分支。 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestDb, type TestDb } from './helpers.js';
import { createApp, type CreatedApp } from '../src/index.js';
import { readSettings } from '../src/config.js';
import { buildMcpInfo, fetchMcpTools, resolveMcpEntry, resetMcpToolsCache } from '../src/services/mcpInfo.js';
import { resetSessionManager } from '../src/services/sessionManager.js';

const mcpEntry = resolveMcpEntry();
const mcpBuilt = existsSync(mcpEntry);

let t: TestDb;
let app: Express;

beforeEach(async () => {
  t = createTestDb();
  const created: CreatedApp = await createApp({ db: t.db, refreshClisOnBoot: false });
  app = created.app;
});

afterEach(() => {
  resetSessionManager();
  t.cleanup();
});

describe('GET /api/system/mcp-info', () => {
  // 真实子进程 + initialize + tools/list（本机未构建则跳过）；先跑让结果进缓存供端点用例复用
  it.runIf(mcpBuilt)('真实 spawn apps/mcp/dist/index.js 拉 tools/list：primary 含核心工具', async () => {
    resetMcpToolsCache();
    const { tools, error } = await fetchMcpTools(mcpEntry);
    expect(error).toBeNull();
    expect(tools).not.toBeNull();
    expect(tools!.protocol_version).toBe('2025-06-18');
    expect(tools!.primary_count).toBeGreaterThan(0);
    expect(tools!.primary_count).toBe(tools!.primary.length);
    expect(tools!.alias_count).toBeGreaterThanOrEqual(0);
    expect(tools!.primary).toEqual(expect.arrayContaining(['list_workspaces', 'create_task']));
  }, 30_000);

  it('端点契约：200、字段齐全、base_url 与 entry 路径', async () => {
    const res = await request(app).get('/api/system/mcp-info');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['base_url', 'mcp_built', 'mcp_entry', 'tools', 'tools_error']);
    expect(res.body.base_url).toBe(`http://127.0.0.1:${readSettings().port}`);
    expect(res.body.mcp_entry).toBe(mcpEntry);
    expect(res.body.mcp_entry.endsWith(join('apps', 'mcp', 'dist', 'index.js'))).toBe(true);
    expect(res.body.mcp_built).toBe(mcpBuilt);
    if (mcpBuilt) {
      expect(res.body.tools).not.toBeNull();
      expect(res.body.tools_error).toBeNull();
      expect(res.body.tools.protocol_version).toBe('2025-06-18');
      expect(res.body.tools.primary_count).toBe(res.body.tools.primary.length);
    } else {
      expect(res.body.tools).toBeNull();
      expect(typeof res.body.tools_error).toBe('string');
      expect((res.body.tools_error as string).length).toBeGreaterThan(0);
    }
  }, 30_000);

  it('未构建分支：entry 注入不存在路径 → tools=null 且 tools_error 非空（不 spawn）', async () => {
    const missing = join(tmpdir(), 'agentboard-mcpinfo-missing', 'index.js');
    expect(existsSync(missing)).toBe(false);
    expect(await buildMcpInfo({ port: 12345 }, missing)).toEqual({
      mcp_entry: missing,
      mcp_built: false,
      base_url: 'http://127.0.0.1:12345',
      tools: null,
      tools_error: expect.stringContaining('MCP 未构建'),
    });
  });
});
