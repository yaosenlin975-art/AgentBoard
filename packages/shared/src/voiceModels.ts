/**
 * VOICE-1：本地语音模型的候选清单（前后端共用的一份常量）。
 *
 * 口径（Docs/design-2026-11-03-local-voice-input.md §服务端-模型管理）：
 * - **不预置、不自动下载**：这里只描述候选，用户必须在设置里主动点下载；
 * - `url` / `sha256` 为 `null` 表示「尚未配置官方发布值」——下载接口会以
 *   `VOICE_MODEL_URL_MISSING` 明确拒绝，而不是去猜地址或跳过校验；
 * - `bytes` 是设计文档给出的**约值**（`size_estimate: true`），用于进度条预估与空间预检；
 *   真实大小以响应头/落盘字节为准。
 */

export interface VoiceModelCatalogEntry {
  id: string;
  /** 展示名 */
  name: string;
  /** 预估体积（字节）；真实体积以实际下载为准 */
  bytes: number;
  size_estimate: boolean;
  /** 支持的识别语言（BCP-47 前缀，前端据此提示「模型不支持当前系统语言」） */
  languages: readonly string[];
  /** 官方发布地址；null = 未配置（下载接口明确拒绝，不猜） */
  url: string | null;
  /** 官方发布 sha256（小写 hex）；null = 未配置（下载完成后只记录实测值，不冒充校验通过） */
  sha256: string | null;
  /** 是否流式（影响识别会话的 partial 事件语义） */
  streaming: boolean;
  note: string;
}

export const VOICE_MODEL_CATALOG: readonly VoiceModelCatalogEntry[] = [
  {
    id: 'sherpa-onnx-streaming-zipformer-bilingual-zh-en-int8',
    name: 'Zipformer 中英双语（流式，int8）',
    bytes: 186_000_000,
    size_estimate: true,
    languages: ['zh', 'en'],
    url: null,
    sha256: null,
    streaming: true,
    note: '中英混说，推荐默认项；约 186MB（设计文档口径）',
  },
  {
    id: 'sherpa-onnx-paraformer-zh-int8',
    name: 'Paraformer 中文（非流式，int8）',
    bytes: 216_800_000,
    size_estimate: true,
    languages: ['zh'],
    url: null,
    sha256: null,
    streaming: false,
    note: '中文更强，非流式；约 216.8MB（设计文档口径）',
  },
];

/** 按 id 找候选（找不到返回 undefined） */
export function findVoiceModel(id: string): VoiceModelCatalogEntry | undefined {
  return VOICE_MODEL_CATALOG.find((entry) => entry.id === id);
}
