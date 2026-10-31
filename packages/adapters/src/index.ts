import type { AgentAdapter } from './types.js';
import { codebuddyAdapter } from './codebuddy.js';

export * from './types.js';
export * from './spawn.js';
export * from './codebuddy.js';

// Task 3 仅 codebuddy；Task 5 补全 codex / opencode / dsh 四项
export const ADAPTERS: AgentAdapter[] = [codebuddyAdapter];

export function getAdapter(id: AgentAdapter['id']): AgentAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}
