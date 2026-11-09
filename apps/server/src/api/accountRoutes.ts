/**
 * 账号管理路由（ACC-05 / ACC-07）：managed-accounts 捕获/切换、能力矩阵、签到授权与批量签到、操作查询。
 * 响应仅含脱敏元数据（PublicManagedAccount / AccountOperation / CheckinAuthorization / CheckinBatch），
 * 不返回快照字节、信封、凭据 ref、remote state 原文。
 * 设计：Docs/designs/accounts/2026-11-01-workbuddy-accounts.md §8。
 */
import { Router } from 'express';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { AccountCapability, CheckinAuthorization, ManagedAppId, PublicManagedAccount } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { getAccountOperation } from '../db/repos/accountOperation.js';
import {
  cancelQueuedCheckinItems,
  createCheckinBatch,
  getCheckinBatch,
  operationsForBatch,
} from '../db/repos/checkin.js';
import { getManagedAccount, publicManagedAccount, setManagedAccountEnabled } from '../db/repos/managedAccount.js';
import { refreshAccountCredential, type CredentialRefreshResult } from '../services/accounts/credentialRefresh.js';
import { getAddAccountSession, listAddAccountSessions, publicAddAccountSession } from '../db/repos/addAccount.js';
import { accountProviderCapability, accountProviderCapabilities } from '../services/accounts/registry.js';
import { createMinimaxClientProbe, type MinimaxClientProbe, type MinimaxClientStatus } from '../services/accounts/minimaxClientProbe.js';
import type { CheckinProviderSpec, CheckinVault } from '../services/accounts/checkinProvider.js';
import type { SecretVault } from '../services/accounts/secretVault.js';
import { pollCheckinAuthorization, profileLocalDay, startCheckinAuthorization } from '../services/accounts/checkinAuthorization.js';
import {
  cancelAddAccountAuthorization,
  pollAddAccountAuthorization,
  startAddAccountAuthorization,
} from '../services/accounts/addAccountAuthorization.js';
import type { AddAccountProviderSpec, AddAccountVault } from '../services/accounts/addAccountProtocol.js';
import { startCheckinBatchInBackground } from '../services/accounts/checkinRunner.js';
import { startAccountRestore } from '../services/accounts/restore.js';
import type { RestoreHandler } from '../services/accounts/restore.js';
import { createCredentialImporter, type ExportRunner } from '../services/accounts/credentialImport.js';
import { CLI_ACCOUNT_APP_IDS, CLI_CLIENT_INSTANCE_ID, captureCliAccounts, commandCodeCapability, deleteCliAccount, importCliCredential, type CliCredentialVault } from '../services/accounts/cliAccounts.js';
import { CLI_SWITCH_CAPABILITIES, switchCliAccount, type CliSwitchVault } from '../services/accounts/cliSwitch.js';
import { createQuotaService, type QuotaService, type QuotaSnapshot } from '../services/quotas/quotaService.js';
import { quotaSourceForAppId, resolveCliAccountQuotaCredential, resolvePlatformQuotaCredential } from '../services/quotas/platformQuotaCredentials.js';
import type { WorkbuddyDesktopProvider } from '../services/accounts/workbuddyDesktopProvider.js';
import { hashPayload, replayIdempotentResult, withIdempotencyResult, type IdempotencyInput } from '../services/idempotency.js';
import { ApiError, NotFoundError, ValidationError } from '../errors.js';

export interface AccountRouterDeps {
  db: Db;
  workbuddy?: WorkbuddyDesktopProvider;
  /** ACC-07：仅注入已验证签到 provider；未注入时所有签到端点 409 PROVIDER_UNVERIFIED */
  checkinProvider?: CheckinProviderSpec;
  /** ACC-12：按平台注入的签到 provider（优先于单个 checkinProvider） */
  checkinProviders?: Partial<Record<ManagedAppId, CheckinProviderSpec>>;
  /** ACC-13：按平台的桌面 provider（capture/switch）；ACC-GET 起允许「只有捕获」的实现（如 Trae） */
  desktopProviders?: Partial<Record<ManagedAppId, DesktopProvider>>;
  vault?: CheckinVault;
  /** ACC-KB-B2S：协议级「添加账号」的 provider（按平台注入；未注入时加号端点 409 PROVIDER_UNVERIFIED） */
  addAccountProviders?: Partial<Record<ManagedAppId, AddAccountProviderSpec>>;
  /** ACC-KB-B2S：加号用的 vault（需支持 pending_credential purpose）；生产复用 SecretVault */
  addAccountVault?: AddAccountVault;
  /** B4S-3：按平台的回滚处理器（restore 端点据此把快照写回客户端；缺省则按人工确认语义收尾） */
  restoreHandlers?: Partial<Record<ManagedAppId, RestoreHandler>>;
  /** ACC-DEL-01：删除账号时清理其 DPAPI 快照/凭据文件（生产为 SecretVault 实例） */
  secretVault?: Pick<SecretVault, 'delete'>;
  /** ACC-11：凭据导出 runner（仅测试注入；生产走真实 python 子进程） */
  credentialRunner?: ExportRunner;
  /** ACC-QUOTA-01：额度聚合（仅测试注入；生产用 60s 缓存的内置实现） */
  quotas?: Pick<QuotaService, 'get'> & Partial<Pick<QuotaService, 'reset'>>;
  /** MINIMAX-PATH：minimax 客户端探测（仅测试注入；生产用 60s 缓存的内置实现） */
  minimaxClientProbe?: MinimaxClientProbe;
  /** ACC-CLI-MULTI：CLI 三来源的凭据保险库（生产复用 SecretVault；测试注入内存替身） */
  cliVault?: CliCredentialVault;
  /** CLI-SWITCH：切换时读取凭据的 vault 视图（生产复用 SecretVault；测试注入内存替身） */
  cliSwitchVault?: CliSwitchVault;
  /** ACC-CLI-MULTI：CLI 凭据根目录（仅测试注入；生产为 os.homedir()） */
  cliAccountHomeDir?: string;
  /** ACC-CLI-MULTI：CLI 凭据发现的 env（仅测试注入；生产为 process.env） */
  cliAccountEnv?: Record<string, string | undefined>;
}

