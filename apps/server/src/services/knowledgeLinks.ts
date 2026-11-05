/**
 * KB-GRAPH-V2-4：知识页正文双链（`[[...]]`）解析与落地。
 *
 * 规则（与卡面一致，逐条有用例）：
 * 1. 语法：`[[a]]` / `[[a|b]]` / `[[a#h]]` / `[[a#h|b]]`
 * 2. 归一：NFKC → trim → 空白折叠为单个 `-` → 小写；**链接目标与页面 slug 用同一个函数**
 *    （`normalizeLinkTarget`），避免「明明存在却判成 unresolved」
 * 3. 代码块（``` / ~~~ 围栏）与行内代码（`` ` ``）里的 `[[` 不解析
 * 4. 非法跳过：未闭合、空 target、跨行、超长（> MAX_TARGET_CHARS）
 * 5. 自链接跳过（归一后等于源页 slug）
 * 6. `#heading` 只用于展示，边归一到页级；`|alias` 同理
 * 7. 同一源页对同一 target 重复出现 → 合并为一条边，权重 = 出现次数
 *
 * 边存新表 `knowledge_link`，按 (source_page_id, revision) 绑定页面版本：
 * 读取一律过滤当前 revision，旧 revision 的行保留但永不重算。
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db/connection.js';
// STORE-4c：跨库目标解析要知道中心库（工作区页双链可解析到中心 common 页）；
// 未绑定句柄按「自身即中心」回退（单测/中心库直连路径行为不变）。entityLocator 无反向依赖，不成环。
import { centerLocatorDb } from '../db/repos/entityLocator.js';

export const MAX_TARGET_CHARS = 200;
export const LINK_EDGE_WEIGHT = 5;

export interface ParsedLink {
  raw_target: string;
  alias: string | null;
  heading: string | null;
  target_slug_norm: string;
  weight: number;
}

/** 链接目标与页面 slug 共用的归一函数（幂等） */
export function normalizeLinkTarget(raw: string): string {
  return raw
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
}

/** 把代码块与行内代码区间替换成空格，保留字符偏移，便于按 index 取原文 */
function maskCode(body: string): string {
  const chars = [...body];
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to && index < chars.length; index += 1) {
      if (chars[index] !== '\n') chars[index] = ' ';
    }
  };
  const lines = body.split('\n');
  let offset = 0;
  let fence: string | null = null;
  for (const line of lines) {
    const trimmed = line.trimStart();
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fence === null && fenceMatch) {
      fence = fenceMatch[1]!;
      blank(offset, offset + line.length);
    } else if (fence !== null) {
      blank(offset, offset + line.length);
      if (fenceMatch && trimmed.startsWith(fence)) fence = null;
    }
    offset += line.length + 1;
  }
  // 行内代码：仅处理围栏之外的区域（已替换为空格的部分不会命中反引号）
  const masked = chars.join('');
  let index = 0;
  while (index < masked.length) {
    if (masked[index] !== '`') { index += 1; continue; }
    let run = 0;
    while (masked[index + run] === '`') run += 1;
    const closing = masked.indexOf('`'.repeat(run), index + run);
    if (closing < 0) break;
    blank(index, closing + run);
    index = closing + run;
  }
  return chars.join('');
}

/** 解析正文里的双链；selfSlug 用于自链接跳过 */
export function parseKnowledgeLinks(body: string, selfSlug: string): ParsedLink[] {
  const masked = maskCode(body);
  const selfNorm = normalizeLinkTarget(selfSlug);
  const merged = new Map<string, ParsedLink>();
  // 末尾负向断言：`[[a]]]` 这种多一个右括号的越界写法不解析
  const pattern = /\[\[([^\[\]\n]+)\]\](?!\])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    const inner = body.slice(match.index + 2, match.index + 2 + match[1]!.length);
    const pipe = inner.indexOf('|');
    const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : null;
    const targetPart = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
    const hash = targetPart.indexOf('#');
    const heading = hash >= 0 ? targetPart.slice(hash + 1).trim() : null;
    const rawTarget = (hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim();
    if (!rawTarget || rawTarget.length > MAX_TARGET_CHARS) continue;
    const slugNorm = normalizeLinkTarget(rawTarget);
    if (!slugNorm || slugNorm === selfNorm) continue;
    const existing = merged.get(slugNorm);
    if (existing) existing.weight += 1;
    else merged.set(slugNorm, { raw_target: rawTarget, alias: alias || null, heading: heading || null, target_slug_norm: slugNorm, weight: 1 });
  }
  return [...merged.values()];
}

const linkId = (pageId: string, revision: number, slugNorm: string): string =>
  createHash('sha256').update(`${pageId}\u0000${revision}\u0000${slugNorm}`).digest('hex').slice(0, 32);

