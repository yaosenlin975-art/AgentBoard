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
 *
 * ACC-SRV-RESTART 交棒时序契约（旧进程 = 编排方，新进程 = 接班方；.logs 2026-11-06/07 三类实录）：
 * - 旧进程：spawn（带 AGENTBOARD_RESTART_FROM=selfPid）→ 202 → +200ms 关监听 → 健康等待
 *   （首段 healthTimeoutMs；接班进程仍活着则延长到总窗口 takeoverTimeoutMs，任一拍
 *   `/api/version` 的 pid 等于新 pid 即接管成功）→ exit(0)。
 *   等待失败后回退前先探端口归属：
 *   · 端口已是健康看板实例且 pid = 新进程 → 接管迟到，按成功收口退出；
 *   · 端口已是健康看板实例但 pid 不同 → 交棒回调被事件循环饿到迟到、期间更晚一次重启已成功
 *     （04:01 / 08:29 实录）：终止自己的迟到子进程后 exit(0)，绝不回退抢监听；
 *   · 端口无健康看板 → 必须先终止已 spawn 的子进程、等端口让出，再 reopen；reopen 成功后
 *     重持单例锁（受让自子进程 pid）。
 * - 新进程：带 AGENTBOARD_RESTART_FROM 受让「前任活着但正在退出」的锁 → 启动 → listen 对
 *   EADDRINUSE 重试（交班子进程总窗口 60s、每 500ms；普通启动 5s、每 250ms，见 index.ts）。
 *   新进程在交棒窗口内不因瞬时 EADDRINUSE 退出；旧进程回退前会先终止它，因此不存在
 *   「回退后新进程才 bind」的死亡路径（14:18 / 14:20 / 14:43 实录主因）。
 */
import { Router, type Request, type Response } from 'express';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { connect } from 'node:net';
import { appendServerLog, resolveServerLogPath } from '../services/serverLog.js';
import { isProcessAlive } from '../services/serverLock.js';
import { ensureProxyEnv } from '@agentboard/shared';

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
  // ---- ACC-SRV-RESTART 交棒竞态收口（回退路径的进程 / 端口 / 锁处置，缺省实现走真实进程）----
  /** 总接管窗口（自关监听起算，含首段健康等待）；接班进程活着就等到它，死了立即收口。缺省 60000 */
  takeoverTimeoutMs?: number;
  /** pid 存活判定（缺省复用单例锁的 isProcessAlive） */
  isProcessAlive?: (pid: number) => boolean;
  /** 终止已 spawn 的子进程并等它消失（true = 已终止 / 本就不在）；缺省 win32 taskkill /T /F、其余 SIGKILL */
  killChild?: (pid: number) => Promise<boolean>;
  /** 端口归属探测：null = 空闲；board = true 表示端口上已是健康看板实例（本子进程或后继链） */
  inspectPortOwner?: (port: number) => Promise<{ board: boolean; pid: number | null } | null>;
  /** 终止子进程后等端口真正让出（true = 已空闲）；缺省 TCP 探测 3s 上限 */
  waitForPortFree?: (port: number) => Promise<boolean>;
  /** 回退成功后旧进程重持单例锁（受让自子进程 pid，true = 已持有）；生产由 index.ts 注入 */
  reacquireLock?: (takeoverFromPid: number) => boolean;
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

/**
 * RESTART-PROXY：重启子进程的环境。
 * 启动器（`pnpm server:ensure`）与服务内重启**共用 `@agentboard/shared` 的 `ensureProxyEnv`**，
 * 不再两条路径各写一套代理判定。
 * 规则：宿主有 HTTPS_PROXY/HTTP_PROXY 且 `NODE_USE_ENV_PROXY` 未显式设 0 → 注入 1；显式 0 尊重用户。
 */
