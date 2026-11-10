/**
 * PERSONA-LIB：智能创建人设草稿（PERSONA-LIB-2）。
 *
 * - **不落库**：只产出可编辑草稿（name / description / role / tone / boundary / domain / warnings），
 *   落库由用户确认后走既有 `POST /api/personas`。
 * - **复用任务卡智能创建的调用链**：同一个 `DraftRunner`（一次性 runTurn，不建会话、不占 claim），
 *   同一个 120s 超时与错误码口径（503 前置探测 / 504 超时 / 502 调用失败 / 422 结构不合法）。
 * - **严格 JSON**：不合法重试 1 次；仍不合法给可解释 422，不抛 500。
 * - **不记原文**：personas 是全局资源，没有 workspace 维度，因此不写 issue_draft_audit（该表按工作区审计任务草稿）。
 */
import { z } from 'zod';
import { ApiError } from '../errors.js';
import {
  DRAFT_TIMEOUT_MS,
  extractJsonObject,
  type DraftAdapterId,
  type DraftRunner,
} from './smartCreateDraft.js';

const MAX_ATTEMPTS = 2;

/** 模型必须返回的结构；可选段落给 null，由服务端归一化成空串 */
const personaDraftModelSchema = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(200).nullable(),
  role: z.string().trim().min(1).max(2000),
  tone: z.string().trim().max(1000).nullable(),
  boundary: z.string().trim().max(1000).nullable(),
  domain: z.string().trim().max(1000).nullable(),
  warnings: z.array(z.string()).max(10),
}).strict();

export interface PersonaDraftInput {
  requirement: string;
  adapter: DraftAdapterId;
}

export interface PersonaDraftResult {
  name: string;
  description: string;
  role: string;
  tone: string;
  boundary: string;
  domain: string;
  warnings: string[];
}

export interface PersonaDraftServiceDeps {
  /** 拉起适配器并收集文本输出（与任务卡草稿同一个 runner） */
  run: DraftRunner;
  /** 适配器可用性探测：不可用直接 503，不等 runTurn 抛错 */
  detectAdapter?(adapter: DraftAdapterId): Promise<{ installed: boolean; version: string | null; message?: string }>;
  /** 一次性调用的工作目录（personas 全局，用服务进程 cwd 即可） */
  cwd: string;
  timeoutMs?: number;
}

export interface PersonaDraftService {
  generate(input: PersonaDraftInput): Promise<PersonaDraftResult>;
}

/** 提示词：只按用户原意生成四段人设，禁止编造身份/机构/经历 */
export function buildPersonaDraftPrompt(requirement: string): string {
  return [
    '你是智能体人设草稿生成器。根据用户给出的一句话描述，产出一份结构化的人设草稿。',
    '',
    '硬性规则：',
    '1. 只输出一个 JSON 对象，不要任何解释文字；字段固定为：',
    '   {"name": string, "description": string|null, "role": string|null, "tone": string|null, "boundary": string|null, "domain": string|null, "warnings": string[]}',
    '2. name 是人设名称（≤12 字）；description 是一句话简介（≤40 字）。',
    '3. role 用第二人称「你是…」，写清职责、工作方式与产出标准（2-4 句）。',
    '4. tone 写一句语气与表达偏好。',
    '5. boundary 写 3-5 条边界与禁忌，每行以「- 」开头（如不编造事实、不可逆操作先确认）。',
    '6. domain 写一句擅长领域与适用范围。',
    '7. 不得编造用户未提到的身份、机构、经历或数据；信息不足时在 warnings 里说明，不要自行补全。',
    '8. 全部使用简体中文。',
    '',
    '用户描述：',
    '"""',
    requirement.trim(),
    '"""',
  ].join('\n');
}

/**
 * 服务工厂：与 `createDraftService` 同错误口径，去掉任务卡特有的会话/标签/审计。
 */
export function createPersonaDraftService(deps: PersonaDraftServiceDeps): PersonaDraftService {
  const timeoutMs = deps.timeoutMs ?? DRAFT_TIMEOUT_MS;

  return {
    async generate(input: PersonaDraftInput): Promise<PersonaDraftResult> {
      if (deps.detectAdapter) {
        const detected = await deps.detectAdapter(input.adapter);
        if (!detected.installed) {
          const reason = detected.message?.trim() !== undefined && detected.message!.trim() !== ''
            ? detected.message!.trim()
            : `适配器 ${input.adapter} 不可用`;
          throw new ApiError(503, 'ADAPTER_UNAVAILABLE', `${reason}；可以改用手动填写，或换一个可用的执行方式`);
        }
      }

      const prompt = buildPersonaDraftPrompt(input.requirement);
      let lastError = '输出不是合法 JSON';
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let text = '';
        try {
          text = await deps.run({ adapter: input.adapter, prompt, cwd: deps.cwd, signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted) {
            throw new ApiError(504, 'DRAFT_TIMEOUT', `草稿生成超时（${Math.round(timeoutMs / 1000)}s），可以改用手动填写，描述已保留`);
          }
          const detail = error instanceof Error ? error.message : String(error);
          throw new ApiError(502, 'PERSONA_DRAFT_FAILED', `适配器 ${input.adapter} 调用失败：${detail}`);
        } finally {
          clearTimeout(timer);
        }

        try {
          const parsed = personaDraftModelSchema.parse(extractJsonObject(text));
          return {
            name: parsed.name,
            description: parsed.description ?? '',
            role: parsed.role,
            tone: parsed.tone ?? '',
            boundary: parsed.boundary ?? '',
            domain: parsed.domain ?? '',
            warnings: parsed.warnings,
          };
        } catch (error) {
          lastError = error instanceof Error ? error.message.split('\n')[0]! : String(error);
        }
      }
      throw new ApiError(422, 'PERSONA_DRAFT_INVALID', `草稿结构不合法（已重试 1 次）：${lastError}；可以改用手动填写`);
    },
  };
}