/**
 * 用给定 revision 的正文重建该页的 link 行（先删同 revision 再插，幂等）。
 *
 * STORE-4c：目标解析分两跳——先解析源页本库（common 页对 common；workspace 页对同工作区），
 * 本库未命中且源页是 workspace 页时再探中心库 common 页（跨库双链，`target_page_id` 存外库 id，
 * 外键已松绑）。跨库探测读另一连接，失败（busy 等）降级为未解析，由 reparse 重试，不打断页面写入；
 * 中心库句柄缺省取 `centerLocatorDb(db)`（routes.ts 装配时绑定），`options.centerDb` 显式覆盖
 * （/reparse 对未走绑定的句柄 fan-out 时用）。
 */
export function syncPageLinks(db: Db, page: { id: string; slug: string; body_md: string; revision: number; scope: 'workspace' | 'common'; workspace_id: string | null }, options: { centerDb?: Db } = {}): number {
  const links = parseKnowledgeLinks(page.body_md, page.slug);
  const remove = db.prepare('DELETE FROM knowledge_link WHERE source_page_id=? AND revision=?');
  const resolve = db.prepare(page.scope === 'common'
    ? "SELECT id FROM knowledge_page WHERE scope='common' AND slug=? AND status<>'deleted'"
    : "SELECT id FROM knowledge_page WHERE scope='workspace' AND workspace_id=? AND slug=? AND status<>'deleted'");
  const crossDb = options.centerDb ?? centerLocatorDb(db);
  // 跨库目标只对 workspace 源页开放（common 页不指工作区页：无法定位到具体工作区）；自库直连时探测等于本库，无额外开销
  const crossResolve = page.scope === 'workspace' && crossDb !== db
    ? crossDb.prepare("SELECT id FROM knowledge_page WHERE scope='common' AND slug=? AND status<>'deleted'")
    : null;
  const insert = db.prepare(`INSERT INTO knowledge_link
    (id, source_page_id, revision, target_slug_norm, raw_target, alias, heading, target_page_id, resolved, weight, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const now = Date.now();
  remove.run(page.id, page.revision);
  for (const link of links) {
    const resolved = (page.scope === 'common' ? resolve.get(link.target_slug_norm) : resolve.get(page.workspace_id, link.target_slug_norm)) as { id: string } | undefined;
    let targetId: string | null = resolved?.id ?? null;
    if (targetId === null && crossResolve !== null) {
      try {
        const cross = crossResolve.get(link.target_slug_norm) as { id: string } | undefined;
        targetId = cross?.id ?? null;
      } catch {
        targetId = null; // 跨库探测失败降级为未解析（reparse 可重试），不打断页面写入
      }
    }
    try {
      insert.run(linkId(page.id, page.revision, link.target_slug_norm), page.id, page.revision, link.target_slug_norm,
        link.raw_target, link.alias, link.heading, targetId, targetId === null ? 0 : 1, link.weight, now);
    } catch (error) {
      // 老结构库（target 外键未松绑）存跨库 id 会被拒：降级为未解析行，结构重建后 reparse 补齐
      if (targetId === null) throw error;
      insert.run(linkId(page.id, page.revision, link.target_slug_norm), page.id, page.revision, link.target_slug_norm,
        link.raw_target, link.alias, link.heading, null, 0, link.weight, now);
    }
  }
  return links.length;
}

export interface BacklinkRow {
  page_id: string;
  slug: string;
  title: string;
  alias: string | null;
  heading: string | null;
  /** STORE-4c：跨库合并的排序键（响应新增字段，旧客户端忽略） */
  created_at: number;
}

/** 反链：指向该页的（当前 revision 的）链接；排序键固定 (created_at, id) 保证翻页稳定 */
export function listBacklinks(db: Db, pageId: string, options: { limit: number; offset: number }): { items: BacklinkRow[]; page_total: number } {
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_link l
    JOIN knowledge_page p ON p.id = l.source_page_id AND p.revision = l.revision
    WHERE l.target_page_id=? AND l.resolved=1 AND p.status<>'deleted'`).get(pageId) as { n: number }).n;
  const items = db.prepare(`SELECT p.id AS page_id, p.slug, p.title, l.alias, l.heading, l.created_at
    FROM knowledge_link l
    JOIN knowledge_page p ON p.id = l.source_page_id AND p.revision = l.revision
    WHERE l.target_page_id=? AND l.resolved=1 AND p.status<>'deleted'
    ORDER BY l.created_at, l.id
    LIMIT ? OFFSET ?`).all(pageId, options.limit, options.offset) as BacklinkRow[];
  return { items, page_total: total };
}

