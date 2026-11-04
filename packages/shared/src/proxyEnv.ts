/**
 * PROXY-ENV：出站代理环境解析与注入（单一实现）。
 *
 * 背景：Node 24 的内置 `fetch`（undici）**默认不读** `HTTPS_PROXY`，必须 `NODE_USE_ENV_PROXY=1`。
 * 缺这个变量时访问 HuggingFace 等外网会 10000ms 连接超时，对外只剩裸 `fetch failed`。
 *
 * 使用者：
 * - `scripts/server-detached.mjs`（`pnpm server:ensure`）拉起子进程前注入；
 * - 服务端只读暴露（`GET /api/version` 的 `proxy_env`、语音下载的 `download_env`）。
 *
 * 安全：只暴露 host:port，**丢弃 userinfo**（不打印凭据）。
 */

/** 只依赖字符串键值：shared 不引 node 类型（浏览器侧也在用） */
export type ProxyEnvSource = Record<string, string | undefined>;

/** 进程环境（没有 `process` 的运行时按空对象处理） */
export function processProxyEnv(): ProxyEnvSource {
  const holder = globalThis as { process?: { env?: ProxyEnvSource } };
  return holder.process?.env ?? {};
}

export interface ProxyEnvInfo {
  /** 子进程/本进程是否会按环境代理出站 */
  enabled: boolean;
  /** 命中的环境变量名（HTTPS_PROXY / HTTP_PROXY / 小写变体） */
  proxy_var: string | null;
  /** 代理 host:port（脱敏，不含 userinfo） */
  proxy_host: string | null;
  /** NODE_USE_ENV_PROXY 的当前值（未设置为 null） */
  node_env_proxy: string | null;
}

/** 代理地址 → host:port（丢弃 userinfo 与路径；无法解析时给固定占位，绝不回显原串） */
export function maskProxyHost(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    return url.port === '' ? url.hostname : `${url.hostname}:${url.port}`;
  } catch {
    return '<无法解析的代理地址>';
  }
}

/** 只读解析：当前环境是否会走代理、命中哪个变量、代理在哪（脱敏） */
export function resolveProxyEnv(env: ProxyEnvSource = processProxyEnv()): ProxyEnvInfo {
  const candidates: Array<[string, string | undefined]> = [
    ['HTTPS_PROXY', env.HTTPS_PROXY ?? env.https_proxy],
    ['HTTP_PROXY', env.HTTP_PROXY ?? env.http_proxy],
  ];
  const hit = candidates.find(([, value]) => value !== undefined && value.trim() !== '');
  const raw = env.NODE_USE_ENV_PROXY;
  return {
    enabled: hit !== undefined && raw !== '0',
    proxy_var: hit?.[0] ?? null,
    proxy_host: maskProxyHost(hit?.[1]),
    node_env_proxy: raw === undefined || raw === '' ? null : raw,
  };
}

/**
 * 需要时注入 `NODE_USE_ENV_PROXY=1`（就地改 env，返回注入后的解析结果）。
 * - 已显式设为 `0` → **不覆盖**（尊重用户主动关闭）；
 * - 没设代理变量 → 不改（无副作用，也不误开）；
 * - 已为 `1` → 保持。
 */
export function ensureProxyEnv(env: ProxyEnvSource = processProxyEnv()): ProxyEnvInfo {
  const before = resolveProxyEnv(env);
  if (before.node_env_proxy === '0') return before;
  if (before.proxy_var === null) return before;
  if (before.node_env_proxy === null) env.NODE_USE_ENV_PROXY = '1';
  return resolveProxyEnv(env);
}
