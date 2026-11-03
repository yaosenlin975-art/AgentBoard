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

/** 模型目录里必须存在的文件（解包/逐文件下载后校验用；`sha256` 为 null 表示上游未发布该文件的校验值） */
export interface VoiceModelFile {
  path: string;
  bytes: number;
  sha256: string | null;
}

export interface VoiceModelCatalogEntry {
  id: string;
  /** 展示名 */
  name: string;
  /** 预估体积（字节）；真实体积以实际下载为准 */
  bytes: number;
  size_estimate: boolean;
  /** 支持的识别语言（BCP-47 前缀，前端据此提示「模型不支持当前系统语言」） */
  languages: readonly string[];
  /** HuggingFace 仓库（`owner/name`）：按文件下载时用 `resolve/<revision>/<path>` 拼直链 */
  repo?: string;
  /** 固定 revision（HF commit sha），避免上游改文件后校验值失效 */
  revision?: string;
  /** 官方归档地址（仅作溯源展示；本版本按文件下载，不下载归档） */
  url: string | null;
  /** 官方发布 sha256（小写 hex）；null = 未配置（下载完成后只记录实测值，不冒充校验通过） */
  sha256: string | null;
  /** 是否流式（影响识别会话的 partial 事件语义） */
  streaming: boolean;
  /** 必需文件清单（缺任一 → VOICE_MODEL_INCOMPLETE） */
  files?: readonly VoiceModelFile[];
  note: string;
}

export const VOICE_MODEL_CATALOG: readonly VoiceModelCatalogEntry[] = [
  {
    id: 'sherpa-onnx-streaming-zipformer-bilingual-zh-en-int8',
    name: 'Zipformer 中英双语（流式，int8）',
    bytes: 511_274_346,
    size_estimate: false,
    languages: ['zh', 'en'],
    repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20',
    revision: '98590b7ed6443e77b714204da2757d75e1a642f4',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2',
    sha256: null,
    streaming: true,
    note: '中英混说，推荐默认项；归档 487.6 MiB（GitHub release 实测），int8 三个 onnx 共 173.5 MiB',
    files: [
      { path: 'encoder-epoch-99-avg-1.int8.onnx', bytes: 181_895_032, sha256: '8fa764187a261844f859d7143ebaa563af5d10adfece4c18a8f414c88cba2a9b' },
      { path: 'decoder-epoch-99-avg-1.int8.onnx', bytes: 13_091_040, sha256: '1a70c593d71e53f023f5f55b0b4cfff5055abb786ee3992e5f63dc2e273cc4fa' },
      { path: 'joiner-epoch-99-avg-1.int8.onnx', bytes: 3_228_404, sha256: '1ed689c5ed19dbaa725d9d191bb4822b5f4855a39e1ffd28cbc1f340d25b2ee0' },
      // tokens.txt 非 LFS：上游只有 git blob oid，没有 sha256 可校验
      { path: 'tokens.txt', bytes: 56_317, sha256: null },
    ],
  },
  {
    id: 'sherpa-onnx-paraformer-zh-int8',
    name: 'Paraformer 中文（非流式，int8）',
    bytes: 234_051_698,
    size_estimate: false,
    languages: ['zh'],
    repo: 'csukuangfj/sherpa-onnx-paraformer-zh-2023-09-14',
    revision: 'def027084691107096b5ebba69785756d63de6c5',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2',
    sha256: null,
    streaming: false,
    note: '中文更强，非流式；归档 223.2 MiB（GitHub release 实测），model.int8.onnx 232.1 MiB',
    files: [
      { path: 'model.int8.onnx', bytes: 243_371_218, sha256: 'f36a0433bcf096bd6d6f11b80a3ac8bed110bdca632fe0d731df8d1a84475945' },
      { path: 'tokens.txt', bytes: 75_756, sha256: null },
    ],
  },
];

/** 按 id 找候选（找不到返回 undefined） */
export function findVoiceModel(id: string): VoiceModelCatalogEntry | undefined {
  return VOICE_MODEL_CATALOG.find((entry) => entry.id === id);
}
