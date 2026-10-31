import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface SpawnLineOptions {
  env?: Record<string, string>;
}

/** stderr 尾部环形缓冲容量（最近 N 行），供适配器排障诊断。 */
export const STDERR_TAIL_LIMIT = 30;

export interface LineChild {
  onLine(cb: (source: 'stdout' | 'stderr', line: string) => void): void;
  onClose(cb: (code: number | null) => void): void;
  /** 子进程 stderr 尾部（最近 30 行的拷贝；含 close 时补发的末尾无换行行） */
  getStderrTail(): string[];
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

/** where/which 探测到的命令安装路径行（去空行）。 */
export interface SpawnForm {
  cmd: string;
  prefix: string[];
}

/** 起一次性子进程收集全部输出行（stdout/stderr 合并），供 detect/listModels/version 探测。 */
export async function collectOutput(cmd: string, args: string[]): Promise<{ code: number | null; lines: string[] }> {
  const child = spawnLineChild(cmd, args, process.cwd());
  const lines: string[] = [];
  child.onLine((_source, line) => {
    lines.push(line);
  });
  const code = await child.exit;
  return { code, lines };
}

/** 用 where/which 探测命令实际安装路径；win32 下 where 失败回退 which（Git Bash），都失败返回空数组。 */
export async function whereCommand(cmd: string): Promise<string[]> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const primary = await collectOutput(finder, [cmd]);
  if (primary.code === 0) {
    const lines = primary.lines.map((l) => l.trim()).filter((l) => l !== '');
    if (lines.length > 0) return lines;
  }
  if (process.platform === 'win32') {
    const fallback = await collectOutput('which', [cmd]);
    if (fallback.code === 0) return fallback.lines.map((l) => l.trim()).filter((l) => l !== '');
  }
  return [];
}

/**
 * Windows 下把逻辑命令解析为 CreateProcess 可执行形态（纯函数，消费 whereCommand 的行）：
 * npm 等安装的 CLI 仅有 .cmd/.bat 垫片（无 .exe），spawn('cmd', shell:false) 会 ENOENT；
 * Node ≥20.12 对 .cmd/.bat 直接 spawn 抛 EINVAL，必须经 cmd.exe /d /s /c 间接执行。
 * .exe 命中返回完整路径；.cmd/.bat 命中返回 cmd.exe 包装；其余返回 null（调用方原样 spawn）。
 */
export function resolveWindowsSpawnForm(whereLines: string[], cmd: string): SpawnForm | null {
  if (process.platform !== 'win32') return null;
  const exe = whereLines.find((l) => l.toLowerCase().endsWith('.exe'));
  if (exe) return { cmd: exe, prefix: [] };
  const shim = whereLines.find((l) => /\.(cmd|bat)$/i.test(l));
  if (shim) return { cmd: 'cmd.exe', prefix: ['/d', '/s', '/c', shim] };
  return null;
}

/** 解析逻辑命令的可执行形态：where 无结果或非 win32 时原样返回（ENOENT 由 close 事件归一）。 */
export async function resolveSpawnForm(cmd: string): Promise<SpawnForm> {
  const lines = await whereCommand(cmd);
  if (lines.length === 0) return { cmd, prefix: [] };
  return resolveWindowsSpawnForm(lines, cmd) ?? { cmd, prefix: [] };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function spawnLineChild(cmd: string, args: string[], cwd: string, opts?: SpawnLineOptions): LineChild {
  const options: SpawnOptionsLite = { cwd, shell: false, windowsHide: true };
  if (opts?.env) options.env = { ...process.env, ...opts.env };

  const child = spawnFn(cmd, args, options);

  const lineCbs: Array<(source: 'stdout' | 'stderr', line: string) => void> = [];
  const closeCbs: Array<(code: number | null) => void> = [];
  const stderrTail: string[] = [];
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
    if (source === 'stderr') {
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LIMIT) stderrTail.shift();
    }
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
    getStderrTail() {
      return [...stderrTail];
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
