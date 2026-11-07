#!/usr/bin/env node
/**
 * 现场列出 stdio MCP 服务真实注册的工具。
 * 走真实子进程 + initialize + tools/list，不是静态清单：改动工具注册后无需同步本文件。
 *
 * 用法：
 *   node apps/mcp/scripts/list-tools.mjs            # 人读表格
 *   node apps/mcp/scripts/list-tools.mjs --json     # 机器可读
 *   pnpm --filter @agentboard/mcp list-tools
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'dist', 'index.js');
const TIMEOUT_MS = 60_000;

if (!existsSync(entry)) {
  process.stderr.write(`未找到 ${entry}，先构建：corepack pnpm --filter @agentboard/mcp build\n`);
  process.exit(1);
}

const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let nextId = 1;
let buffer = '';
let stderr = '';

function fail(message) {
  child.kill();
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const timer = setTimeout(() => fail(`MCP 工具列表超时（${TIMEOUT_MS}ms）`), TIMEOUT_MS);
timer.unref();

child.stderr.on('data', (chunk) => {
  stderr += chunk.toString('utf8');
});

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const end = buffer.indexOf('\n');
    if (end < 0) break;
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(`MCP stdout 出现非 JSON-RPC 行：${line.slice(0, 200)}`);
    }
    if (typeof message.id === 'number') {
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  }
});

child.on('exit', (code) => {
  if (pending.size > 0) fail(`MCP 进程提前退出（code=${code}）${stderr ? `：${stderr.trim()}` : ''}`);
});

function request(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

const init = await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'agentboard-list-tools', version: '1.0.0' },
});
if (init.error) fail(`initialize 失败：${JSON.stringify(init.error)}`);
notify('notifications/initialized', {});
const listed = await request('tools/list', {});
if (listed.error) fail(`tools/list 失败：${JSON.stringify(listed.error)}`);
clearTimeout(timer);
child.stdin.end();
child.kill();

const tools = (listed.result?.tools ?? []).map((tool) => ({
  name: tool.name,
  read_only: tool.annotations?.readOnlyHint === true,
  description: tool.description ?? '',
}));
const aliases = tools.filter((tool) => tool.name.startsWith('agentboard_'));
const primary = tools.filter((tool) => !tool.name.startsWith('agentboard_'));

if (process.argv.includes('--json')) {
  emit(`${JSON.stringify({ protocolVersion: init.result?.protocolVersion, count: tools.length, primary: primary.length, aliases: aliases.length, tools }, null, 2)}\n`);
} else {
  const lines = [`AgentBoard MCP tools: ${tools.length} (${primary.length} primary + ${aliases.length} agentboard_* aliases)`];
  const width = Math.max(...tools.map((tool) => tool.name.length));
  for (const tool of tools) {
    const kind = tool.read_only ? 'read ' : 'write';
    lines.push(`${tool.name.padEnd(width)}  ${kind}  ${tool.description}`);
  }
  emit(`${lines.join('\n')}\n`);
}

/** 先结束子进程再刷 stdout；回调里显式退出，避免子进程句柄让脚本挂住。 */
function emit(text) {
  child.stdin.end();
  child.kill();
  process.stdout.write(text, () => process.exit(0));
}
