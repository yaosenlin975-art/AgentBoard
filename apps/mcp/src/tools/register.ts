import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { mcpToolFailure, mcpToolSuccess, type McpToolResponse } from './result.js';

export interface BoardToolSpec {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  /** 默认 true（readOnlyHint 注解）；写工具传 false */
  readOnly?: boolean;
  /** 缺省 `mcpToolSuccess(data, summary)`；域内需再加工（写结果裁剪、体积闸）时覆写 */
  onResult?: (data: unknown, summary: string) => McpToolResponse;
}

/**
 * CR2-8 注册收敛：handler try/catch、成功包装与 `agentboard_<name>` alias 注册六域共用一份；
 * alias 去留归既有卡 f78d7465，此处保持现状。
 */
export function registerBoardTool(server: McpServer, spec: BoardToolSpec, run: (input: any) => Promise<unknown>): void {
  const { name, description, inputSchema, readOnly = true, onResult } = spec;
  const handler = async (input: any) => {
    try {
      const data = await run(input);
      return onResult ? onResult(data, `${name} succeeded.`) : mcpToolSuccess(data, `${name} succeeded.`);
    } catch (error) {
      return mcpToolFailure(error);
    }
  };
  const meta = { description, inputSchema, annotations: { readOnlyHint: readOnly } };
  server.registerTool(name, meta, handler);
  // 向后兼容：旧名 agentboard_<name> 保留为 alias，下个大版本移除
  server.registerTool(`agentboard_${name}`, meta, handler);
}
