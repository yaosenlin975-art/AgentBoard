/**
 * P2-01（方向 B §7.2）：知识文件仓储的装配缓存（per-Docs-dir 单例）。
 *
 * - 索引/仓储按目录绝对路径缓存：同一进程内每个 Docs 目录只建一次索引（启动扫两目录建内存索引
 *   的「两目录」= 工作区 Docs + 公共 Docs，每次请求经 ensureFresh 差量刷新，索引非事实源）。
 * - `KnowledgeDocsView` 聚合两目录（scope 过滤、跨目录检索合并、M2 跨目录链接解析），
 *   是 knowledgeRoutes 的读写门面。
 */
import type { KnowledgePage } from '@agentboard/shared';
import { mergeKnowledgeRowsByRecency } from '../db/repos/knowledgeSearch.js';
import { DocsIndex } from './index.js';
import { KnowledgeFileRepo } from './fileRepo.js';
import { resolveDocsDir, type DocsDirOverrides } from './paths.js';
import { reconcileDocsDir } from './reconcile.js';
import { pushAll } from '../services/pushAll.js';

export interface ScopeSelector {
  scope: 'common' | 'workspace' | 'both';
  workspace_id?: string | null;
}

export class KnowledgeDocsStore {
  private indexes = new Map<string, DocsIndex>();
  private repos = new Map<string, KnowledgeFileRepo>();

  indexFor(docsDir: string, identity: { scope: 'workspace' | 'common'; workspace_id: string | null }): DocsIndex {
    let index = this.indexes.get(docsDir);
    if (index === undefined) {
      index = new DocsIndex(docsDir, identity);
      index.hydrateOrRebuild();
      this.indexes.set(docsDir, index);
    }
    return index;
  }

  repoFor(docsDir: string, identity: { scope: 'workspace' | 'common'; workspace_id: string | null }, options: ConstructorParameters<typeof KnowledgeFileRepo>[2] = {}): KnowledgeFileRepo {
    let repo = this.repos.get(docsDir);
    if (repo === undefined) {
      repo = new KnowledgeFileRepo(docsDir, this.indexFor(docsDir, identity), options);
      this.repos.set(docsDir, repo);
    }
    return repo;
  }

  /** scope 对应 Docs 目录（不建索引；写路径定位用） */
  resolveDir(identity: { scope: 'workspace' | 'common'; workspace_id: string | null }, workspacePath: string | null, overrides?: DocsDirOverrides): string {
    if (identity.scope === 'workspace') {
      if (workspacePath === null) throw new Error('workspace scope 需要工作区路径');
      return resolveDocsDir(overrides, 'workspace', workspacePath);
    }
    return resolveDocsDir(overrides, 'common', null);
  }

  /** 两目录索引（scope=workspace/both 时需要工作区目录） */
  view(selector: ScopeSelector, workspacePath: string | null, overrides?: DocsDirOverrides): KnowledgeDocsView {
    const commonDir = resolveDocsDir(overrides, 'common', null);
    const commonIndex = this.indexFor(commonDir, { scope: 'common', workspace_id: null });
    let workspaceIndex: DocsIndex | null = null;
    if (selector.scope !== 'common') {
      if (workspacePath === null) throw new Error('scope=workspace/both 时必须提供工作区路径');
      const workspaceDir = resolveDocsDir(overrides, 'workspace', workspacePath);
      workspaceIndex = this.indexFor(workspaceDir, { scope: 'workspace', workspace_id: selector.workspace_id ?? null });
    }
    return new KnowledgeDocsView(selector, workspaceIndex, commonIndex);
  }
}

/** scope=both 的跨目录合并排序键（与旧跨库一致：(updated_at desc, id asc)） */
type MergeRow = { id: string; updated_at: number };

/** 两目录聚合视图：读路径与链接解析的门面（写走 repo） */
export class KnowledgeDocsView {
  constructor(
    private readonly selector: ScopeSelector,
    private readonly workspaceIndex: DocsIndex | null,
    private readonly commonIndex: DocsIndex,
  ) {}

  get common(): DocsIndex {
    return this.commonIndex;
  }

  get workspace(): DocsIndex | null {
    return this.workspaceIndex;
  }

  /** selector 覆盖的目录集合 */
  private indexesInScope(): DocsIndex[] {
    if (this.selector.scope === 'common') return [this.commonIndex];
    if (this.selector.scope === 'workspace') return [this.workspaceIndex!];
    return [this.workspaceIndex!, this.commonIndex];
  }

  requireWorkspace(): DocsIndex {
    if (this.workspaceIndex === null) throw new Error('该 scope 需要工作区目录');
    return this.workspaceIndex;
  }

  /** 按 id 取页（范围内唯一；id 只会存在于一个目录）。archived 可见（对齐旧 getKnowledgePage：只排除软删，软删在文件层=文件已撤） */
  pageById(id: string): { page: KnowledgePage; entryScope: 'workspace' | 'common' } | null {
    for (const index of this.indexesInScope()) {
      const entry = index.getByIdIncludeArchived(id);
      if (entry !== null && entry.issues.length === 0) {
        return { page: entryToPage(entry), entryScope: index.scopeIdentity.scope };
      }
      if (entry !== null && entry.issues.length > 0) return null; // 坏文件占位：明确「存在但不可读」→ 404
    }
    return null;
  }

