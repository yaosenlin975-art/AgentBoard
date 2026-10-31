import type { CliInfo } from '@agentboard/shared';
import { ADAPTERS, type AgentAdapter } from '@agentboard/adapters';

/** 内存缓存：服务启动 refreshClis 后供顶栏/派发弹窗读取（设计 §5.1） */
let cache: CliInfo[] = [];

/**
 * 并行探测全部适配器并刷新内存缓存；adapters 参数供测试注入 fake。
 * CLI 未安装由适配器 detect 返回 { installed: false } 表达（Review Focus 5：探测不抛错），
 * detect 本身抛错视为适配器缺陷，向上传播且不写缓存。
 */
export async function refreshClis(adapters: AgentAdapter[] = ADAPTERS): Promise<CliInfo[]> {
  const infos = await Promise.all(
    adapters.map(async (adapter) => {
      const { installed, version } = await adapter.detect();
      return { id: adapter.id, displayName: adapter.displayName, installed, version };
    }),
  );
  cache = infos;
  return infos;
}

export function getCachedClis(): CliInfo[] {
  return cache;
}

export function invalidateClis(): void {
  cache = [];
}
