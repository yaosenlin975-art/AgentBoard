/**
 * G4：客户端崩溃取证端点 `POST /api/client-diagnostics`。
 *
 * 背景：桌面端偶尔白屏（React 无 ErrorBoundary → 整树卸载）。复发时无法取证——
 * release 未启 devtools、`window.onerror` 未挂。本端点是取证通道：web 上报，服务端写独立 JSONL 日志。
 *
 * 三条约束（来自卡面）：
 * - **限流**：同 `instance_id` 每分钟最多 20 条。白屏若进循环，前端会疯狂重报，
 *   不限制会刷爆磁盘。超出返回 429 且**只记一条「限流触发」**，不记被丢弃的内容
 *   （否则限流本身又成了刷屏源）。
 * - **独立日志**：`<configDir>/logs/client-error.log`，不写 `server.log`。
 * - **不鉴权**：本地服务，与 `/api/version` 同级。
 */
import { Router } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../errors.js';

/** 同一 instance_id 的限流窗口与上限 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 20;

/** 内存限流表：instance_id → 窗口起点与已计数。进程重启清零即可，不持久化。 */
interface RateBucket {
  windowStart: number;
  count: number;
  /** 本窗口是否已写过一条「限流触发」——刷屏时只记一次，否则限流记录本身就成了刷屏源 */
  limitLogged: boolean;
}
const rateBuckets = new Map<string, RateBucket>();

/** 仅供测试重置 */
export function resetClientDiagnosticsRateLimit(): void {
  rateBuckets.clear();
}

/**
 * 记录一次上报尝试。
 *
 * 返回 `allowed` 与 `shouldLogLimit`：只有本窗口**第一次**被拒时才要求写限流记录。
 * 窗口过期时重置计数（不按滑动窗口做，避免为每次请求存时间戳数组——限流只需挡住刷屏）。
 */
export function allowClientDiagnostic(instanceId: string, now: number = Date.now()): { allowed: boolean; shouldLogLimit: boolean } {
  const bucket = rateBuckets.get(instanceId);
  if (bucket === undefined || now - bucket.windowStart >= RATE_WINDOW_MS) {
    rateBuckets.set(instanceId, { windowStart: now, count: 1, limitLogged: false });
    return { allowed: true, shouldLogLimit: false };
  }
  bucket.count += 1;
  if (bucket.count <= RATE_MAX_PER_WINDOW) return { allowed: true, shouldLogLimit: false };
  if (bucket.limitLogged) return { allowed: false, shouldLogLimit: false };
  bucket.limitLogged = true;
  return { allowed: false, shouldLogLimit: true };
}

/**
 * 请求体契约。`.strict()` 保留：这是写入接口，拼错字段必须报错
 * （与查询参数相反——那边的未知键要 strip，见 knowledgeRoutes 的 parse 注释）。
 */
export const clientDiagnosticSchema = z.object({
  instance_id: z.string().trim().min(1).max(200),
  kind: z.enum(['error', 'rejection', 'react']),
  message: z.string().min(1).max(2000),
  stack: z.string().max(20_000).optional(),
  source: z.string().max(500).optional(),
  url: z.string().max(2000).optional(),
  user_agent: z.string().max(500).optional(),
  client_ts: z.number().int().nonnegative(),
  app_version: z.string().max(100).optional(),
  context: z.record(z.string().max(100), z.string().max(200)).refine(
    record => Object.keys(record).length <= 10,
    '最多 10 个键',
  ).optional(),
}).strict();

export type ClientDiagnostic = z.infer<typeof clientDiagnosticSchema>;

/** 限流触发记录（只有这一行，不含被丢弃的内容） */
export const RATE_LIMIT_LOG_LINE = 'rate_limit: 客户端错误上报超过限额，本窗口内后续内容已丢弃';

export interface ClientDiagnosticsDeps {
  /** 追加一行到客户端错误日志（测试注入以避写真实 APPDATA） */
  appendLog: (line: string) => void;
  /** 当前时间（测试注入） */
  now?: () => number;
}

export function createClientDiagnosticsRouter(deps: ClientDiagnosticsDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;

  router.post('/client-diagnostics', (req, res) => {
    const parsed = clientDiagnosticSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      // 校验失败不落盘：垃圾内容不值得占磁盘
      throw new ValidationError(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    }
    const input = parsed.data;
    const verdict = allowClientDiagnostic(input.instance_id, now());
    if (!verdict.allowed) {
      // 同窗口只记一条：刷屏时不能让限流记录自己变成刷屏源
      if (verdict.shouldLogLimit) deps.appendLog(RATE_LIMIT_LOG_LINE);
      res.status(429).json({
        error: {
          code: 'CLIENT_DIAGNOSTICS_RATE_LIMITED',
          message: `同一 instance 每分钟最多 ${RATE_MAX_PER_WINDOW} 条，请稍后重试`,
        },
      });
      return;
    }
    deps.appendLog(JSON.stringify({
      received_at: new Date(now()).toISOString(),
      client_ts: input.client_ts,
      instance_id: input.instance_id,
      app_version: input.app_version ?? null,
      kind: input.kind,
      message: input.message,
      stack: input.stack ?? null,
      source: input.source ?? null,
      url: input.url ?? null,
      user_agent: input.user_agent ?? null,
      context: input.context ?? null,
    }));
    res.json({ ok: true });
  });

  return router;
}
