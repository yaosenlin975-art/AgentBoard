/**
 * KBIMP-1：知识页文本导入（md / txt / json）。
 *
 * 设计取舍：
 * - **纯函数 + 注入依赖**：解析/标题/ slug/来源构造都在这里，落库仍走既有 `createKnowledgePage`
 *   （它自带事务：页面行 + 首发修订 + 双链同步，失败不留半成品）。
 * - **json 不塞正文**：只接受「对象」或「对象数组」，每个对象映射成一条知识页；字段固定为
 *   `{ title?, body|body_md, labels?, category?, landed?, slug? }`，多出来的字段记 warnings 而不是拼进正文。
 * - **来源自动构造**：`source_type: 'file'` + `locator` 为文件名（或 `<import:{format}>`）+ 内容 sha256；
 *   `file` 来源**不写 snapshot**（`validateKnowledgeContent` 会拒），evidence 至少 1 条且同样不带 snapshot。
 * - 限额：单文件/请求正文 ≤1MB（UTF-8 字节），`body_md` ≤100000 字符（与知识页存量一致）。
 */
import { createHash } from 'node:crypto';
import { KnowledgeErrorCode } from '../api/knowledgeCodes.js';
import { KNOWLEDGE_DOMAINS, KNOWLEDGE_SHORT_ID_LEN, type KnowledgeDomain } from '@agentboard/shared';
import type { KnowledgeEvidence, KnowledgePage, KnowledgeSource } from '@agentboard/shared';
import { ApiError, ValidationError } from '../errors.js';
import { createKnowledgePage, requireKnowledgeDomain } from '../db/repos/knowledge.js';
import { KNOWLEDGE_BODY_MAX_CHARS } from './knowledge.js';
import type { Db } from '../db/connection.js';

/** IMPORT-LIMIT-S：单次导入内容上限 10MB（与前端预检 10MB 同口径；请求体上限见 index.ts 的 12MB parser） */
export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
/** IMPORT-LIMIT-S：单页正文上限（引用领域常量，不另立数字） */
export const IMPORT_MAX_BODY_CHARS = KNOWLEDGE_BODY_MAX_CHARS;
export const IMPORT_TITLE_MAX = 300;
/** title 兜底上限（txt 首行） */
const TXT_TITLE_MAX = 80;

export type ImportFormat = 'md' | 'txt' | 'json';

export interface ImportRequestInput {
  scope: 'workspace' | 'common';
  workspace_id?: string;
  format: ImportFormat;
  content: string;
  /** 文件名（用于 locator 与 md/txt 的标题兜底） */
  filename?: string;
  title?: string;
  slug?: string;
  category?: KnowledgePage['category'];
  landed?: KnowledgePage['landed'];
  /** KB-CR-1：导入即建页，domain 必填（json 条目内可逐条覆盖）；null 与缺省同义，由 requireKnowledgeDomain 拒 */
  domain?: string | null;
  labels?: string[];
  actor?: string;
  change_note?: string;
}

/** 单条待导入的知识页内容（json 数组会有多条） */
export interface ImportPageDraft {
  title: string;
  body_md: string;
  domain: KnowledgeDomain;
  category?: KnowledgePage['category'];
  landed?: KnowledgePage['landed'];
  slug?: string;
  labels: string[];
}

const SLUG_ALLOWED = /^[\p{L}\p{N}][\p{L}\p{N}._/-]{0,199}$/u;

/** 从标题生成 slug：保留 Unicode 字母数字，其余折叠成 `-`；空则用 `import-<hash>` 兜底 */
export function slugifyTitle(title: string, fallbackSeed?: string): string {
  const base = title
    .normalize('NFKC')
    .replace(/[\s\u3000]+/gu, '-')
    .replace(/[^\p{L}\p{N}._/-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._/]+|[-._/]+$/gu, '')
    .slice(0, 120);
  if (SLUG_ALLOWED.test(base)) return base;
  const seed = createHash('sha256').update(fallbackSeed ?? title).digest('hex').slice(0, KNOWLEDGE_SHORT_ID_LEN);
  return `import-${seed}`;
}

