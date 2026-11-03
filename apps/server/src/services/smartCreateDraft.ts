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

export const DRAFT_ADAPTERS = ['dsh', 'codex', 'opencode'] as const;
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
  title: string;
  description: string;
  labels: string[];
  warnings: string[];
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

/** 一次适配器调用的抽象：生产用 runTurn，测试注入 fake */
export type DraftRunner = (args: { adapter: DraftAdapterId; prompt: string; cwd: string; signal: AbortSignal }) => Promise<string>;

export interface DraftServiceDeps {
  db: Db;
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

export function createDraftService(deps: DraftServiceDeps): DraftService {
  const timeoutMs = deps.timeoutMs ?? DRAFT_TIMEOUT_MS;
  const now = deps.now ?? (() => Date.now());

  return {
    async generate(input: DraftInput) {
      const started = now();
      const cwd = deps.workspacePath(input.workspace_id);
      const existing = deps.existingLabels(input.workspace_id);
      const prompt = buildDraftPrompt(input.requirement, existing);

      /** 失败出口：按错误码给 HTTP 状态（可解释、非 500），并落审计 */
      const finishFailure = (status: number, code: string, message: string, warnings: string[] = []): never => {
        audit(deps.db, {
          workspace_id: input.workspace_id, adapter: input.adapter, duration_ms: now() - started,
          ok: 0, warning_count: warnings.length, error_code: code, created_at: now(),
        });
        throw new ApiError(status, code, message);
      };

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
          const parsed = draftModelSchema.parse(extractJsonObject(text));
          // 标签只保留工作区已有值；模型自造的丢弃并记 warning
          const invented = parsed.labels.filter(label => !existing.includes(label));
          const labels = parsed.labels.filter(label => existing.includes(label));
          const warnings = [...parsed.warnings];
          if (invented.length > 0) warnings.push(`已忽略模型自造的标签：${invented.join('、')}（只允许使用工作区已有标签）`);
          const result: DraftResult = {
            title: parsed.title,
            description: renderDraftDescription(parsed),
            labels,
            warnings,
          };
          audit(deps.db, {
            workspace_id: input.workspace_id, adapter: input.adapter, duration_ms: now() - started,
            ok: 1, warning_count: warnings.length, error_code: null, created_at: now(),
          });
          return result;
        } catch (error) {
          lastError = error instanceof Error ? error.message.split('\n')[0]! : String(error);
        }
      }
      return finishFailure(422, 'DRAFT_INVALID_OUTPUT', `适配器输出的草稿不是合法的 JSON（${lastError}），可以改用手动创建`);
    },
  };
}
