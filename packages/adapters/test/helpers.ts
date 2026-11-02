import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { vi } from 'vitest';

export interface FakeChild extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
}

export function makeFakeChild(pid = 4242): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.kill = vi.fn(() => true);
  return child;
}

export function closeChild(child: FakeChild, code: number | null): void {
  child.emit('exit', code);
  child.emit('close', code);
}

/** 自动型假进程：下一个微任务输出给定行并退出（供 detect/listModels 等一次性收集流程）。 */
export function makeAutoChild(
  lines: Array<{ source: 'stdout' | 'stderr'; text: string }>,
  code: number | null,
): FakeChild {
  const child = makeFakeChild();
  queueMicrotask(() => {
    for (const l of lines) child[l.source].emit('data', Buffer.from(l.text));
    closeChild(child, code);
  });
  return child;
}

export function asChild(child: FakeChild): ChildProcess {
  return child as unknown as ChildProcess;
}