/** md：正文首个 `# ` 一级标题优先 */
export function mdTitle(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) return match[1]!.trim();
    if (line.trim() === '') continue;
    // 首个非空行不是标题就不再往后找（避免把文中 `#` 当标题）
    if (!line.startsWith('#')) break;
  }
  return null;
}

/** txt：首行（去掉 markdown 头部噪声），≤80 字符 */
export function txtTitle(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const text = line.trim();
    if (text === '') continue;
    return text.slice(0, TXT_TITLE_MAX);
  }
  return null;
}

export function baseName(filename: string | undefined): string | null {
  if (filename === undefined) return null;
  const parts = filename.split(/[\\/]/).filter((part) => part !== '');
  const last = parts.at(-1);
  if (last === undefined) return null;
  return last.replace(/\.[^.]*$/, '') || last;
}

export function assertContentLimits(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > IMPORT_MAX_BYTES) {
    throw new ApiError(413, 'IMPORT_TOO_LARGE', `导入内容 ${bytes} 字节，超过单次上限 ${IMPORT_MAX_BYTES} 字节（10MB）`);
  }
  if (content.trim() === '') throw new ValidationError('导入内容不能为空');
}

/** 自动构造的来源（file 来源不写 snapshot）与证据 */
export function buildSources(content: string, filename: string | undefined, format: ImportFormat, now: number): {
  sources: KnowledgeSource[];
  evidence: KnowledgeEvidence[];
} {
  const locator = filename !== undefined && filename.trim() !== '' ? filename.trim() : `<import:${format}>`;
  const sourceId = `import:${createHash('sha256').update(content).digest('hex').slice(0, 12)}`;
  return {
    sources: [{
      source_id: sourceId,
      source_type: 'file',
      locator,
      captured_at: now,
      content_hash: createHash('sha256').update(content).digest('hex'),
    }],
    evidence: [{ source_id: sourceId, locator }],
  };
}

/** KBIMP-1B2：json 逐条允许的分类与落地状态（与 zod 顶层枚举、repos 的归一规则同一套值） */
export const IMPORT_CATEGORY_VALUES = ['design', 'solved', 'pinned', 'open', 'legacy'] as const;
export const IMPORT_LANDED_VALUES = ['landed', 'partial', 'proposed'] as const;

/**
 * 逐条取值（KBIMP-1B2）：
 * - 键存在 → 用本条的值（**逐条优先于请求顶层**）；`null`/`''` 表示本条未指定（不继承顶层）；
 * - 键不存在 → 继承顶层；
 * - 值非法 → 400，且 message 指明第几条与可选值（不静默归一成 legacy/proposed）。
 */
function pickPerItem<T extends string>(
  record: Record<string, unknown>,
  key: 'category' | 'landed',
  allowed: readonly T[],
  index: number,
  fallback: T | null | undefined,
): T | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return fallback;
  const raw = record[key];
  if (raw === null || raw === '') return key === 'landed' ? null : undefined;
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) return raw as T;
  const shown = typeof raw === 'string' ? raw : JSON.stringify(raw);
  throw new ValidationError(
    `第 ${index + 1} 条 ${key} 非法：${shown}（可选 ${allowed.join(' / ')}${key === 'landed' ? '；null 表示未落地' : ''}）`,
  );
}

/**
 * KB-CR-1：json 逐条 domain（词表来自 `@agentboard/shared`）。
 * 键不存在 / `null` / `''` → 继承请求顶层（domain 必填，顶层已校验过）；非法值 → 400 并指明第几条。
 */
function pickDomain(record: Record<string, unknown>, index: number, fallback: KnowledgeDomain): KnowledgeDomain {
  if (!Object.prototype.hasOwnProperty.call(record, 'domain')) return fallback;
  const raw = record.domain;
  if (raw === null || raw === '') return fallback;
  if (typeof raw === 'string' && (KNOWLEDGE_DOMAINS as readonly string[]).includes(raw)) return raw as KnowledgeDomain;
  const shown = typeof raw === 'string' ? raw : JSON.stringify(raw);
  throw new ValidationError(`第 ${index + 1} 条 domain 非法：${shown}（可选 ${KNOWLEDGE_DOMAINS.join(' / ')}）`);
}

