/**
 * P2-01（方向 B §7.2/§7.3/§8 #2）：知识文件的内存索引与落盘可重建检索索引。
 *
 * - `DocsIndex` 绑定一个 Docs 目录（scope 由目录决定，N4）；启动/首次请求扫描建索引，
 *   之后每个读操作前 `ensureFresh()`（readdir+stat 差量，mtimeMs+size 变化才重读解析）。
 * - **索引不是事实源**：正文读路径直接读文件；这里缓存的 body 仅供检索/图聚合，
 *   文件变更在下次请求时差量刷新（不引入文件监听，C12）。
 * - 落盘检索索引 `<Docs>/.index.json`：承载 bm25 排序、trigram／1–2 字符子串、snippet 所需的
 *   全部数据（meta + 正文）。可全量重建、非事实源：加载时校验 stat 与 content_hash，任何
 *   不符即重建并回写（「删除 .index.json 后首次请求重建且结果等价」）。
 * - 检索语义对照旧 FTS5 实现（db/repos/knowledgeSearch.ts，旧库只读回退保留）：
 *   · ≥3 码点：trigram 全命中 + 子串确认，bm25 排序（title 权重 5 / body 权重 1，k1=1.2 b=0.75），
 *     score 为负值、越小越相关（对齐 FTS5 bm25 的 ORDER BY score ASC 口径；数值与 FTS5 不逐字节相等，
 *     score 语义变化按 §8 #2 写进 Docs/api.md，由 P2-04 落文档）。
 *   · 1–2 码点：title/body 大小写不敏感子串，title 命中 score=-1。
 *   · snippet：首个命中位置前 100 字符起、≤1200 字符（照抄旧 JS 截断口径）。
 * - 排序键：score ASC, scope='workspace' DESC, updated_at DESC, id ASC（单目录）；
 *   跨目录（scope=both）合并按 (updated_at desc, id asc)——与旧跨库合并口径一致。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { KnowledgeFileParseError, type KnowledgeFileMeta } from '@agentboard/shared';
import { computeContentHash } from './frontMatter.js';
import { indexPathFor } from './paths.js';
import { listDocFiles, readDocFile, type ScannedFileInfo } from './scanner.js';
import { parseKnowledgeRefs, type KnowledgeRefs } from '../services/knowledgeLinks.js';

export interface DocEntry {
  fileName: string;
  path: string;
  mtimeMs: number;
  size: number;
  meta: KnowledgeFileMeta;
  body: string;
  /** 解析/校验问题（reconcile 报告用；非空时该文件不参与检索与图） */
  issues: string[];
}

/** 解析失败/校验不过的文件（进 reconcile 报告，不进 byId/bySlugNorm）；读得出 meta/body 时携带 */
export interface InvalidDocFile {
  fileName: string;
  path: string;
  mtimeMs: number;
  size: number;
  issues: string[];
  meta?: KnowledgeFileMeta;
  body?: string;
}

export interface ScopeIdentity {
  scope: 'workspace' | 'common';
  workspace_id: string | null;
}

const INDEX_VERSION = 1;
const BODY_EXCERPT = 2000; // 与 db/repos/knowledge.ts GRAPH_TEXT_EXCERPT 同口径

export class DocsIndex {
  readonly docsDir: string;
  readonly scopeIdentity: ScopeIdentity;
  private entries = new Map<string, DocEntry>();
  private invalid = new Map<string, InvalidDocFile>();
  private byId = new Map<string, DocEntry>();
  /** 坏文件（含外部编辑 content_hash 不符）也按 id 可见——写路径要显式报 409 而非伪装成不存在 */
  private byIdInvalid = new Map<string, InvalidDocFile>();
  private bySlugNorm = new Map<string, DocEntry[]>();
  private trigrams = new Map<string, Set<string>>();
  private lastError: string | null = null;

  constructor(docsDir: string, scopeIdentity: ScopeIdentity) {
    this.docsDir = docsDir;
    this.scopeIdentity = scopeIdentity;
  }

  // ---- 刷新 ----

