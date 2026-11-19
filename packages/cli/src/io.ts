import type { Readable } from 'node:stream';

/** 输出/输入注入点：测试传入捕获实现，入口用 processIo */
export interface Io {
  /** stdout（调用方自带换行） */
  write(line: string): void;
  writeErr(line: string): void;
  /** 一次性读取全部 stdin（UTF-8，中文/多行不损坏） */
  readStdin(): Promise<string>;
}

/** 命令执行上下文 */
export interface Ctx {
  base: string;
  json: boolean;
  agentId: string;
  io: Io;
}

export function readAllStdin(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      data += chunk;
    });
    stream.on('end', () => {
      // PowerShell 5.1 管道会给 stdin 加 UTF-8 BOM；剥离，避免正文/评论首字符被污染
      // K2：PowerShell 管道还会在末尾注入 \r\n（实测 21 字节 → 23 字节），且 CRLF 会让知识页
      // content_hash 在写入与回读之间不一致（parse 侧恒归一 CRLF）。stdin 是文本传输通道，
      // 换行统一为 LF；孤立 CR 不归一（正文里可能有意义，往返本来就保真）。
      resolve(data.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'));
    });
    stream.on('error', reject);
  });
}

/**
 * ARCH-06：输出体积埋点（KB_METRICS=1）。
 * 只在「最终写 stdout 的那一层」统计已写出的字节数（UTF-8）与行数；stderr 原样透传、不计数。
 * 不在启用开关本身：是否打印由入口 main 决定，未设 KB_METRICS 时与改造前逐字节一致。
 */
export interface OutputMeter {
  io: Io;
  /** 已写入 stdout 的字节数与行数（行数按换行符计，末尾无换行的非空片段也算一行） */
  stats(): { bytes: number; lines: number };
}

export function meterIo(inner: Io): OutputMeter {
  let bytes = 0;
  let lines = 0;
  /** 是否有一行已写出内容但还没遇到换行（跨 write 分片时避免把同一条长行数成多行） */
  let pendingLine = false;
  const io: Io = {
    write: (line) => {
      bytes += Buffer.byteLength(line, 'utf8');
      const parts = line.split('\n');
      if (parts.length === 1) {
        if (line !== '') pendingLine = true;
      } else {
        lines += parts.length - 1;
        pendingLine = parts[parts.length - 1] !== '';
      }
      inner.write(line);
    },
    writeErr: (line) => inner.writeErr(line),
    readStdin: () => inner.readStdin(),
  };
  return { io, stats: () => ({ bytes, lines: lines + (pendingLine ? 1 : 0) }) };
}

/**
 * C11：下游关闭管道（`kb list-spaces | head`、`| node -e "process.exit(0)"`）时，
 * 对端已关，任何写入都会得到 EPIPE。Unix 惯例：这是**正常情况**，不是错误——
 * 静默停写、进程照常以 0 退出，不打印栈、不让 libuv 走到 assertion。
 *
 * 关键点：EPIPE 不是 `write()` 的同步 throw，而是 stream 上的**异步 'error' 事件**
 * （`node:events throw er; // Unhandled 'error' event`）。所以两件事都要做：
 * 1) 在流上挂一次性 'error' 监听，收到 EPIPE 就标记 broken，之后所有写入变 no-op；
 * 2) `write()` 外包 try/catch，兜住少数平台/时机下的同步抛出。
 */
let stdoutBroken = false;
let stderrBroken = false;

function isEpipe(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'EPIPE';
}

function guard(stream: NodeJS.WriteStream, markBroken: () => void): void {
  // 只认 EPIPE；其它写错误（真实磁盘/管道故障）仍交给默认行为，不吞
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (isEpipe(error)) {
      markBroken();
      return;
    }
    throw error;
  });
}

guard(process.stdout, () => { stdoutBroken = true; });
guard(process.stderr, () => { stderrBroken = true; });

/** 单次安全写：EPIPE → 静默停写（返回 false），其它错误照常抛 */
function safeWrite(stream: NodeJS.WriteStream, text: string, isBroken: () => boolean, markBroken: () => void): void {
  if (isBroken()) return;
  try {
    stream.write(text);
  } catch (error) {
    if (isEpipe(error)) {
      markBroken();
      return;
    }
    throw error;
  }
}

export const processIo: Io = {
  write: (line) => {
    safeWrite(process.stdout, line, () => stdoutBroken, () => { stdoutBroken = true; });
  },
  writeErr: (line) => {
    safeWrite(process.stderr, line, () => stderrBroken, () => { stderrBroken = true; });
  },
  readStdin: () => readAllStdin(process.stdin),
};

/** api.ts / 命令内的直写 stderr 统一走这里（同样是 EPIPE 静默） */
export function writeStderr(text: string): void {
  safeWrite(process.stderr, text, () => stderrBroken, () => { stderrBroken = true; });
}
