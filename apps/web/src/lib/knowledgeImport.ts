/**
 * KBIMP-2：知识库导入的**纯前端解析层**（不触 DOM、不触网络，便于单测）。
 *
 * 契约来自服务端 `POST /api/knowledge/pages/import`（KBIMP-1，`9a4e06a`）：
 * body `{ scope, workspace_id?, title?, format: md|txt|json, content, category?, landed?, labels? }`，
 * json 支持**单对象或数组（≤100 条）**，多余字段进 `warnings`；语言侧错误码
 * `IMPORT_BODY_TOO_LONG`(413) / `KNOWLEDGE_EXISTS`(409) / 400 结构错误。
 *
 * 前端自己做的那部分：1MB 上限预检、格式识别、预览草稿、json 数组逐条可取消、错误文案。
 * **不替服务端做业务校验**（slug 冲突、正文长度上限都以服务端返回为准）。
 */

/** 前端预检上限：与服务端路由级 2MB 相比留一半余量，按卡片要求取 1MB */
export const MAX_IMPORT_BYTES = 1024 * 1024;
/** json 数组最多条数（与服务端一致） */
export const MAX_IMPORT_ITEMS = 100;
/** 预览里展示的正文行数 */
export const PREVIEW_LINES = 20;

export type ImportFormat = 'md' | 'txt' | 'json';

export const IMPORT_FORMAT_LABEL: Record<ImportFormat, string> = { md: 'Markdown', txt: '纯文本', json: 'JSON' };

export interface ImportDraft {
  /** 前端本地 id（json 数组逐条取消用；不发给服务端） */
  key: string;
  title: string;
  body_md: string;
  category?: string;
  landed?: string;
  labels?: string[];
}

export interface ParsedImport {
  format: ImportFormat;
  filename: string;
  bytes: number;
  drafts: ImportDraft[];
  warnings: string[];
}

export type ParseFailure = { error: 'UNSUPPORTED_FORMAT' | 'TOO_LARGE' | 'EMPTY' | 'BAD_JSON' | 'TOO_MANY_ITEMS'; message: string };
export type ParseResult = { ok: true; value: ParsedImport } | { ok: false; failure: ParseFailure };

const utf8Bytes = (text: string): number =>
  typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : unescape(encodeURIComponent(text)).length;

/** 扩展名 → 格式；不支持返回 null */
export function detectFormat(filename: string): ImportFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
  if (lower.endsWith('.txt')) return 'txt';
  if (lower.endsWith('.json')) return 'json';
  return null;
}

/** 从正文里猜标题：md 取第一个标题，txt 取第一行，兜底用文件名 */
export function guessTitle(filename: string, content: string): string {
  const firstHeading = /^#{1,6}\s+(.+)$/m.exec(content)?.[1]?.trim();
  if (firstHeading !== undefined && firstHeading !== '') return firstHeading.slice(0, 300);
  const firstLine = content.split('\n').map((line) => line.trim()).find((line) => line !== '');
  if (firstLine !== undefined) return firstLine.slice(0, 300);
  return filename.replace(/\.[^.]+$/, '').slice(0, 300);
}

/** 预览用的前 N 行 */
export function previewLines(content: string, count = PREVIEW_LINES): string[] {
  return content.split('\n').slice(0, count);
}

const JSON_CATEGORIES = new Set(['design', 'solved', 'pinned', 'open', 'legacy']);
const JSON_LANDED = new Set(['landed', 'partial', 'proposed']);

