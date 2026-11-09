/**
 * DEC-4：kb 决策命令组（设计 v3 §5.1 / §7 DEC-4）。
 *
 * 命令面：
 *   kb ask <issue-id> --question ... --option '<label>|<consequence>' ×≥2 ...
 *   kb decisions [--state grace|open|answered|withdrawn] [--issue <id>] [--stale] [--limit n]
 *   kb decision <id|前缀>            详情
 *   kb decision withdraw <id> --reason <text>
 *   kb answer <id> --option <ord|label> | --text <文本> [--revise --expected-revision n]
 *   kb ask-extend <id> --seconds 60 [--by <actor>] [--fence <n>]
 *   kb stop-check <issue-id>
 *
 * 退出码（与卡面/设计 v3 一致）：
 *   0 成功；answered / locked 都是正常结果，用 output/JSON 的 outcome 区分
 *   1 任务/决策不存在、服务不可达、其它服务错误
 *   2 409（非占用者 / 已有在途 / 限流 / 状态非进行中 / 已回答 / 撤回 / CAS 冲突 / 延长上限）/ 403（跨区延长）
 *   3 选项不足 / 重复 label / consequence 空 / 非法枚举 / 非法 grace / 非法 seconds / 决策 id 前缀不合法
 */
import { Command, CommanderError } from 'commander';
import { CliHttpError, request } from '../api.js';
import { loadClaimedFence } from '../claimStore.js';
import { describeError, errorJson } from '../errors.js';
import type { Ctx, Io } from '../io.js';
import { resolveIssueByRef } from '../issueRef.js';
import { matchCurrentWorkspace, matchWorkspace } from '../workspace.js';
import type { Workspace } from '@agentboard/shared';

/** 服务端详情/列表投影（DEC-1/3 定稿；shared 未收录，CLI 本地声明） */
export interface DecisionOptionDto {
  id: string; ord: number; label: string; consequence: string; is_default: number;
}
export interface DecisionAnswerDto {
  revision: number; option_id: string | null; answer_text: string | null;
  answered_by: string; source: string; created_at: number;
}
export interface DecisionDto {
  id: string; workspace_id: string; issue_id: string; question: string; context_md: string;
  trigger: string; state: 'grace' | 'open' | 'answered' | 'withdrawn'; created_by: string;
  grace_seconds: number; grace_until: number; locked_at: number | null;
  stop_requested_at: number | null; stop_ack_at: number | null;
  answer_revision: number; created_at: number; answered_at: number | null;
  withdrawn_at: number | null; withdrawn_by: string | null; withdrawn_reason: string | null;
  expires_at: number | null; on_expire: string;
  remaining_grace_seconds: number | null; waiting_seconds: number | null;
  options: DecisionOptionDto[]; answers: DecisionAnswerDto[];
}
export interface DecisionListItemDto extends Omit<DecisionDto, 'options' | 'answers' | 'context_md'> {
  issue_title: string; issue_status: string; option_count: number;
}
export interface StopCheckDto {
  issue_id: string; stop_requested: boolean; decision_id: string | null;
  reason: string | null; stop_requested_at: number | null;
}

const TRIGGERS = ['blocked', 'scope_change', 'irreversible', 'missing_input'];
const ON_EXPIRE = ['stay_locked', 'unlock_default'];
const EXIT3_CODES: ReadonlySet<string> = new Set(['ASK_TOO_FEW_OPTIONS', 'INVALID_GRACE', 'INVALID_SECONDS']);

