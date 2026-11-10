/**
 * PERSONA-LIB-2：智能创建人设草稿（调 `POST /api/personas/draft`，服务端不落库）。
 *
 * 与任务卡智能创建（lib/smartDraft.ts）同口径：
 * - 请求可取消（AbortController），取消抛 DraftAbortError，不当失败回退；
 * - 错误码 → 中文文案集中在 mapPersonaDraftError，组件只负责展示；
 * - 服务端契约：200 { name, description, role, tone, boundary, domain, warnings[] }
 *   400 参数 / 422 PERSONA_DRAFT_INVALID（已重试 1 次）/ 502 PERSONA_DRAFT_FAILED /
 *   503 ADAPTER_UNAVAILABLE（前置探测）/ 504 DRAFT_TIMEOUT。
 */
import { ADAPTER_LABEL, DraftAbortError, type DraftAdapter } from './smartDraft';

export interface PersonaDraft {
  name: string;
  description: string;
  role: string;
  tone: string;
  boundary: string;
  domain: string;
  warnings: string[];
}

export interface PersonaDraftInput {
  requirement: string;
  adapter: DraftAdapter;
}

export class PersonaDraftError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'PersonaDraftError';
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_ENDPOINT = '/api/personas/draft';

/** 错误码 → 中文（不写「已回退」，人设生成失败是原地重试） */
export function mapPersonaDraftError(error: unknown, adapter: DraftAdapter): string {
  if (error instanceof DraftAbortError) return '已取消生成';
  const status = error instanceof PersonaDraftError ? error.status : 0;
  const code = error instanceof PersonaDraftError ? error.code : 'UNKNOWN';
  const detail = error instanceof Error && error.message !== '' ? error.message : '未知原因';
  const name = ADAPTER_LABEL[adapter];
  switch (code) {
    case 'PERSONA_DRAFT_FAILED':
      return `执行方式「${name}」生成失败：${detail}。描述已保留，可重试或直接手动填写。`;
    case 'PERSONA_DRAFT_INVALID':
      return `执行方式「${name}」返回的草稿格式不合法（系统已自动重试一次）：${detail}。可重试或直接手动填写。`;
    case 'DRAFT_TIMEOUT':
      return `执行方式「${name}」生成超时（120 秒未完成）。可重试或直接手动填写。`;
    case 'ADAPTER_UNAVAILABLE':
      return `执行方式「${name}」当前不可用：${detail}。可重试或直接手动填写。`;
    case 'VALIDATION_ERROR':
      return `请求参数不合法：${detail}`;
    default:
      return `生成草稿失败（HTTP ${status}${code === 'UNKNOWN' ? '' : ` ${code}`}）：${detail}。可重试或直接手动填写。`;
  }
}

/** 环境里的 fetch 与 AbortSignal 可能不同 realm（jsdom + Node fetch）；首次拒绝后不再传 signal，退化为忽略迟到结果 */
let signalSupported: boolean | null = null;
async function postDraft(input: PersonaDraftInput, endpoint: string, signal?: AbortSignal): Promise<Response> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  };
  const withSignal = signal !== undefined && signalSupported !== false;
  try {
    const res = await fetch(endpoint, withSignal ? { ...init, signal } : init);
    if (withSignal) signalSupported = true;
    return res;
  } catch (e) {
    const message = e instanceof Error ? e.message : '';
    if (withSignal && /signal/i.test(message) && signal?.aborted !== true) {
      signalSupported = false;
      return fetch(endpoint, init);
    }
    throw e;
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 发起人设草稿生成；被 signal 取消时抛 DraftAbortError */
export async function requestPersonaDraft(
  input: PersonaDraftInput,
  options: { signal?: AbortSignal; endpoint?: string } = {},
): Promise<PersonaDraft> {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  let res: Response;
  try {
    res = await postDraft(input, endpoint, options.signal);
  } catch (e) {
    if (options.signal?.aborted === true) throw new DraftAbortError();
    throw new PersonaDraftError(e instanceof Error ? e.message : '网络错误', 'UNKNOWN', 0);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // 非 JSON 响应统一走下面的错误分支
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new PersonaDraftError(err?.message ?? `请求失败（HTTP ${res.status}）`, err?.code ?? 'UNKNOWN', res.status);
  }
  const body = (data ?? {}) as Record<string, unknown>;
  return {
    name: text(body.name),
    description: text(body.description),
    role: text(body.role),
    tone: text(body.tone),
    boundary: text(body.boundary),
    domain: text(body.domain),
    warnings: Array.isArray(body.warnings) ? body.warnings.filter((w): w is string => typeof w === 'string') : [],
  };
}
