/** 共享测试夹具：可编程 FakeAdapter（sessionManager / dispatch / api 集成测试共用） */
import type {
  AgentAdapter,
  RunTurnOptions,
  TurnHandle,
  TurnResult,
  UnifiedEvent,
} from '@agentboard/adapters';
import type { ModelInfo } from '@agentboard/shared';

export interface FakeTurnControl {
  readonly callIndex: number;
  readonly killed: boolean;
  emit(event: UnifiedEvent): void;
  finish(exitCode?: number, adapterSessionId?: string | null, stderrTail?: string[]): void;
}

export class FakeAdapter implements AgentAdapter {
  readonly id = 'codebuddy' as const;
  readonly displayName = 'Fake CLI';
  readonly supportsModelSelection = true;
  readonly calls: RunTurnOptions[] = [];
  /** 每次 runTurn 的行为脚本；默认立即回复一条文本并正常结束 */
  script: (control: FakeTurnControl) => void | Promise<void> = (control) => {
    control.emit({ type: 'text', delta: `回复${control.callIndex}` });
    control.finish(0, `fake-as-${control.callIndex}`);
  };

  async detect(): Promise<{ installed: boolean; version: string | null }> {
    return { installed: true, version: 'fake-1.0' };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  runTurn(opts: RunTurnOptions): TurnHandle {
    const callIndex = this.calls.length;
    this.calls.push(opts);
    let listener: ((event: UnifiedEvent) => void) | null = null;
    let killed = false;
    let resolveResult!: (result: TurnResult) => void;
    const result = new Promise<TurnResult>((resolve) => {
      resolveResult = resolve;
    });
    const control: FakeTurnControl = {
      callIndex,
      get killed() {
        return killed;
      },
      emit(event) {
        listener?.(event);
      },
      finish(exitCode = 0, adapterSessionId: string | null = `fake-as-${callIndex}`, stderrTail?: string[]) {
        listener?.({ type: 'end', exitCode }); // 仿真实适配器：结束前产出 end 事件
        const result: TurnResult = { exitCode, adapterSessionId };
        if (stderrTail && stderrTail.length > 0) result.stderrTail = stderrTail;
        resolveResult(result);
      },
    };
    const handle: TurnHandle = {
      onEvent(cb) {
        listener = cb;
      },
      kill: async () => {
        killed = true;
        resolveResult({ exitCode: 130, adapterSessionId: null });
      },
      result,
    };
    queueMicrotask(() => {
      try {
        const out = this.script(control);
        if (out instanceof Promise) out.catch(() => undefined);
      } catch {
        // 脚本异常视为挂起，由用例自行处理
      }
    });
    return handle;
  }
}

/** 微任务/macrotask 全量冲刷（FakeAdapter 全链路只用微任务，一次 macrotask 边界即收敛） */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
