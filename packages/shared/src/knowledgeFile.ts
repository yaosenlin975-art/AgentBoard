/**
 * P2-01（方向 B §7.1）：知识页文件事实源的 front matter 契约（前后端同源）。
 *
 * - `Docs/<slug>.md` 是知识页唯一事实源；本文件定义 md 的 front matter 字段集、固定字段顺序、
 *   确定性序列化（同一 revision 重复渲染逐字节一致）与受限 YAML 子集解析。
 * - 序列化口径：字段顺序固定（§7.1）；标量值安全时原样输出、含特殊字符时用 JSON 双引号串
 *   （JSON 字符串是合法 YAML flow scalar，js-yaml / Obsidian 均可读）；sources/evidence 为
 *   两层缩进的 YAML 数组块；`snapshot` 一律 JSON 字符串（任意内容 round-trip 安全，
 *   不用 `|` 块标量——首行空格/结尾换行等边角无需显式缩进指示符）。
 * - `content_hash` = sha256(去掉 content_hash 行的完整文档)（正文 + front matter 除本字段），
 *   由服务端（apps/server/src/knowledge/frontMatter.ts）计算；本文件只负责携带与渲染。
 * - 解析容错：BOM 剥离、CRLF 归一为 LF；字段缺失/类型不符抛 KnowledgeFileParseError。
 *   解析器只认本契约的受限子集，不追求通用 YAML。
 */
import type { KnowledgeEvidence, KnowledgeSource } from './types.js';

/** front matter 携带的页面元数据（§7.1 已定 7 字段 + M9 补充字段 + M9 content_hash） */
export interface KnowledgeFileMeta {
  /** 稳定 id（uuid）；不再作对外主键，但保留兼容解析（knowledge:<uuid>） */
  id: string;
  slug: string;
  title: string;
  /** 每次经 API/CLI 写 +1，作 CAS 基线 */
  revision: number;
  scope: 'workspace' | 'common';
  /** scope 由所在目录决定（N4），此字段作冗余校验 */
  workspace_id: string | null;
  status: 'active' | 'archived';
  domain: string;
  category: 'design' | 'solved' | 'pinned' | 'open' | 'legacy';
  landed: 'landed' | 'partial' | 'proposed' | null;
  sources: KnowledgeSource[];
  evidence: KnowledgeEvidence[];
  /** sha256(去掉本字段的完整文档)；外部编辑检测 */
  content_hash: string;
  /** epoch ms；null = 不过期 */
  expires_at: number | null;
  created_at: number;
  updated_at: number;
  created_by: string;
  updated_by: string;
  change_note: string;
}

/** front matter 字段固定顺序（幂等渲染的根基） */
export const KNOWLEDGE_FILE_FIELD_ORDER = [
  'id', 'slug', 'title', 'revision', 'scope', 'workspace_id', 'status',
  'domain', 'category', 'landed',
  'sources', 'evidence',
  'content_hash',
  'expires_at', 'created_at', 'updated_at', 'created_by', 'updated_by', 'change_note',
] as const;

/** 归档页保留文件 + front matter 标记（N5）；软删不写文件（撤文件） */
export type KnowledgeFileStatus = KnowledgeFileMeta['status'];

/** 解析失败原因（reconcile 报告与 API 404 都用它区分原因） */
export type KnowledgeFileParseIssue =
  | 'missing_front_matter'
  | 'missing_field'
  | 'bad_type'
  | 'bad_yaml'
  | 'empty_body';

export class KnowledgeFileParseError extends Error {
  readonly issue: KnowledgeFileParseIssue;
  readonly field: string | null;
  constructor(issue: KnowledgeFileParseIssue, field: string | null, detail: string) {
    super(`知识文件 front matter 解析失败（${issue}${field === null ? '' : `: ${field}`}）：${detail}`);
    this.name = 'KnowledgeFileParseError';
    this.issue = issue;
    this.field = field;
  }
}