// ACC-10：app_id 校验扩到四值，与 managed_account 的 CHECK 及 shared ManagedAppId 保持一致
const managedAppParam = z.enum(['workbuddy_desktop', 'codebuddy_desktop', 'minimax', 'trae', 'qoder_cn', 'zcode']);
const captureBodySchema = z.object({ display_name: z.string().trim().min(1).max(100).optional() }).strict();
const importCredentialsSchema = z.object({
  platforms: z.array(z.enum(['workbuddy', 'trae', 'minimax'])).min(1).max(3).optional(),
  actor: z.string().trim().min(1).max(100).optional(),
}).strict();
const authorizationStartSchema = z.object({ account_id: z.string().uuid() }).strict();
/** CLI-IMPORT：手动导入只接受「一个来源 + 一份凭据文本」，字段严格（多余字段直接 400） */
const cliImportSchema = z.object({
  app_id: z.enum(CLI_ACCOUNT_APP_IDS),
  credential: z.string().min(1).max(2048),
}).strict();
/** ACC-KB-B2S：发起协议级加号 */
const addAccountStartSchema = z.object({
  app_id: managedAppParam,
  region: z.enum(['cn', 'global']).optional(),
}).strict();
const batchCreateSchema = z.object({
  app_id: managedAppParam,
  account_ids: z.array(z.string().uuid()).min(1).max(50),
}).strict().refine(v => new Set(v.account_ids).size === v.account_ids.length, 'account_ids 不能重复');
/** ACC-TOKEN-2：刷新凭据请求体为空对象（actor 由 idempotencyInput 读取；Idempotency-Key 必需） */
const refreshCredentialBodySchema = z.object({}).strict();

export type DesktopCaptureProvider = Pick<WorkbuddyDesktopProvider, 'captureCurrent'>;
export type DesktopSwitchProvider = Pick<WorkbuddyDesktopProvider, 'switchAccount'>;
/** ACC-FIX-4：客户端未运行时用插件线 JWT 回填既有账号行的签到凭据（仅 WorkBuddy 实现可选暴露） */
export type DesktopCheckinBackfillProvider = Pick<WorkbuddyDesktopProvider, 'backfillCheckinCredentialFromPlugin'>;
/**
 * ACC-SWITCH：读「客户端当前登录身份」的哈希（只读、不抛错；读不到返回 null）。
 * 列表用它逐平台判定 `is_current`，缺方法时该平台退化为 null（未知），不再用 WorkBuddy 的身份去比对别的平台。
 */
export type DesktopIdentityProvider = { getCurrentIdentityHash?: () => Promise<string | null> };
/** ACC-GET：捕获与切换不再强制同时存在（Trae 只有捕获能力，registry 的 switch=false 会先拦住切换） */
export type DesktopProvider = Partial<DesktopCaptureProvider & DesktopSwitchProvider & DesktopCheckinBackfillProvider> & DesktopIdentityProvider;

/** ACC-SWITCH：逐平台取当前身份哈希；读不到/未装配读取能力 → 该平台不出现在结果里（is_current = null） */
async function readCurrentIdentityHashes(deps: AccountRouterDeps): Promise<Partial<Record<ManagedAppId, string | null>>> {
  const hashes: Partial<Record<ManagedAppId, string | null>> = {};
  if (deps.workbuddy) {
    const identity = await deps.workbuddy.getCurrentIdentity().catch(() => null);
    hashes.workbuddy_desktop = identity?.identity_hash ?? null;
  }
  for (const app of ['minimax', 'trae'] as const) {
    const provider = deps.desktopProviders?.[app];
    if (!provider?.getCurrentIdentityHash) continue;
    hashes[app] = await Promise.resolve(provider.getCurrentIdentityHash()).catch(() => null);
  }
  return hashes;
}

