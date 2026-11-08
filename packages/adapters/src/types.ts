import type { ModelInfo } from '@agentboard/shared';

/** ask 事件的单个选项：label 必填，description 为补充说明 */
export interface AskOption {
  label: string;
  description?: string;
}

/** 适配器发出的提问（如 codebuddy 的 AskUserQuestion）；request_id 供回答回填定位 */
export interface AskEvent {
  type: 'ask';
  request_id: string;
  question: string;
  options: AskOption[];
  /** 提问所属步骤（如 assistant message id）；协议无对应字段时为 null */
  step_id: string | null;
}

export type UnifiedEvent =
  | { type: 'text'; delta: string }
  /** 模型思考/推理内容（终值或增量），服务端聚合为「思考」折叠块，不进聊天正文 */
  | { type: 'thinking'; delta: string }
  | { type: 'tool'; name: string; input: string }
  | AskEvent
  | { type: 'error'; message: string }
  | { type: 'end'; exitCode: number };
/** 会话 persona：body 为注入 CLI 的系统提示词文本（作为单个 argv 直传，不经 shell） */
export interface SessionPersona {
  id: string;
  body: string;
  source: 'builtin' | 'user' | 'import';
}

/** 会话工具管控策略：allow/deny 为工具名清单（逗号拼接后传 CLI） */
export interface SessionToolPolicy {
  approval_mode: 'inherit' | 'plan' | 'acceptEdits' | 'bypass';
  allow: string[];
  deny: string[];
}

export interface RunTurnOptions {
  cwd: string;
  model?: string;
  /** CLI version detected by the server immediately before an image-bearing adapter call. */
  detectedCliVersion?: string;
  prompt: string;
  adapterSessionId?: string;
  attachments?: Array<{ path: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' }>;
  /** 会话 persona；注入方式由 personaInjection 控制（未设置按 auto 语义处理） */
  persona?: SessionPersona;
  /** 会话工具管控；personaInjection=off 时随注入全关，其余模式（含 file）照传工具/权限 flags */
  toolPolicy?: SessionToolPolicy;
  /** persona 注入方式：auto/flag=适配器传 CLI flag；file=服务端走标记块（适配器不传 persona flag）；off=全关 */
  personaInjection?: 'auto' | 'flag' | 'file' | 'off';
}
export interface TurnResult {
  exitCode: number;
  adapterSessionId: string | null;
  /** 子进程 stderr 尾部（最近 30 行，非空才携带）；排障诊断用 */
  stderrTail?: string[];
}
export interface TurnHandle {
  onEvent(cb: (e: UnifiedEvent) => void): void;
  /**
   * 把对 ask 事件（request_id）的回答写入子进程 stdin，同一 request_id 只允许一次。
   * 未知/过期 request_id、重复回答、轮次已结束、stdin 不可写时以 reject 返回明确错误（不抛同步异常）。
   * 仅支持提问回填的适配器实现该方法（如 codebuddy）；其余适配器可不实现，消费方须判空。
   */
  answer?(requestId: string, answer: string): Promise<void>;
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
  /**
   * 探测 CLI 是否可用。**不可用时必须给可解释原因**（`message`）：
   * 例如 shim 指向的入口缺失、版本输出不是版本号时，不要把报错文本当成 version 回传。
   */
  detect(): Promise<{ installed: boolean; version: string | null; message?: string }>;
  listModels(): Promise<ModelInfo[]>;
  runTurn(opts: RunTurnOptions): TurnHandle;
}
