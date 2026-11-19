/**
 * G4：客户端崩溃取证日志（`<configDir>/logs/client-error.log`，JSONL）。
 *
 * 为什么独立文件：`server.log` 是服务端视角，混入客户端错误会毁掉两者可读性。
 * 位置跟 `configDir()` 走（`%APPDATA%\AgentBoard`），**不落安装根**——D6 修过的 bug 不能回退。
 *
 * 轮转：单文件超 5 MB → 固定名 `.1`（只保留一个，与 D14 的 `main.log → main.log.1` 同口径）。
 * 不带时间戳是有意的：「最多占多少磁盘」要可预测，运维只需记一条规则。
 *
 * 写失败一律静默吞掉（与 `serverLog.ts` 同口径）：取证日志不得影响服务本身。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configDir } from '../config.js';

/** 单文件上限：超过即轮转为 `.1` */
export const CLIENT_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** 客户端错误日志路径：`<configDir>/logs/client-error.log`（测试靠覆盖 APPDATA 隔离） */
export function resolveClientLogPath(): string {
  return join(configDir(), 'logs', 'client-error.log');
}

/**
 * 追加一行；文件超限时先轮转。
 *
 * 轮转判定用「写入前」的大小：一条日志最多几十 KB，超过 5MB 再写不会爆，
 * 且避免每写一行都先算写入后大小（多一次字符串长度计算）。
 */
export function appendWithRotation(path: string, line: string, maxBytes: number = CLIENT_LOG_MAX_BYTES): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && statSync(path).size >= maxBytes) {
      renameSync(path, `${path}.1`);
    }
    appendFileSync(path, `${line}\n`);
  } catch {
    /* 取证日志失败不影响服务 */
  }
}

/** 客户端错误日志追加（固定路径版） */
export function appendClientErrorLog(line: string): void {
  appendWithRotation(resolveClientLogPath(), line);
}
