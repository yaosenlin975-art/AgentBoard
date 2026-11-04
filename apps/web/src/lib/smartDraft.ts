/**
 * 智能创建草稿（SMART-CREATE-UI）：调 `POST /api/issues/draft`（服务端不落库）+ 错误码中文化。
 *
 * 单独成文件的目的：请求可取消（AbortController）、错误码映射可单测，不把网络细节塞进对话框组件。
 * 服务端契约（提交 6e70276）：
 *   200 { title, description, labels, warnings[] }
 *   502 DRAFT_ADAPTER_FAILED / 422 DRAFT_INVALID_OUTPUT（已自动重试 1 次）/ 504 DRAFT_TIMEOUT /
 *   503 ADAPTER_UNAVAILABLE（前置探测，附原因）/ 400 参数 / 404 工作区
 */
import type { Priority } from '@agentboard/shared';

export const DRAFT_ADAPTERS = ['dsh', 'codex', 'opencode', 'codebuddy'] as const;
export type DraftAdapter = (typeof DRAFT_ADAPTERS)[number];

export const ADAPTER_LABEL: Record<DraftAdapter, string> = {
  dsh: 'DSH',
  codex: 'Codex',
  opencode: 'OpenCode',
  codebuddy: 'CodeBuddy',
};

/** MULTI-DRAFT：一张草稿卡（1 条需求 1 张） */
export interface DraftCard {
  localId: string;
  title: string;
  description: string;
  labels: string[];
  warnings: string[];
}

export interface IssueDraft {
  /** MULTI-DRAFT：草稿卡（≥1；单条需求时长度 1） */
  cards: DraftCard[];
  title: string;
  description: string;
  labels: string[];
  warnings: string[];
  /** 草稿会话 id（服务端按 workspace_id + adapter 复用；同会话多轮生成时相同） */
  sessionId: string | null;
  /** 该会话第几轮（首次 1） */
  sessionTurn: number | null;
  /** 本次是否复用已有草稿会话 */
  sessionReused: boolean;
}

export interface DraftRequestInput {
  workspace_id: string;
  requirement: string;
  adapter: DraftAdapter;
  priority?: Priority;
}

export class DraftError extends Error {
  /** 服务端错误码（无则 UNKNOWN） */
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'DraftError';
    this.code = code;
    this.status = status;
  }
}

/** 取消（用户点「取消生成」）——不当失败处理，不回退手动表单 */
export class DraftAbortError extends Error {
  constructor() {
    super('已取消生成');
    this.name = 'DraftAbortError';
  }
}

/** 错误码 → 中文文案（都带「已回退到手动创建」提示，需求原文在对话框里保留） */
export function mapDraftError(error: unknown, adapter: DraftAdapter): string {
  if (error instanceof DraftAbortError) return '已取消生成';
  const status = error instanceof DraftError ? error.status : 0;
  const code = error instanceof DraftError ? error.code : 'UNKNOWN';
  const detail = error instanceof Error && error.message !== '' ? error.message : '未知原因';
  const name = ADAPTER_LABEL[adapter];
  switch (code) {
    case 'DRAFT_ADAPTER_FAILED':
      return `执行方式「${name}」生成失败：${detail}。已回退到手动创建，需求原文已保留。`;
    case 'DRAFT_INVALID_OUTPUT':
      return `执行方式「${name}」返回的草稿格式不合法（系统已自动重试一次）：${detail}。已回退到手动创建，需求原文已保留。`;
    case 'DRAFT_TIMEOUT':
      return `执行方式「${name}」生成超时（120 秒未完成）。已回退到手动创建，需求原文已保留。`;
    case 'ADAPTER_UNAVAILABLE':
      return `执行方式「${name}」当前不可用：${detail}。已回退到手动创建，需求原文已保留。`;
    case 'NOT_FOUND':
      return `工作空间不存在（HTTP ${status}）。请重新选择工作空间后重试。`;
    case 'VALIDATION_ERROR':
      return `请求参数不合法：${detail}`;
    default:
      return `生成草稿失败（HTTP ${status}${code === 'UNKNOWN' ? '' : ` ${code}`}）：${detail}。已回退到手动创建，需求原文已保留。`;
  }
}

interface DraftOptions {
  signal?: AbortSignal;
  /** 测试注入用；默认 `/api/issues/draft` */
  endpoint?: string;
}