/** 退出码 3 的客户端校验失败：先写错误（--json 走结构化体），再抛 CommanderError(3) */
function fail3(ctx: Ctx, message: string, code = 'INVALID_ARGUMENT', details?: unknown): never {
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify({ error: { code, message, ...(details === undefined ? {} : { details }) } })}\n`);
  } else {
    ctx.io.writeErr(`${message}\n`);
  }
  throw new CommanderError(3, 'agentboard.decision', '');
}

/** 服务端 400 的选项/宽限类错误也按退出码 3 口径 */
function rethrowDecisionError(ctx: Ctx, err: unknown): never {
  if (err instanceof CliHttpError && EXIT3_CODES.has(err.code)) {
    const described = describeError(err);
    if (ctx.json) ctx.io.write(`${errorJson(described)}\n`);
    else ctx.io.writeErr(`${described.message}\n`);
    throw new CommanderError(3, 'agentboard.decision', '');
  }
  throw err;
}

function parseGrace(ctx: Ctx, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 600) {
    fail3(ctx, `--grace 必须是 0–600 的整数秒（收到 ${JSON.stringify(raw)}）`, 'INVALID_GRACE');
  }
  return value;
}

function parseWait(ctx: Ctx, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    fail3(ctx, `--wait 必须是 ≥0 的整数秒（收到 ${JSON.stringify(raw)}）`, 'INVALID_ARGUMENT');
  }
  return value;
}

/** `--option '<label>|<consequence>'`：按第一个 `|` 切分；两者都非空、label 不重复、至少 2 个 */
export function parseOptions(ctx: Ctx, raw: string[], defaultLabel?: string) {
  if (raw.length < 2) {
    fail3(ctx, `至少需要 2 个 --option '<label>|<consequence>'（收到 ${raw.length} 个）`, 'ASK_TOO_FEW_OPTIONS');
  }
  const labels = new Set<string>();
  const options = raw.map((item) => {
    const index = item.indexOf('|');
    const label = index < 0 ? item.trim() : item.slice(0, index).trim();
    const consequence = index < 0 ? '' : item.slice(index + 1).trim();
    if (label === '' || consequence === '') {
      fail3(ctx, `--option 必须是 '<label>|<consequence>' 且两段非空：${JSON.stringify(item)}`, 'ASK_TOO_FEW_OPTIONS');
    }
    if (labels.has(label)) fail3(ctx, `--option label 重复：${label}`, 'ASK_TOO_FEW_OPTIONS');
    labels.add(label);
    return { label, consequence, ...(defaultLabel === label ? { is_default: true } : {}) };
  });
  if (defaultLabel !== undefined && !labels.has(defaultLabel)) {
    fail3(ctx, `--default 指向的 label 不在选项中：${defaultLabel}`, 'INVALID_ARGUMENT');
  }
  return options;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function secondsLeft(graceUntil: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((graceUntil - now) / 1000));
}

/** 轮询期间顺带续租（宽限内租约不能过期）；失败静默——提问者可能不是当前占用者 */
async function touchLease(ctx: Ctx, issueId: string): Promise<void> {
  const fence = loadClaimedFence(issueId);
  try {
    await request(ctx.base, 'POST', `/api/issues/${encodeURIComponent(issueId)}/heartbeat`, {
      agent_id: ctx.agentId,
      ...(fence === undefined ? {} : { fence }),
    });
  } catch {
    // 软失败：续租不是本命令的职责边界，失败不改变 ask 的结果
  }
}

function answerText(decision: DecisionDto): string | null {
  const answer = decision.answers.find((item) => item.revision === decision.answer_revision);
  if (!answer) return null;
  if (answer.answer_text !== null && answer.answer_text !== '') return `文本：${answer.answer_text}`;
  const option = decision.options.find((item) => item.id === answer.option_id);
  return option ? `${option.label}（${option.consequence}）` : `选项 id：${answer.option_id}`;
}

export interface AskOptions {
  question: string;
  option: string[];
  default?: string;
  context?: string;
  contextStdin?: boolean;
  trigger?: string;
  grace?: string;
  wait?: string;
  noWait?: boolean;
  checkpointFile?: string;
  checkpointStdin?: boolean;
  onExpire?: string;
  session?: string;
  turn?: string;
}

export async function ask(ctx: Ctx, id: string, opts: AskOptions): Promise<void> {
  const issue = await resolveIssueByRef(ctx, id);
  if (opts.question === undefined || opts.question.trim() === '') {
    fail3(ctx, '缺少 --question', 'INVALID_ARGUMENT');
  }
  const options = parseOptions(ctx, opts.option ?? [], opts.default);
  const graceSeconds = parseGrace(ctx, opts.grace);
  const waitSeconds = parseWait(ctx, opts.wait);
  if (opts.trigger !== undefined && !TRIGGERS.includes(opts.trigger)) {
    fail3(ctx, `--trigger 必须是：${TRIGGERS.join(' / ')}`, 'INVALID_ARGUMENT');
  }
  if (opts.onExpire !== undefined && !ON_EXPIRE.includes(opts.onExpire)) {
    fail3(ctx, `--on-expire 必须是：${ON_EXPIRE.join(' / ')}`, 'INVALID_ARGUMENT');
  }
  let contextMd = opts.context;
  if (opts.contextStdin === true) contextMd = await ctx.io.readStdin();
  let checkpoint: unknown;
  if (opts.checkpointStdin === true || opts.checkpointFile !== undefined) {
    const raw = opts.checkpointStdin === true
      ? await ctx.io.readStdin()
      : await (await import('node:fs/promises')).readFile(opts.checkpointFile!, 'utf8');
    try {
      checkpoint = JSON.parse(raw);
    } catch {
      fail3(ctx, '--checkpoint-file/--checkpoint-stdin 内容必须是合法 JSON', 'INVALID_ARGUMENT');
    }
  }
  const fence = loadClaimedFence(issue.id);
  const body = {
    agent_id: ctx.agentId,
    question: opts.question,
    options,
    ...(contextMd === undefined || contextMd === '' ? {} : { context_md: contextMd }),
    ...(opts.trigger === undefined ? {} : { trigger: opts.trigger }),
    ...(graceSeconds === undefined ? {} : { grace_seconds: graceSeconds }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
    ...(opts.onExpire === undefined ? {} : { on_expire: opts.onExpire }),
    ...(opts.session === undefined ? {} : { session_id: opts.session }),
    ...(opts.turn === undefined ? {} : { turn_id: opts.turn }),
    ...(fence === undefined ? {} : { fence }),
  };
  let created: DecisionDto;
  try {
    const response = await request<{ decision: DecisionDto }>(
      ctx.base, 'POST', `/api/issues/${encodeURIComponent(issue.id)}/ask`, body,
    );
    created = response.decision;
  } catch (err) {
    rethrowDecisionError(ctx, err);
  }
  const effectiveWait = opts.noWait === true ? 0 : waitSeconds ?? created.grace_seconds;
  // grace=0：服务端已在事务内落锁，不轮询、不等待、忽略 --wait
  if (created.state === 'open') {
    emitAskResult(ctx, created, 'locked', null);
    return;
  }
  if (effectiveWait <= 0) {
    emitAskResult(ctx, created, 'pending', null);
    return;
  }
  const deadline = Date.now() + effectiveWait * 1000;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // 到点补一次读取：服务端 ticker（DEC-9）可能已落锁并写入答案
      const decision = await fetchDecision(ctx, created.id);
      if (decision.state === 'answered') return emitAskResult(ctx, decision, 'answered', answerText(decision));
      emitAskResult(ctx, decision, 'locked', null, decision.state === 'grace');
      return;
    }
    await sleep(Math.min(2000, remaining));
    await touchLease(ctx, issue.id);
    const decision = await fetchDecision(ctx, created.id);
    if (decision.state === 'answered') return emitAskResult(ctx, decision, 'answered', answerText(decision));
    if (decision.state === 'withdrawn') return emitAskResult(ctx, decision, 'withdrawn', null);
    if (decision.state === 'open') return emitAskResult(ctx, decision, 'locked', null);
  }
}

/** pending / locked / answered / withdrawn 都是正常退出（0）；grace 到点未落锁时 stderr 提示真实状态 */
function emitAskResult(
  ctx: Ctx,
  decision: DecisionDto,
  outcome: 'pending' | 'locked' | 'answered' | 'withdrawn',
  answer: string | null,
  serverStillGrace = false,
): void {
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify({
      outcome,
      decision: { id: decision.id, state: decision.state, grace_until: decision.grace_until, ...(answer === null ? {} : { answer }) },
    }, null, 2)}\n`);
    return;
  }
  if (outcome === 'answered') {
    ctx.io.write(`ANSWERED decision=${decision.id}\n${answer ?? '（无答案内容）'}\n`);
    return;
  }
  if (outcome === 'withdrawn') {
    ctx.io.write(`WITHDRAWN decision=${decision.id}\n`);
    return;
  }
  if (outcome === 'pending') {
    ctx.io.write(`PENDING decision=${decision.id} grace_until=${decision.grace_until}（剩余 ${secondsLeft(decision.grace_until)} 秒）\n`);
    return;
  }
  ctx.io.write(`LOCKED decision=${decision.id}\n`);
  if (serverStillGrace) {
    ctx.io.writeErr('注意：宽限已到但服务端尚未落锁（DEC-9 ticker 未接线时会出现），请用 kb decisions 复核\n');
  }
}

