import type { ModelInfo } from '@agentboard/shared';
export type UnifiedEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; input: string }
  | { type: 'error'; message: string }
  | { type: 'end'; exitCode: number };
export interface RunTurnOptions { cwd: string; model?: string; prompt: string; adapterSessionId?: string }
export interface TurnResult { exitCode: number; adapterSessionId: string | null }
export interface TurnHandle {
  onEvent(cb: (e: UnifiedEvent) => void): void;
  kill(): Promise<void>;
  result: Promise<TurnResult>;
}
export interface AgentAdapter {
  id: 'codebuddy' | 'codex' | 'opencode' | 'dsh';
  displayName: string;
  detect(): Promise<{ installed: boolean; version: string | null }>;
  listModels(): Promise<ModelInfo[]>;
  runTurn(opts: RunTurnOptions): TurnHandle;
}