/**
 * json 映射：支持
 * 1) 单个对象 `{ title?, body|body_md, labels?, category?, landed?, slug?, domain? }`
 * 2) 对象数组（逐条建页）
 * 其它形态（字符串/数字/嵌套数组）一律 400，绝不把整个 json 塞进正文。
 */
export function mapJsonPages(content: string, overrides: { title?: string; category?: KnowledgePage['category']; landed?: KnowledgePage['landed']; domain: KnowledgeDomain }): { drafts: ImportPageDraft[]; warnings: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new ValidationError(`json 解析失败：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0) throw new ValidationError('json 数组为空，没有可导入的条目');
  if (items.length > 100) throw new ValidationError(`一次最多导入 100 条（当前 ${items.length} 条）`);
  const warnings: string[] = [];
  const drafts: ImportPageDraft[] = [];
  items.forEach((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ValidationError(`第 ${index + 1} 条不是对象：json 只支持 {title?, body|body_md, ...} 或它们的数组`);
    }
    const record = item as Record<string, unknown>;
    const body = typeof record.body_md === 'string' ? record.body_md : typeof record.body === 'string' ? record.body : null;
    if (body === null || body.trim() === '') {
      throw new ValidationError(`第 ${index + 1} 条缺少正文：需要 body 或 body_md 字符串`);
    }
    const titleRaw = typeof record.title === 'string' ? record.title.trim() : '';
    const labels = Array.isArray(record.labels) ? record.labels.filter((l): l is string => typeof l === 'string') : [];
    const extra = Object.keys(record).filter((key) => !['title', 'body', 'body_md', 'labels', 'category', 'landed', 'slug', 'domain'].includes(key));
    if (extra.length > 0) warnings.push(`第 ${index + 1} 条忽略了不支持的字段：${extra.join('、')}`);
    // KBIMP-1B2：逐条优先于顶层——键出现即生效（显式 null 也算「本条未指定」，不继承顶层）
    const category = pickPerItem(record, 'category', IMPORT_CATEGORY_VALUES, index, overrides.category) ?? undefined;
    const landed = pickPerItem(record, 'landed', IMPORT_LANDED_VALUES, index, overrides.landed);
    drafts.push({
      title: (titleRaw !== '' ? titleRaw : (overrides.title ?? txtTitle(body) ?? '导入的知识页')).slice(0, IMPORT_TITLE_MAX),
      body_md: body,
      domain: pickDomain(record, index, overrides.domain),
      ...(category === undefined ? {} : { category }),
      ...(landed === undefined ? {} : { landed }),
      ...(typeof record.slug === 'string' && record.slug.trim() !== '' ? { slug: record.slug.trim() } : {}),
      labels,
    });
  });
  return { drafts, warnings };
}

/** md / txt 单页草稿 */
export function mapTextPage(input: ImportRequestInput, domain: KnowledgeDomain): { drafts: ImportPageDraft[]; warnings: string[] } {
  const warnings: string[] = [];
  const fromFile = baseName(input.filename);
  let title: string | null = input.title?.trim() || null;
  if (title === null) {
    title = input.format === 'md' ? mdTitle(input.content) : txtTitle(input.content);
  }
  if (title === null) title = fromFile;
  if (title === null) title = `导入的${input.format === 'md' ? ' Markdown' : '文本'}页`;
  const labels = input.labels ?? [];
  if (labels.length > 0) warnings.push('知识页没有 labels 字段，导入时忽略 labels（可写进正文或变更说明）');
  return {
    drafts: [{
      title: title.slice(0, IMPORT_TITLE_MAX),
      body_md: input.content,
      domain,
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.landed === undefined ? {} : { landed: input.landed }),
      ...(input.slug === undefined || input.slug.trim() === '' ? {} : { slug: input.slug.trim() }),
      labels,
    }],
    warnings,
  };
}

/** 纯函数入口：把一次导入请求映射成 N 份草稿（不落库，便于单测） */
export function planImport(input: ImportRequestInput): { drafts: ImportPageDraft[]; warnings: string[] } {
  assertContentLimits(input.content);
  // KB-CR-1：导入即建页，domain 必填（缺省 / null / '' / 非法词表 → 中文 4xx）
  const domain = requireKnowledgeDomain(input.domain);
  const planned = input.format === 'json'
    ? mapJsonPages(input.content, { ...(input.title === undefined ? {} : { title: input.title }), ...(input.category === undefined ? {} : { category: input.category }), ...(input.landed === undefined ? {} : { landed: input.landed }), domain })
    : mapTextPage(input, domain);
  for (const draft of planned.drafts) {
    if (draft.body_md.length > IMPORT_MAX_BODY_CHARS) {
      throw new ApiError(413, 'IMPORT_BODY_TOO_LONG', `正文 ${draft.body_md.length} 字符，超过单页上限 ${IMPORT_MAX_BODY_CHARS.toLocaleString('en-US')} 字符`);
    }
  }
  return planned;
}

export interface ImportResult {
  pages: KnowledgePage[];
  warnings: string[];
}

/** 已存在时的建议 slug（`x` → `x-2`、`x-3`…；最多试 20 次） */
export function suggestSlug(db: Db, scope: { scope: 'workspace' | 'common'; workspaceId: string | null }, slug: string): string | null {
  for (let i = 2; i <= 20; i += 1) {
    const candidate = `${slug}-${i}`.slice(0, 200);
    const exists = db.prepare('SELECT 1 FROM knowledge_page WHERE scope=? AND workspace_id IS ? AND slug=? AND status<>\'deleted\'')
      .get(scope.scope, scope.workspaceId, candidate);
    if (exists === undefined) return candidate;
  }
  return null;
}

/** 落库：逐条走既有 createKnowledgePage（自带事务）；slug 冲突 → 409 并给建议 */
/** workspace scope 必须带 workspace_id（KnowledgeScope 是判别联合） */
function requireWorkspaceId(input: ImportRequestInput): string {
  const id = input.workspace_id?.trim();
  if (id === undefined || id === '') throw new ValidationError('scope=workspace 时必须提供 workspace_id');
  return id;
}
export function importKnowledgePages(
  db: Db,
  input: ImportRequestInput,
  deps: { now?: () => number; actor?: string } = {},
): ImportResult {
  const now = deps.now ?? (() => Date.now());
  const planned = planImport(input);
  const scope = input.scope === 'workspace'
    ? ({ scope: 'workspace' as const, workspace_id: requireWorkspaceId(input) })
    : ({ scope: 'common' as const });
  const { sources, evidence } = buildSources(input.content, input.filename, input.format, now());
  const actor = deps.actor ?? input.actor ?? 'importer';
  const pages: KnowledgePage[] = [];
  for (const draft of planned.drafts) {
    const slug = draft.slug ?? slugifyTitle(draft.title, `${input.format}:${draft.title}`);
    try {
      pages.push(createKnowledgePage(db, {
        ...scope,
        slug,
        title: draft.title,
        body_md: draft.body_md,
        domain: draft.domain,
        sources,
        evidence,
        actor,
        ...(draft.category === undefined ? {} : { category: draft.category }),
        ...(draft.landed === undefined ? {} : { landed: draft.landed }),
        ...(input.change_note === undefined ? {} : { change_note: input.change_note }),
      }));
    } catch (error) {
      if (error instanceof ApiError && error.code === KnowledgeErrorCode.EXISTS) {
        const suggestion = suggestSlug(db, { scope: scope.scope, workspaceId: scope.scope === 'workspace' ? scope.workspace_id : null }, slug);
        throw new ApiError(
          409,
          KnowledgeErrorCode.EXISTS,
          `范围内已存在 slug「${slug}」（${scope.scope === 'workspace' ? `工作区 ${scope.workspace_id}` : '公共库'}）`
            + (suggestion === null ? '；请换一个 slug' : `；可改用「${suggestion}」或先归档同 slug 的旧页`),
        );
      }
      throw error;
    }
  }
  return { pages, warnings: planned.warnings };
}
