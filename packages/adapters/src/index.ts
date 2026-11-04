import type { AgentAdapter } from './types.js';
import { codebuddyAdapter } from './codebuddy.js';
import { codexAdapter } from './codex.js';
import { opencodeAdapter } from './opencode.js';
import { dshAdapter } from './dsh.js';

export * from './types.js';
export * from './imageInput.js';
export * from './spawn.js';
export * from './codebuddy.js';
export * from './codex.js';
export * from './opencode.js';
export * from './dsh.js';

export const ADAPTERS: AgentAdapter[] = [codebuddyAdapter, codexAdapter, opencodeAdapter, dshAdapter];

export function getAdapter(id: AgentAdapter['id']): AgentAdapter {
  const adapter = ADAPTERS.find((a) => a.id === id);
  if (!adapter) throw new Error(`未知适配器 id: ${id}`);
  return adapter;
}
export { JG, KG, traePepper } from './trae/pepper.js';
export { decryptTcEnvelope, encryptTcEnvelope, deriveKeyIv, TraeEnvelopeError, type TraeEnvelopeErrorCode } from './trae/tcEnvelope.js';