  /** 差量刷新：readdir+stat，mtime/size 不变的文件沿用缓存；其余重读。任何读路径前调用 */
  ensureFresh(): void {
    const files = listDocFiles(this.docsDir);
    const seen = new Set<string>();
    let changed = false;
    for (const file of files) {
      seen.add(file.fileName);
      const cached = this.entries.get(file.fileName);
      const cachedInvalid = this.invalid.get(file.fileName);
      if (cached !== undefined && cached.mtimeMs === file.mtimeMs && cached.size === file.size) continue;
      if (cachedInvalid !== undefined && cachedInvalid.mtimeMs === file.mtimeMs && cachedInvalid.size === file.size) continue;
      this.loadFile(file);
      changed = true;
    }
    for (const fileName of [...this.entries.keys(), ...this.invalid.keys()]) {
      if (!seen.has(fileName)) {
        this.entries.delete(fileName);
        this.invalid.delete(fileName);
        this.trigrams.delete(fileName);
        changed = true;
      }
    }
    if (changed) this.rebuildMaps();
  }

  private loadFile(file: ScannedFileInfo): void {
    this.trigrams.delete(file.fileName);
    try {
      const { meta, body_md } = readDocFile(this.docsDir, file.path);
      const issues: string[] = [];
      if (meta.scope !== this.scopeIdentity.scope) issues.push(`scope: front matter ${meta.scope} 与所在目录 ${this.scopeIdentity.scope} 不一致`);
      if (meta.workspace_id !== this.scopeIdentity.workspace_id) issues.push(`workspace_id: front matter ${String(meta.workspace_id)} 与所在目录不符`);
      const recomputed = computeContentHash({ ...meta, content_hash: '' } as never, body_md);
      if (recomputed !== meta.content_hash) issues.push('content_hash: 与文档内容不符（外部编辑未走 API/CLI）');
      if (issues.length === 0) {
        this.entries.set(file.fileName, { fileName: file.fileName, path: file.path, mtimeMs: file.mtimeMs, size: file.size, meta, body: body_md, issues });
        this.invalid.delete(file.fileName);
      } else {
        this.entries.delete(file.fileName);
        this.invalid.set(file.fileName, { fileName: file.fileName, path: file.path, mtimeMs: file.mtimeMs, size: file.size, issues, meta, body: body_md });
      }
    } catch (error) {
      this.entries.delete(file.fileName);
      const issues = [error instanceof KnowledgeFileParseError ? `front matter: ${error.message}` : `读取失败: ${error instanceof Error ? error.message : String(error)}`];
      this.invalid.set(file.fileName, { fileName: file.fileName, path: file.path, mtimeMs: file.mtimeMs, size: file.size, issues });
    }
  }

  private rebuildMaps(): void {
    this.byId.clear();
    this.byIdInvalid.clear();
    this.bySlugNorm.clear();
    for (const entry of this.entries.values()) {
      const existing = this.byId.get(entry.meta.id);
      if (existing === undefined) this.byId.set(entry.meta.id, entry);
      else existing.issues.push(`id: 与 ${existing.fileName} 重复`);
      const norm = slugNormOf(entry.meta.slug);
      const bucket = this.bySlugNorm.get(norm);
      if (bucket === undefined) this.bySlugNorm.set(norm, [entry]);
      else bucket.push(entry);
    }
    for (const entry of this.invalid.values()) {
      if (entry.meta !== undefined && !this.byIdInvalid.has(entry.meta.id)) this.byIdInvalid.set(entry.meta.id, entry);
    }
  }

  private slugSet(fileName: string): Set<string> {
    let set = this.trigrams.get(fileName);
    if (set === undefined) {
      const entry = this.entries.get(fileName);
      set = new Set(trigramsOf(`${entry!.meta.title}\n${entry!.body}`));
      this.trigrams.set(fileName, set);
    }
    return set;
  }

  /** 单文件写后刷新（fileRepo 写协议收尾调用） */
  notifyChanged(fileName: string): void {
    const files = listDocFiles(this.docsDir);
    const file = files.find(item => item.fileName === fileName);
    if (file === undefined) {
      this.entries.delete(fileName);
      this.invalid.delete(fileName);
      this.trigrams.delete(fileName);
    } else {
      this.loadFile(file);
    }
    this.rebuildMaps();
  }

