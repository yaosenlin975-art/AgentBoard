/**
 * SYSTEM-RESTART：`POST /api/system/restart` 由设置页触发的服务自重启。
 *
 * 顺序（唯一严重风险点就是「别把服务搞挂」，所以顺序是刻意的）：
 * 1. 只允许回环地址（本项目无鉴权，这是唯一防线）；
 * 2. 先确认入口脚本存在，再 `spawn` detached 子进程，**等子进程 'spawn' 事件确认起来**；
 * 3. spawn 失败 → 500 且**绝不触碰旧进程的监听**（继续服务）；
 * 4. spawn 成功 → 先回 202（响应必须发得出去），再延迟约 200ms：`server.close()` 停掉监听 → 退出旧进程；
 *    新进程在 `main()` 里对 `EADDRINUSE` 做重试，等旧进程把端口让出来即可 bind 成功。
 *
 * spawn 成功但旧进程 `close` 后新进程仍起不来时，`main()` 的重试会在旧进程退出前完成绑定；
 * 若重试全部失败，新进程自行退出——旧进程此时已退出，这是该功能唯一不可完全消除的窗口，
 * 因此入口存在性、spawn 错误、'spawn' 事件三道检查都放在**回 202 之前**。
 */
import { Router, type Request, type Response } from 'express';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface RestartDeps {
  /** 自重启用的入口（node + argv.slice(1)）；缺省用当前进程参数 */
  entry?: () => { command: string; args: string[]; exists: boolean };
  /** 启动新进程；resolve 表示已确认拉起来（'spawn' 事件），reject 表示失败 */
  spawnChild?: (command: string, args: string[]) => Promise<void>;
  /** 关闭监听（旧进程让出端口） */
  closeServer?: () => Promise<void>;
  /** 退出旧进程 */
  exit?: (code: number) => void;
  /** 延迟执行（测试注入立即执行） */
  schedule?: (fn: () => void, ms: number) => void;
  now?: () => number;
  pid?: () => number;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** 只接受回环地址；`req.ip` 由 express 解析（含 `::ffff:` 前缀形态） */
export function isLoopbackAddress(ip: string | undefined): boolean {
  return ip !== undefined && LOOPBACK.has(ip);
}

const defaultEntry = (): { command: string; args: string[]; exists: boolean } => {
  const entry = process.argv[1] ?? '';
  return { command: process.execPath, args: process.argv.slice(1), exists: entry !== '' && existsSync(entry) };
};

/** 真实 spawn：detached + stdio ignore + unref；等 'spawn' 事件确认进程已创建 */
export function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', env: process.env, cwd: process.cwd(), windowsHide: true });
    const timer = setTimeout(() => reject(new Error('SPAWN_TIMEOUT')), 2000);
    child.once('spawn', () => { clearTimeout(timer); child.unref(); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

export function createRestartHandler(deps: RestartDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    if (!isLoopbackAddress(req.ip)) {
      res.status(403).json({ error: { code: 'RESTART_FORBIDDEN', message: '仅允许本机回环地址触发重启' } });
      return;
    }
    const entry = (deps.entry ?? defaultEntry)();
    if (!entry.exists) {
      res.status(500).json({ error: { code: 'RESTART_ENTRY_MISSING', message: '未找到服务入口脚本，服务未重启' } });
      return;
    }
    try {
      await (deps.spawnChild ?? spawnDetached)(entry.command, entry.args);
    } catch {
      res.status(500).json({ error: { code: 'RESTART_SPAWN_FAILED', message: '新进程启动失败，旧进程继续服务' } });
      return;
    }
    const startedAt = (deps.now ?? Date.now)();
    res.status(202).json({ restarting: true, pid: (deps.pid ?? (() => process.pid))(), started_at: startedAt });
    // 响应已发出：延迟关闭监听并退出，让新进程接管端口
    (deps.schedule ?? ((fn, ms) => { setTimeout(fn, ms); }))(() => {
      void (async () => {
        try { await deps.closeServer?.(); } catch { /* 关闭失败也要退出，交给新进程 */ }
        (deps.exit ?? (code => process.exit(code)))(0);
      })();
    }, 200);
  };
}

export interface SystemRouterOptions {
  restart?: RestartDeps;
}

/** 未注入 restart 依赖时（测试/非生产装配）端点返回 503，而非静默 404 */
export function createSystemRouter(options: SystemRouterOptions = {}): Router {
  const router = Router();
  router.post('/system/restart', async (req, res, next) => {
    try {
      if (!options.restart) {
        res.status(503).json({ error: { code: 'RESTART_UNAVAILABLE', message: '当前装配未启用服务重启' } });
        return;
      }
      await createRestartHandler(options.restart)(req, res);
    } catch (error) { next(error); }
  });
  return router;
}
