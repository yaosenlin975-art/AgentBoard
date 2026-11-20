import type { CliInfo, StreamingGranularity } from '@agentboard/shared';
import { ADAPTERS, CODEBUDDY_CMD, probeCliCapabilities, type AgentAdapter } from '@agentboard/adapters';

/** 内存缓存：服务启动 refreshClis 后供顶栏/派发弹窗读取（设计 §5.1） */
let cache: CliInfo[] = [];

/**
 * CHAT-STREAM-PROBE：流式粒度透出。静态声明直接透传；codebuddy 的 token 级依赖
 * `--include-partial-messages`，已安装时经 --help 探测校准，老 CLI（无该参数）降级 block。
 * 探测失败（超时/spawn 错误）按能力全无处理 → 降级 block，不阻断会话。
 */
async function resolveStreaming(adapter: AgentAdapter, installed: boolean): Promise<StreamingGranularity | undefined> {
  if (adapter.streaming !== 'token') return adapter.streaming;
  if (adapter.id === 'codebuddy' && installed) {
    const caps = await probeCliCapabilities(CODEBUDDY_CMD);
    return caps.partialMessages ? 'token' : 'block';
  }
  return adapter.streaming;
}

/**
 * 并行探测全部适配器并刷新内存缓存；adapters 参数供测试注入 fake。
 * CLI 未安装由适配器 detect 返回 { installed: false } 表达（Review Focus 5：探测不抛错），
 * detect 本身抛错视为适配器缺陷，向上传播且不写缓存。
 */
export async function refreshClis(adapters: AgentAdapter[] = ADAPTERS): Promise<CliInfo[]> {
  const infos = await Promise.all(
    adapters.map(async (adapter) => {
      const { installed, version } = await adapter.detect();
      return {
        id: adapter.id,
        displayName: adapter.displayName,
        installed,
        version,
        supportsModelSelection: adapter.supportsModelSelection,
        streaming: await resolveStreaming(adapter, installed),
      };
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