export function restartChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  extraEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const info = ensureProxyEnv(baseEnv);
  const env: NodeJS.ProcessEnv = { ...baseEnv, ...extraEnv };
  if (info.node_env_proxy !== null) env.NODE_USE_ENV_PROXY = info.node_env_proxy;
  return env;
}

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
      // RESTART-PROXY：代理注入与启动器同一份语义（ensureProxyEnv）
      env: restartChildEnv(process.env, extraEnv),
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

/** 端口归属探测（回退前判定）：null = 端口空闲；board = true = 端口上已是健康看板实例 */
export async function defaultInspectPortOwner(port: number): Promise<{ board: boolean; pid: number | null } | null> {
  const version = await probeVersion(port);
  if (version === null) return null;
  return { board: version.name === 'agentboard-server', pid: typeof version.pid === 'number' ? version.pid : null };
}

/**
 * 终止自重启拉起的接班进程并等它真正消失（回退路径用，见 performRestart 时序契约）。
 * win32 用 `taskkill /T /F`：/T 连子树（接班进程启动期可能已拉起适配器 CLI），/F 走
 * TerminateProcess，taskkill 返回即内核已确认；其余平台 SIGKILL。taskkill 非 0 不直接判
 * 失败（目标已不存在也非 0），以存活探测收口。
 */
export async function defaultKillChild(pid: number): Promise<boolean> {
  if (!isProcessAlive(pid)) return true;
  if (process.platform === 'win32') {
    const code = await new Promise<number | null>(resolve => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('exit', code_ => resolve(code_));
      killer.once('error', () => resolve(null));
    });
    if (code !== 0 && !isProcessAlive(pid)) return true;
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已死 */ }
  }
  const deadline = Date.now() + 2_000;
  while (isProcessAlive(pid) && Date.now() < deadline) await sleep(50);
  return !isProcessAlive(pid);
}