async function fetchDecision(ctx: Ctx, id: string): Promise<DecisionDto> {
  const response = await request<{ decision: DecisionDto }>(ctx.base, 'GET', `/api/decisions/${encodeURIComponent(id)}`);
  return response.decision;
}

/** CR2-10：前缀解析需要「全部决策」，服务端无游标，只能用一个足够大的上限一次性读回 */
const DECISION_PREFIX_SCAN_LIMIT = 100_000;

/** ≥8 位前缀只在本命令组解析：一次批量拉全部工作区的在途决策再按 id 前缀匹配（不再逐区串行扇出） */
async function resolveDecisionRef(ctx: Ctx, ref: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return ref;
  if (ref.length < 8) throw new Error('决策 id 前缀至少 8 位（或传完整 UUID）');
  const spaces = await request<Workspace[]>(ctx.base, 'GET', '/api/workspaces');
  if (spaces.length === 0) throw new Error(`决策不存在：${ref}`);
  // CR2-10：用 workspace_ids 一次批量读（不再逐区串行）。服务端没有游标/offset，且 repo 在缺省 limit 时只回 200 条，
  // 所以必须显式传一个大上限，否则历史决策一多就会假阴性「决策不存在」。
  const list = await request<{ decisions: DecisionListItemDto[] }>(
    ctx.base,
    'GET',
    `/api/decisions?workspace_ids=${spaces.map(space => encodeURIComponent(space.id)).join(',')}&limit=${DECISION_PREFIX_SCAN_LIMIT}`,
  );
  const matches = new Set<string>();
  for (const item of list.decisions) if (item.id.startsWith(ref.toLowerCase())) matches.add(item.id);
  if (matches.size === 0) throw new Error(`决策不存在：${ref}`);
  if (matches.size > 1) throw new Error(`决策前缀命中多条：${[...matches].join(' / ')}`);
  return [...matches][0]!;
}