  /**
   * OCR C3：批量通知。逐文件 `notifyChanged` 每次都 `listDocFiles`（全目录 stat）+
   * `rebuildMaps`（全量重建），1000 文件 × 100 引用 ≈ 10 万次 stat + 3–10 s 阻塞。
   * 这里只 readdir/stat 一次、`rebuildMaps` 一次。
   */
  notifyManyChanged(fileNames: readonly string[]): void {
    if (fileNames.length === 0) return;
    const wanted = new Set(fileNames);
    const files = listDocFiles(this.docsDir);
    const found = new Map<string, ScannedFileInfo>();
    for (const file of files) if (wanted.has(file.fileName)) found.set(file.fileName, file);
    for (const fileName of wanted) {
      const file = found.get(fileName);
      if (file === undefined) {
        this.entries.delete(fileName);
        this.invalid.delete(fileName);
        this.trigrams.delete(fileName);
      } else {
        this.loadFile(file);
      }
    }
    this.rebuildMaps();
  }

  // ---- 读取 ----

  get activeCount(): number {
    return [...this.entries.values()].filter(entry => entry.meta.status === 'active').length;
  }

  allEntries(): DocEntry[] {
    this.ensureFresh();
    return [...this.entries.values()];
  }

  allInvalid(): InvalidDocFile[] {
    this.ensureFresh();
    return [...this.invalid.values()];
  }

  lastRefreshError(): string | null {
    return this.lastError;
  }

  getById(id: string, options: { includeArchived?: boolean } = {}): DocEntry | null {
    const entry = this.byId.get(id) ?? null;
    if (entry === null) return null;
    if (entry.meta.status === 'archived' && options.includeArchived !== true) return null;
    return entry;
  }

  /** 软删不可寻址：删文件即消失；archived 只在显式索取时可见 */
  getByIdIncludeArchived(id: string): DocEntry | null {
    return this.byId.get(id) ?? null;
  }

  /** 含坏文件的 id 查找（写路径用：外部编辑的页要显式 409，不伪装成不存在） */
  getByIdAny(id: string): DocEntry | InvalidDocFile | null {
    return this.byId.get(id) ?? this.byIdInvalid.get(id) ?? null;
  }

  getBySlug(slug: string): DocEntry[] {
    this.ensureFresh();
    return [...(this.bySlugNorm.get(slugNormOf(slug)) ?? [])];
  }

  entryOf(entry: DocEntry, options: { includeArchived?: boolean } = {}): boolean {
    if (entry.meta.status === 'archived' && options.includeArchived !== true) return false;
    return true;
  }

  /** 图聚合行（对齐 listKnowledgeGraphRows 列口径：active、按 id 排序、上限截断） */
  graphRows(maxPages: number): { rows: Array<{ id: string; scope: 'workspace' | 'common'; workspace_id: string | null; title: string; body_md: string; body_chars: number; sources: KnowledgeFileMeta['sources']; category: string | null; landed: string | null }>; pagesTruncated: boolean; pageTotal: number } {
    const all = this.allEntries().filter(entry => entry.meta.status === 'active').sort((a, b) => (a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0));
    const rows = all.slice(0, maxPages).map(entry => ({
      id: entry.meta.id,
      scope: entry.meta.scope,
      workspace_id: entry.meta.workspace_id,
      title: entry.meta.title,
      body_md: [...entry.body].slice(0, BODY_EXCERPT).join(''),
      body_chars: [...entry.body].length,
      sources: entry.meta.sources,
      category: entry.meta.category,
      landed: entry.meta.landed,
    }));
    return { rows, pagesTruncated: all.length > maxPages, pageTotal: all.length };
  }

  /**
   * 解析后的双链（link 边）：target 解析顺序 = 本目录优先，再 `cross` 目录（M2：
   * 工作区页 → 本区 Docs 未命中 → `~/.agentboard/Docs`；common 页不指工作区页）。
   * 返回 { source, target, weight }（target 为页 id）与 unresolved 清单。
   */
  resolveLinks(cross: DocsIndex | null): { links: Array<{ source: string; target: string; weight: number }>; unresolved: Array<{ source: string; raw_target: string; alias: string | null; heading: string | null }> } {
    const refs = this.graphRefs(cross);
    return {
      links: refs.links.filter(link => link.kind === 'link').map(({ source, target, weight }) => ({ source, target, weight })),
      unresolved: refs.unresolved.map(({ source, raw_target, alias, heading }) => ({ source, raw_target, alias, heading })),
    };
  }

  // ---- P2-03：图引用全量（link/embed 边、tag/attachment/unresolved 节点数据） ----

