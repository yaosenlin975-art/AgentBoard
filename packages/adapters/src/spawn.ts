import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface SpawnLineOptions {
  env?: Record<string, string>;
}

export interface LineChild {
  onLine(cb: (source: 'stdout' | 'stderr', line: string) => void): void;
  onClose(cb: (code: number | null) => void): void;
  kill(): Promise<void>;
  exit: Promise<number | null>;
}

export interface SpawnOptionsLite {
  cwd: string;
  shell: false;
  windowsHide: boolean;
  env?: NodeJS.ProcessEnv;
}

export type SpawnFn = (cmd: string, args: string[], options: SpawnOptionsLite) => ChildProcess;

const realSpawn: SpawnFn = (cmd, args, options) => nodeSpawn(cmd, args, options);

let spawnFn: SpawnFn = realSpawn;

/** 测试注入点：替换底层 spawn 实现，不依赖本机真实 CLI。 */
export function setSpawnFn(fn: SpawnFn): void {
  spawnFn = fn;
}

const KILL_GRACE_MS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function spawnLineChild(cmd: string, args: string[], cwd: string, opts?: SpawnLineOptions): LineChild {
  const options: SpawnOptionsLite = { cwd, shell: false, windowsHide: true };
  if (opts?.env) options.env = { ...process.env, ...opts.env };

  const child = spawnFn(cmd, args, options);

  const lineCbs: Array<(source: 'stdout' | 'stderr', line: string) => void> = [];
  const closeCbs: Array<(code: number | null) => void> = [];
  const buffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  const decoders: Record<'stdout' | 'stderr', StringDecoder> = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  };

  let exited = false;
  let resolveExit!: (code: number | null) => void;
  const exitPromise = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });

  const emitLine = (source: 'stdout' | 'stderr', line: string) => {
    for (const cb of lineCbs) cb(source, line);
  };

  const feed = (source: 'stdout' | 'stderr', chunk: Buffer) => {
    buffers[source] += decoders[source].write(chunk);
    let idx = buffers[source].indexOf('\n');
    while (idx !== -1) {
      const raw = buffers[source].slice(0, idx);
      buffers[source] = buffers[source].slice(idx + 1);
      emitLine(source, raw.endsWith('\r') ? raw.slice(0, -1) : raw);
      idx = buffers[source].indexOf('\n');
    }
  };

  const finalize = (code: number | null) => {
    if (exited) return;
    exited = true;
    for (const source of ['stdout', 'stderr'] as const) {
      const rest = buffers[source] + decoders[source].end();
      buffers[source] = '';
      if (rest !== '') {
        emitLine(source, rest.endsWith('\r') ? rest.slice(0, -1) : rest);
      }
    }
    resolveExit(code);
    for (const cb of closeCbs) cb(code);
  };

  child.stdout?.on('data', (chunk: Buffer) => feed('stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => feed('stderr', chunk));
  child.on('close', (code) => finalize(code));

  return {
    onLine(cb) {
      lineCbs.push(cb);
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
    exit: exitPromise,
    async kill() {
      if (exited) return;
      try {
        child.kill();
      } catch {
        /* 进程可能已退出 */
      }
      const exitedInGrace = await Promise.race([
        exitPromise.then(() => true),
        delay(KILL_GRACE_MS).then(() => false),
      ]);
      if (exitedInGrace || exited) return;
      if (process.platform === 'win32') {
        const pid = child.pid;
        if (pid != null) {
          // tree-kill 兜底：taskkill 连同子进程树一起强制结束
          const tk = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], {
            cwd,
            shell: false,
            windowsHide: true,
          });
          await new Promise<void>((resolve) => {
            tk.once('exit', () => resolve());
            tk.once('error', () => resolve());
          });
        }
      } else {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 进程可能已退出 */
        }
      }
      await Promise.race([exitPromise, delay(KILL_GRACE_MS)]);
    },
  };
}
