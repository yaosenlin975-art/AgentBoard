/**
 * SYSTEM-RESTART：`POST /api/system/restart` 由设置页触发的服务自重启。
 *
 * RESTART-HARDENING（卡 3ab175f5）堵掉两条静默死路径：
 * - 新进程 stdio 不再 `ignore`，stdout/stderr 重定向到固定日志（`.logs/server.log`），
 *   新进程 bind 失败至少留得下栈；
 * - 「即将重启 → 新 pid + 日志路径」「重启完成」「重启失败 → 已回退旧监听」都写进同一日志；
 * - 新进程启动后轮询健康（≤15s，默认判定 `/api/version` 的 pid 等于新 pid）；
 *   不健康则**重新监听旧端口并继续服务**，不再一走了之。
 *
 * 顺序（唯一严重风险点就是「别把服务搞挂」）：
 * 1. 只允许回环地址（本项目无鉴权，这是唯一防线）；
 * 2. 目标端口前置检查：被别的进程占着 → 409 + 持有者，绝不先 exit 再失败；
 * 3. 先确认入口脚本存在，再 spawn detached 子进程，**等子进程 'spawn' 事件确认起来**；
 * 4. spawn 失败 → 500 且**绝不触碰旧进程的监听**；
 * 5. spawn 成功 → 先回 202（响应必须发得出去，closeAllConnections 会掐断在途响应），
 *    再延迟约 200ms：`server.close()` 停掉监听 → 轮询新进程健康 → 健康才退出旧进程；
 *    不健康则 `reopenServer()` 把监听要回来，旧进程继续服务（前端据 `/api/version` 的 pid
 *    与 202 里的 `new_pid` 对比即可判断是「新进程接管」还是「已回退」）。
 */
import { Router, type Request, type Response } from 'express';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { connect } from 'node:net';
import { appendServerLog, resolveServerLogPath } from '../services/serverLog.js';

/** 端口占用判定：free=没人监听 / self=本进程 / foreign=别的进程（含另一个看板实例） */
export interface PortProbe {
  kind: 'free' | 'self' | 'foreign';
  detail?: string;
}