/** 字段必填与类型校验（解析后调用；返回首个问题，无问题返回 null） */
export function validateKnowledgeFileMeta(meta: Record<string, unknown>): { issue: KnowledgeFileParseIssue; field: string } | null {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const field of KNOWLEDGE_FILE_FIELD_ORDER) {
    if (!(field in meta)) return { issue: 'missing_field', field };
  }
  const asString = (value: unknown): boolean => typeof value === 'string' && value !== '';
  if (!asString(meta.id) || !UUID_RE.test(meta.id as string)) return { issue: 'bad_type', field: 'id' };
  for (const field of ['slug', 'title', 'domain', 'content_hash', 'created_by', 'updated_by', 'change_note'] as const) {
    if (typeof meta[field] !== 'string') return { issue: 'bad_type', field };
  }
  if (!Number.isSafeInteger(meta.revision) || (meta.revision as number) < 1) return { issue: 'bad_type', field: 'revision' };
  if (meta.scope !== 'workspace' && meta.scope !== 'common') return { issue: 'bad_type', field: 'scope' };
  if (meta.scope === 'workspace' && !asString(meta.workspace_id)) return { issue: 'bad_type', field: 'workspace_id' };
  if (meta.scope === 'common' && meta.workspace_id !== null) return { issue: 'bad_type', field: 'workspace_id' };
  if (meta.status !== 'active' && meta.status !== 'archived') return { issue: 'bad_type', field: 'status' };
  if (!['design', 'solved', 'pinned', 'open', 'legacy'].includes(meta.category as string)) return { issue: 'bad_type', field: 'category' };
  if (meta.landed !== null && !['landed', 'partial', 'proposed'].includes(meta.landed as string)) return { issue: 'bad_type', field: 'landed' };
  if (!Array.isArray(meta.sources) || (meta.sources as unknown[]).length === 0) return { issue: 'bad_type', field: 'sources' };
  if (!Array.isArray(meta.evidence)) return { issue: 'bad_type', field: 'evidence' };
  for (const field of ['expires_at', 'created_at', 'updated_at'] as const) {
    if (meta[field] !== null && !Number.isSafeInteger(meta[field])) return { issue: 'bad_type', field };
  }
  return null;
}

/** 安全纯标量：不含 YAML 特殊字符，可原样输出 */
const PLAIN_SCALAR = /^[A-Za-z0-9][A-Za-z0-9._@/-]*$/;

function yamlScalar(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return String(value);
  const text = String(value);
  return PLAIN_SCALAR.test(text) ? text : JSON.stringify(text);
}

/** sources/evidence 条目的字段与输出顺序（固定，保证幂等） */
const SOURCE_FIELD_ORDER = ['source_id', 'source_type', 'locator', 'captured_at', 'content_hash', 'snapshot'] as const;
const EVIDENCE_FIELD_ORDER = ['source_id', 'locator', 'snapshot'] as const;

function renderArrayBlock(key: 'sources' | 'evidence', items: Array<Record<string, unknown>>): string {
  if (items.length === 0) return `${key}: []`;
  const order = key === 'sources' ? SOURCE_FIELD_ORDER : EVIDENCE_FIELD_ORDER;
  const lines = [`${key}:`];
  for (const item of items) {
    let first = true;
    for (const field of order) {
      if (!(field in item) || item[field] === undefined) continue;
      lines.push(`${first ? '  - ' : '    '}${field}: ${yamlScalar(item[field])}`);
      first = false;
    }
  }
  return lines.join('\n');
}

/**
 * 渲染完整文档：`---\n<front matter>---\n\n<body>`。
 * `omitFields` 用于 content_hash 计算（去掉该字段后渲染）。
 * 正文**原样落盘**（不自动补尾换行）：保证 `parse(render(meta, body)) === body` 的逐字节回读一致
 * （验收口径「POST 后 Docs/<slug>.md 与回读正文一致」）。
 */
export function renderKnowledgeDocument(meta: KnowledgeFileMeta, bodyMd: string, omitFields: readonly string[] = []): string {
  const omitted = new Set(omitFields);
  const lines: string[] = ['---'];
  for (const field of KNOWLEDGE_FILE_FIELD_ORDER) {
    if (omitted.has(field)) continue;
    const value = (meta as unknown as Record<string, unknown>)[field];
    if (field === 'sources' || field === 'evidence') {
      lines.push(renderArrayBlock(field, Array.isArray(value) ? value as Array<Record<string, unknown>> : []));
    } else if (field === 'workspace_id' || field === 'landed' || field === 'expires_at') {
      // 可空字段恒输出（显式 null），保证幂等
      lines.push(`${field}: ${yamlScalar(value ?? null)}`);
    } else {
      lines.push(`${field}: ${yamlScalar(value)}`);
    }
  }
  lines.push('---');
  return `${lines.join('\n')}\n\n${bodyMd}`;
}

/** 解析单个标量值：null / 整数 / JSON 双引号串 / 原样字符串 */
function parseScalar(raw: string): unknown {
  const text = raw.trim();
  if (text === 'null') return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try { return JSON.parse(text); } catch { throw new KnowledgeFileParseError('bad_yaml', null, `无法解析引号标量：${text.slice(0, 80)}`); }
  }
  if (text === '[]') return [];
  return text;
}

function parseArrayItem(fields: Array<{ key: string; value: unknown }>): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  for (const { key, value } of fields) item[key] = value;
  return item;
}

