import { PassThrough } from 'node:stream';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { createTaskMcpServer } from '../src/index.js';

export type RpcResponse = {
  id?: number;
  jsonrpc?: string;
  result?: Record<string, any>;
  error?: Record<string, any>;
};

export function createHarness(config: { baseUrl: string; workspaceId?: string; agentId?: string }, fetcher?: typeof fetch) {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new StdioServerTransport(input, output);
  const handle = serveStdio(() => createTaskMcpServer(config, fetcher), { transport });
  const pending = new Map<number, (response: RpcResponse) => void>();
  const stdoutMessages: RpcResponse[] = [];
  let data = '';
  let id = 1;
  output.on('data', (chunk: Buffer) => {
    data += chunk.toString('utf8');
    for (;;) {
      const end = data.indexOf('\n');
      if (end < 0) break;
      const line = data.slice(0, end).trim();
      data = data.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line) as RpcResponse;
      stdoutMessages.push(message);
      if (typeof message.id === 'number') pending.get(message.id)?.(message);
    }
  });
  return {
    async start() {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const initialized = await this.request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'agentboard-mcp-test', version: '1.0.0' },
      });
      input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return initialized;
    },
    request(method: string, params: Record<string, unknown> = {}) {
      const requestId = id++;
      const response = new Promise<RpcResponse>((resolve) => pending.set(requestId, resolve));
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
      return response;
    },
    async close() {
      await handle.close();
      input.destroy();
      output.destroy();
    },
    stdoutMessages,
  };
}