  /**
   * 解析双链（M2：工作区页 → 本区优先 → 公共目录；common 页只解析公共目录）。
   * 跨目录同名不猜（歧义在 resolve 层处理；这里按「本目录命中即用」的链接语义取活跃页）。
   */
  resolvedLinks(): { links: Array<{ source: string; target: string; weight: number }>; unresolved: Array<{ source: string; raw_target: string; alias: string | null; heading: string | null }> } {
    const links: Array<{ source: string; target: string; weight: number }> = [];
    const unresolved: Array<{ source: string; raw_target: string; alias: string | null; heading: string | null }> = [];
    for (const index of this.indexesInScope()) {
      const result = index.resolveLinks(index === this.commonIndex ? null : this.commonIndex);
      pushAll(links, result.links);
      pushAll(unresolved, result.unresolved);
    }
    return { links, unresolved };
  }

  /**
   * P2-03：图引用全量（link/embed 边 + tag/attachment/unresolved 合成节点数据）。
   * 跨目录聚合：tag 同 norm 合并（weight 求和）；attachment 按目录身份分节点（ws 与 common 各自的
   * `_attachments/` 是不同文件集）；unresolved 按 ref 去重（同一缺失目标只画一个节点，weight 求和）。
   * attachment 节点 id 携带目录身份：`att:ws:<workspace_id>:<key>` / `att:common:<key>`。
   */
  graphLinks(): {
    links: Array<{ source: string; target: string; weight: number; kind: 'link' | 'embed' }>;
    unresolved: Array<{ source: string; ref: string; raw_target: string; alias: string | null; heading: string | null; weight: number }>;
    tags: Array<{ tag_norm: string; raw_tag: string; weight: number; refs: Array<{ source: string; weight: number }> }>;
    attachments: Array<{ key: string; name: string; node_id: string; scope: 'workspace' | 'common'; workspace_id: string | null; refs: Array<{ source: string; weight: number }> }>;
  } {
    const links: Array<{ source: string; target: string; weight: number; kind: 'link' | 'embed' }> = [];
    const unresolved: Array<{ source: string; ref: string; raw_target: string; alias: string | null; heading: string | null; weight: number }> = [];
    const tags = new Map<string, { raw_tag: string; weight: number; refs: Array<{ source: string; weight: number }> }>();
    const attachments = new Map<string, { key: string; name: string; node_id: string; scope: 'workspace' | 'common'; workspace_id: string | null; refs: Array<{ source: string; weight: number }> }>();
    for (const index of this.indexesInScope()) {
      const identity = index.scopeIdentity;
      const attachmentNodeId = (key: string): string => identity.scope === 'workspace' ? `att:ws:${identity.workspace_id ?? ''}:${key}` : `att:common:${key}`;
      const refs = index.graphRefs(index === this.commonIndex ? null : this.commonIndex);
      pushAll(links, refs.links);
      pushAll(unresolved, refs.unresolved);
      for (const tag of refs.tags) {
        const bucket = tags.get(tag.tag_norm);
        if (bucket === undefined) tags.set(tag.tag_norm, { raw_tag: tag.raw_tag, weight: tag.weight, refs: [...tag.refs] });
        else {
          bucket.weight += tag.weight;
          pushAll(bucket.refs, tag.refs);
        }
      }
      for (const attachment of refs.attachments) {
        const nodeId = attachmentNodeId(attachment.key);
        const bucket = attachments.get(nodeId);
        if (bucket === undefined) attachments.set(nodeId, { key: attachment.key, name: attachment.name, node_id: nodeId, scope: identity.scope, workspace_id: identity.workspace_id, refs: [...attachment.refs] });
        else pushAll(bucket.refs, attachment.refs);
      }
    }
    return {
      links,
      unresolved,
      tags: [...tags.entries()].map(([tag_norm, value]) => ({ tag_norm, ...value })),
      attachments: [...attachments.values()],
    };
  }

  /** 反链（跨两目录合并；工作区页 → 公共页的跨目录目标按 M2 解析；排序稳定 (page_id)） */
  backlinks(pageId: string): Array<{ page_id: string; slug: string; title: string; alias: string | null; heading: string | null }> {
    const items: Array<{ page_id: string; slug: string; title: string; alias: string | null; heading: string | null }> = [];
    for (const index of this.indexesInScope()) pushAll(items, index.backlinks(pageId, index === this.commonIndex ? null : this.commonIndex));
    return items.sort((a, b) => (a.page_id < b.page_id ? -1 : a.page_id > b.page_id ? 1 : 0));
  }