export function countBacklinks(db: Db, pageId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_link l
    JOIN knowledge_page p ON p.id = l.source_page_id AND p.revision = l.revision
    WHERE l.target_page_id=? AND l.resolved=1 AND p.status<>'deleted'`).get(pageId) as { n: number }).n;
}

export function listUnresolvedLinks(db: Db, pageId: string): Array<{ raw_target: string; alias: string | null; heading: string | null }> {
  return db.prepare(`SELECT raw_target, alias, heading FROM knowledge_link
    WHERE source_page_id=? AND revision=(SELECT revision FROM knowledge_page WHERE id=?) AND resolved=0
    ORDER BY raw_target`).all(pageId, pageId) as Array<{ raw_target: string; alias: string | null; heading: string | null }>;
}

/**
 * PERF-2（F6）：详情页链接统计聚合——backlinks_count / links_out_count / unresolved_links
 * 三次独立查询合成 1 条（标量子查询 + json_group_array），返回字段与三个旧函数逐一对应。
 */
export interface KnowledgePageLinkStats {
  backlinks_count: number;
  links_out_count: number;
  unresolved_links: Array<{ raw_target: string; alias: string | null; heading: string | null }>;
}

export function getKnowledgePageLinkStats(db: Db, pageId: string): KnowledgePageLinkStats {
  const row = db.prepare(`SELECT
      (SELECT COUNT(*) FROM knowledge_link l
        JOIN knowledge_page p ON p.id = l.source_page_id AND p.revision = l.revision
        WHERE l.target_page_id=@pageId AND l.resolved=1 AND p.status<>'deleted') AS backlinks_count,
      (SELECT COUNT(*) FROM knowledge_link
        WHERE source_page_id=@pageId
          AND revision=(SELECT revision FROM knowledge_page WHERE id=@pageId)) AS links_out_count,
      (SELECT COALESCE(json_group_array(json_object('raw_target', r.raw_target, 'alias', r.alias, 'heading', r.heading)), json_array())
        FROM (SELECT raw_target, alias, heading FROM knowledge_link
              WHERE source_page_id=@pageId
                AND revision=(SELECT revision FROM knowledge_page WHERE id=@pageId)
                AND resolved=0
              ORDER BY raw_target) r) AS unresolved_links
    `).get({ pageId }) as { backlinks_count: number; links_out_count: number; unresolved_links: string };
  return {
    backlinks_count: row.backlinks_count,
    links_out_count: row.links_out_count,
    unresolved_links: JSON.parse(row.unresolved_links) as KnowledgePageLinkStats['unresolved_links'],
  };
}

/** 该页当前 revision 的出链数（去重后的目标数） */
export function countOutgoingLinks(db: Db, pageId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_link
    WHERE source_page_id=? AND revision=(SELECT revision FROM knowledge_page WHERE id=?)`).get(pageId, pageId) as { n: number }).n;
}

/**
 * 存量回填：按当前 revision 重新解析所有未被删除的页面。
 * 幂等（按 (page, revision) 先删后写），分批提交，可重复执行。
 * `options.centerDb`：STORE-4c 跨库目标解析用——对工作区库回填时显式传中心库
 * （fan-out 句柄可能未经 centerLocatorDb 绑定），中心库回填不用传。
 */
export function reparseAllPages(db: Db, options: { batchSize?: number; centerDb?: Db } = {}): { pages: number; links: number; duration_ms: number } {
  const batchSize = options.batchSize ?? 200;
  const centerDb = options.centerDb;
  const started = Date.now();
  let pages = 0;
  let links = 0;
  let cursor = '';
  for (;;) {
    const rows = db.prepare(`SELECT id, slug, body_md, revision, scope, workspace_id FROM knowledge_page
      WHERE status<>'deleted' AND id > ? ORDER BY id LIMIT ?`).all(cursor, batchSize) as Array<{
        id: string; slug: string; body_md: string; revision: number; scope: 'workspace' | 'common'; workspace_id: string | null;
      }>;
    if (rows.length === 0) break;
    db.transaction(() => {
      for (const row of rows) links += centerDb === undefined ? syncPageLinks(db, row) : syncPageLinks(db, row, { centerDb });
    })();
    pages += rows.length;
    cursor = rows[rows.length - 1]!.id;
    if (rows.length < batchSize) break;
  }
  return { pages, links, duration_ms: Date.now() - started };
}

export interface KnowledgeLinkRow {
  source_page_id: string;
  target_page_id: string;
  weight: number;
}

/** 图端点用：当前 revision 的已解析出链 */
export function listResolvedLinks(db: Db, pageIds: string[]): Array<{ source: string; target: string; weight: number }> {
  if (pageIds.length === 0) return [];
  const placeholders = pageIds.map(() => '?').join(',');
  return db.prepare(`SELECT l.source_page_id AS source, l.target_page_id AS target, l.weight
    FROM knowledge_link l
    JOIN knowledge_page p ON p.id = l.source_page_id AND p.revision = l.revision
    WHERE l.resolved=1 AND p.status<>'deleted' AND l.source_page_id IN (${placeholders})`)
    .all(...pageIds) as Array<{ source: string; target: string; weight: number }>;
}
