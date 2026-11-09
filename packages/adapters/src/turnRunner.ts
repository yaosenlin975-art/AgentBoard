import type { LineChild } from './spawn.js';
import type { TurnResult, UnifiedEvent } from './types.js';

/**
 * CR2-9：四个适配器的 runTurn 骨架（state/eventCbs/settled/killed/finish）。
 *
 * 契约与抽取前逐字一致：
 * - `finish` 幂等（首个退出码生效），在 end 之前发 `适配器未捕获到结构化输出` 诊断
 *   （非零退出，或 exit 0 但零事件且无 session id，且 stderr 有内容）；
 * - `kill` 后尚未 spawn 的分支立即以 -1 收尾，避免挂起的 turn；
 * - 子进程 stderr 尾部随 TurnResult 返回（非空才带）。
 * 适配器只保留自己的参数拼装、行解析与个性化终局判定（如 codebuddy 的图片无文本）。
 */

export interface TurnRunnerFinishInfo {
  /** 子进程原始退出码（被信号终止为 null） */
  code: number | null;
  /** 归一后的退出码（code ?? -1），可被 onFinish 改写 */
  exitCode: number;
  tail: string[];
  sawEvents: boolean;
}

export interface TurnRunnerOptions {
  /** 当前轮次的 adapter session id（end 前读取，可能由行解析中途写入） */
  sessionId: () => string | null;
  /** 个性化终局判定：改写退出码或追加错误事件（在通用 stderr 诊断之前发出） */
  onFinish?: (info: TurnRunnerFinishInfo) => { exitCode?: number; errors?: string[] } | void;
}

export interface TurnRunner {
  readonly result: Promise<TurnResult>;
  onEvent(cb: (e: UnifiedEvent) => void): void;
  emit(e: UnifiedEvent): void;
  /** 标记已收到结构化事件（抑制「exit 0 零事件」诊断） */
  markEvent(): void;
  /** 绑定主进程：stderr 尾部来源，同时作为 kill 目标 */
  bindChild(child: LineChild): void;
  /** 额外 kill 目标（如 dsh 的版本探针进程） */
  bindKillTarget(child: LineChild): void;
  isKilled(): boolean;
  isSettled(): boolean;
  /** 当前主进程（供 answer 写 stdin） */
  getChild(): LineChild | null;
  finish(code: number | null): void;
  kill(): Promise<void>;
}

export function createTurnRunner(options: TurnRunnerOptions): TurnRunner {
  const eventCbs: Array<(e: UnifiedEvent) => void> = [];
  let settled = false;
  let killed = false;
  let sawEvents = false;
  let child: LineChild | null = null;
  const killTargets = new Set<LineChild>();

  let resolveResult!: (r: TurnResult) => void;
  const result = new Promise<TurnResult>((resolve) => {
    resolveResult = resolve;
  });

  const emit = (event: UnifiedEvent): void => {
    for (const cb of eventCbs) cb(event);
  };

  const finish = (code: number | null): void => {
    if (settled) return;
    settled = true;
    const tail = child?.getStderrTail() ?? [];
    const exitCode = code ?? -1; // 被 kill（信号终止）无退出码，归一为 -1
    const hook = options.onFinish?.({ code, exitCode, tail, sawEvents });
    const finalExitCode = hook?.exitCode ?? exitCode;
    for (const message of hook?.errors ?? []) emit({ type: 'error', message });
    // 排障诊断：非零退出，或 exit 0 但零事件且无 session id（stderr 有内容才发），
    // 在 end 之前发一条 error 事件，避免真实 CLI 静默失败无法定位
    if (tail.length > 0 && (finalExitCode !== 0 || (!sawEvents && options.sessionId() === null))) {
      emit({ type: 'error', message: `适配器未捕获到结构化输出；stderr 尾部：\n${tail.join('\n')}` });
    }
    emit({ type: 'end', exitCode: finalExitCode });
    const turnResult: TurnResult = { exitCode: finalExitCode, adapterSessionId: options.sessionId() };
    if (tail.length > 0) turnResult.stderrTail = tail;
    resolveResult(turnResult);
  };

  return {
    result,
    onEvent(cb) {
      eventCbs.push(cb);
    },
    emit,
    markEvent() {
      sawEvents = true;
    },
    bindChild(next) {
      child = next;
      killTargets.add(next);
    },
    bindKillTarget(target) {
      killTargets.add(target);
    },
    isKilled: () => killed,
    isSettled: () => settled,
    getChild: () => child,
    finish,
    async kill() {
      killed = true;
      for (const target of killTargets) await target.kill();
    },
  };
}
