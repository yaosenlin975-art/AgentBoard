/**
 * SMART-CREATE：智能创建草稿（设计 §4）。
 *
 * - **不落库**：只产出可编辑草稿（title / description / labels / warnings），落库由用户确认后走既有 `POST /api/issues`。
 * - **一次性调用**：复用 `packages/adapters` 的 `runTurn`（不建常驻会话、不占 claim 槽位），默认超时 120s。
 * - **严格 JSON schema**：不合法重试 1 次；仍不合法 → 可解释错误（422），不抛 500。
 * - **不补未提的要求**：模型返回的 `background/requirements/acceptance` 若为空 → 渲染成「未提供」，
 *   由结构保证（不是靠 prompt 自觉）；标签只保留工作区里已存在的值，模型自造的一律丢弃并进 warnings。
 * - **审计**：只记 adapter / 耗时 / 成败 / warning 数 / 错误码，**不记需求原文**（可能含敏感信息）。
 */
import { z } from 'zod';
import type { Db } from '../db/connection.js';
import { ApiError } from '../errors.js';

// SMART-CREATE-CB：这里是草稿可用适配器的**唯一来源**；api/schemas.ts 的 zod 枚举从它派生（不再各写一份）。
// 为什么不直接从 ADAPTERS 注册表推导：注册表会随新增适配器自动变大，而草稿要求「一次性 runTurn + 严格 JSON」，
// 新适配器未必满足；改为「显式清单 + 防漂移断言」（测试里断言每个 id 都在注册表与 /api/clis 中）。
export const DRAFT_ADAPTERS = ['dsh', 'codex', 'opencode', 'codebuddy'] as const;
export type DraftAdapterId = (typeof DRAFT_ADAPTERS)[number];
export const DRAFT_TIMEOUT_MS = 120_000;
/** 生成失败后最多再试 1 次（设计 §4「不合法重试 1 次」） */
const MAX_ATTEMPTS = 2;

export interface DraftInput {
  workspace_id: string;
  requirement: string;
  adapter: DraftAdapterId;
  priority?: '低' | '中' | '高';
}

export interface DraftResult {
  /** MULTI-DRAFT：本次生成的草稿卡（≥1 张；1 条需求 = 1 张；顶层字段镜像 cards[0]，兼容旧读取方式） */
  cards: DraftCard[];
  title: string;
  description: string;
  labels: string[];
  warnings: string[];
  /** 草稿会话 id（= workspace_id + adapter 维度，同一维度连续生成复用同一个） */
  session_id: string;
  /** 该会话的第几轮生成（首次为 1） */
  session_turn: number;
  /** 本次是否为复用已有会话（false = 新建） */
  session_reused: boolean;
}

/** 会话上限：超过后按 lastUsedAt 淘汰最旧的（防泄漏） */
export const MAX_DRAFT_SESSIONS = 32;
/** 单个会话最多带入多少条历史需求作为上下文 */
const MAX_CONTEXT_TURNS = 5;

interface DraftSession {
  id: string;
  key: string;
  workspace_id: string;
  adapter: DraftAdapterId;
  turns: number;
  createdAt: number;
  lastUsedAt: number;
  /** 成功生成的历次需求（失败不入，避免污染上下文） */
  requirements: string[];
}

export function draftSessionKey(workspaceId: string, adapter: DraftAdapterId): string {
  return `${workspaceId}::${adapter}`;
}

/** 模型必须返回的结构；`null` 表示「用户没提这一段」，不是「空字符串」 */
const draftModelSchema = z.object({
  title: z.string().trim().min(1).max(200),
  background: z.string().nullable(),
  requirements: z.string().nullable(),
  acceptance: z.string().nullable(),
  labels: z.array(z.string()).max(20),
  warnings: z.array(z.string()).max(20),
}).strict();

type DraftModelOutput = z.infer<typeof draftModelSchema>;

/** 一次生成最多拆多少张卡（防跑飞；超出保留前 N 条并给 warning） */
export const MAX_DRAFT_CARDS = 10;

/** 批量模式：模型必须返回与用户条数一一对应的卡片数组（不得合并、不得新增） */
const draftCardsSchema = z.object({
  cards: z.array(draftModelSchema).min(1).max(MAX_DRAFT_CARDS),
}).strict();

/** MULTI-DRAFT：单张草稿卡（1 条需求 1 张卡） */
export interface DraftCard {
  /** 前端本地标识（稳定、不落库） */
  local_id: string;
  title: string;
  description: string;
  labels: string[];
  warnings: string[];
}