export interface DecisionsArgs {
  workspace?: string;
  issue?: string;
  state?: string;
  stale?: boolean;
  limit?: string;
}

export async function decisions(ctx: Ctx, args: DecisionsArgs): Promise<void> {
  if (args.state !== undefined && !['grace', 'open', 'answered', 'withdrawn'].includes(args.state)) {
    fail3(ctx, '--state 必须是 grace / open / answered / withdrawn', 'INVALID_ARGUMENT');
  }
  const limit = args.limit === undefined ? undefined : Number(args.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    fail3(ctx, '--limit 必须是 ≥1 的整数', 'INVALID_ARGUMENT');
  }
  let workspaceId: string;
  let issueId: string | undefined;
  if (args.issue !== undefined) {
    const issue = await resolveIssueByRef(ctx, args.issue);
    workspaceId = issue.workspace_id;
    issueId = issue.id;
  } else {
    const spaces = await request<Workspace[]>(ctx.base, 'GET', '/api/workspaces');
    workspaceId = args.workspace === undefined ? matchCurrentWorkspace(spaces).id : matchWorkspace(spaces, args.workspace).id;
  }
  const query = new URLSearchParams({ workspace_id: workspaceId });
  if (issueId !== undefined) query.set('issue_id', issueId);
  if (args.state !== undefined) query.set('state', args.state);
  if (args.stale === true) query.set('stale', 'true');
  if (limit !== undefined) query.set('limit', String(limit));
  const response = await request<{ decisions: DecisionListItemDto[]; counts: unknown }>(
    ctx.base, 'GET', `/api/decisions?${query.toString()}`,
  );
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }
  if (response.decisions.length === 0) {
    ctx.io.write('（无决策）\n');
    return;
  }
  for (const item of response.decisions) {
    const remaining = item.remaining_grace_seconds === null ? '-' : `${item.remaining_grace_seconds}s`;
    const waiting = item.waiting_seconds === null ? '-' : `${item.waiting_seconds}s`;
    ctx.io.write(
      `${item.id} [${item.state}] ${item.issue_title}（${item.issue_status}） 剩余宽限=${remaining} 已等待=${waiting} 选项=${item.option_count} 提问者=${item.created_by}\n`,
    );
  }
}