/** ACC-13：按平台解析桌面 provider；minimax/trae 从注入表取，workbuddy 走既有字段 */
function resolveDesktopProvider(app: ManagedAppId, deps: AccountRouterDeps): DesktopProvider {
  const injected = deps.desktopProviders?.[app];
  if (injected) return injected;
  if (app === 'workbuddy_desktop') {
    if (!deps.workbuddy) throw new ApiError(503, 'PROVIDER_UNAVAILABLE', 'WorkBuddy provider 未装配');
    return deps.workbuddy;
  }
  throw new ApiError(503, 'PROVIDER_UNAVAILABLE', '该产品的桌面 provider 未装配');
}

/**
 * ACC-GET：能力表说「可用」就必须真有对应方法；缺方法时仍是 503（能力/行为不一致的兜底）。
 * ACC-SW-MAX：minimax 行按客户端探测推导（与能力矩阵同一套探测/口径），gate 不再硬编码静态表。
 */
async function requireProvider(app: ManagedAppId, deps: AccountRouterDeps, action: 'capture', minimaxProbe?: MinimaxClientProbe): Promise<DesktopCaptureProvider & Partial<DesktopCheckinBackfillProvider>>;
async function requireProvider(app: ManagedAppId, deps: AccountRouterDeps, action: 'switch', minimaxProbe?: MinimaxClientProbe): Promise<DesktopSwitchProvider>;
async function requireProvider(app: ManagedAppId, deps: AccountRouterDeps, action: 'capture' | 'switch', minimaxProbe?: MinimaxClientProbe): Promise<DesktopCaptureProvider | DesktopSwitchProvider> {
  const minimaxClient = app === 'minimax' && minimaxProbe ? await minimaxProbe.get() : undefined;
  const capability = accountProviderCapability(app, minimaxClient);
  if (!capability || !capability[action]) throw new ApiError(409, 'PROVIDER_UNVERIFIED', `该产品的${action === 'capture' ? '捕获' : '切换'}能力未验证`, capability ? { reason_code: capability.reason_code } : undefined);
  const provider = resolveDesktopProvider(app, deps);
  // 不能重新包一层对象：方法里会用到 this（db/vault 等），必须保持原 provider 的接收者
  if (action === 'capture') {
    if (!provider.captureCurrent) throw new ApiError(503, 'PROVIDER_UNAVAILABLE', '该产品的桌面捕获 provider 未装配');
    return provider as DesktopCaptureProvider;
  }
  if (!provider.switchAccount) throw new ApiError(503, 'PROVIDER_UNAVAILABLE', '该产品的桌面切换 provider 未装配');
  return provider as DesktopSwitchProvider;
}

/**
 * ACC-07：能力矩阵 = registry 静态表 ⊕ 注入的已验证 provider。
 *
 * 原因码按能力维度给出（**新字段优先**，`capture_reason_code` / `switch_reason_code` / `checkin_reason_code`）：
 * - 能力可用 → `'OK'`；
 * - capture / switch 不可用 → 取 registry 该产品的真实根因码（例如 CodeBuddy 的 `TARGET_KIND_UNCONFIRMED`）；
 * - checkin 不可用 → 恒为 `CHECKIN_PROVIDER_UNVERIFIED`（两产品签到 gate 未验证，与 registry 无关）。
 *
 * `reason_code` 为向后兼容的聚合值：capture 与 switch 均可用时取 `checkin_reason_code`，否则取 registry 根因码。
 * `source`：`static` = 各项均来自 registry 静态表；`derived` = 至少一项由注入 provider 推导（混合时以 `derived` 为准）。
 */
export type CheckinProviderInput = CheckinProviderSpec | Partial<Record<ManagedAppId, CheckinProviderSpec>> | undefined;

/** 支持单 provider（ACC-07 兼容）与按 app_id 的多 provider 映射（ACC-12） */
export function resolveProviderMap(providers: CheckinProviderInput): Partial<Record<ManagedAppId, CheckinProviderSpec>> {
  if (!providers) return {};
  if ('app_id' in providers && typeof (providers as CheckinProviderSpec).app_id === 'string') {
    const single = providers as CheckinProviderSpec;
    return { [single.app_id]: single };
  }
  const map: Partial<Record<ManagedAppId, CheckinProviderSpec>> = {};
  for (const [appId, provider] of Object.entries(providers as Partial<Record<ManagedAppId, CheckinProviderSpec>>)) {
    if (provider) map[appId as ManagedAppId] = provider;
  }
  return map;
}

export function mergeAccountCapabilities(checkinProvider?: CheckinProviderInput, minimaxClient?: MinimaxClientStatus): AccountCapability[] {
  const available = resolveProviderMap(checkinProvider);
  return accountProviderCapabilities(minimaxClient).map(capability => {
    const derived = available[capability.app_id] !== undefined;
    const checkinReason = derived ? 'CHECKIN_PROVIDER_AVAILABLE' : 'CHECKIN_PROVIDER_UNVERIFIED';
    const captureReason = capability.capture ? 'OK' : capability.reason_code;
    const switchReason = capability.switch ? 'OK' : capability.reason_code;
    return {
      app_id: capability.app_id,
      capture: capability.capture,
      switch: capability.switch,
      checkin: derived,
      capture_reason_code: captureReason,
      switch_reason_code: switchReason,
      checkin_reason_code: checkinReason,
      reason_code: capability.capture && capability.switch ? checkinReason : capability.reason_code,
      source: derived ? 'derived' as const : 'static' as const,
    };
  });
}