/**
 * MULTI-DRAFT：把用户需求原文按**原话**分条（确定性，不做任何推断）。
 *
 * 规则顺序：
 * 1. 归一化换行；
 * 2. 命中列表标记（`1.` `1、` `1)` `-` `*` `•`）→ 每条一卡，缩进/非标记行并入当前条，空行结束当前条；
 * 3. 无标记但含 `；`/`;` 且分段 ≥2 → 按分号切；
 * 4. 否则按行切。
 *
 * 只做「切分」：不合并、不改写、不去重语义（完全相同的重复文本只保留一份）。
 */
export function splitRequirementItems(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const marker = /^\s*(?:(\d+)[.、)]|[-*•])\s+(.*)$/;
  const hasMarker = lines.some((line) => marker.test(line));
  const items: string[] = [];
  const push = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed !== '') items.push(trimmed);
  };

  if (hasMarker) {
    let current: string[] = [];
    const flush = (): void => {
      if (current.length > 0) push(current.join(' '));
      current = [];
    };
    for (const line of lines) {
      const matched = marker.exec(line);
      if (matched !== null) {
        flush();
        current.push(matched[2] ?? '');
      } else if (line.trim() === '') {
        flush();
      } else if (current.length > 0) {
        current.push(line.trim());
      } else {
        push(line);
      }
    }
    flush();
  } else if (/[；;]/.test(normalized) && normalized.split(/[；;]/).filter((part) => part.trim() !== '').length >= 2) {
    for (const part of normalized.split(/[；;]/)) push(part);
  } else {
    for (const line of lines) push(line);
  }

  const unique: string[] = [];
  for (const item of items) if (!unique.includes(item)) unique.push(item);
  return unique;
}

/** 未提供段落占位（断言用固定文案） */
export const NOT_PROVIDED = '未提供';

/** 把模型输出渲染成三段式 description：缺哪段写「未提供」，绝不编造 */
export function renderDraftDescription(output: DraftModelOutput): string {
  const section = (title: string, body: string | null): string => {
    const text = (body ?? '').trim();
    return `## ${title}\n${text === '' ? NOT_PROVIDED : text}`;
  };
  return [
    section('背景', output.background),
    section('要求', output.requirements),
    section('验收', output.acceptance),
  ].join('\n\n');
}

/** 从模型自由文本里抠出第一个 JSON 对象（容忍 ```json 围栏与前后废话） */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('输出里没有 JSON 对象');
  return JSON.parse(body.slice(start, end + 1));
}

/** 拼提示词：只复述原意，禁止补未提到的内容 */
export function buildDraftPrompt(requirement: string, existingLabels: readonly string[]): string {
  const labels = existingLabels.length > 0 ? existingLabels.join('、') : '（无）';
  return [
    '你是任务看板的任务草稿生成器。根据用户给出的需求原意，产出一份结构化任务草稿。',
    '',
    '硬性规则：',
    '1. 只输出一个 JSON 对象，不要任何解释文字；字段固定为：',
    '   {"title": string, "background": string|null, "requirements": string|null, "acceptance": string|null, "labels": string[], "warnings": string[]}',
    '2. 用户没有提到的段落一律给 null，**不要补充需求、不要推断验收条件、不要编造负责人或优先级**。',
    '3. title 用一句话概括需求（≤60 字）。',
    `4. labels 只能从这些已有标签里选：[${labels}]；没有合适的就返回空数组。`,
    '5. warnings 只写「需求本身存在歧义或缺口」的提示，不要写建议方案。',
    '',
    '需求原文（只作参考，不要复述整段）：',
    '"""',
    requirement.trim(),
    '"""',
  ].join('\n');
}