export async function showDecision(ctx: Ctx, ref: string): Promise<void> {
  const id = await resolveDecisionRef(ctx, ref);
  const decision = await fetchDecision(ctx, id);
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify({ decision }, null, 2)}\n`);
    return;
  }
  ctx.io.write(`id: ${decision.id}\n任务: ${decision.issue_id}\n状态: ${decision.state}\n问题: ${decision.question}\n`);
  if (decision.context_md !== '') ctx.io.write(`上下文: ${decision.context_md}\n`);
  ctx.io.write(`宽限: ${decision.grace_seconds}s`);
  if (decision.state === 'grace') ctx.io.write(`（剩余 ${secondsLeft(decision.grace_until)}s）`);
  ctx.io.write(`\n提问者: ${decision.created_by}\n`);
  for (const option of decision.options) {
    ctx.io.write(`  [${option.ord}] ${option.label} → ${option.consequence}${option.is_default === 1 ? '（默认）' : ''}\n`);
  }
  if (decision.answer_revision > 0) {
    ctx.io.write(`回答（revision ${decision.answer_revision}）：${answerText(decision) ?? '（无）'}\n`);
  }
  if (decision.state === 'withdrawn') ctx.io.write(`撤回：${decision.withdrawn_by ?? '-'} / ${decision.withdrawn_reason ?? '-'}\n`);
}

export interface AnswerArgs {
  option?: string;
  text?: string;
  revise?: boolean;
  expectedRevision?: string;
}

export async function answer(ctx: Ctx, ref: string, args: AnswerArgs): Promise<void> {
  if (args.option === undefined && args.text === undefined) {
    fail3(ctx, '需要 --option <序号|label> 或 --text <文本>', 'INVALID_ARGUMENT');
  }
  if (args.option !== undefined && args.text !== undefined) {
    fail3(ctx, '--option 与 --text 不能同时使用', 'INVALID_ARGUMENT');
  }
  const expected = args.expectedRevision === undefined ? undefined : Number(args.expectedRevision);
  if (expected !== undefined && (!Number.isInteger(expected) || expected < 0)) {
    fail3(ctx, '--expected-revision 必须是 ≥0 的整数', 'INVALID_ARGUMENT');
  }
  if (args.revise === true && expected === undefined) {
    fail3(ctx, '--revise 必须同时给 --expected-revision', 'INVALID_ARGUMENT');
  }
  const id = await resolveDecisionRef(ctx, ref);
  const decision = await fetchDecision(ctx, id);
  const body: Record<string, unknown> = { answered_by: ctx.agentId, source: 'cli' };
  if (args.option !== undefined) {
    const ordinal = Number(args.option);
    if (Number.isInteger(ordinal)) body.option_ord = ordinal;
    else {
      const option = decision.options.find((item) => item.label === args.option);
      if (!option) fail3(ctx, `决策里没有 label 为 ${JSON.stringify(args.option)} 的选项`, 'INVALID_ARGUMENT');
      body.option_id = option.id;
    }
  }
  if (args.text !== undefined) body.answer_text = args.text;
  if (expected !== undefined) body.expected_revision = expected;
  const response = await request<{ decision: DecisionDto }>(
    ctx.base, 'POST', `/api/decisions/${encodeURIComponent(id)}/answer`, body,
  );
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify({ decision: response.decision }, null, 2)}\n`);
    return;
  }
  ctx.io.write(`ANSWERED decision=${id} revision=${response.decision.answer_revision}\n${answerText(response.decision) ?? ''}\n`);
}