function requireCheckin(app: ManagedAppId, deps: AccountRouterDeps): { provider: CheckinProviderSpec; vault: CheckinVault } {
  const providers = resolveProviderMap(deps.checkinProviders ?? deps.checkinProvider);
  const provider = providers[app];
  const capability = mergeAccountCapabilities(deps.checkinProviders ?? deps.checkinProvider).find(item => item.app_id === app);
  if (!capability || !capability.checkin || !provider) throw new ApiError(409, 'PROVIDER_UNVERIFIED', '该产品的签到能力未验证', { reason_code: 'CHECKIN_PROVIDER_UNVERIFIED' });
  if (!deps.vault) throw new ApiError(503, 'VAULT_UNAVAILABLE', '凭据保护未装配');
  return { provider, vault: deps.vault };
}

/** ACC-KB-B2S：加号 provider + vault；缺 provider → 409，缺 vault → 503 */
function requireAddAccount(app: ManagedAppId, deps: AccountRouterDeps): { provider: AddAccountProviderSpec; vault: AddAccountVault } {
  const provider = deps.addAccountProviders?.[app];
  if (!provider) throw new ApiError(409, 'PROVIDER_UNVERIFIED', '该产品暂不支持协议级添加账号', { reason_code: 'ADD_ACCOUNT_PROTOCOL_UNSUPPORTED' });
  if (!deps.addAccountVault) throw new ApiError(503, 'VAULT_UNAVAILABLE', '凭据保护未装配');
  return { provider, vault: deps.addAccountVault };
}

function idempotencyInput(req: { method: string; baseUrl: string; path: string; body?: unknown; get?: (name: string) => string | undefined }, required: boolean): IdempotencyInput | null {
  const value = req.get ? req.get('Idempotency-Key') : undefined;
  if (!value) {
    if (required) throw new ValidationError('该接口要求 Idempotency-Key（UUID）');
    return null;
  }
  const actor = (req.body as { actor?: unknown } | undefined)?.actor ?? 'user';
  if (typeof actor !== 'string') throw new ValidationError('actor 不合法');
  return { key: value, actorId: actor, action: req.method, resource: `${req.baseUrl}${req.path}`, payloadHash: hashPayload({ body: req.body ?? null }) };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** zod 校验：失败统一转 ValidationError（否则裸 ZodError 会被错误中间件当 500） */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '));
  return parsed.data;
}