/** MULTI-DRAFT：多需求批量提示词。条数必须与用户条目一致，禁止合并/新增 */
export function buildMultiDraftPrompt(items: readonly string[], existingLabels: readonly string[]): string {
  const labels = existingLabels.length > 0 ? existingLabels.join('、') : '（无）';
  return [
    '你是任务看板的任务草稿生成器。用户这次给了多条彼此独立的需求，请**每条需求各产出一张卡片**。',
    '',
    '硬性规则：',
    '1. 只输出一个 JSON 对象，不要任何解释文字；结构为：',
    '   {"cards": [{"title": string, "background": string|null, "requirements": string|null, "acceptance": string|null, "labels": string[], "warnings": string[]}]}',
    `2. cards 必须**恰好 ${items.length} 张**，顺序与下面条目一一对应；不得把多条合并成一张，也不得凭空增加卡片。`,
    '3. 每张卡只写该条目提到的内容；用户没提到的段落一律给 null，不要补需求、不要推断验收条件、不要编造负责人或优先级。',
    '4. title 用一句话概括该条目（≤60 字）。',
    `5. labels 只能从这些已有标签里选：[${labels}]；没有合适的就返回空数组。`,
    '6. warnings 只写「该条目本身存在歧义或缺口」的提示，不要写建议方案。',
    '',
    '需求条目（按顺序，一条一卡）：',
    ...items.map((item, index) => `${index + 1}. """${item.trim()}"""`),
  ].join('\n');
}

/** 模型输出单卡的结构（prompt 用），便于把解析结果映射成 DraftCard */
function toCard(output: DraftModelOutput, existingLabels: readonly string[], index: number): DraftCard {
  const invented = output.labels.filter((label) => !existingLabels.includes(label));
  const labels = output.labels.filter((label) => existingLabels.includes(label));
  const warnings = [...output.warnings];
  if (invented.length > 0) warnings.push(`已忽略模型自造的标签：${invented.join('、')}（只允许使用工作区已有标签）`);
  return {
    local_id: `c${index + 1}`,
    title: output.title,
    description: renderDraftDescription(output),
    labels,
    warnings,
  };
}

/**
 * MULTI-DRAFT 兜底：模型没按条拆分（条数不符 / JSON 不合法）时，用**原文**逐条生成卡。
 * 不编造内容：background/acceptance 给 null（渲染为「未提供」），requirements 就是该条原文。
 */
export function fallbackCards(items: readonly string[]): DraftCard[] {
  return items.map((item, index) => {
    const firstLine = item.split('\n')[0]!.trim();
    const title = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
    return {
      local_id: `c${index + 1}`,
      title,
      description: renderDraftDescription({ title, background: null, requirements: item.trim(), acceptance: null, labels: [], warnings: [] }),
      labels: [],
      warnings: ['模型未按条拆分，已按需求原文逐条生成（内容未做改写）'],
    };
  });
}

/** 一次适配器调用的抽象：生产用 runTurn，测试注入 fake */
export type DraftRunner = (args: { adapter: DraftAdapterId; prompt: string; cwd: string; signal: AbortSignal }) => Promise<string>;

export interface DraftServiceDeps {
  db: Db;
  /**
   * 适配器可用性探测（adapter.detect）。不可用时直接 503 ADAPTER_UNAVAILABLE 并附原因，
   * 不再等到 runTurn 抛错再包成 502（DSH-ADAPTER-BUG：shim 坏掉时曾把 loader 报错当版本回传）。
   */
  detectAdapter?(adapter: DraftAdapterId): Promise<{ installed: boolean; version: string | null; message?: string }>;
  /** 拉起适配器并收集文本输出（一次性） */
  run: DraftRunner;
  /** 工作区已有标签（用于约束 labels） */
  existingLabels(workspaceId: string): string[];
  /** 工作区路径（作为一次性调用的 cwd） */
  workspacePath(workspaceId: string): string;
  timeoutMs?: number;
  now?: () => number;
}

export interface DraftService {
  generate(input: DraftInput): Promise<DraftResult & { warnings: string[] }>;
}