export async function withdraw(ctx: Ctx, ref: string, reason: string, actor?: string): Promise<void> {
  if (reason.trim() === '') fail3(ctx, '--reason 必填', 'INVALID_ARGUMENT');
  const id = await resolveDecisionRef(ctx, ref);
  const response = await request<{ decision: DecisionDto }>(
    ctx.base, 'POST', `/api/decisions/${encodeURIComponent(id)}/withdraw`, {
      reason,
      ...(actor === undefined ? {} : { by: actor }),
    },
  );
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify({ decision: response.decision }, null, 2)}\n`);
    return;
  }
  ctx.io.write(`WITHDRAWN decision=${id}\n`);
}

export interface AskExtendArgs {
  seconds?: string;
  by?: string;
  fence?: string;
}

interface ExtendDecisionResponse {
  decision_id: string;
  state: string;
  grace_until: number;
  remaining_grace_seconds: number;
  extended_seconds: number;
  extension_count: number;
  max_extend_seconds: number;
}

/**
 * DEC-V4-API-EXTEND：延长宽限。
 * 退出码：0 成功；2 状态/上限（409）/跨区（403）；3 参数或 id 前缀非法；1 其它。
 */
export async function askExtend(ctx: Ctx, ref: string, args: AskExtendArgs): Promise<void> {
  const rawSeconds = args.seconds ?? '60';
  const seconds = Number(rawSeconds);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) {
    fail3(ctx, `--seconds 必须是 1–300 的整数（收到 ${JSON.stringify(rawSeconds)}）`, 'INVALID_SECONDS');
  }
  const fence = args.fence === undefined ? undefined : Number(args.fence);
  if (fence !== undefined && (!Number.isInteger(fence) || fence < 0)) {
    fail3(ctx, '--fence 必须是 ≥0 的整数', 'INVALID_ARGUMENT');
  }
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
  if (!isUuid && ref.length < 8) {
    fail3(ctx, '决策 id 前缀至少 8 位（或传完整 UUID）', 'INVALID_ARGUMENT');
  }
  let id: string;
  try {
    id = await resolveDecisionRef(ctx, ref);
  } catch (err) {
    fail3(ctx, err instanceof Error ? err.message : String(err), 'DECISION_NOT_FOUND');
  }
  // 跨区守卫：显式带当前工作区；cwd 不绑定工作区时省略（由服务端按无 workspace_id 处理）
  let workspaceId: string | undefined;
  try {
    const spaces = await request<Workspace[]>(ctx.base, 'GET', '/api/workspaces');
    workspaceId = matchCurrentWorkspace(spaces).id;
  } catch {
    workspaceId = undefined;
  }
  const body = {
    seconds,
    by: args.by ?? ctx.agentId,
    ...(fence === undefined ? {} : { fence }),
    ...(workspaceId === undefined ? {} : { workspace_id: workspaceId }),
  };
  let result: ExtendDecisionResponse;
  try {
    result = await request<ExtendDecisionResponse>(
      ctx.base, 'POST', `/api/decisions/${encodeURIComponent(id)}/extend`, body,
    );
  } catch (err) {
    if (err instanceof CliHttpError && err.status === 403) {
      const described = describeError(err);
      if (ctx.json) ctx.io.write(`${JSON.stringify({ error: { code: err.code, message: described.message } })}\n`);
      else ctx.io.writeErr(`${err.code}: ${described.message}\n`);
      throw new CommanderError(2, 'agentboard.decision', '');
    }
    rethrowDecisionError(ctx, err);
  }
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  ctx.io.write(
    `EXTENDED decision=${result.decision_id} grace_until=${result.grace_until}` +
      `（剩余 ${result.remaining_grace_seconds} 秒；累计已延长 ${result.extended_seconds}/${result.max_extend_seconds} 秒，第 ${result.extension_count} 次）\n`,
  );
}

export async function stopCheck(ctx: Ctx, id: string): Promise<void> {
  const issue = await resolveIssueByRef(ctx, id);
  const stop = await request<StopCheckDto>(ctx.base, 'GET', `/api/issues/${encodeURIComponent(issue.id)}/stop`);
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify({
      stop_requested: stop.stop_requested,
      decision_id: stop.decision_id,
      reason: stop.reason,
    }, null, 2)}\n`);
    return;
  }
  ctx.io.write(
    stop.stop_requested
      ? `STOP_REQUESTED decision=${stop.decision_id} reason=${stop.reason ?? '-'}\n下一步：保存断点（stash/diff/next_step），不提交，退出并把卡交回人类\n`
      : 'NOT_STOPPED\n',
  );
}

