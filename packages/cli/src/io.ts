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
    // PowerShell 5.1 管道会给 stdin 加 UTF-8 BOM；剥离，避免正文/评论首字符被污染
    stream.on('end', () => resolve(data.replace(/^\uFEFF/, '')));
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

export const processIo: Io = {
  write: (line) => {
    process.stdout.write(line);
  },
  writeErr: (line) => {
    process.stderr.write(line);
  },
  readStdin: () => readAllStdin(process.stdin),
};
