/**
 * 服务运行日志（RESTART-HARDENING）：固定落盘位置与追加写入的唯一入口。
 *
 * 为什么需要：8787 此前的启动行、崩溃栈、退出原因只打到 stdout，而所有启动方式
 * （`pnpm server:ensure`、手工 `node apps/server/dist/index.js`、`POST /api/system/restart`
 * 的 detached 子进程）都不会保留 stdout，导致服务静默退出后无任何痕迹可查。
 *
 * 位置：环境变量 `AGENTBOARD_LOG` 指定绝对路径；否则 `<cwd>/.logs/server.log`
 * （与 `scripts/server-detached.mjs` 一致——两者都要求 cwd 是仓库根）。
 * 写日志永不抛错：日志失败不得影响服务本身。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export function resolveServerLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENTBOARD_LOG;
  if (override !== undefined && override.trim() !== '') return isAbsolute(override) ? override : join(process.cwd(), override);
  return join(process.cwd(), '.logs', 'server.log');
}

/** 追加一行（自动补时间戳与换行）；任何 IO 失败静默吞掉 */
export function appendServerLog(line: string, path: string = resolveServerLogPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* 日志失败不影响服务 */
  }
}
