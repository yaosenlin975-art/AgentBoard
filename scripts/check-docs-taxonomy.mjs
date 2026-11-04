#!/usr/bin/env node
/**
 * Docs + 知识页 taxonomy 校验（KB-DOC-4，分类体系 §4.4 / §4.6 批 7）。
 *
 * 校验三件事：
 *   1. 索引覆盖：`Docs/INDEX.md` 是否登记了每个 `Docs/**\/*.md`（INDEX 自身与 `Docs/archive/` 除外）；
 *      新增（git 未跟踪）文件缺索引行 → 报错；存量已跟踪文件缺索引行 → 只告警。
 *   2. 索引一致性：INDEX 里写了但磁盘上不存在的路径 / 不存在的知识页 id → 报错。
 *   3. 知识页分类：本工作区 + common 的非删除页，`domain` 必须在封闭词表内（缺失/非法 → 报错 `分类缺失 / 域非法`），
 *      `category` 只允许 design / solved / pinned / open（legacy 视为未分流 → 报错）。
 *
 * 刻意不做的事：不检查其它工作区的知识页（它们仍有 legacy 存量，本卡无权改，也不做全局强制）。
 *
 * 用法：
 *   node scripts/check-docs-taxonomy.mjs                 # 校验（新增缺失/不一致/分类问题 → exit 1）
 *   node scripts/check-docs-taxonomy.mjs --emit-section5 # 打印 INDEX §5 表格（从 kb 实时生成，不手抄）
 *   node scripts/check-docs-taxonomy.mjs --strict        # 存量缺索引行也视为失败（收口时用）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const emitSection5 = args.includes('--emit-section5');

/** 域词表（封闭集合，见分类体系 §4.2 第 5 条） */
const DOMAINS = new Set(['accounts', 'knowledge', 'board', 'chat', 'ui', 'infra']);
/** 内容类型（legacy 是待分流的历史值，不合法） */
const CATEGORIES = new Set(['design', 'solved', 'pinned', 'open']);

function runKb(kbArgs) {
  try {
    return execFileSync('kb', kbArgs, {
      cwd: root,
      encoding: 'utf8',
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const message = String(error.stderr || error.message || error);
    throw new Error(`kb ${kbArgs.join(' ')} 失败：${message.trim().split('\n')[0]}`);
  }
}

function parseKbJson(text) {
  const clean = text.replace(/^\uFEFF/, '');
  return JSON.parse(clean);
}

function resolveWorkspaceId() {
  const spaces = parseKbJson(runKb(['list-spaces', '--current', '--json']));
  const list = Array.isArray(spaces) ? spaces : spaces.items || [];
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const hit = list.find((s) => String(s.path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === normalizedRoot);
  if (!hit) {
    throw new Error(`无法把仓库根解析成已注册工作区：${root}（候选：${list.map((s) => s.path).join('；') || '无'}）`);
  }
  return hit.id;
}

function listPages(workspaceId) {
  // --limit 上限为 100（CLI 校验），本工作区 workspace + common 合计 < 100
  const ws = parseKbJson(runKb(['knowledge', 'list', '--scope', 'workspace', '--workspace', workspaceId, '--status', 'all', '--include-expired', '--limit', '100', '--json']));
  const common = parseKbJson(runKb(['knowledge', 'list', '--scope', 'common', '--status', 'all', '--include-expired', '--limit', '100', '--json']));
  const take = (value) => (Array.isArray(value) ? value : value.items || value.pages || []);
  return [...take(ws), ...take(common)]; // list 不返回 domain，下面逐页 show 补齐
}

function showPage(page) {
  const kbArgs = ['knowledge', 'show', page.id, '--scope', page.scope];
  if (page.scope === 'workspace') kbArgs.push('--workspace', page.workspace_id);
  kbArgs.push('--json');
  return parseKbJson(runKb(kbArgs));
}

function docsInventory() {
  const docs = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'archive') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      const rel = relative(root, full).split('\\').join('/');
      if (rel === 'Docs/INDEX.md') continue;
      docs.push(rel);
    }
  };
  walk(join(root, 'Docs'));
  return docs.sort();
}