/** json：单对象或数组（≤100）；多余字段记 warning，不拼进正文 */
function parseJson(content: string): { drafts: ImportDraft[]; warnings: string[] } | ParseFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { error: 'BAD_JSON', message: 'JSON 解析失败：请检查括号/逗号，或确认文件确实是 JSON' };
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length > MAX_IMPORT_ITEMS) {
    return { error: 'TOO_MANY_ITEMS', message: `JSON 数组最多 ${MAX_IMPORT_ITEMS} 条（当前 ${items.length} 条）` };
  }
  const warnings: string[] = [];
  const drafts: ImportDraft[] = [];
  items.forEach((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      warnings.push(`第 ${index + 1} 条不是对象，已跳过`);
      return;
    }
    const record = item as Record<string, unknown>;
    const bodyRaw = record.body_md ?? record.body;
    if (typeof bodyRaw !== 'string' || bodyRaw.trim() === '') {
      warnings.push(`第 ${index + 1} 条缺少 body/body_md，已跳过`);
      return;
    }
    const known = ['title', 'slug', 'body', 'body_md', 'category', 'landed', 'labels'];
    const extra = Object.keys(record).filter((key) => !known.includes(key));
    if (extra.length > 0) warnings.push(`第 ${index + 1} 条忽略了不支持的字段：${extra.join('、')}`);
    const category = typeof record.category === 'string' && JSON_CATEGORIES.has(record.category) ? record.category : undefined;
    const landed = typeof record.landed === 'string' && JSON_LANDED.has(record.landed) ? record.landed : undefined;
    const labels = Array.isArray(record.labels) ? record.labels.filter((label): label is string => typeof label === 'string').slice(0, 20) : undefined;
    drafts.push({
      key: `draft-${index}`,
      title: typeof record.title === 'string' && record.title.trim() !== '' ? record.title.trim().slice(0, 300) : `导入条目 ${index + 1}`,
      body_md: bodyRaw,
      ...(category === undefined ? {} : { category }),
      ...(landed === undefined ? {} : { landed }),
      ...(labels === undefined ? {} : { labels }),
    });
  });
  return { drafts, warnings };
}

/**
 * 解析一个待导入文件（纯函数）。所有失败都返回可读中文，由 UI 直接展示。
 */
export function parseImportFile(filename: string, content: string): ParseResult {
  const format = detectFormat(filename);
  if (format === null) {
    return { ok: false, failure: { error: 'UNSUPPORTED_FORMAT', message: `不支持的文件类型：${filename}（只支持 .md / .markdown / .txt / .json）` } };
  }
  const bytes = utf8Bytes(content);
  if (bytes > MAX_IMPORT_BYTES) {
    return { ok: false, failure: { error: 'TOO_LARGE', message: `文件过大：${(bytes / 1024 / 1024).toFixed(2)} MB，上限 ${MAX_IMPORT_BYTES / 1024 / 1024} MB` } };
  }
  if (content.trim() === '') {
    return { ok: false, failure: { error: 'EMPTY', message: '文件是空的' } };
  }

  if (format === 'json') {
    const parsed = parseJson(content);
    if ('error' in parsed) return { ok: false, failure: parsed };
    if (parsed.drafts.length === 0) {
      return { ok: false, failure: { error: 'BAD_JSON', message: 'JSON 里没有可导入的条目（每条需要 body 或 body_md）' } };
    }
    return { ok: true, value: { format, filename, bytes, drafts: parsed.drafts, warnings: parsed.warnings } };
  }

  return {
    ok: true,
    value: {
      format,
      filename,
      bytes,
      drafts: [{ key: 'draft-0', title: guessTitle(filename, content), body_md: content }],
      warnings: [],
    },
  };
}

/** 只保留被选中的草稿（json 数组逐条取消）；返回重建后的 content（json 数组重新序列化） */
export function selectedDrafts(parsed: ParsedImport, cancelledKeys: readonly string[]): ImportDraft[] {
  return parsed.drafts.filter((draft) => !cancelledKeys.includes(draft.key));
}

export function rebuildContent(parsed: ParsedImport, drafts: readonly ImportDraft[]): string {
  if (parsed.format !== 'json') return parsed.drafts[0]?.body_md ?? '';
  return JSON.stringify(drafts.map((draft) => ({
    title: draft.title,
    body_md: draft.body_md,
    ...(draft.category === undefined ? {} : { category: draft.category }),
    ...(draft.landed === undefined ? {} : { landed: draft.landed }),
    ...(draft.labels === undefined ? {} : { labels: draft.labels }),
  })));
}

/** 导入错误码 → 可读文案（KNOWLEDGE_EXISTS 给两条可执行建议） */
export function importErrorView(code: string | null, message: string): { text: string; suggestions: string[] } {
  if (code === 'KNOWLEDGE_EXISTS') {
    return {
      text: '同范围内已存在相同标题/别名的知识页，导入被拒（409）',
      suggestions: ['改标题后再导：标题不同即生成不同别名', '加后缀再导：例如在标题后拼接日期或 ID'],
    };
  }
  if (code === 'IMPORT_BODY_TOO_LONG') {
    return { text: '内容超过服务端上限（正文 ≤100000 字符 / 请求 ≤2MB）', suggestions: ['拆分成多页后再导入'] };
  }
  return { text: message || '导入失败', suggestions: [] };
}