import type { AgentAdapter } from './types.js';
import { codebuddyAdapter } from './codebuddy.js';
import { codexAdapter } from './codex.js';

export * from './types.js';
export * from './spawn.js';
export * from './codebuddy.js';
export * from './codex.js';

// Task 4 已加 codex；Task 5 补全 opencode / dsh 后为四项
export const ADAPTERS: AgentAdapter[] = [codebuddyAdapter, codexAdapter];

export function getAdapter(id: AgentAdapter['id']): AgentAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}