  /** P2-03 图边/节点引用行（weight 已按出现次数合并；M2 跨目录解析同 resolveLinks） */
  graphRefs(cross: DocsIndex | null): {
    links: Array<{ source: string; target: string; weight: number; kind: 'link' | 'embed' }>;
    /** 未命中目标（含页嵌入未命中）：ref = 归一目标（页面 slug 或附件 key） */
    unresolved: Array<{ source: string; ref: string; raw_target: string; alias: string | null; heading: string | null; weight: number }>;
    /** 本目录正文引用的附件（key = 归一 basename；scope/workspace_id 按目录身份） */
    attachments: Array<{ key: string; name: string; weight: number; refs: Array<{ source: string; weight: number }> }>;
    /** 本目录正文里的标签（weight = 出现次数合计） */
    tags: Array<{ tag_norm: string; raw_tag: string; weight: number; refs: Array<{ source: string; weight: number }> }>;
  } {
    this.ensureFresh();
    const links: Array<{ source: string; target: string; weight: number; kind: 'link' | 'embed' }> = [];
    const unresolved: Array<{ source: string; ref: string; raw_target: string; alias: string | null; heading: string | null; weight: number }> = [];
    const attachmentRefs = new Map<string, { name: string; refs: Array<{ source: string; weight: number }> }>();
    const tagRefs = new Map<string, { raw_tag: string; refs: Array<{ source: string; weight: number }> }>();
    const resolvePage = (slugNorm: string): string | null =>
      this.lookupTarget(slugNorm) ?? (this.scopeIdentity.scope === 'workspace' ? cross?.lookupTarget(slugNorm) ?? null : null);
    for (const entry of this.entries.values()) {
      if (entry.meta.status !== 'active') continue;
      const source = entry.meta.id;
      const refs = parseRefsCached(entry);
      for (const parsed of refs.links) {
        const target = resolvePage(parsed.target_slug_norm);
        if (target !== null) links.push({ source, target, weight: parsed.weight, kind: 'link' });
        else unresolved.push({ source, ref: parsed.target_slug_norm, raw_target: parsed.raw_target, alias: parsed.alias, heading: parsed.heading, weight: parsed.weight });
      }
      for (const parsed of refs.embeds) {
        const target = resolvePage(parsed.target_slug_norm);
        if (target !== null) links.push({ source, target, weight: parsed.weight, kind: 'embed' });
        else unresolved.push({ source, ref: parsed.target_slug_norm, raw_target: parsed.raw_target, alias: parsed.alias, heading: null, weight: parsed.weight });
      }
      for (const parsed of refs.attachments) {
        const bucket = attachmentRefs.get(parsed.target_slug_norm);
        if (bucket === undefined) attachmentRefs.set(parsed.target_slug_norm, { name: parsed.raw_target.split(/[\\/]/).pop() ?? parsed.raw_target, refs: [{ source, weight: parsed.weight }] });
        else bucket.refs.push({ source, weight: parsed.weight });
      }
      for (const parsed of refs.tags) {
        const bucket = tagRefs.get(parsed.tag_norm);
        if (bucket === undefined) tagRefs.set(parsed.tag_norm, { raw_tag: parsed.raw_tag, refs: [{ source, weight: parsed.weight }] });
        else bucket.refs.push({ source, weight: parsed.weight });
      }
    }
    return {
      links,
      unresolved,
      attachments: [...attachmentRefs.entries()].map(([key, value]) => ({ key, name: value.name, weight: value.refs.reduce((sum, ref) => sum + ref.weight, 0), refs: value.refs })),
      tags: [...tagRefs.entries()].map(([tag_norm, value]) => ({ tag_norm, raw_tag: value.raw_tag, weight: value.refs.reduce((sum, ref) => sum + ref.weight, 0), refs: value.refs })),
    };
  }

  /** M2 解析顺序的目录内一跳（返回页 id） */
  lookupTarget(slugNorm: string): string | null {
    const bucket = this.bySlugNorm.get(slugNorm);
    if (bucket === undefined || bucket.length === 0) return null;
    const active = bucket.find(entry => entry.meta.status === 'active');
    return active?.meta.id ?? null;
  }