/** index.ts 注册入口：决定命令组独占 index.ts 命令注册区（DEC-4 同文件串行） */
export function registerDecisionCommands(program: Command, io: Io, makeCtx: (program: Command, io: Io) => Ctx): void {
  program
    .command('ask')
    .description('提问并等待一轮宽限（默认 180 秒，2 秒短轮询）；--no-wait 异步、--grace 0 立即落锁')
    .argument('<issue-id>', '任务 id：完整 UUID，或 ≥8 位唯一前缀')
    .requiredOption('--question <text>', '问题（人话，非空）')
    .option('--option <label|consequence>', '选项，格式 "<label>|<consequence>"，至少重复 2 次', (value: string, previous: string[] = []) => [...previous, value], [])
    .option('--default <label>', '默认选项 label（--option 里必须存在；on_expire=unlock_default 时采用）')
    .option('--context <text>', '背景/已知信息')
    .option('--context-stdin', '从标准输入读取背景/已知信息')
    .option('--trigger <枚举>', `触发原因：${TRIGGERS.join(' / ')}`)
    .option('--grace <seconds>', '覆盖工作区默认宽限（0–600 整数秒；0=立即落锁不等待）')
    .option('--wait <seconds>', '同步等待秒数（默认=宽限秒数；0 等同 --no-wait）')
    .option('--no-wait', '不等待，创建后立即返回 PENDING')
    .option('--checkpoint-file <path>', '断点 JSON 文件（stash SHA / diff 摘要 / next_step / 后台 PID）')
    .option('--checkpoint-stdin', '从标准输入读取断点 JSON')
    .option('--on-expire <枚举>', `到期处置：${ON_EXPIRE.join(' / ')}（默认 stay_locked）`)
    .option('--session <id>', '关联会话 id（可选）')
    .option('--turn <id>', '关联轮次 id（可选）')
    .addHelpText('after', `
示例：
  kb ask <issue> --question 'A 还是 B？' --option 'A|做 A' --option 'B|做 B'
  kb ask <issue> --question '…' --option 'A|…' --option 'B|…' --grace 0     # 立即落锁
  kb ask <issue> --question '…' --option 'A|…' --option 'B|…' --no-wait    # 异步
退出码：0 answered/locked/pending 都成功（用输出或 --json 的 outcome 区分）；2 占用/在途/限流/状态；3 选项或 grace 非法；1 其它
`)
    .action(async (id: string, opts: AskOptions) => ask(makeCtx(program, io), id, opts));

  program
    .command('decisions')
    .description('列待决策（默认当前工作区；--state/--issue/--stale/--limit）')
    .option('--workspace <id|名>', '工作空间 id 或名称（缺省按 cwd 解析）')
    .option('--issue <issue-id>', '只看某张卡（自动解析工作区）')
    .option('--state <state>', 'grace / open / answered / withdrawn')
    .option('--stale', '只看超过 72 小时未处理的 open 决策')
    .option('--limit <n>', '条数上限（≥1）')
    .action(async (opts: DecisionsArgs) => decisions(makeCtx(program, io), opts));

  const decision = program.command('decision').description('决策详情 / 撤回（id 支持 ≥8 位前缀）');
  decision
    .command('show')
    .argument('<id>', '决策 id 或 ≥8 位前缀')
    .action(async (id: string) => showDecision(makeCtx(program, io), id));
  decision
    .command('withdraw')
    .argument('<id>', '决策 id 或 ≥8 位前缀')
    .requiredOption('--reason <text>', '撤回原因（必填）')
    .option('--actor <who>', '操作者（默认当前 agent 身份）')
    .action(async (id: string, opts: { reason: string; actor?: string }) =>
      withdraw(makeCtx(program, io), id, opts.reason, opts.actor));

  program
    .command('answer')
    .description('回答决策（--option 序号|label 或 --text；--revise 需 --expected-revision）')
    .argument('<id>', '决策 id 或 ≥8 位前缀')
    .option('--option <ord|label>', '选项序号（从 1 开始）或 label')
    .option('--text <text>', '自由文本答案（与 --option 互斥）')
    .option('--revise', '修订已有回答（必须同时给 --expected-revision）')
    .option('--expected-revision <n>', '修订时的期望当前 revision（CAS）')
    .action(async (id: string, opts: AnswerArgs) => answer(makeCtx(program, io), id, opts));

  program
    .command('ask-extend')
    .description('延长宽限（仅宽限中；1–300 秒/次，原宽限+累计延长 ≤600 秒）')
    .argument('<decision-id>', '决策 id：完整 UUID 或 ≥8 位前缀')
    .option('--seconds <n>', '延长秒数（1–300，默认 60）', '60')
    .option('--by <actor>', '操作者（默认当前 agent 身份）')
    .option('--fence <n>', '占用代次（传了就必须等于当前 claim_fence）')
    .addHelpText('after', `
示例：
  kb ask-extend <decision> --seconds 60
  kb ask-extend <decision> --seconds 120 --by user
退出码：0 成功；2 非宽限中/超上限/跨区；3 参数或 id 前缀非法；1 其它
`)
    .action(async (id: string, opts: AskExtendArgs) => askExtend(makeCtx(program, io), id, opts));

  program
    .command('stop-check')
    .description('检查停止信号（协作式停止：检查点在步骤间/写文件前/提交前）')
    .argument('<issue-id>', '任务 id：完整 UUID，或 ≥8 位唯一前缀')
    .action(async (id: string) => stopCheck(makeCtx(program, io), id));
}
