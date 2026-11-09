import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export interface SpawnLineOptions {
  env?: Record<string, string>;
  stdinText?: string;
  /** 写入 stdinText 后保持 stdin 可写（供 ask 回答回填）；未设置时写完立即 end */
  keepStdinOpen?: boolean;
}

export type StdinWriteErrorCode = 'STDIN_UNAVAILABLE' | 'STDIN_CLOSED' | 'STDIN_WRITE_FAILED';

/** writeStdin 的明确错误：stdin 未开放 / 进程已退出 / 写入失败 */
export class StdinWriteError extends Error {
  readonly code: StdinWriteErrorCode;
  constructor(code: StdinWriteErrorCode, message: string, cause?: Error) {
    super(message);
    this.name = 'StdinWriteError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/** stderr 尾部环形缓冲容量（最近 N 行），供适配器排障诊断。 */
export const STDERR_TAIL_LIMIT = 30;

export interface LineChild {
  onLine(cb: (source: 'stdout' | 'stderr', line: string) => void): void;
  onClose(cb: (code: number | null) => void): void;
  /** 子进程 stderr 尾部（最近 30 行的拷贝；含 close 时补发的末尾无换行行） */
  getStderrTail(): string[];
  /** 向子进程 stdin 追加写入；未开放/已关闭/写失败时以 StdinWriteError reject（不抛同步异常） */
  writeStdin(chunk: string): Promise<void>;
  kill(): Promise<void>;
  exit: Promise<number | null>;
  /** spawn 失败（'error' 事件，如 ENOENT）时以 SpawnFailedError reject；正常退出永不安定（内部已兜底消费，无观察者也不产生 unhandledRejection） */
  failure: Promise<Error>;
}

/** spawn 失败（'error' 事件：ENOENT/EACCES 等）归一错误：message 含命令名与原始原因。 */
export class SpawnFailedError extends Error {
  readonly code = 'SPAWN_FAILED';
  constructor(cmd: string, cause: Error) {
    super(`spawn ${cmd} 失败：${cause.message}`);
    this.name = 'SpawnFailedError';
    this.cause = cause;
  }
}

export interface SpawnOptionsLite {
  cwd: string;
  shell: false;
  windowsHide: boolean;
  env?: NodeJS.ProcessEnv;
  /** stdin 为 ignore 或 pipe；stdout/stderr 按调用方需要 pipe */
  stdio: ('ignore' | 'pipe')[];
}

export type SpawnFn = (cmd: string, args: string[], options: SpawnOptionsLite) => ChildProcess;

const realSpawn: SpawnFn = (cmd, args, options) => nodeSpawn(cmd, args, options);

let spawnFn: SpawnFn = realSpawn;

/** 测试注入点：替换底层 spawn 实现，不依赖本机真实 CLI。 */
export function setSpawnFn(fn: SpawnFn): void {
  spawnFn = fn;
  // 注入新的 spawn 实现后旧的探测结果不再可信（测试之间也靠这里隔离）
  spawnFormCache.clear();
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
  // child.failure 在 spawn error 时同步 reject（先于 finalize 的 exit 归一），race 直接以 SpawnFailedError 败出
  const settled = await Promise.race([child.exit, child.failure]);
  if (settled instanceof Error) throw settled;
  return { code: settled, lines };
}

/** 用 where/which 探测命令实际安装路径；win32 下 where 失败回退 which（Git Bash），都失败返回空数组。 */
export async function whereCommand(cmd: string): Promise<string[]> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  // finder 自身 spawn 失败（如 SpawnFailedError）视同探测无结果，不向上抛（探测不抛错契约）
  const collectSafe = (c: string): Promise<{ code: number | null; lines: string[] } | null> =>
    collectOutput(c, [cmd]).catch((e: unknown) => {
      if (e instanceof SpawnFailedError) return null;
      throw e;
    });
  const primary = await collectSafe(finder);
  if (primary !== null && primary.code === 0) {
    const lines = primary.lines.map((l) => l.trim()).filter((l) => l !== '');
    if (lines.length > 0) return lines;
  }
  if (process.platform === 'win32') {
    const fallback = await collectSafe('which');
    if (fallback !== null && fallback.code === 0) return fallback.lines.map((l) => l.trim()).filter((l) => l !== '');
  }
  return [];
}

/** npm .cmd/.bat 垫片中 node 入口脚本 token：带引号 `"%dp0%\…js"` / `"%~dp0\…js"` */
const SHIM_JS_ENTRY_QUOTED_RE = /"(?:%~dp0|%dp0%)[\\/]([^"\r\n]+\.js)"/i;
/** 同上，无引号变体（行首、空白、& 或 ( 之后） */
const SHIM_JS_ENTRY_BARE_RE = /(?:^|[\s&(])(?:%~dp0|%dp0%)[\\/]([^\s"&|(),;]+\.js)/im;

/** 从垫片内容提取 node 入口相对路径；非 node 垫片（无 node 标识）或无 %dp0%/%~dp0 js 入口返回 null。 */
function extractShimJsEntry(content: string): string | null {
  if (!/\bnode\b/i.test(content)) return null;
  return SHIM_JS_ENTRY_QUOTED_RE.exec(content)?.[1] ?? SHIM_JS_ENTRY_BARE_RE.exec(content)?.[1] ?? null;
}

/** 读垫片内容：utf8 解码出现替换符（非 ASCII 路径经 OEM 码页如 GBK 写入）时按 GBK 重解码。 */
function readShimContent(shimPath: string): string {
  const buf = readFileSync(shimPath);
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return utf8;
  }
}

/**
 * 解析 .cmd/.bat 垫片为 node 直跑形态（node + 绝对 .js 入口，绕开 cmd.exe 包装丢参进交互模式）。
 * 垫片不可读、非 node 垫片、解析不出入口、入口 js 文件不存在 → 返回 null（调用方回退 cmd.exe 包装）。
 */
function resolveNodeShimForm(shimPath: string): SpawnForm | null {
  let content: string;
  try {
    content = readShimContent(shimPath);
  } catch {
    return null;
  }
  const rel = extractShimJsEntry(content);
  if (!rel) return null;
  const jsPath = resolvePath(dirname(shimPath), rel);
  try {
    if (!statSync(jsPath).isFile()) return null;
  } catch {
    return null;
  }
  return { cmd: 'node', prefix: [jsPath] };
}

/**
 * Windows 下把逻辑命令解析为 CreateProcess 可执行形态（消费 whereCommand 的行）：
 * .exe 命中返回完整路径；.cmd/.bat 垫片先解析 node 入口直跑（npm 垫片经 cmd.exe /d /s /c
 * 包装会丢参进交互模式；node 为 .exe，直接 spawn 不触发 Node ≥20.12 的 EINVAL）；
 * 垫片解析失败回退 cmd.exe /d /s /c 包装；其余返回 null（调用方原样 spawn）。
 */
export function resolveWindowsSpawnForm(whereLines: string[], cmd: string): SpawnForm | null {
  if (process.platform !== 'win32') return null;
  const exe = whereLines.find((l) => l.toLowerCase().endsWith('.exe'));
  if (exe) return { cmd: exe, prefix: [] };
  const shim = whereLines.find((l) => /\.(cmd|bat)$/i.test(l));
  if (shim) return resolveNodeShimForm(shim) ?? { cmd: 'cmd.exe', prefix: ['/d', '/s', '/c', shim] };
  return null;
}

/** 逻辑命令 → 上次探测成功的可执行形态（进程内缓存，避免每轮 turn 都起 where 子进程） */
const spawnFormCache = new Map<string, SpawnForm>();

/** 解析逻辑命令的可执行形态：where 无结果或非 win32 时原样返回（ENOENT 由 close 事件归一）。 */
export async function resolveSpawnForm(cmd: string): Promise<SpawnForm> {
  const cached = spawnFormCache.get(cmd);
  if (cached !== undefined) return cached;
  const lines = await whereCommand(cmd);
  // 未探测到安装路径时不缓存：用户随后装好 CLI，下一轮仍能重新探测
  if (lines.length === 0) return { cmd, prefix: [] };
  const form = resolveWindowsSpawnForm(lines, cmd) ?? { cmd, prefix: [] };
  spawnFormCache.set(cmd, form);
  return form;
}

/** 测试用：清空 spawn 形态缓存（模拟「进程内首次探测」或换了一套 where 结果）。 */
export function resetSpawnFormCache(): void {
  spawnFormCache.clear();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function spawnLineChild(cmd: string, args: string[], cwd: string, opts?: SpawnLineOptions): LineChild {
  const stdinOpen = opts?.stdinText !== undefined || opts?.keepStdinOpen === true;
  const options: SpawnOptionsLite = {
    cwd,
    shell: false,
    windowsHide: true,
    stdio: [stdinOpen ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  };
  if (opts?.env) options.env = { ...process.env, ...opts.env };

  const child = spawnFn(cmd, args, options);
  // keepStdinOpen 时 stdin 常驻，EPIPE 等 error 事件必须有监听，否则会成为未处理的 'error' 崩溃
  let stdinError: Error | null = null;
  if (stdinOpen) {
    child.stdin?.on('error', (err: Error) => {
      stdinError = err;
    });
  }
  if (opts?.stdinText !== undefined) child.stdin?.write(opts.stdinText);
  if (stdinOpen && opts?.keepStdinOpen !== true) child.stdin?.end();

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
  let rejectFailure!: (err: Error) => void;
  const failurePromise = new Promise<Error>((_resolve, reject) => {
    rejectFailure = reject;
  });
  // 兜底消费：无人观察 failure（如 runTurn 只等 exit/onClose）也不产生 unhandledRejection
  failurePromise.catch(() => {});

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

  // spawn 失败（ENOENT/EACCES 等）按"异常退出"归一：error.message 写入 stderr 尾部环形缓冲
  // （runTurn 侧 finish() 据此发含 stderr 尾部的诊断 error 事件）、failure promise 以 SpawnFailedError reject
  // （collectOutput 据此 reject）、exit/close 事件流照常触发，绝不留 unhandled 'error'。
  child.on('error', (err: Error) => {
    if (exited) return;
    emitLine('stderr', `spawn 失败：${err.message}`);
    // 先 reject 再 finalize：collectOutput 的 race 在 exit 归一前以 SpawnFailedError 败出
    rejectFailure(new SpawnFailedError(cmd, err));
    finalize(null); // 进程未启动无退出码；runTurn 侧归一为 -1
  });

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
    writeStdin(chunk: string) {
      return new Promise<void>((resolve, reject) => {
        const stream = child.stdin;
        if (!stdinOpen || stream == null) {
          reject(new StdinWriteError('STDIN_UNAVAILABLE', '子进程 stdin 未开放（spawn 时未启用 stdin 管道）'));
          return;
        }
        if (exited) {
          reject(new StdinWriteError('STDIN_CLOSED', '子进程已退出，stdin 不可写'));
          return;
        }
        if (stdinError !== null) {
          reject(new StdinWriteError('STDIN_WRITE_FAILED', `写入 stdin 失败：${stdinError.message}`, stdinError));
          return;
        }
        if (stream.destroyed || !stream.writable) {
          reject(new StdinWriteError('STDIN_CLOSED', '子进程 stdin 已关闭，不可写'));
          return;
        }
        try {
          stream.write(chunk, (err?: Error | null) => {
            if (err) reject(new StdinWriteError('STDIN_WRITE_FAILED', `写入 stdin 失败：${err.message}`, err));
            else resolve();
          });
        } catch (err) {
          const cause = err instanceof Error ? err : new Error(String(err));
          reject(new StdinWriteError('STDIN_WRITE_FAILED', `写入 stdin 失败：${cause.message}`, cause));
        }
      });
    },
    exit: exitPromise,
    failure: failurePromise,
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
            stdio: ['ignore', 'ignore', 'ignore'],
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
