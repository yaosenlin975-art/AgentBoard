import type { ModelInfo } from '@agentboard/shared';
export type UnifiedEvent =
  | { type: 'text'; delta: string }
  /** 模型思考/推理内容（终值或增量），服务端聚合为「思考」折叠块，不进聊天正文 */
  | { type: 'thinking'; delta: string }
  | { type: 'tool'; name: string; input: string }
  | { type: 'error'; message: string }
  | { type: 'end'; exitCode: number };
export interface RunTurnOptions {
  cwd: string;
  model?: string;
  /** CLI version detected by the server immediately before an image-bearing adapter call. */
  detectedCliVersion?: string;
  prompt: string;
  adapterSessionId?: string;
  attachments?: Array<{ path: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' }>;
}
export interface TurnResult {
  exitCode: number;
  adapterSessionId: string | null;
  /** 子进程 stderr 尾部（最近 30 行，非空才携带）；排障诊断用 */
  stderrTail?: string[];
}
export interface TurnHandle {
  onEvent(cb: (e: UnifiedEvent) => void): void;
  kill(): Promise<void>;
  result: Promise<TurnResult>;
}
export interface AgentAdapter {
  id: 'codebuddy' | 'codex' | 'opencode' | 'dsh';
  displayName: string;
  /** false=模型只读（无 CLI flag，由 CLI profile 配置决定，如 dsh）；runTurn 忽略 opts.model */
  supportsModelSelection: boolean;
  /** 仅返回当前已用合成图验证过的 CLI/model 图片输入组合 */
  supportsImageInput(model: string | undefined, cliVersion?: string | null): boolean;
  detect(): Promise<{ installed: boolean; version: string | null }>;
  listModels(): Promise<ModelInfo[]>;
  runTurn(opts: RunTurnOptions): TurnHandle;
}