/**
 * 解析完整文档 → { meta, body_md }。
 * 只认本契约的受限子集：顶层 `key: value` 与 `sources:` / `evidence:` 两层数组块。
 * BOM 剥离；CRLF 归一。正文从第二个 `---` 之后取（去首个空行，保留尾部换行）。
 */
export function parseKnowledgeDocument(raw: string): { meta: KnowledgeFileMeta; body_md: string } {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') throw new KnowledgeFileParseError('missing_front_matter', null, '文件必须以 --- 开头');
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === '---') { close = i; break; }
  }
  if (close === -1) throw new KnowledgeFileParseError('missing_front_matter', null, 'front matter 缺少结束 ---');
  const meta: Record<string, unknown> = {};
  const knownScalar = new Set(KNOWLEDGE_FILE_FIELD_ORDER.filter(f => f !== 'sources' && f !== 'evidence'));
  for (let i = 1; i < close;) {
    const line = lines[i]!;
    const match = /^([A-Za-z_][A-Za-z0-9_]*): ?(.*)$/.exec(line);
    if (match === null) throw new KnowledgeFileParseError('bad_yaml', null, `无法识别的行：${line.slice(0, 80)}`);
    const key = match[1]!;
    if (key === 'sources' || key === 'evidence') {
      if (match[2]!.trim() === '[]') { meta[key] = []; i += 1; continue; }
      if (match[2]!.trim() !== '') throw new KnowledgeFileParseError('bad_yaml', key, '数组字段只支持块序列或 []');
      const items: Array<Record<string, unknown>> = [];
      let current: Array<{ key: string; value: unknown }> | null = null;
      i += 1;
      while (i < close) {
        const itemLine = lines[i]!;
        // 下一个顶层键（无缩进的 key:）→ 数组块结束，交回主循环
        if (/^[A-Za-z_][A-Za-z0-9_]*: ?/.test(itemLine)) break;
        if (/^  - /.test(itemLine)) {
          if (current !== null) items.push(parseArrayItem(current));
          current = [];
          const pair = /^  - ([A-Za-z_][A-Za-z0-9_]*): ?(.*)$/.exec(itemLine);
          if (pair === null) throw new KnowledgeFileParseError('bad_yaml', key, `无法识别的条目行：${itemLine.slice(0, 80)}`);
          current.push({ key: pair[1]!, value: parseScalar(pair[2]!) });
        } else if (/^    /.test(itemLine)) {
          const pair = /^    ([A-Za-z_][A-Za-z0-9_]*): ?(.*)$/.exec(itemLine);
          if (pair === null || current === null) throw new KnowledgeFileParseError('bad_yaml', key, `无法识别的条目续行：${itemLine.slice(0, 80)}`);
          current.push({ key: pair[1]!, value: parseScalar(pair[2]!) });
        } else if (itemLine.trim() === '') {
          i += 1;
          continue;
        } else {
          throw new KnowledgeFileParseError('bad_yaml', key, `数组块缩进不合法：${itemLine.slice(0, 80)}`);
        }
        i += 1;
      }
      if (current !== null) items.push(parseArrayItem(current));
      meta[key] = items;
      continue;
    }
    if (!knownScalar.has(key as never)) throw new KnowledgeFileParseError('bad_yaml', key, `未知字段：${key}`);
    meta[key] = parseScalar(match[2]!);
    i += 1;
  }
  const invalid = validateKnowledgeFileMeta(meta);
  if (invalid !== null) throw new KnowledgeFileParseError(invalid.issue, invalid.field, '必填字段缺失或类型不符');
  // 正文：结束 --- 之后，去掉一个空行分隔
  let bodyLines = lines.slice(close + 1);
  while (bodyLines.length > 0 && bodyLines[0]!.trim() === '') bodyLines = bodyLines.slice(1);
  const body = bodyLines.join('\n');
  return { meta: meta as unknown as KnowledgeFileMeta, body_md: body };
}

/**
 * 文件名清洗（N3）：slug → `<norm>.md`。
 * NFKC + 空白折叠为 `-` + 小写（与 wikilink 归一同一函数口径）→ Windows 非法字符/保留名处理 →
 * 80 字符截断（sanitizeExportFilename 口径）。slug 本身的格式校验（`[\p{L}\p{N}]...`）在服务层。
 */
const WINDOWS_RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);
const MAX_FILE_NAME_CHARS = 80;

export function normalizeDocSlug(raw: string): string {
  return raw.normalize('NFKC').trim().replace(/\s+/g, '-').toLowerCase();
}

export function docFileNameFor(slug: string): string {
  let name = normalizeDocSlug(slug)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, MAX_FILE_NAME_CHARS)
    .replace(/[-. ]+$/g, '');
  if (name === '') name = 'untitled';
  if (WINDOWS_RESERVED.has(name.toUpperCase())) name = `_${name}`;
  return `${name}.md`;
}