export function createAccountRouter(deps: AccountRouterDeps): Router {
  const router = Router();
  const { db } = deps;
  /** CLI-SWITCH / Command Code quota: production reuses SecretVault; each lookup scopes to one cli_account row. */
  const cliSwitchVault = deps.cliSwitchVault ?? (deps.secretVault as unknown as CliSwitchVault | undefined);
  /** ACC-QUOTA-01：单实例缓存（60s TTL + 失败退避），每次服务装配只建一次 */
  // ACC-QUOTA-ALL：平台凭据 fetch 时解析（中心库签到凭据 / zcode 本机文件），凭据导入/轮换即时生效
  const quotas = deps.quotas ?? createQuotaService({
    platformCredential: (source, accountId) => resolvePlatformQuotaCredential({
      db,
      vault: deps.vault,
      homeDir: deps.cliAccountHomeDir,
      env: deps.cliAccountEnv,
      source,
      accountId,
    }),
    commandCodeCredential: accountId => resolveCliAccountQuotaCredential({
      db,
      vault: cliSwitchVault,
      accountId,
      clientInstanceId: CLI_CLIENT_INSTANCE_ID,
    }),
  });
  /** MINIMAX-PATH：客户端探测单实例缓存（60s TTL），每次装配只建一次 */
  const minimaxProbe = deps.minimaxClientProbe ?? createMinimaxClientProbe();
  /** ACC-CLI-MULTI：生产复用注入的 SecretVault（`vault` 字段是签到侧的窄类型视图） */
  const cliVault = deps.cliVault ?? (deps.vault as unknown as CliCredentialVault | undefined);
  // ---- ACC-CLI-MULTI：CLI 三来源的本机凭据登记（口径 A：只读发现 + 真实计数 + 持久化） ----
  // GET 触发一次幂等登记：界面首屏无需额外按钮即可拿到真实计数；已登记账号只更新 last_seen_at。
  router.get('/cli-accounts', async (_req, res) => {
    const items = await captureCliAccounts({
      db,
      vault: cliVault,
      homeDir: deps.cliAccountHomeDir,
      env: deps.cliAccountEnv,
    });
    res.json({ items });
  });

  /**
   * CLI-IMPORT：手动导入一份凭据（粘贴文本或文件内容，一次一份）。
   * 明文只在内存解析后进 vault；响应只回 action + 脱敏身份指纹，不含 key / credential_ref。
   */
  router.post('/cli-accounts/import', async (req, res) => {
    const body = parseBody(cliImportSchema, req.body);
    const result = await importCliCredential({ db, vault: cliVault, appId: body.app_id, credential: body.credential });
    if (body.app_id === 'commandcode') quotas.reset?.();
    res.json(result);
  });

  /**
   * ACC-CC-5：删除一条 CLI 账号记录，并回收它的 vault 密文（purpose `cli_credential`）。
   * 凭据文件仍在的「本机发现」账号删掉后，下次 GET 会重新登记；界面负责提示这一点。
   */
  const deleteCliCredential = deps.cliVault?.delete !== undefined
    ? deps.cliVault.delete.bind(deps.cliVault)
    : deps.secretVault?.delete.bind(deps.secretVault);
  router.delete('/cli-accounts/:id', async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new ValidationError('账号 id 不合法');
    const result = await deleteCliAccount({ db, accountId: id.data, deleteCredential: deleteCliCredential });
    res.json(result);
  });

  /**
   * ACC-CC-3：Command Code 的真实发现能力（本机安装 / 凭据文件状态 / 三维能力）。
   * 未安装或格式未识别时返回对应原因码，不伪造账号；写回与签到恒为不可用。
   */
  router.get('/cli-accounts/commandcode/capability', (_req, res) => {
    res.json({
      capability: commandCodeCapability(
        deps.cliAccountHomeDir ?? homedir(),
        deps.cliAccountEnv ?? process.env,
      ),
    });
  });

  // ---- CLI-SWITCH：能力表 + 逐来源切换（默认 dry-run，显式 apply 才写本机配置） ----
  router.get('/cli-accounts/switch-capabilities', (_req, res) => {
    res.json({ items: CLI_SWITCH_CAPABILITIES });
  });

  // ---- Command Code：按 cli_account 精确读取额度，不触发 CLI 账号捕获或 last_seen_at 更新 ----
  router.get('/cli-account-quotas', async (req, res) => {
    const accountId = z.string().uuid().safeParse(req.query.account_id);
    if (!accountId.success) throw new ValidationError('account_id 必须为 UUID');
    const account = db.prepare('SELECT app_id FROM cli_account WHERE id=?').get(accountId.data) as { app_id: string } | undefined;
    if (!account || account.app_id !== 'commandcode') throw new NotFoundError('Command Code 账号不存在');
    res.json(await quotas.get({ accountId: accountId.data, source: 'commandcode' }));
  });

  const cliSwitchBodySchema = z.object({ apply: z.boolean().optional() }).strict();
  router.post('/cli-accounts/:id/switch', async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new ValidationError('账号 id 不合法');
    const body = parseBody(cliSwitchBodySchema, req.body);
    const result = await switchCliAccount({
      db,
      vault: cliSwitchVault,
      accountId: id.data,
      apply: body.apply === true,
      homeDir: deps.cliAccountHomeDir ?? homedir(),
      env: deps.cliAccountEnv ?? process.env,
    });
    res.json(result);
  });

  // ---- ACC-QUOTA-01：账号页额度/余额聚合（逐来源独立结果） ----
  router.get('/managed-account-quotas', async (req, res) => {
    const workspace = z.string().uuid().safeParse(req.query.workspace_id ?? undefined);
    if (req.query.workspace_id !== undefined && !workspace.success) throw new ValidationError('workspace_id 不合法');
    const accountId = z.string().uuid().safeParse(req.query.account_id ?? undefined);
    if (req.query.account_id !== undefined && !accountId.success) throw new ValidationError('account_id 不合法');
    let snapshot: QuotaSnapshot;
    if (accountId.success) {
      const account = getManagedAccount(db, accountId.data);
      if (!account) throw new NotFoundError('账号不存在');
      const source = quotaSourceForAppId(account.app_id);
      if (!source) throw new ValidationError('该账号平台没有额度来源');
      snapshot = await quotas.get({ accountId: account.id, source });
    } else {
      snapshot = await quotas.get();
    }
    res.json({ ...snapshot, workspace_id: workspace.success ? workspace.data : null });
  });

  // ---- managed-accounts ----
  router.get('/managed-accounts', async (req, res) => {
    const app = managedAppParam.safeParse(req.query.app ?? undefined);
    if (req.query.app !== undefined && !app.success) throw new ValidationError('app 不合法');
    const filter = app.success ? app.data : undefined;
    // ACC-SWITCH：按账号所属平台各自读取「客户端当前身份」，不再拿 WorkBuddy 的身份去比对所有平台
    const currentHashes = await readCurrentIdentityHashes(deps);
    const rows = (db.prepare('SELECT id FROM managed_account ORDER BY created_at,id').all() as Array<{ id: string }>)
      .map(row => getManagedAccount(db, row.id)!);
    res.json(rows
      .filter(account => filter === undefined || account.app_id === filter)
      .map(account => {
        const currentHash = currentHashes[account.app_id];
        return {
          ...publicManagedAccount(account),
          is_current: currentHash === undefined || currentHash === null ? null : account.identity_hash === currentHash,
        };
      }));
  });

  router.post('/managed-accounts/:app/capture-current', async (req, res) => {
    const parsed = managedAppParam.safeParse(req.params.app);
    if (!parsed.success) throw new ValidationError('app 不合法');
    const app = parsed.data;
    const body = parseBody(captureBodySchema, req.body);
    const provider = await requireProvider(app, deps, 'capture', minimaxProbe);
    let account;
    try {
      account = await provider.captureCurrent({ display_name: body.display_name });
    } catch (error) {
      // ACC-FIX-4：WorkBuddy 进程不在时，插件线 JWT（文件级，无需进程）仍可回填既有账号行的签到凭据；匹配不到维持原 409
      if (error instanceof ApiError && error.code === 'CLIENT_NOT_RUNNING' && app === 'workbuddy_desktop' && typeof provider.backfillCheckinCredentialFromPlugin === 'function') {
        const backfilled = await provider.backfillCheckinCredentialFromPlugin();
        if (backfilled) { res.json({ account: publicManagedAccount(backfilled) }); return; }
      }
      throw error;
    }
    res.json({ account: publicManagedAccount(account) });
  });

  /**
   * ACC-TOKEN-2：按 refresh_method 三分派刷新凭据（设计页 §4）。
   * Idempotency-Key 必需（UUID）：一次性 refresh token 不得重复发送，重放返回首次结果；
   * 同账号刷新经 runAccountOperation tryLock 串行（与签到/捕获/切换互斥），抢不到锁 409 ACCOUNT_BUSY。
   */
  router.post('/managed-accounts/:id/refresh-credential', async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new ValidationError('id 必须为 UUID');
    const input = idempotencyInput(req, true)!;
    const cached = replayIdempotentResult<CredentialRefreshResult>(db, input);
    if (cached) { res.status(202).json(cached); return; }
    parseBody(refreshCredentialBodySchema, req.body);
    const account = getManagedAccount(db, id.data);
    if (!account) throw new NotFoundError('账号不存在');
    const result = await refreshAccountCredential({
      db,
      vault: deps.vault,
      resolveCapture: async () => requireProvider(account.app_id, deps, 'capture', minimaxProbe),
    }, account);
    const payload: CredentialRefreshResult = { account: result.account, refreshed: true, method: result.method };
    withIdempotencyResult(db, input, () => payload);
    res.status(202).json(payload);
  });

  // 切换：立即返回 operation id，执行结果经 GET /account-operations/:id 轮询（设计 §8）
  router.post('/managed-accounts/:id/switch', async (req, res) => {
    // ACC-SW-VALID：对齐同域写端点（refresh-credential/restore/PATCH/delete）的 :id UUID 校验
    const parsed = z.string().uuid().safeParse(req.params.id);
    if (!parsed.success) throw new ValidationError('id 必须为 UUID');
    const account = getManagedAccount(db, parsed.data);
    if (!account) throw new NotFoundError('账号不存在');
    const provider = await requireProvider(account.app_id, deps, 'switch', minimaxProbe);
    let operationId: string | undefined;
    let failure: unknown;
    const completion = provider.switchAccount(account.id, { onOperationCreated: id => { operationId = id; } });
    completion.catch(error => { failure = error; });
    const deadline = Date.now() + 10_000;
    while (operationId === undefined && failure === undefined && Date.now() < deadline) await sleep(10);
    if (operationId === undefined) {
      if (failure !== undefined) throw failure;
      throw new ApiError(500, 'OPERATION_START_TIMEOUT', '切换操作未能启动');
    }
    const operation = getAccountOperation(db, operationId);
    res.status(202).json({ operation_id: operationId, operation });
  });

  // ---- ACC-KB-A3：restore 端点——解掉 recovery_required 死锁（幂等，重放不新建行） ----
  router.post('/managed-accounts/:id/restore', async (req, res) => {
    const parsed = z.string().uuid().safeParse(req.params.id);
    if (!parsed.success) throw new ValidationError('id 必须为 UUID');
    const result = await startAccountRestore(db, parsed.data, deps.restoreHandlers);
    res.status(202).json({
      operation_id: result.operation.id,
      operation: result.operation,
      recovered_operation_id: result.recovered_operation_id,
      replayed: result.replayed,
    });
  });

  // ---- ACC-KB-A2：enabled 写入路径（此前只有读取，界面上「已停用」徽标永远不可达） ----
  router.patch('/managed-accounts/:id', (req, res) => {
    const parsed = z.string().uuid().safeParse(req.params.id);
    if (!parsed.success) throw new ValidationError('id 必须为 UUID');
    const body = z.object({ enabled: z.boolean() }).strict().safeParse(req.body);
    if (!body.success) throw new ValidationError('body 只能是 {enabled: boolean}');
    const id = parsed.data;
    if (!getManagedAccount(db, id)) throw new NotFoundError('账号不存在');
    // 有排队/进行中的操作时禁止改状态：避免「操作跑到一半账号被停用」造成的语义歧义
    if (db.prepare("SELECT 1 FROM account_operation WHERE account_id=? AND state IN ('queued','running') LIMIT 1").get(id)) {
      throw new ApiError(409, 'ACCOUNT_BUSY', '账号有排队或进行中的操作，稍后再改启用状态', { reason_code: 'ACCOUNT_BUSY' });
    }
    res.json(publicManagedAccount(setManagedAccountEnabled(db, id, body.data.enabled)));
  });

  // ---- ACC-DEL-01：删除账号元数据与其 DPAPI 文件（设计 §7；不触碰客户端自身登录文件） ----
  router.delete('/managed-accounts/:id', async (req, res) => {
    const parsed = z.string().uuid().safeParse(req.params.id);
    if (!parsed.success) throw new ValidationError('id 必须为 UUID');
    const id = parsed.data;
    const account = getManagedAccount(db, id);
    if (!account) throw new NotFoundError('账号不存在');
    // 阻塞条件按安全优先顺序判定（设计 §7 拍板）
    if (db.prepare("SELECT 1 FROM account_operation WHERE account_id=? AND state IN ('queued','running') LIMIT 1").get(id)) {
      throw new ApiError(409, 'ACCOUNT_BUSY', '账号有排队或进行中的操作', { reason_code: 'ACCOUNT_BUSY' });
    }
    if (db.prepare("SELECT 1 FROM checkin_authorization WHERE account_id=? AND status='pending' AND expires_at>? LIMIT 1").get(id, Date.now())) {
      throw new ApiError(409, 'CHECKIN_AUTHORIZATION_EXISTS', '账号有未过期的签到授权', { reason_code: 'CHECKIN_AUTHORIZATION_EXISTS' });
    }
    const lastSwitch = db.prepare("SELECT state FROM account_operation WHERE account_id=? AND operation='switch' ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(id) as { state: string } | undefined;
    if (lastSwitch?.state === 'recovery_required') {
      throw new ApiError(409, 'RECOVERY_REQUIRED', '最近一次切换仍需恢复，快照是恢复依据', { reason_code: 'RECOVERY_REQUIRED' });
    }
    const refs = [account.client_snapshot_ref, account.checkin_credential_ref].filter((ref): ref is string => ref !== null);
    if (refs.length > 0 && !deps.secretVault) throw new ApiError(503, 'VAULT_UNAVAILABLE', '凭据保护未装配');
    // 先清凭据文件（delete 走 rm force，幂等），再删元数据行：中途异常时重试仍能删净，且不会留下无人引用的凭据
    for (const ref of refs) await deps.secretVault!.delete(ref);
    // 历史关联行交 schema 已声明的 FK：account_operation → SET NULL，checkin_* → CASCADE（见开工评论口径）
    db.prepare('DELETE FROM managed_account WHERE id=?').run(id);
    res.json({ deleted: true, id });
  });

  // ---- 能力矩阵（ACC-07；board-ui 缺口：前端不再维护副本） ----
  router.get('/managed-account-capabilities', async (req, res) => {
    const app = managedAppParam.safeParse(req.query.app ?? undefined);
    if (req.query.app !== undefined && !app.success) throw new ValidationError('app 不合法');
    // MINIMAX-PATH：能力矩阵带上 minimax 客户端探测结果（多候选位置 + 卸载注册表，60s 缓存）
    const minimaxClient = await minimaxProbe.get();
    const rows = mergeAccountCapabilities(deps.checkinProviders ?? deps.checkinProvider, minimaxClient);
    res.json(app.success ? rows.filter(row => row.app_id === app.data) : rows);
  });

  // ---- ACC-11：显式触发的本机凭据导入（唯一入口；无启动/定时扫描）----
  router.post('/accounts/import-credentials', async (req, res) => {
    const body = parseBody(importCredentialsSchema, req.body);
    if (!deps.vault) throw new ApiError(503, 'VAULT_UNAVAILABLE', '凭据保险库不可用');
    const importer = createCredentialImporter({ db: deps.db, vault: deps.vault, runExport: deps.credentialRunner });
    const result = await importer.importCredentials({ platforms: body.platforms, actor: body.actor ?? 'user' });
    res.json(result);
  });
  // ---- 签到授权 ----
  router.post('/checkin-authorizations/start', async (req, res) => {
    const input = idempotencyInput(req, true)!;
    const cached = replayIdempotentResult<{ authorization: CheckinAuthorization }>(db, input);
    if (cached) { res.status(202).json(cached); return; }
    const body = parseBody(authorizationStartSchema, req.body);
    const account = getManagedAccount(db, body.account_id);
    if (!account) throw new NotFoundError('账号不存在');
    const { provider, vault } = requireCheckin(account.app_id, deps);
    const authorization = await startCheckinAuthorization({ db, vault, provider }, account.id);
    const payload = { authorization };
    withIdempotencyResult(db, input, () => payload);
    res.status(202).json(payload);
  });

  router.post('/checkin-authorizations/:id/poll', async (req, res) => {
    const row = db.prepare('SELECT account_id FROM checkin_authorization WHERE id=?').get(req.params.id!) as { account_id: string } | undefined;
    if (!row) throw new NotFoundError('签到授权不存在');
    const account = getManagedAccount(db, row.account_id);
    if (!account) throw new NotFoundError('账号不存在');
    const { provider, vault } = requireCheckin(account.app_id, deps);
    const result = await pollCheckinAuthorization({ db, vault, provider }, req.params.id!);
    res.json({ authorization: result.authorization, account: result.account });
  });

  // ---- ACC-KB-B2S：协议级「添加账号」（不依赖客户端在跑）----
  // 发起 → 用户在浏览器确认一次 → 轮询 → 凭据落 vault → 建 managed_account。
  // 凭据只在授权成功后才落库；放弃/超时会删掉待激活凭据，不留半条账号、不留孤儿 vault 文件。
  router.get('/add-account-protocols', (_req, res) => {
    const providers = deps.addAccountProviders ?? {};
    res.json({
      items: Object.values(providers).map(provider => ({
        app_id: provider.app_id,
        protocol: provider.protocol,
        provider_version: provider.provider_version,
        requires_browser: true as const,
        regions: provider.regions,
      })),
    });
  });

  router.post('/add-account-sessions', async (req, res) => {
    const body = parseBody(addAccountStartSchema, req.body);
    const { vault } = requireAddAccount(body.app_id, deps);
    const session = await startAddAccountAuthorization({ db, vault, providers: deps.addAccountProviders ?? {} }, {
      app_id: body.app_id,
      region: body.region,
    });
    res.status(202).json({ session: publicAddAccountSession(session) });
  });

  router.get('/add-account-sessions', (req, res) => {
    const app = managedAppParam.safeParse(req.query.app ?? undefined);
    if (req.query.app !== undefined && !app.success) throw new ValidationError('app 不合法');
    res.json({ items: listAddAccountSessions(db, app.success ? app.data : undefined).map(publicAddAccountSession) });
  });

  router.get('/add-account-sessions/:id', (req, res) => {
    const session = getAddAccountSession(db, req.params.id!);
    if (!session) throw new NotFoundError('添加账号会话不存在');
    res.json({ session: publicAddAccountSession(session) });
  });

  router.post('/add-account-sessions/:id/poll', async (req, res) => {
    const row = db.prepare('SELECT app_id FROM add_account_session WHERE id=?').get(req.params.id!) as { app_id: string } | undefined;
    if (!row) throw new NotFoundError('添加账号会话不存在');
    const { vault } = requireAddAccount(row.app_id as ManagedAppId, deps);
    const result = await pollAddAccountAuthorization({ db, vault, providers: deps.addAccountProviders ?? {} }, req.params.id!);
    res.json({ session: publicAddAccountSession(result.session), account: result.account });
  });

  router.delete('/add-account-sessions/:id', async (req, res) => {
    const row = db.prepare('SELECT app_id FROM add_account_session WHERE id=?').get(req.params.id!) as { app_id: string } | undefined;
    if (!row) throw new NotFoundError('添加账号会话不存在');
    const { vault } = requireAddAccount(row.app_id as ManagedAppId, deps);
    const session = await cancelAddAccountAuthorization({ db, vault, providers: deps.addAccountProviders ?? {} }, req.params.id!);
    res.json({ session: publicAddAccountSession(session) });
  });

  // ---- 批量签到 ----
  router.post('/checkin-runs', (req, res) => {
    const input = idempotencyInput(req, true)!;
    const body = parseBody(batchCreateSchema, req.body);
    const { provider, vault } = requireCheckin(body.app_id, deps);
    const accounts = body.account_ids.map(id => {
      const account = getManagedAccount(db, id);
      if (!account) throw new NotFoundError(`账号不存在: ${id}`);
      if (account.app_id !== body.app_id) throw new ValidationError(`账号 ${id} 不属于该产品`);
      return account;
    });
    const created = withIdempotencyResult(db, input, () => createCheckinBatch(db, {
      app_id: body.app_id,
      account_ids: accounts.map(account => account.id),
      profile_local_day: profileLocalDay(),
    }));
    if (!created.replayed) {
      void startCheckinBatchInBackground({ db, vault, provider }, created.result.id).finally(() => quotas.reset?.());
    }
    res.status(202).json({ batch: created.result, replayed: created.replayed });
  });

  router.get('/checkin-runs/:batchId', (req, res) => {
    const batch = getCheckinBatch(db, req.params.batchId!);
    if (!batch) throw new NotFoundError('签到批次不存在');
    res.json(batch);
  });

  router.post('/checkin-runs/:batchId/cancel', (req, res) => {
    const batch = getCheckinBatch(db, req.params.batchId!);
    if (!batch) throw new NotFoundError('签到批次不存在');
    if (batch.finished_at !== null) throw new ApiError(409, 'CHECKIN_BATCH_FINISHED', '批次已结束，无法取消');
    const cancelled = cancelQueuedCheckinItems(db, batch.id);
    const running = (batch.items ?? []).filter(item => item.state === 'running').map(item => item.account_id);
    res.json({ batch_id: batch.id, cancelled, running });
  });

  // ---- account-operations ----
  router.get('/account-operations', (req, res) => {
    const parsed = z.string().uuid().safeParse(req.query.batch_id);
    if (!parsed.success) throw new ValidationError('batch_id 必须为 UUID');
    res.json(operationsForBatch(db, parsed.data));
  });

  router.get('/account-operations/:id', (req, res) => {
    const operation = getAccountOperation(db, req.params.id!);
    if (!operation) throw new ApiError(404, 'OPERATION_NOT_FOUND', '账号操作不存在');
    res.json(operation);
  });

  return router;
}