const indexPath = join(root, 'Docs', 'INDEX.md');
if (!existsSync(indexPath)) {
  console.error('check-docs-taxonomy: 缺少 Docs/INDEX.md（唯一入口，先建索引再跑校验）');
  process.exit(1);
}
const indexText = readFileSync(indexPath, 'utf8');

const workspaceId = resolveWorkspaceId();
const pages = listPages(workspaceId).filter((p) => p.status !== 'deleted');
for (const page of pages) page.detail = showPage(page);
pages.sort((a, b) =>
  (a.detail.domain || 'zzz').localeCompare(b.detail.domain || 'zzz') ||
  a.category.localeCompare(b.category) ||
  a.slug.localeCompare(b.slug));

if (emitSection5) {
  console.log('| 域 | page id | category | 生命周期 | landed | 是否 common | 标题 |');
  console.log('|---|---|---|---|---|---|---|');
  for (const page of pages) {
    const domain = page.detail.domain || '（缺域）';
    const landed = page.detail.landed || '—';
    console.log(`| ${domain} | \`${page.id}\` | ${page.category} | ${page.status} | ${landed} | ${page.scope === 'common' ? 'common' : 'workspace'} | ${page.title.replace(/\|/g, '\\|')} |`);
  }
  process.exit(0);
}

const errors = [];
const warnings = [];

// ── 1/2. 索引覆盖与一致性 ───────────────────────────────────────────
const docs = docsInventory();
const indexedDocs = new Set(
  (indexText.match(/Docs\/[\w\u4e00-\u9fa5.\-/]+\.md/g) || []).map((p) => p.replace(/\.$/, '')),
);
for (const doc of docs) {
  if (indexedDocs.has(doc)) continue;
  let tracked = false;
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', doc], { cwd: root, stdio: 'ignore' });
    tracked = true;
  } catch {
    tracked = false;
  }
  if (tracked) warnings.push(`存量文档缺索引行：${doc}`);
  else errors.push(`新增文档缺索引行：${doc}（新增文件必须在 INDEX 里加一行）`);
}
for (const indexed of indexedDocs) {
  if (existsSync(join(root, indexed))) continue;
  if (/Docs\/(design|research|decision|migration|docker|governance)-|Docs\/verification\//.test(indexed)) continue;
  errors.push(`索引指向不存在的文件：${indexed}`);
}

// ── 3. 知识页分类 ──────────────────────────────────────────────────
const indexedIds = new Set(indexText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || []);
for (const page of pages) {
  if (!indexedIds.has(page.id)) errors.push(`知识页缺索引行：${page.scope}/${page.slug}（${page.id}）`);
  const domain = page.detail.domain;
  if (!domain) errors.push(`分类缺失（domain 为空）：${page.scope}/${page.slug}（${page.id}）`);
  else if (!DOMAINS.has(domain)) errors.push(`域非法：${page.scope}/${page.slug} 的 domain=${domain}，允许 ${[...DOMAINS].join('/')}`);
  if (!CATEGORIES.has(page.category)) errors.push(`分类缺失/非法：${page.scope}/${page.slug} 的 category=${page.category}，允许 ${[...CATEGORIES].join('/')}`);
}
for (const id of indexedIds) {
  if (!pages.some((p) => p.id === id)) errors.push(`索引指向不存在的知识页 id：${id}`);
}

console.log(`check-docs-taxonomy: Docs 文档 ${docs.length} 篇、索引登记 ${indexedDocs.size} 条；` +
  `知识页 ${pages.length} 页（workspace + common，剔除 deleted）、索引登记 ${indexedIds.size} 条`);
if (warnings.length > 0) {
  console.log(`\n存量告警（${warnings.length} 条，不阻断）：`);
  for (const w of warnings) console.log(`  - ${w}`);
}
if (errors.length > 0) {
  console.log(`\n错误（${errors.length} 条，必须修）：`);
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
if (strict && warnings.length > 0) {
  console.log('\n--strict：存量告警视为失败');
  process.exit(1);
}
console.log('\ncheck-docs-taxonomy: OK');
