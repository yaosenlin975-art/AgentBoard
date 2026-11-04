/**
 * 账号管理路由（ACC-05 / ACC-07）：managed-accounts 捕获/切换、能力矩阵、签到授权与批量签到、操作查询。
 * 响应仅含脱敏元数据（PublicManagedAccount / AccountOperation / CheckinAuthorization / CheckinBatch），
 * 不返回快照字节、信封、凭据 ref、remote state 原文。
 * 设计：Docs/design-2026-11-01-workbuddy-accounts.md §8。
 */
import { Router } from 'express';
import { z } from 'zod';
import type { AccountCapability, CheckinAuthorization, ManagedAppId } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { getAccountOperation } from '../db/repos/accountOperation.js';
import {
  cancelQueuedCheckinItems,
  createCheckinBatch,
  getCheckinBatch,
  operationsForBatch,
} from '../db/repos/checkin.js';
import { getManagedAccount, publicManagedAccount, setManagedAccountEnabled } from '../db/repos/managedAccount.js';
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
import { createQuotaService, type QuotaService } from '../services/quotas/quotaService.js';
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
  /** ACC-13：minimax 等按平台的桌面 provider（capture/switch） */
  desktopProviders?: Partial<Record<ManagedAppId, Pick<WorkbuddyDesktopProvider, 'captureCurrent' | 'switchAccount'>>>;
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
  quotas?: Pick<QuotaService, 'get'>;
  /** MINIMAX-PATH：minimax 客户端探测（仅测试注入；生产用 60s 缓存的内置实现） */
  minimaxClientProbe?: MinimaxClientProbe;
}

// ACC-10：app_id 校验扩到四值，与 managed_account 的 CHECK 及 shared ManagedAppId 保持一致
const managedAppParam = z.enum(['workbuddy_desktop', 'codebuddy_desktop', 'minimax', 'trae', 'qoder_cn', 'zcode']);
const captureBodySchema = z.object({ display_name: z.string().trim().min(1).max(100).optional() }).strict();
const importCredentialsSchema = z.object({
  platforms: z.array(z.enum(['workbuddy', 'trae', 'minimax'])).min(1).max(3).optional(),
  actor: z.string().trim().min(1).max(100).optional(),
}).strict();
const authorizationStartSchema = z.object({ account_id: z.string().uuid() }).strict();
/** ACC-KB-B2S：发起协议级加号 */
const addAccountStartSchema = z.object({
  app_id: managedAppParam,
  region: z.enum(['cn', 'global']).optional(),
}).strict();
const batchCreateSchema = z.object({
  app_id: managedAppParam,
  account_ids: z.array(z.string().uuid()).min(1).max(50),
}).strict().refine(v => new Set(v.account_ids).size === v.account_ids.length, 'account_ids 不能重复');

type DesktopProvider = Pick<WorkbuddyDesktopProvider, 'captureCurrent' | 'switchAccount'>;

/** ACC-13：按平台解析桌面 provider；minimax 从注入表取，workbuddy 走既有字段 */
function requireProvider(app: ManagedAppId, deps: AccountRouterDeps, action: 'capture' | 'switch'): DesktopProvider {
  const capability = accountProviderCapability(app);
  if (!capability || !capability[action]) throw new ApiError(409, 'PROVIDER_UNVERIFIED', `该产品的${action === 'capture' ? '捕获' : '切换'}能力未验证`, capability ? { reason_code: capability.reason_code } : undefined);
  const injected = deps.desktopProviders?.[app];
  if (injected) return injected;
  if (app === 'workbuddy_desktop') {
    if (!deps.workbuddy) throw new ApiError(503, 'PROVIDER_UNAVAILABLE', 'WorkBuddy provider 未装配');
    return deps.workbuddy;
  }
  throw new ApiError(503, 'PROVIDER_UNAVAILABLE', '该产品的桌面 provider 未装配');
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
  /** ACC-QUOTA-01：单实例缓存（60s TTL + 失败退避），每次服务装配只建一次 */
  const quotas = deps.quotas ?? createQuotaService();
  /** MINIMAX-PATH：客户端探测单实例缓存（60s TTL），每次装配只建一次 */
  const minimaxProbe = deps.minimaxClientProbe ?? createMinimaxClientProbe();

  // ---- ACC-QUOTA-01：账号页额度/余额聚合（逐来源独立结果） ----
  router.get('/managed-account-quotas', async (req, res) => {
    const workspace = z.string().uuid().safeParse(req.query.workspace_id ?? undefined);
    if (req.query.workspace_id !== undefined && !workspace.success) throw new ValidationError('workspace_id 不合法');
    const snapshot = await quotas.get();
    res.json({ ...snapshot, workspace_id: workspace.success ? workspace.data : null });
  });

  // ---- managed-accounts ----
  router.get('/managed-accounts', async (req, res) => {
    const app = managedAppParam.safeParse(req.query.app ?? undefined);
    if (req.query.app !== undefined && !app.success) throw new ValidationError('app 不合法');
    const filter = app.success ? app.data : undefined;
    const currentIdentity = deps.workbuddy ? await deps.workbuddy.getCurrentIdentity() : null;
    const rows = (db.prepare('SELECT id FROM managed_account ORDER BY created_at,id').all() as Array<{ id: string }>)
      .map(row => getManagedAccount(db, row.id)!);
    res.json(rows
      .filter(account => filter === undefined || account.app_id === filter)
      .map(account => ({ ...publicManagedAccount(account), is_current: currentIdentity ? account.identity_hash === currentIdentity.identity_hash : null })));
  });

  router.post('/managed-accounts/:app/capture-current', async (req, res) => {
    const parsed = managedAppParam.safeParse(req.params.app);
    if (!parsed.success) throw new ValidationError('app 不合法');
    const app = parsed.data;
    const body = parseBody(captureBodySchema, req.body);
    const provider = requireProvider(app, deps, 'capture');
    const account = await provider.captureCurrent({ display_name: body.display_name });
    res.json({ account: publicManagedAccount(account) });
  });

  // 切换：立即返回 operation id，执行结果经 GET /account-operations/:id 轮询（设计 §8）
  router.post('/managed-accounts/:id/switch', async (req, res) => {
    const account = getManagedAccount(db, req.params.id!);
    if (!account) throw new NotFoundError('账号不存在');
    const provider = requireProvider(account.app_id, deps, 'switch');
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
    if (!created.replayed) startCheckinBatchInBackground({ db, vault, provider }, created.result.id);
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