  /**
   * 反链：指向 pageId 的活跃源页（`[[...]]` 双链与 `![[page]]` 页嵌入都算引用，S-4/S-7）；
   * 同一源页只一行（对齐旧 knowledge_link 行语义：link 命中优先于 embed）；`cross` 供工作区目录
   * 解析跨目录目标（M2：ws → 公共 Docs）
   */
  backlinks(pageId: string, cross: DocsIndex | null = null): Array<{ page_id: string; slug: string; title: string; alias: string | null; heading: string | null; kind: 'link' | 'embed' }> {
    this.ensureFresh();
    const byPage = new Map<string, { page_id: string; slug: string; title: string; alias: string | null; heading: string | null; kind: 'link' | 'embed' }>();
    for (const entry of this.entries.values()) {
      if (entry.meta.status !== 'active') continue;
      const refs = parseRefsCached(entry);
      const hit = (targetSlugNorm: string, alias: string | null, heading: string | null, kind: 'link' | 'embed'): void => {
        const target = this.lookupTarget(targetSlugNorm)
          ?? (this.scopeIdentity.scope === 'workspace' ? cross?.lookupTarget(targetSlugNorm) ?? null : null);
        if (target === pageId && !byPage.has(entry.meta.id)) {
          byPage.set(entry.meta.id, { page_id: entry.meta.id, slug: entry.meta.slug, title: entry.meta.title, alias, heading, kind });
        }
      };
      for (const parsed of refs.links) hit(parsed.target_slug_norm, parsed.alias, parsed.heading, 'link');
      for (const parsed of refs.embeds) hit(parsed.target_slug_norm, parsed.alias, null, 'embed');
    }
    return [...byPage.values()].sort((a, b) => (a.page_id < b.page_id ? -1 : a.page_id > b.page_id ? 1 : 0));
  }

  // ---- 检索 ----

  /**
   * 单目录检索。scope=both 的跨目录合并（(updated_at desc, id asc) + truncated）由调用方
   * （knowledgeRoutes / store）完成——分数跨目录不可比，与旧跨库口径一致。
   */
  search(input: { query: string; limit: number; now: number }): Array<{
    page_id: string; id: string; updated_at: number; scope: 'workspace' | 'common'; workspace_id: string | null; revision: number; title: string;
    slug: string; status: 'active'; snippet: string; sources: KnowledgeFileMeta['sources']; evidence: KnowledgeFileMeta['evidence']; score: number;
  }> {
    this.ensureFresh();
    const chars = [...input.query];
    const lower = input.query.toLowerCase();
    const long = chars.length >= 3;
    const qTrigrams = long ? new Set(trigramsOf(input.query)) : null;
    type Hit = { entry: DocEntry; score: number };
    const hits: Hit[] = [];
    const eligible = this.allEntries().filter(entry =>
      entry.meta.status === 'active' && (entry.meta.expires_at === null || entry.meta.expires_at > input.now));
    if (long && qTrigrams !== null && qTrigrams.size > 0) {
      const candidates = eligible.filter(entry => {
        const set = this.slugSet(entry.fileName);
        for (const t of qTrigrams) if (!set.has(t)) return false;
        return entry.meta.title.toLowerCase().includes(lower) || entry.body.toLowerCase().includes(lower);
      });
      hits.push(...bm25Rank(candidates, [...qTrigrams], input.query));
    } else {
      for (const entry of eligible) {
        const titleHit = entry.meta.title.toLowerCase().includes(lower);
        const bodyHit = entry.body.toLowerCase().includes(lower);
        if (titleHit || bodyHit) hits.push({ entry, score: titleHit ? -1 : 0 });
      }
    }
    hits.sort((a, b) =>
      (a.score - b.score)
      || (a.entry.meta.scope === 'workspace' ? 0 : 1) - (b.entry.meta.scope === 'workspace' ? 0 : 1)
      || (b.entry.meta.updated_at - a.entry.meta.updated_at)
      || (a.entry.meta.id < b.entry.meta.id ? -1 : a.entry.meta.id > b.entry.meta.id ? 1 : 0));
    return hits.slice(0, input.limit).map(({ entry, score }) => ({
      page_id: entry.meta.id,
      id: entry.meta.id,
      updated_at: entry.meta.updated_at,
      scope: entry.meta.scope,
      workspace_id: entry.meta.workspace_id,
      revision: entry.meta.revision,
      title: entry.meta.title,
      slug: entry.meta.slug,
      status: 'active' as const,
      snippet: snippetOf(entry.body, lower),
      sources: entry.meta.sources,
      evidence: entry.meta.evidence,
      score,
    }));
  }

  // ---- .index.json 持久化 ----