/** 终止子进程后等监听句柄真正释放（内核回收有延迟），给 reopen 一个干净的端口 */
async function defaultWaitForPortFree(port: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await canConnect(port, 500))) return true;
    await sleep(100);
  }
  return !(await canConnect(port, 500));
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

  // 3) 交接：先让调用方回 202（closeAllConnections 会掐断在途响应），200ms 后关监听并判定。
  //    旧进程是唯一编排方，完整时序契约见文件头注；窗口计时一律走 wall clock（deps.now 只给 202 打戳）。
  const startedAt = (deps.now ?? Date.now)();
  log('即将重启：旧进程 ' + selfPid + ' → 新进程 ' + (newPid ?? '未知') + '，日志 ' + logPath);
  const healthTimeoutMs = deps.healthTimeoutMs ?? 15_000;
  const takeoverTimeoutMs = deps.takeoverTimeoutMs ?? 60_000;
  const exitProcess = deps.exit ?? (code => process.exit(code));
  (deps.schedule ?? ((fn, ms) => { setTimeout(fn, ms); }))(() => {
    void (async () => {
      try { await deps.closeServer?.(); } catch { /* 关闭失败也要继续判定，交给新进程 */ }
      const isAlive = deps.isProcessAlive ?? isProcessAlive;
      const inspectOwner = deps.inspectPortOwner ?? defaultInspectPortOwner;
      const waitForHealth = deps.waitForHealth ?? ((pid, ms) => defaultWaitForHealth(port, pid, ms));
      const handoffStart = Date.now();

      // ④ 首段等 healthTimeoutMs；接班进程还活着（可能只是启动慢）则延长到总窗口 takeoverTimeoutMs，
      //    期间接班进程死亡立即收口回退，任一拍健康成立即接管成功。
      let healthy = await waitForHealth(newPid, healthTimeoutMs);
      if (!healthy && newPid !== null && isAlive(newPid)) {
        while (!healthy && Date.now() < handoffStart + takeoverTimeoutMs) {
          if (!isAlive(newPid)) break;
          healthy = await waitForHealth(newPid, 1_000);
          if (!healthy) await sleep(50);
        }
      }
      if (healthy) {
        log('重启完成：新进程 ' + (newPid ?? '未知') + ' 已接管端口 ' + port);
        exitProcess(0);
        return;
      }

      // 回退前的竞态收口：先探端口现在归谁，再决定「退出 / 终止子进程后回退」。
      const owner = await inspectOwner(port);
      if (owner !== null && owner.board && newPid !== null && owner.pid === newPid) {
        // 健康等待刚过期、子进程恰好在这之后才 bind 成功（探测迟到）：按接管成功收口。
        log('重启完成（回退检查时确认）：新进程 ' + newPid + ' 已在端口 ' + port + ' 服务');
        exitProcess(0);
        return;
      }
      if (owner !== null && owner.board) {
        // 端口已是健康看板实例但不是本子进程：交棒回调被事件循环饿到迟到，期间更晚一次重启已成功
        // （.logs 2026-11-07 04:01 / 08:29 实录）。旧进程不得回退抢监听：终止自己的迟到子进程
        // （若还在）后退出，由后继实例继续服务。
        if (newPid !== null && isAlive(newPid)) {
          const killed = await (deps.killChild ?? defaultKillChild)(newPid);
          log('竞态处置：端口 ' + port + ' 已由看板 pid ' + (owner.pid ?? '未知') + ' 服务；迟到子进程 ' + newPid + (killed ? ' 已终止' : ' 终止失败'));
        } else {
          log('竞态处置：端口 ' + port + ' 已由看板 pid ' + (owner.pid ?? '未知') + ' 服务；子进程 ' + (newPid ?? '未知') + ' 已退出');
        }
        log('竞态结局：旧进程 ' + selfPid + ' 退出，不回退（后继实例继续服务端口 ' + port + '）');
        exitProcess(0);
        return;
      }

      // 端口无健康看板（空闲或被外来进程占用）：回退前必须先终止已 spawn 的子进程——否则回退后
      // 子进程 bind 必撞 EADDRINUSE 死亡（.logs 2026-11-06 14:18 / 14:20 / 14:43 实录主因）。
      const waitedMs = Math.max(healthTimeoutMs, Date.now() - handoffStart);
      log('重启失败：新进程 ' + (newPid ?? '未知') + ' 未在 ' + waitedMs + 'ms 内接管端口 ' + port + '，回退旧进程 ' + selfPid + ' 监听（日志 ' + logPath + '）');
      let killAttempted = false;
      if (newPid !== null && isAlive(newPid)) {
        killAttempted = true;
        const killed = await (deps.killChild ?? defaultKillChild)(newPid);
        log('竞态处置：已终止子进程 ' + newPid + (killed ? '，端口归属交还旧进程' : '（终止失败，端口可能仍被其占用）'));
      } else if (newPid !== null) {
        log('竞态处置：子进程 ' + newPid + ' 已退出，无需终止');
      }
      if (killAttempted && !(await (deps.waitForPortFree ?? defaultWaitForPortFree)(port))) {
        log('竞态处置：端口 ' + port + ' 在子进程终止后仍被占用，回退可能失败');
      }
      try {
        await deps.reopenServer?.();
        log('已回退：旧进程 ' + selfPid + ' 重新监听端口 ' + port);
        // 交棒期间单例锁已归子进程（受让自旧进程）；子进程被终止后锁文件挂着死 pid，旧进程必须
        // 拿回来，否则「同库双开检测」对仍在服务的旧进程失效。失败只记录（可用性优先）。
        if (newPid !== null && deps.reacquireLock !== undefined) {
          const regained = deps.reacquireLock(newPid);
          log(regained
            ? '竞态结局：旧进程 ' + selfPid + ' 已重新持有单例锁（受让自 ' + newPid + '）'
            : '竞态结局：旧进程 ' + selfPid + ' 未能重新持有单例锁（继续服务，后续以陈旧锁接管兜底）');
        }
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
