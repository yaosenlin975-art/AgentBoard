/** Windows 原生命令（reg.exe / powershell.exe）零依赖执行封装：stdin 恒 ignore、error 事件必挂、GBK 输出回退解码。 */
import { spawn } from 'node:child_process';

/** 一次子进程执行的结果 */
export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 执行器：测试注入假实现，真实实现 spawn reg.exe / powershell.exe */
export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

/** reg.exe / powershell.exe 输出解码：UTF-16LE BOM（部分 PowerShell 输出）→ utf16le；UTF-8 出现替换符（OEM 码页如 GBK 写入的中文路径）→ 按 GBK 重解码（同 adapters readShimContent 先例） */
export function decodeOutput(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString('utf16le').slice(1);
  }
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return utf8;
  }
}

/** 真实执行器：参数数组直传不经 shell；windowsHide 防闪黑窗；stdin ignore 防交互挂死；'error'（ENOENT 等）归一 reject */
export const spawnRunner: Runner = (cmd, args) =>
  new Promise<RunResult>((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e: Error) => reject(new Error(`spawn ${cmd} 失败：${e.message}`)));
    child.on('close', (code) => {
      resolve({ code, stdout: decodeOutput(Buffer.concat(out)), stderr: decodeOutput(Buffer.concat(err)) });
    });
  });

/** stderr 首行（截断）；错误消息取首要原因，避免整段 PowerShell 报错灌入一行 */
export function firstLine(text: string, fallback = '未知错误'): string {
  const line = text.trim().split(/\r?\n/, 1)[0];
  return line && line !== '' ? line.slice(0, 300) : fallback;
}