  /**
   * 尝试从 `<Docs>/.index.json` 水合：stat 全集与逐文件 content_hash 都吻合才采用；
   * 任何不符（含文件不存在）→ 全量重建并回写。返回 'hydrated' | 'rebuilt' | 'absent'。
   */
  hydrateOrRebuild(): 'hydrated' | 'rebuilt' | 'absent' {
    const path = indexPathFor(this.docsDir);
    if (!existsSync(path)) {
      this.ensureFresh();
      this.persist();
      return 'rebuilt';
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        version?: number; files?: Record<string, { mtimeMs: number; size: number }>; docs?: Array<{ fileName?: string; meta?: KnowledgeFileMeta; body_md?: string }>;
      };
      if (parsed.version !== INDEX_VERSION || parsed.files === undefined || parsed.docs === undefined) throw new Error('version 不受支持');
      const files = listDocFiles(this.docsDir);
      if (files.length !== Object.keys(parsed.files).length) throw new Error('文件集合不一致');
      for (const file of files) {
        const stat = parsed.files[file.fileName];
        if (stat === undefined || stat.mtimeMs !== file.mtimeMs || stat.size !== file.size) throw new Error(`stat 不一致: ${file.fileName}`);
      }
      const nextEntries = new Map<string, DocEntry>();
      const nextInvalid = new Map<string, InvalidDocFile>();
      for (const doc of parsed.docs) {
        if (typeof doc.fileName !== 'string' || doc.meta === undefined || typeof doc.body_md !== 'string') throw new Error('doc 结构不完整');
        const file = files.find(item => item.fileName === doc.fileName);
        if (file === undefined) throw new Error(`索引含已消失文件: ${doc.fileName}`);
        const meta = doc.meta;
        const recomputed = computeContentHash({ ...meta, content_hash: '' } as never, doc.body_md);
        const issues: string[] = [];
        if (recomputed !== meta.content_hash) throw new Error(`content_hash 不符: ${doc.fileName}`);
        if (meta.scope !== this.scopeIdentity.scope) issues.push(`scope: front matter ${meta.scope} 与所在目录 ${this.scopeIdentity.scope} 不一致`);
        if (meta.workspace_id !== this.scopeIdentity.workspace_id) issues.push(`workspace_id: front matter ${String(meta.workspace_id)} 与所在目录不符`);
        const entry: DocEntry = { fileName: doc.fileName, path: file.path, mtimeMs: file.mtimeMs, size: file.size, meta, body: doc.body_md, issues };
        if (issues.length === 0) nextEntries.set(doc.fileName, entry);
        else nextInvalid.set(doc.fileName, { ...entry, issues });
      }
      this.entries = nextEntries;
      this.invalid = nextInvalid;
      this.trigrams.clear();
      this.rebuildMaps();
      return 'hydrated';
    } catch {
      // 索引损坏/过期：全量重建（索引可重建、非事实源）
      this.entries.clear();
      this.invalid.clear();
      this.trigrams.clear();
      this.ensureFresh();
      this.persist();
      return 'rebuilt';
    }
  }

  /** 原子回写 .index.json（tmp + rename）；失败不阻断读（下次请求再试） */
  persist(): void {
    const path = indexPathFor(this.docsDir);
    try {
      mkdirSync(this.docsDir, { recursive: true });
      const files: Record<string, { mtimeMs: number; size: number }> = {};
      const docs: Array<{ fileName: string; meta: KnowledgeFileMeta; body_md: string }> = [];
      for (const fileName of [...this.entries.keys(), ...this.invalid.keys()].sort()) {
        const entry = this.entries.get(fileName) ?? this.invalid.get(fileName)!;
        files[fileName] = { mtimeMs: entry.mtimeMs, size: entry.size };
        if (entry.meta !== undefined && entry.body !== undefined) docs.push({ fileName, meta: entry.meta, body_md: entry.body });
      }
      const payload = `${JSON.stringify({ version: INDEX_VERSION, generated_at: new Date().toISOString(), files, docs }, null, 1)}\n`;
      const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      const fd = openSync(tmp, 'w');
      try {
        writeFileSync(fd, payload, 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    } catch {
      /* 索引回写失败不阻断服务；下次刷新重试 */
    }
  }
}

// ---- 模块级纯函数 ----

function slugNormOf(slug: string): string {
  return slug.normalize('NFKC').trim().replace(/\s+/g, '-').toLowerCase();
}

function trigramsOf(text: string): string[] {
  const chars = [...text.toLowerCase()];
  const out: string[] = [];
  for (let i = 0; i + 3 <= chars.length; i += 1) out.push(chars.slice(i, i + 3).join(''));
  return out;
}

/** bm25 排序（title 权重 5 / body 权重 1；k1=1.2 b=0.75）；score 取负、越小越相关（对齐 FTS5 ASC 口径） */
function bm25Rank(candidates: DocEntry[], terms: string[], query: string): Array<{ entry: DocEntry; score: number }> {
  if (candidates.length === 0) return [];
  const k1 = 1.2;
  const b = 0.75;
  const n = candidates.length;
  const lowerQuery = query.toLowerCase();
  const df = new Map<string, number>();
  const termSet = new Set(terms);
  const counted = new Set<string>();
  for (const entry of candidates) {
    counted.clear();
    for (const t of trigramsOf(`${entry.meta.title}\n${entry.body}`)) {
      if (termSet.has(t) && !counted.has(t)) { counted.add(t); df.set(t, (df.get(t) ?? 0) + 1); }
    }
  }
  const lenTitle = (entry: DocEntry): number => [...entry.meta.title].length || 1;
  const lenBody = (entry: DocEntry): number => [...entry.body].length || 1;
  const avgTitle = candidates.reduce((sum, entry) => sum + lenTitle(entry), 0) / n;
  const avgBody = candidates.reduce((sum, entry) => sum + lenBody(entry), 0) / n;
  /**
   * OCR C2：小写缓存。原实现在 (候选页 × trigram) 的双重循环里每对都调一次
   * `text.toLowerCase()`——300 页 × 20 KB、8 字符查询 ≈ 84 MB 临时字符串分配。
   * 正文是常量，按 entry 缓存一次即可。
   */
  const lowerCache = new WeakMap<DocEntry, { title: string; body: string }>();
  const lowerOf = (entry: DocEntry): { title: string; body: string } => {
    let cached = lowerCache.get(entry);
    if (cached === undefined) {
      cached = { title: entry.meta.title.toLowerCase(), body: entry.body.toLowerCase() };
      lowerCache.set(entry, cached);
    }
    return cached;
  };
  /** 在已小写的文本里数出现次数（调用方负责先 toLowerCase） */
  const countIn = (lower: string, term: string): number => {
    let count = 0;
    let index = lower.indexOf(term);
    while (index !== -1) { count += 1; index = lower.indexOf(term, index + 1); }
    return count;
  };
  const scored = candidates.map(entry => {
    const lower = lowerOf(entry);
    let sum = 0;
    for (const t of terms) {
      const termDf = df.get(t) ?? 0;
      if (termDf === 0) continue;
      const idf = Math.log((n - termDf + 0.5) / (termDf + 0.5) + 1);
      const tfTitle = countIn(lower.title, t);
      const tfBody = countIn(lower.body, t);
      const normTitle = (tfTitle * (k1 + 1)) / (tfTitle + k1 * (1 - b + (b * lenTitle(entry)) / avgTitle));
      const normBody = (tfBody * (k1 + 1)) / (tfBody + k1 * (1 - b + (b * lenBody(entry)) / avgBody));
      sum += idf * (5 * normTitle + 1 * normBody);
    }
    // FTS5 bm25 返回负值（越小越相关）；短查询整体上加一项「完整子串加权」保持精确命中优先
    const exact = (lower.title.includes(lowerQuery) ? 5 : 0) + (lower.body.includes(lowerQuery) ? 1 : 0);
    return { entry, score: -(sum + exact * 0.001) };
  });
  return scored;
}

/** snippet：首个命中位置前 100 字符起、≤1200 字符（照抄旧 JS 截断口径） */
function snippetOf(body: string, lowerQuery: string): string {
  const position = body.toLowerCase().indexOf(lowerQuery);
  const start = Math.max(0, position - 100);
  return body.slice(start, start + 1200);
}

// parseKnowledgeRefs 缓存（link/embed/attachment/tag 的 weight 合并由 parseKnowledgeRefs 完成）
const linkCache = new WeakMap<DocEntry, KnowledgeRefs>();
function parseRefsCached(entry: DocEntry): KnowledgeRefs {
  let refs = linkCache.get(entry);
  if (refs === undefined) {
    refs = parseKnowledgeRefs(entry.body, entry.meta.slug);
    linkCache.set(entry, refs);
  }
  return refs;
}