/** 发起草稿生成；被 signal 取消时抛 DraftAbortError */
export async function requestDraft(input: DraftRequestInput, options: DraftOptions = {}): Promise<IssueDraft> {
  let res: Response;
  try {
    res = await postDraft(input, options);
  } catch (e) {
    if (options.signal?.aborted === true) throw new DraftAbortError();
    throw new DraftError(e instanceof Error ? e.message : '网络错误', 'UNKNOWN', 0);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // 非 JSON 响应按空处理，下面统一走错误分支
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new DraftError(err?.message ?? `请求失败（HTTP ${res.status}）`, err?.code ?? 'UNKNOWN', res.status);
  }
  const draft = data as
    | (Partial<IssueDraft> & { session_id?: unknown; session_turn?: unknown; session_reused?: unknown; cards?: unknown })
    | null;
  const topLevelLabels = Array.isArray(draft?.labels) ? draft!.labels.filter((l): l is string => typeof l === 'string') : [];
  const topLevelWarnings = Array.isArray(draft?.warnings) ? draft!.warnings.filter((w): w is string => typeof w === 'string') : [];
  // MULTI-DRAFT：优先读 cards[]；服务端没给（旧响应）时按单卡合成，调用方无感
  const rawCards = Array.isArray(draft?.cards) ? (draft!.cards as unknown[]) : [];
  const cards: DraftCard[] = rawCards
    .map((raw, index) => {
      const card = raw as Partial<DraftCard> | null;
      const title = typeof card?.title === 'string' ? card.title : '';
      if (title.trim() === '') return null;
      return {
        localId: typeof card?.localId === 'string'
          ? card.localId
          : typeof (card as { local_id?: unknown } | null)?.local_id === 'string'
            ? String((card as { local_id?: string }).local_id)
            : `c${index + 1}`,
        title,
        description: typeof card?.description === 'string' ? card.description : '',
        labels: Array.isArray(card?.labels) ? card!.labels.filter((l): l is string => typeof l === 'string') : [],
        warnings: Array.isArray(card?.warnings) ? card!.warnings.filter((w): w is string => typeof w === 'string') : [],
      } satisfies DraftCard;
    })
    .filter((card): card is DraftCard => card !== null);
  const fallbackCard: DraftCard = {
    localId: 'c1',
    title: typeof draft?.title === 'string' ? draft.title : '',
    description: typeof draft?.description === 'string' ? draft.description : '',
    labels: topLevelLabels,
    warnings: topLevelWarnings,
  };
  return {
    cards: cards.length > 0 ? cards : [fallbackCard],
    title: typeof draft?.title === 'string' ? draft.title : fallbackCard.title,
    description: typeof draft?.description === 'string' ? draft.description : fallbackCard.description,
    labels: topLevelLabels,
    warnings: topLevelWarnings,
    sessionId: typeof draft?.session_id === 'string' ? draft.session_id : null,
    sessionTurn: typeof draft?.session_turn === 'number' ? draft.session_turn : null,
    sessionReused: draft?.session_reused === true,
  };
}

/** 智能创建随需求提交的图片引用（KB-SMART-IMG：服务端 draft 契约只收文本，前端负责整理成说明块） */
export interface DraftImageRef {
  name: string;
  mimeType: string;
  /** 上传成功后拿到的附件 id；未成功时为空 */
  attachmentId?: string;
  uploaded: boolean;
}

/**
 * 把图片整理成需求末尾的说明块一起发给草稿服务。
 * 服务端 `DraftInput` 只有 `requirement`（无图片字段），因此这里只传**图片说明**：
 * 明确写「模型无法读取像素」，只提供文件名/类型/附件 id 作为上下文，不伪造视觉理解能力。
 */
export function composeRequirementWithImages(requirement: string, images: readonly DraftImageRef[]): string {
  if (images.length === 0) return requirement;
  const lines = images.map((image, index) => {
    const upload = image.uploaded && image.attachmentId !== undefined ? `attachment_id=${image.attachmentId}` : '未上传完成';
    return `${index + 1}. ${image.name} · ${image.mimeType} · ${upload}`;
  });
  return [
    requirement,
    '',
    '---',
    `[需求图片 ${images.length} 张] 草稿服务当前只接收文本，模型无法读取图片像素，只能依据下列图片说明推断意图：`,
    ...lines,
  ].join('\n');
}

/** 环境里的 fetch 与 AbortSignal 可能来自不同的 realm（jsdom + Node fetch），此时 signal 会被拒；
 *  首次拒绝后记住该事实，后续不再传 signal（取消退化为「忽略迟到结果」，组件已保证 UI 取消语义）。 */
let signalSupported: boolean | null = null;
async function postDraft(input: DraftRequestInput, options: DraftOptions): Promise<Response> {
  const body = JSON.stringify(input);
  const init: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
  const withSignal = options.signal !== undefined && signalSupported !== false;
  try {
    const res = await fetch(options.endpoint ?? '/api/issues/draft', withSignal ? { ...init, signal: options.signal } : init);
    if (withSignal) signalSupported = true;
    return res;
  } catch (e) {
    const message = e instanceof Error ? e.message : '';
    // fetch 会在跨 realm signal 上抛 "Expected signal ... to be an instance of AbortSignal"
    if (withSignal && /signal/i.test(message) && options.signal?.aborted !== true) {
      signalSupported = false;
      return fetch(options.endpoint ?? '/api/issues/draft', init);
    }
    throw e;
  }
}