  /** 跨目录检索合并：(updated_at desc, id asc)，truncated = 任一路在 limit 之外还有命中 */
  search(input: { query: string; limit: number; now: number }): { items: ReturnType<DocsIndex['search']>; truncated: boolean } {
    const fetchLimit = input.limit + 1;
    const sides = this.indexesInScope().map(index => index.search({ ...input, limit: fetchLimit }));
    const merged = mergeKnowledgeRowsByRecency(sides) as ReturnType<DocsIndex['search']>;
    return { items: merged.slice(0, input.limit), truncated: merged.length > input.limit };
  }

  /** 跨目录列表合并（窗口法 next_offset，对齐 listKnowledgePagesAcrossDbs） */
  listPages<T extends MergeRow & { scope: 'workspace' | 'common'; workspace_id: string | null }>(fetch: (index: DocsIndex) => T[], offset: number, limit: number): { items: T[]; next_offset: number | null } {
    const sides = this.indexesInScope().map(index => fetch(index));
    const merged = mergeKnowledgeRowsByRecency(sides);
    const end = offset + limit;
    return { items: merged.slice(offset, end) as T[], next_offset: merged.length > end ? end : null };
  }

  /**
   * K3：范围内全部「存在但校验失败」的文件（跨目录合并，按文件名排序）。
   * 只回 slug / 文件名 / issues，不回正文——坏内容不能当正常内容传播。
   * scope 过滤按 meta.status 尽力判断：meta 读不出时保留（宁可多报，不漏报）。
   */
  invalidFiles(filter?: (meta: { status: string; expires_at: number | null }) => boolean): Array<{ slug: string | null; file_name: string; issues: string[] }> {
    return this.indexesInScope()
      .flatMap(index => index.allInvalid())
      .filter(file => filter === undefined || file.meta === undefined || filter(file.meta))
      .map(file => ({
        slug: file.meta?.slug ?? null,
        file_name: file.fileName,
        issues: [...file.issues],
      }))
      .sort((left, right) => (left.file_name < right.file_name ? -1 : left.file_name > right.file_name ? 1 : 0));
  }
}

function entryToPage(entry: { meta: import('@agentboard/shared').KnowledgeFileMeta; body: string }): KnowledgePage {
  return {
    id: entry.meta.id,
    scope: entry.meta.scope,
    workspace_id: entry.meta.workspace_id,
    slug: entry.meta.slug,
    title: entry.meta.title,
    body_md: entry.body,
    status: entry.meta.status,
    revision: entry.meta.revision,
    expires_at: entry.meta.expires_at,
    created_by: entry.meta.created_by,
    updated_by: entry.meta.updated_by,
    created_at: entry.meta.created_at,
    updated_at: entry.meta.updated_at,
    sources: entry.meta.sources,
    evidence: entry.meta.evidence,
    category: entry.meta.category,
    landed: entry.meta.landed,
    domain: entry.meta.domain,
  } as KnowledgePage;
}

/** 进程级单例（知识路由与启动预热共用同一份索引缓存） */
export const knowledgeDocsStore = new KnowledgeDocsStore();

/**
 * P2-01 启动接线（§7.3：启动扫两目录建内存索引 + reconcile 默认只读报告）：
 * 扫公共 Docs + 全部已下沉工作区 Docs 建索引，逐目录跑只读 reconcile 并打印问题计数。
 * 任何失败不阻断启动（索引非事实源，下次请求差量刷新会自愈）。
 */
export function warmKnowledgeIndexes(input: { centerDb: { prepare: (sql: string) => { all: () => Array<{ id: string; path: string }> } }; overrides?: DocsDirOverrides; log?: (message: string) => void }): void {
  const log = input.log ?? ((message: string) => { console.log(message); });
  const scanDir = (docsDir: string, identity: { scope: 'workspace' | 'common'; workspace_id: string | null }, cross: DocsIndex | null): void => {
    const index = knowledgeDocsStore.indexFor(docsDir, identity);
    index.ensureFresh();
    const report = reconcileDocsDir(index, { cross });
    if (report.issues.length > 0 || report.stale_tmp.length > 0 || report.stale_locks.length > 0) {
      log(`[knowledge] reconcile（只读报告）${docsDir}：${report.issues.length} 个文件问题、${report.stale_tmp.length} 个残留 tmp、${report.stale_locks.length} 个残留 lock；运行 kb knowledge reconcile --fix 清理`);
    }
  };
  try {
    let workspaces: Array<{ id: string; path: string }> = [];
    try {
      workspaces = input.centerDb.prepare("SELECT id, path FROM workspace WHERE db_mode='localized'").all();
    } catch { /* 注册表不可读：只扫公共目录 */ }
    const commonDir = resolveDocsDir(input.overrides, 'common', null);
    const commonIndex = knowledgeDocsStore.indexFor(commonDir, { scope: 'common', workspace_id: null });
    for (const row of workspaces) {
      try {
        const workspaceDir = resolveDocsDir(input.overrides, 'workspace', row.path);
        scanDir(workspaceDir, { scope: 'workspace', workspace_id: row.id }, commonIndex);
      } catch { /* 单区失败不阻断 */ }
    }
    scanDir(commonDir, { scope: 'common', workspace_id: null }, null);
  } catch { /* 预热失败不阻断启动 */ }
}
