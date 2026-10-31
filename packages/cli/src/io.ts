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
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
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