/** 审计：只记结构性字段，不记需求原文 */
function audit(db: Db, row: {
  workspace_id: string; adapter: string; duration_ms: number; ok: number; warning_count: number; error_code: string | null; created_at: number;
}): void {
  db.prepare(`INSERT INTO issue_draft_audit
    (id, workspace_id, adapter, duration_ms, ok, warning_count, error_code, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    `draft-${row.created_at}-${Math.random().toString(36).slice(2, 10)}`,
    row.workspace_id, row.adapter, row.duration_ms, row.ok, row.warning_count, row.error_code, row.created_at,
  );
}

/**
 * 草稿会话注册表（进程内）：key = `${workspace_id}::${adapter}`。
 *
 * 为什么不直接复用 agent 的常驻会话：本路径的 `run` 是一次性 runTurn（不建 session 行、不占 claim 槽位），
 * 适配器侧没有 resume 句柄；因此「会话」实现在草稿层——同一 key 连续生成复用同一个会话 id，
 * 并把该会话此前**成功**的需求作为只读上下文拼进 prompt（多轮追加需求能延续）。
 * 换 workspace 或换 adapter → key 不同 → 新会话；旧会话按 lastUsedAt 淘汰（MAX_DRAFT_SESSIONS）。
 * 失败（502/422/504/503）不写入 requirements，因此不会把半截需求留进上下文。
 */
const sessions = new Map<string, DraftSession>();
let sessionSeq = 0;

function evictIfNeeded(): void {
  if (sessions.size <= MAX_DRAFT_SESSIONS) return;
  const sorted = [...sessions.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  while (sessions.size > MAX_DRAFT_SESSIONS && sorted.length > 0) {
    const victim = sorted.shift();
    if (victim !== undefined) sessions.delete(victim.key);
  }
}

/** 取（或新建）会话；返回是否复用 */
export function acquireDraftSession(workspaceId: string, adapter: DraftAdapterId, now: number): { session: DraftSession; reused: boolean } {
  const key = draftSessionKey(workspaceId, adapter);
  const existing = sessions.get(key);
  if (existing !== undefined) {
    existing.lastUsedAt = now;
    return { session: existing, reused: true };
  }
  sessionSeq += 1;
  const created: DraftSession = {
    id: `draft-session-${now}-${sessionSeq}`,
    key,
    workspace_id: workspaceId,
    adapter,
    turns: 0,
    createdAt: now,
    lastUsedAt: now,
    requirements: [],
  };
  sessions.set(key, created);
  evictIfNeeded();
  return { session: created, reused: false };
}

/** 成功一轮：轮次 +1 并记录需求（供下一轮上下文） */
export function recordDraftTurn(session: DraftSession, requirement: string, now: number): void {
  session.turns += 1;
  session.lastUsedAt = now;
  session.requirements.push(requirement);
  if (session.requirements.length > MAX_CONTEXT_TURNS) session.requirements.splice(0, session.requirements.length - MAX_CONTEXT_TURNS);
}

/** 测试/诊断用：当前会话快照与清空 */
export function draftSessionSnapshot(): Array<{ id: string; key: string; turns: number }> {
  return [...sessions.values()].map((s) => ({ id: s.id, key: s.key, turns: s.turns }));
}
export function resetDraftSessions(): void {
  sessions.clear();
  sessionSeq = 0;
}

/** 把会话里此前的需求拼成只读上下文（首轮为空） */
export function sessionContextBlock(requirements: readonly string[]): string {
  if (requirements.length === 0) return '';
  return [
    '以下是本草稿会话此前已确认的需求（只读上下文，用于保持同一话题；本次请按最后一段新增需求更新草稿）：',
    ...requirements.map((item, index) => `${index + 1}. ${item}`),
    '',
  ].join('\n');
}
export function createDraftService(deps: DraftServiceDeps): DraftService {
  const timeoutMs = deps.timeoutMs ?? DRAFT_TIMEOUT_MS;
  const now = deps.now ?? (() => Date.now());

  return {
    async generate(input: DraftInput) {
      const started = now();
      const cwd = deps.workspacePath(input.workspace_id);
      const existing = deps.existingLabels(input.workspace_id);
      // SMART-CREATE-SESSION：同一 workspace+adapter 复用同一个草稿会话；失败不记轮次（不污染上下文）
      const acquired = acquireDraftSession(input.workspace_id, input.adapter, started);
      const context = sessionContextBlock(acquired.session.requirements);
      // MULTI-DRAFT：先按原文分条（确定性），1 条走单卡老路径，≥2 条走批量路径
      const splitAll = splitRequirementItems(input.requirement);
      const items = splitAll.slice(0, MAX_DRAFT_CARDS);
      const truncatedWarning = splitAll.length > items.length
        ? [`需求条数 ${splitAll.length} 超过上限 ${MAX_DRAFT_CARDS}，已只处理前 ${MAX_DRAFT_CARDS} 条`]
        : [];
      const multi = items.length >= 2;
      const basePrompt = multi
        ? buildMultiDraftPrompt(items, existing)
        : buildDraftPrompt(input.requirement, existing);
      const prompt = context === '' ? basePrompt : `${context}\n${basePrompt}`;

      /** 失败出口：按错误码给 HTTP 状态（可解释、非 500），并落审计 */
      const finishFailure = (status: number, code: string, message: string, warnings: string[] = []): never => {
        audit(deps.db, {
          workspace_id: input.workspace_id, adapter: input.adapter, duration_ms: now() - started,
          ok: 0, warning_count: warnings.length, error_code: code, created_at: now(),
        });
        throw new ApiError(status, code, message);
      };

      if (deps.detectAdapter) {
        const detected = await deps.detectAdapter(input.adapter);
        if (!detected.installed) {
          const reason = detected.message?.trim() !== undefined && detected.message!.trim() !== ''
            ? detected.message!.trim()
            : `适配器 ${input.adapter} 不可用`;
          audit(deps.db, {
            workspace_id: input.workspace_id, adapter: input.adapter, duration_ms: now() - started,
            ok: 0, warning_count: 0, error_code: 'ADAPTER_UNAVAILABLE', created_at: now(),
          });
          throw new ApiError(503, 'ADAPTER_UNAVAILABLE', `${reason}；可以改用手动创建，或换一个可用的执行方式`);
        }
      }
      let lastError = '输出不是合法 JSON';
      let text = '';
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          text = await deps.run({ adapter: input.adapter, prompt, cwd, signal: controller.signal });
        } catch (error) {
          clearTimeout(timer);
          if (controller.signal.aborted) {
            audit(deps.db, {
              workspace_id: input.workspace_id, adapter: input.adapter, duration_ms: now() - started,
              ok: 0, warning_count: 0, error_code: 'DRAFT_TIMEOUT', created_at: now(),
            });
            throw new ApiError(504, 'DRAFT_TIMEOUT', `草稿生成超时（${Math.round(timeoutMs / 1000)}s），可以改用手动创建，需求已保留`);
          }
          const detail = error instanceof Error ? error.message : String(error);
          return finishFailure(502, 'DRAFT_ADAPTER_FAILED', `适配器 ${input.adapter} 调用失败：${detail}`);
        } finally {
          clearTimeout(timer);
        }
        try {
          const raw = extractJsonObject(text);
          // MULTI-DRAFT：≥2 条时要求模型返回等长 cards；单条沿用单卡结构
          const cards: DraftCard[] = multi
            ? (() => {
                const parsed = draftCardsSchema.parse(raw);
                if (parsed.cards.length !== items.length) {
                  throw new Error(`卡片条数与需求条数不一致（${parsed.cards.length} ≠ ${items.length}）`);
                }
                return parsed.cards.map((card, index) => toCard(card, existing, index));
              })()
            : [toCard(draftModelSchema.parse(raw), existing, 0)];
          recordDraftTurn(acquired.session, input.requirement, now());
          const first = cards[0]!;
          const allWarnings = [...truncatedWarning, ...cards.flatMap((card) => card.warnings)];
          const result: DraftResult = {
            cards,
            // 兼容旧读取方式：顶层字段镜像第一张卡
            title: first.title,
            description: first.description,
            labels: first.labels,
            warnings: allWarnings,
            session_id: acquired.session.id,
            session_turn: acquired.session.turns,
            session_reused: acquired.reused,
          };
          audit(deps.db, {
            workspace_id: input.workspace_id, adapter: input.adapter, duration_ms: now() - started,
            ok: 1, warning_count: allWarnings.length, error_code: null, created_at: now(),
          });
          return result;
        } catch (error) {
          lastError = error instanceof Error ? error.message.split('\n')[0]! : String(error);
        }
      }
      // MULTI-DRAFT：多条需求时不让模型抖动破坏契约 —— 用原文逐条兜底（1 张也照建）
      if (multi) {
        const cards = fallbackCards(items);
        recordDraftTurn(acquired.session, input.requirement, now());
        const allWarnings = [...truncatedWarning, ...cards.flatMap((card) => card.warnings)];
        audit(deps.db, {
          workspace_id: input.workspace_id, adapter: input.adapter, duration_ms: now() - started,
          ok: 1, warning_count: allWarnings.length, error_code: null, created_at: now(),
        });
        return {
          cards,
          title: cards[0]!.title,
          description: cards[0]!.description,
          labels: cards[0]!.labels,
          warnings: allWarnings,
          session_id: acquired.session.id,
          session_turn: acquired.session.turns,
          session_reused: acquired.reused,
        };
      }
      return finishFailure(422, 'DRAFT_INVALID_OUTPUT', `适配器输出的草稿不是合法的 JSON（${lastError}），可以改用手动创建`);
    },
  };
}