export interface RestartDeps {
  /** 自重启用的入口（node + argv.slice(1)）；缺省用当前进程参数 */
  entry?: () => { command: string; args: string[]; exists: boolean };
  /** 启动新进程；resolve 表示已确认拉起（'spawn' 事件）并给出新 pid */
  spawnChild?: (command: string, args: string[]) => Promise<{ pid: number | null }>;
  /** 关闭监听（旧进程让出端口） */
  closeServer?: () => Promise<void>;
  /** 回退：新进程不健康时把监听要回来，旧进程继续服务 */
  reopenServer?: () => Promise<void>;
  /** 退出旧进程 */
  exit?: (code: number) => void;
  /** 延迟执行（测试注入立即执行） */
  schedule?: (fn: () => void, ms: number) => void;
  now?: () => number;
  pid?: () => number;
  /** 目标端口（缺省 8787 或 AGENTBOARD_PORT） */
  port?: () => number;
  /** 端口前置检查（测试注入；缺省走真实 TCP + /api/version 探测） */
  probePort?: () => Promise<PortProbe>;
  /** 等新进程健康（测试注入；缺省轮询 /api/version 且 pid 必须等于新 pid） */
  waitForHealth?: (newPid: number | null, timeoutMs: number) => Promise<boolean>;
  /** 日志写入（缺省追加到固定日志文件） */
  log?: (line: string) => void;
  /** 日志路径（缺省 resolveServerLogPath()） */
  logPath?: () => string;
  /** 健康等待上限，缺省 15000 */
  healthTimeoutMs?: number;
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

/** 真实 spawn：detached + stdio 重定向到固定日志（不再 ignore）+ unref；等 'spawn' 事件确认进程已创建 */
export function spawnDetached(command: string, args: string[], logPath: string = resolveServerLogPath(), extraEnv: Record<string, string> = {}): Promise<{ pid: number | null }> {
  return new Promise((resolve, reject) => {
    let fd: number | null = null;
    try {
      fd = openSync(logPath, 'a');
    } catch {
      fd = null; // 日志开不了也要能重启：退回丢弃输出（调用方已在日志里记下路径）
    }
    const child = spawn(command, args, {
      detached: true,
      stdio: fd === null ? 'ignore' : ['ignore', fd, fd],
      env: { ...process.env, ...extraEnv },
      cwd: process.cwd(),
      windowsHide: true,
    });
    if (fd !== null) closeSync(fd);
    const timer = setTimeout(() => reject(new Error('SPAWN_TIMEOUT')), 2000);
    child.once('spawn', () => { clearTimeout(timer); child.unref(); resolve({ pid: child.pid ?? null }); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

/** TCP 能否连上（连不上=没人监听；能连上但 HTTP 不通=别的进程占着） */
function canConnect(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ port, host: '127.0.0.1' });
    const done = (value: boolean): void => { socket.removeAllListeners(); socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

interface VersionProbe { name?: unknown; pid?: unknown; status: number }

async function probeVersion(port: number, timeoutMs = 1500): Promise<VersionProbe | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: controller.signal });
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { name?: unknown; pid?: unknown };
      return { name: body.name, pid: body.pid, status: res.status };
    } catch {
      return { status: res.status };
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 缺省端口检查：本进程占着算 self，另一个看板实例/其它服务算 foreign */
async function defaultProbePort(port: number, selfPid: number): Promise<PortProbe> {
  if (!(await canConnect(port))) return { kind: 'free' };
  const version = await probeVersion(port);
  if (version === null) return { kind: 'foreign', detail: `端口 ${port} 有监听但 /api/version 无响应` };
  if (version.name === 'agentboard-server' && version.pid === selfPid) return { kind: 'self' };
  if (version.name === 'agentboard-server') {
    const holder = typeof version.pid === 'number' ? `pid ${version.pid}` : 'pid 未知';
    return { kind: 'foreign', detail: `端口 ${port} 由另一个看板实例（${holder}）占用` };
  }
  return { kind: 'foreign', detail: `端口 ${port} 被非看板服务占用（HTTP ${version.status}）` };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 缺省健康等待：/api/version 必须由**新 pid** 应答，才算新进程真的接管了端口 */
async function defaultWaitForHealth(port: number, newPid: number | null, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const version = await probeVersion(port);
    if (version?.name === 'agentboard-server' && (newPid === null || version.pid === newPid)) return true;
    await sleep(300);
  }
  return false;
}

/** 重启结果：ok=false 时调用方决定 HTTP 状态（内部调用方据 code 判定） */
export type RestartOutcome =
  | { ok: true; old_pid: number; new_pid: number | null; log_path: string; started_at: number }
  | { ok: false; status: number; code: 'RESTART_ENTRY_MISSING' | 'RESTART_PORT_CONFLICT' | 'RESTART_SPAWN_FAILED'; message: string };

/**
 * 执行一次自重启（不含 HTTP 与回环校验，供路由与内部编排共用）。
 * ok=true 表示新进程已拉起、202 该发了；真正的交接（关监听 → 健康判定 → 退出/回退）在 200ms 后开始。
 */
export async function performRestart(deps: RestartDeps): Promise<RestartOutcome> {
  const selfPid = (deps.pid ?? (() => process.pid))();
  const logPath = (deps.logPath ?? resolveServerLogPath)();
  const log = deps.log ?? ((line: string) => appendServerLog(line, logPath));
  const port = (deps.port ?? (() => Number(process.env.AGENTBOARD_PORT ?? 8787)))();

  const entry = (deps.entry ?? defaultEntry)();
  if (!entry.exists) {
    return { ok: false, status: 500, code: 'RESTART_ENTRY_MISSING', message: '未找到服务入口脚本，服务未重启' };
  }

  // 1) 端口前置检查：被别的进程占着就别先杀自己
  const probe = await (deps.probePort ?? (() => defaultProbePort(port, selfPid)))();
  if (probe.kind === 'foreign') {
    const detail = probe.detail ?? ('端口 ' + port + ' 被其它进程占用');
    log('重启已拒绝：' + detail + '；旧进程 ' + selfPid + ' 继续服务');
    return { ok: false, status: 409, code: 'RESTART_PORT_CONFLICT', message: detail + '，未重启；旧进程 ' + selfPid + ' 继续服务' };
  }

  // 2) 拉起新进程（stdio 已重定向到固定日志）
  let newPid: number | null = null;
  try {
    // SERVER-SINGLETON：告诉接班进程「你是 pid X 的接班人」，允许它受让还活着的旧锁（旧进程正在交棒）
    newPid = (await (deps.spawnChild ?? ((command, args) => spawnDetached(command, args, logPath, { AGENTBOARD_RESTART_FROM: String(selfPid) })))(entry.command, entry.args)).pid;
  } catch {
    return { ok: false, status: 500, code: 'RESTART_SPAWN_FAILED', message: '新进程启动失败，旧进程继续服务' };
  }

  // 3) 交接：先让调用方回 202（closeAllConnections 会掐断在途响应），200ms 后关监听并判定
  const startedAt = (deps.now ?? Date.now)();
  log('即将重启：旧进程 ' + selfPid + ' → 新进程 ' + (newPid ?? '未知') + '，日志 ' + logPath);
  const timeoutMs = deps.healthTimeoutMs ?? 15_000;
  (deps.schedule ?? ((fn, ms) => { setTimeout(fn, ms); }))(() => {
    void (async () => {
      try { await deps.closeServer?.(); } catch { /* 关闭失败也要继续判定，交给新进程 */ }
      const healthy = await (deps.waitForHealth ?? ((pid, ms) => defaultWaitForHealth(port, pid, ms)))(newPid, timeoutMs);
      if (healthy) {
        log('重启完成：新进程 ' + (newPid ?? '未知') + ' 已接管端口 ' + port);
        (deps.exit ?? (code => process.exit(code)))(0);
        return;
      }
      log('重启失败：新进程 ' + (newPid ?? '未知') + ' 未在 ' + timeoutMs + 'ms 内接管端口 ' + port + '，回退旧进程 ' + selfPid + ' 监听（日志 ' + logPath + '）');
      try {
        await deps.reopenServer?.();
        log('已回退：旧进程 ' + selfPid + ' 重新监听端口 ' + port);
      } catch (error) {
        log('回退失败：旧进程 ' + selfPid + ' 无法重新监听端口 ' + port + '（' + (error instanceof Error ? error.message : String(error)) + '），服务不可用');
      }
    })();
  }, 200);
  return { ok: true, old_pid: selfPid, new_pid: newPid, log_path: logPath, started_at: startedAt };
}

export function createRestartHandler(deps: RestartDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    if (!isLoopbackAddress(req.ip)) {
      res.status(403).json({ error: { code: 'RESTART_FORBIDDEN', message: '仅允许本机回环地址触发重启' } });
      return;
    }
    const outcome = await performRestart(deps);
    if (!outcome.ok) {
      res.status(outcome.status).json({ error: { code: outcome.code, message: outcome.message } });
      return;
    }
    res.status(202).json({
      restarting: true,
      old_pid: outcome.old_pid,
      new_pid: outcome.new_pid,
      log_path: outcome.log_path,
      started_at: outcome.started_at,
    });
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
