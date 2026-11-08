/**
 * MCP 信息自报（GET /api/system/mcp-info）：解析 apps/mcp/dist/index.js 入口，
 * 真实 spawn 子进程走 initialize → tools/list 拉取已注册工具（非静态清单）。
 * 协议口径与 apps/mcp/scripts/list-tools.mjs 一致：主名=非 agentboard_ 前缀，别名=agentboard_* 前缀。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;

export interface McpToolsInfo {
  protocol_version: string;
  primary: string[];
  primary_count: number;
  alias_count: number;
}

export interface McpInfo {
  mcp_entry: string;
  mcp_built: boolean;
  base_url: string;
  tools: McpToolsInfo | null;
  tools_error: string | null;
}

interface JsonRpcMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string } | undefined;
}

interface McpToolsResult {
  tools: McpToolsInfo | null;
  error: string | null;
}

/** apps/mcp/dist/index.js 绝对路径：server 测试跑 src、生产跑 dist，services 目录距 apps/ 同为 3 级 */
export function resolveMcpEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', 'mcp', 'dist', 'index.js');
}

function fetchMcpToolsOnce(entry: string): Promise<McpToolsResult> {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let settled = false;
    let stdoutBuffer = '';
    let stderr = '';
    let nextId = 1;
    const pending = new Map<number, { resolve: (message: JsonRpcMessage) => void; reject: (err: Error) => void }>();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: McpToolsResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      child.kill();
      settle(result);
    };
    const fail = (message: string): void => {
      for (const waiter of pending.values()) waiter.reject(new Error(message));
      pending.clear();
      finish({ tools: null, error: message });
    };

    timer = setTimeout(() => {
      finish({ tools: null, error: `MCP tools/list 超时（${FETCH_TIMEOUT_MS}ms）` });
    }, FETCH_TIMEOUT_MS);

    // 子进程死后 stdin 可能残余写入触发 EPIPE，error 事件吞掉即可（失败路径已由 exit/timeout 接管）
    child.stdin?.on('error', () => {});
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      for (;;) {
        const newline = stdoutBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line === '') continue;
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(line) as JsonRpcMessage;
        } catch {
          continue;
        }
        if (typeof message.id === 'number') {
          const waiter = pending.get(message.id);
          if (waiter !== undefined) {
            pending.delete(message.id);
            waiter.resolve(message);
          }
        }
      }
    });
    child.on('error', (err) => {
      fail(`MCP 进程启动失败: ${err.message}`);
    });
    child.on('exit', (code) => {
      const detail = stderr.trim().slice(0, 200);
      fail(`MCP 进程提前退出（code=${code}）${detail === '' ? '' : `：${detail}`}`);
    });

    const request = (method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> =>
      new Promise((resolveRequest, rejectRequest) => {
        const id = nextId++;
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });

    void (async () => {
      try {
        const init = await request('initialize', {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'agentboard-server', version: '1.0.0' },
        });
        if (init.error) {
          fail(`initialize 失败：${JSON.stringify(init.error)}`);
          return;
        }
        child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
        const listed = await request('tools/list', {});
        if (listed.error) {
          fail(`tools/list 失败：${JSON.stringify(listed.error)}`);
          return;
        }
        const names = ((listed.result as { tools?: Array<{ name?: unknown }> } | undefined)?.tools ?? [])
          .map((tool) => (typeof tool?.name === 'string' ? tool.name : ''))
          .filter((name) => name !== '');
        const primary = names.filter((name) => !name.startsWith('agentboard_'));
        finish({
          tools: { protocol_version: MCP_PROTOCOL_VERSION, primary, primary_count: primary.length, alias_count: names.length - primary.length },
          error: null,
        });
      } catch (err) {
        finish({ tools: null, error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}

let toolsCache: { at: number; result: McpToolsResult } | null = null;

/** spawn 拉 tools/list；60s 模块级 TTL 缓存（成功与失败都缓存，避免逐请求起子进程） */
export async function fetchMcpTools(entry: string): Promise<McpToolsResult> {
  const now = Date.now();
  if (toolsCache !== null && now - toolsCache.at < CACHE_TTL_MS) return toolsCache.result;
  const result = await fetchMcpToolsOnce(entry);
  toolsCache = { at: now, result };
  return result;
}

/** 测试隔离用：清空 tools 缓存 */
export function resetMcpToolsCache(): void {
  toolsCache = null;
}

/** 装配 /api/system/mcp-info 响应；entryOverride 仅测试注入（未构建分支断言用） */
export async function buildMcpInfo(config: { port: number }, entryOverride?: string): Promise<McpInfo> {
  const entry = entryOverride ?? resolveMcpEntry();
  const base_url = `http://127.0.0.1:${config.port}`;
  if (!existsSync(entry)) {
    return {
      mcp_entry: entry,
      mcp_built: false,
      base_url,
      tools: null,
      tools_error: `MCP 未构建（先 pnpm --filter @agentboard/mcp build）：${entry}`,
    };
  }
  const { tools, error } = await fetchMcpTools(entry);
  return { mcp_entry: entry, mcp_built: true, base_url, tools, tools_error: error };
}
