/**
 * KB-PAGE-3b：knowledge_page.domain 数据回填（规则优先轮）
 *
 * 机制来源：KB-PAGE-3（c2f5975e / 92b4d15）已建 `domain TEXT` 幂等列 + 词表
 * `accounts|knowledge|board|chat|ui|infra`（migrations/knowledge.ts:43,50）。
 * 本脚本只做**数据回填**：按 slug / 标题关键词的显式白名单命中即写，拿不准留 NULL。
 *
 * 硬约束：
 * - 只 UPDATE `domain` 一列，不改正文 / sources / category / landed / status。
 * - 规则与 scope 无关（禁止「同 scope 全填」这类批量手段）。
 * - 幂等：重复执行结果不变（每条 UPDATE 都带 `AND domain IS NULL`）。
 * - 词表以外的值一律不写（写前用 KNOWLEDGE_DOMAINS 校验）。
 *
 * 用法：
 *   node scripts/verify/kb-page-domain-backfill.mjs --dry-run   # 只打印将要写入的映射
 *   node scripts/verify/kb-page-domain-backfill.mjs --apply     # 实际执行
 *   node scripts/verify/kb-page-domain-backfill.mjs --stats     # 只打印分布与自证指标
 *   node scripts/verify/kb-page-domain-backfill.mjs --legacy-triage [--apply]  # KB-PAGE-3 收口轮：legacy → pinned/solved
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';

// better-sqlite3 是 apps/server 的依赖（pnpm workspace 不 hoist 到根），从 server 包解析
const serverRequire = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const Database = serverRequire('better-sqlite3');

/** 域词表唯一来源：packages/shared/src/domain.ts（脚本不复制值，改词表只改那一处） */
function loadKnowledgeDomains() {
  const file = new URL('../../packages/shared/src/domain.ts', import.meta.url);
  const source = readFileSync(file, 'utf8');
  const match = /export const KNOWLEDGE_DOMAINS = \[([^\]]+)\] as const/.exec(source);
  if (match === null) throw new Error(`未在 ${file.pathname} 找到 KNOWLEDGE_DOMAINS 定义`);
  return match[1].split(',').map((part) => part.trim().replace(/^'|'$/g, '')).filter((part) => part !== '');
}
const KNOWLEDGE_DOMAINS = loadKnowledgeDomains();

/**
 * 显式白名单规则表：命中即写，未命中留 NULL。
 * 每条规则都是「slug 或标题」上的具体模式，不对 scope 做任何假设。
 */
const RULES = [
  // ---- accounts：五平台账号运维 / 凭据 / 切换骨架 / 协议级添加 ----
  { domain: 'accounts', id: 'A1', why: '五平台账号运维总览', re: /^platform-account-/ },
  { domain: 'accounts', id: 'A2', why: 'ZCode 账号深挖', re: /^zcode-/ },
  { domain: 'accounts', id: 'A3', why: '账号危险操作/删除外键/六行总览', re: /^account-(danger|delete)|^accounts-six-row/ },
  { domain: 'accounts', id: 'A4', why: 'B4S 切换骨架子卡结论', re: /-b4s[0-9]-/ },
  { domain: 'accounts', id: 'A5', why: 'B4W 切换前置与失败原因', re: /-b4w-/ },
  { domain: 'accounts', id: 'A6', why: 'ACC-KB 协议级添加账号服务端', re: /acc-kb-b2s|协议级添加账号/i },

  // ---- knowledge：知识库模型 / 导入 / 分类 / 引用门禁 / 页面时间 ----
  { domain: 'knowledge', id: 'K1', why: '工作区知识与任务指引设计', re: /^agentboard-workspace-knowledge/ },
  { domain: 'knowledge', id: 'K2', why: '知识库设计页（taxonomy / card-links / 分布式存储以外的 knowledge-*）', re: /^knowledge-/ },
  { domain: 'knowledge', id: 'K3', why: 'KBIMP 导入演练页', re: /^kbimp-/i },
  { domain: 'knowledge', id: 'K4', why: 'Docs 引用校验门禁', re: /^docs-refs-gate$/ },
  { domain: 'knowledge', id: 'K5', why: '知识页时间展示验证', re: /^page-time-verify$/ },
  { domain: 'knowledge', id: 'K6', why: 'category/landed 参数实测临时页', re: /^tmp-cat-/ },
  { domain: 'knowledge', id: 'K7', why: 'CLI knowledge selftest 页', re: /^guide-selftest-/ },

  // ---- board：看板坑位 / 任务依赖 / 项目现状 / 交接总览 ----
  { domain: 'board', id: 'B1', why: 'AgentBoard 坑与注意点', re: /^agentboard-pitfalls$/ },
  { domain: 'board', id: 'B2', why: '任务依赖设计', re: /^design-task-dependencies$/ },
  { domain: 'board', id: 'B3', why: '项目现状/状态交接页', re: /^project-status-/ },
  { domain: 'board', id: 'B4', why: '项目级暂停交接', re: /^handoff-project-/ },

  // ---- chat：聊天渲染 / 图片投递与会话集成 ----
  { domain: 'chat', id: 'C1', why: '聊天图片投递真机验证模式', re: /^chatimg-/ },
  { domain: 'chat', id: 'C2', why: 'CHAT-RENDER01 泡泡/正文渲染', re: /chat-render/i },
  { domain: 'chat', id: 'C3', why: 'IMG-04 图片派发/唤醒/会话集成', re: /img-0[0-9]\b|图片派发/i },

  // ---- ui：前端交互 / 星图渲染 / 测试页 DOM / 双语浏览器验证 ----
  { domain: 'ui', id: 'U1', why: 'AgentBoard 前端与交互', re: /^agentboard-frontend-ux$/ },
  { domain: 'ui', id: 'U2', why: 'apps/web 新增绘制形态', re: /^web-inline-drawing-/ },
  { domain: 'ui', id: 'U3', why: 'web 测试页 DOM 验证路径与基线', re: /^web-testpage-/ },
  { domain: 'ui', id: 'U4', why: '星图 PIXI 重建设计', re: /^design-graph-pixi$/ },
  { domain: 'ui', id: 'U5', why: '时间轴双语浏览器验证口径', re: /^timeline-bilingual-/ },
  { domain: 'ui', id: 'U6', why: 'UI-FILTER01 标签 toggle 筛选', re: /ui-filter/i },

  // ---- KB-PAGE-3 收口轮：3b 留 NULL 的 21 页按设计 §5.4 逐页补域（非按 scope 批量） ----
  { domain: 'accounts', id: 'A7', why: '平台添加账号 / 凭据落点 / 积分接口（3b 未覆盖的 common 页）', re: /^platform-(add-account|credential-storage|credits-api)$/ },
  { domain: 'knowledge', id: 'K8', why: '知识卡引用落地面（KB-PAGE-2b）', re: /^agentboard-knowledge-links-implementation$/ },
  { domain: 'knowledge', id: 'K9', why: '纯文本导入样例页', re: /^纯文本样例/i },
  { domain: 'knowledge', id: 'K10', why: '图片演练页', re: /^img-3edebe$/ },
  { domain: 'knowledge', id: 'K11', why: '知识页分类回填口径（KB-PAGE-3 收口）', re: /^agentboard-knowledge-taxonomy-rollout$/ },
  { domain: 'board', id: 'B5', why: 'AgentBoard 测试与门禁', re: /^agentboard-testing-gates$/ },

  // ---- infra：服务端数据层 / 分布式存储 / DSH 工具链 / 打包通道 ----
  { domain: 'infra', id: 'I1', why: 'AgentBoard 服务端与数据层', re: /^agentboard-server-data$/ },
  { domain: 'infra', id: 'I2', why: '工作区自治数据库（分布式存储）设计', re: /^workspace-distributed-storage-/ },
  { domain: 'infra', id: 'I3', why: 'DSH 工具链问题（认证/codegraph/归档会话）', re: /^dsh-/ },
  { domain: 'infra', id: 'I4', why: 'MSI 打包通道与再发布', re: /msi 打包|msi-/i },
  { domain: 'infra', id: 'I5', why: 'P0 清缓存验证状态行（工具链）', re: /p0 清缓存/i },

  // ---- KB-PAGE-4（a83ab388）：2026-11-05 服务换代后新落页，逐页精确 slug 归域 ----
  // 旧进程（pid 35060，11-04 16:00 起）落后 dist 一整天：create 时 domain 被 strict schema 拒、category 缺省落 legacy。
  { domain: 'chat', id: 'C4', why: '会话侧栏服务端契约（CHAT-SB1）', re: /^chat-session-sidebar$/ },
  { domain: 'chat', id: 'C5', why: '轮次底座 session_turn 契约（CHAT-TURN1）', re: /^agentboard-session-turn-contract$/ },
  { domain: 'chat', id: 'C6', why: 'AUDIT-SRV 会话服务端配套交接页', re: /^handoff-759a545b-09cd-4326-bd1b-0f9755bb05eb$/ },
  { domain: 'accounts', id: 'A8', why: 'CLI 三来源账号手动导入（CLI-IMPORT）', re: /^cli-account-manual-import$/ },
  { domain: 'board', id: 'B6', why: 'GIT-ON-DONE 收尾提交边界', re: /^agentboard-git-on-done-scope$/ },
  { domain: 'board', id: 'B7', why: 'kb release 单卡释放口径', re: /^cli-release-command$/ },
  { domain: 'board', id: 'B8', why: 'KB-CLI-2 CLI 错误信封与退出码', re: /^kb-cli-error-envelope$/ },
  { domain: 'board', id: 'B9', why: 'kb list-tasks 请求数模型（KB-CLI-4）', re: /^kb-cli-list-request-model$/ },
  { domain: 'board', id: 'B10', why: 'KB-SRVMSG done nudge 与 comment 语义交接页', re: /^handoff-服务端提示文案-2026-11-05$/ },
  { domain: 'ui', id: 'U7', why: '抽屉点外部关闭的四类豁免', re: /^drawer-outside-dismiss-pitfalls$/ },
  { domain: 'ui', id: 'U8', why: 'Modal 焦点闭环', re: /^modal-focus-loop$/ },
  { domain: 'ui', id: 'U9', why: 'apps/web HMR 双 store 假象', re: /^web-hmr-store-reverify$/ },
  { domain: 'infra', id: 'I6', why: '产物陈旧自检（dist/src 比对与 server:ensure 换代）', re: /^agentboard-build-staleness$/ },
  { domain: 'knowledge', id: 'K12', why: 'KB-CR-2 知识路由层三处归一交接页', re: /^handoff-67fbc184-ee8a-48b2-b185-8f0115dc7cdb$/ },
  { domain: 'knowledge', id: 'K13', why: 'PROV-C 证据写入侧示例页（已归档）', re: /^provc-sample-check$/ },
  { domain: 'knowledge', id: 'K14', why: '分类体系参数探针页（已删）', re: /^tmp-taxonomy-probe$/ },
];

/**
 * KB-PAGE-3 收口轮：`legacy` 逐页分流白名单（设计 §5.2/§5.4：legacy 是迁移期临时态，验收清零）。
 * 只写 category 一列；pinned=稳定操作口径，solved=可复用踩坑/结论。禁止按 scope 一把梭。
 */
const LEGACY_TRIAGE = new Map([
  // common：平台账号/凭据/切换/积分 → pinned（稳定操作口径）
  ['platform-account-ops-overview', 'pinned'],
  ['platform-account-switch', 'pinned'],
  ['platform-add-account', 'pinned'],
  ['platform-credential-storage', 'pinned'],
  ['platform-credits-api', 'pinned'],
  ['zcode-deep-dive', 'pinned'],
  // common：导入演练 / UI 修复结论 → solved
  ['KBIMP-2B-同-slug-演练', 'solved'],
  ['KBIMP-2B-同-slug-演练-202611040819', 'solved'],
  ['KBIMP-2B-同-slug-演练-202611040821', 'solved'],
  ['KBIMP-3-Markdown-样例', 'solved'],
  ['KBIMP-3-数组样例-B', 'solved'],
  ['纯文本样例-第一行作为标题', 'solved'],
  ['dsh-hide-archived-sessions', 'solved'],
  // workspace：归档/软删的历史交接与验证页 → solved
  ['guide-selftest-20261104', 'solved'],
  ['handoff-077ece77-75d3-40cf-adcc-c8b08b731e84', 'solved'],
  ['handoff-2044dcb4-e422-4ce3-af83-cb1b55cb63ad', 'solved'],
  ['handoff-72daf739-fa1d-4847-aaef-5fd4d9e87959', 'solved'],
  ['img-3edebe', 'solved'],
  ['page-time-verify', 'solved'],
  ['project-status-2026-11-03', 'solved'],
  // KB-PAGE-4（a83ab388）：换代期新落的 legacy 页，全是「已落地工作的结论/踩坑记录」→ solved（无稳定操作口径，故不 pinned）
  ['handoff-67fbc184-ee8a-48b2-b185-8f0115dc7cdb', 'solved'],
  ['handoff-759a545b-09cd-4326-bd1b-0f9755bb05eb', 'solved'],
  ['handoff-服务端提示文案-2026-11-05', 'solved'],
  ['provc-sample-check', 'solved'],
  ['tmp-taxonomy-probe', 'solved'],
]);

function pickDomain(row) {
  const slug = row.slug ?? '';
  const hay = `${slug} ${row.title ?? ''}`;
  for (const rule of RULES) {
    // 精确锚定规则（^…$）只对 slug 单独判定；含标题关键词的规则对「slug + title」判定
    const target = rule.re.source.startsWith('^') && rule.re.source.endsWith('$') ? slug : hay;
    if (rule.re.test(target)) return rule;
  }
  return null;
}

function stats(db, label) {
  const total = db.prepare('SELECT count(*) c FROM knowledge_page').get().c;
  const rev = db.prepare('SELECT count(*) c FROM knowledge_revision').get().c;
  const bodyLen = db.prepare('SELECT sum(length(body_md)) s FROM knowledge_page').get().s;
  const slugs = db.prepare('SELECT count(DISTINCT slug) c FROM knowledge_page').get().c;
  const dist = db
    .prepare('SELECT domain, count(*) c FROM knowledge_page GROUP BY domain ORDER BY domain IS NOT NULL, domain')
    .all()
    .map((d) => `${d.domain ?? 'NULL'}=${d.c}`)
    .join(' ');
  console.log(`[${label}] total=${total} revision=${rev} body_len=${bodyLen} distinct_slug=${slugs}`);
  console.log(`[${label}] domain: ${dist}`);
  return { total, rev, bodyLen, slugs, dist };
}

const dbPath = process.env.AGENTBOARD_DB ?? `${process.env.APPDATA}/AgentBoard/agentboard.db`;
if (!existsSync(dbPath)) {
  console.error(`DB 不存在：${dbPath}`);
  process.exit(1);
}
const db = new Database(dbPath);
const triage = process.argv.includes('--legacy-triage');
const apply = process.argv.includes('--apply');
// 收口轮按工作区收窄（common 页共享，按主题归域仍写；workspace 页只动自己的）
const wsIndex = process.argv.indexOf('--workspace');
const onlyWs = wsIndex === -1 ? null : process.argv[wsIndex + 1];
const inScope = (row) => !onlyWs || row.scope === 'common' || row.workspace_id === onlyWs;
const mode = apply ? 'apply' : process.argv.includes('--stats') ? 'stats' : 'dry-run';

if (mode === 'stats') {
  stats(db, 'stats');
  db.close();
  process.exit(0);
}

if (triage) {
  // 收口轮：只写 category（legacy → design/solved/pinned/open），逐页白名单，幂等（WHERE category='legacy'）
  const before = stats(db, 'before');
  const rowList = db.prepare("SELECT id, scope, workspace_id, slug, category FROM knowledge_page WHERE category='legacy' ORDER BY scope, slug").all().filter(inScope);
  const hits = [];
  const misses = [];
  for (const row of rowList) {
    const to = LEGACY_TRIAGE.get(row.slug);
    if (to) hits.push({ row, to });
    else misses.push(row);
  }
  console.log(`\nlegacy 待分流 ${hits.length} 页，无白名单 ${misses.length} 页（共 ${rowList.length}）`);
  for (const { row, to } of hits) console.log(`  ${row.slug} legacy → ${to}`);
  if (misses.length) {
    console.error('存在未在白名单的 legacy 页，已中止：' + misses.map(r => r.slug).join(', '));
    db.close();
    process.exit(1);
  }
  if (apply) {
    const stmt = db.prepare("UPDATE knowledge_page SET category = ? WHERE id = ? AND category='legacy'");
    const changed = db.transaction(() => hits.reduce((n, { row, to }) => n + stmt.run(to, row.id).changes, 0))();
    console.log(`\n已更新 ${changed} 行`);
    const after = stats(db, 'after');
    // 收窄到本次范围：别的 workspace 的 legacy 不归本卡负责，不得顺手改
    const legacyLeft = onlyWs
      ? db.prepare("SELECT count(*) c FROM knowledge_page WHERE (scope='common' OR workspace_id=?) AND category='legacy'").get(onlyWs).c
      : db.prepare("SELECT count(*) c FROM knowledge_page WHERE category='legacy'").get().c;
    const invariants = {
      'total 不变': before.total === after.total,
      'revision 不变': before.rev === after.rev,
      'body_len 不变': before.bodyLen === after.bodyLen,
      'distinct_slug 不变': before.slugs === after.slugs,
      'legacy=0': legacyLeft === 0,
    };
    console.log('自证：' + Object.entries(invariants).map(([k, v]) => `${k}=${v ? '✅' : '❌'}`).join(' '));
    if (!Object.values(invariants).every(Boolean)) { db.close(); process.exit(1); }
  } else {
    console.log('\n（dry-run：未写库，加 --apply 执行）');
  }
  db.close();
  process.exit(0);
}

const before = stats(db, 'before');
const rows = db.prepare('SELECT id, scope, workspace_id, slug, title, category, domain FROM knowledge_page ORDER BY scope, slug').all().filter(inScope);

const hits = [];
const misses = [];
for (const row of rows) {
  if (row.domain !== null && row.domain !== undefined) continue; // 已归类的跳过（幂等）
  const rule = pickDomain(row);
  if (rule) hits.push({ row, rule });
  else misses.push(row);
}

console.log(`\n待写入 ${hits.length} 页，留 NULL ${misses.length} 页（共 ${rows.length}）`);
for (const { row, rule } of hits) {
  console.log(`  [${rule.id}] ${row.slug} → ${rule.domain}（${rule.why}）`);
}
if (hits.some((h) => !KNOWLEDGE_DOMAINS.includes(h.rule.domain))) {
  console.error('词表校验失败：存在词表以外的 domain，已中止');
  process.exit(1);
}

if (mode === 'apply') {
  const stmt = db.prepare('UPDATE knowledge_page SET domain = ? WHERE id = ? AND domain IS NULL');
  const tx = db.transaction((items) => {
    let n = 0;
    for (const { row, rule } of items) n += stmt.run(rule.domain, row.id).changes;
    return n;
  });
  const changed = tx(hits);
  console.log(`\n已更新 ${changed} 行`);
  const after = stats(db, 'after');
  const invariants = {
    'total 不变': before.total === after.total,
    'revision 不变': before.rev === after.rev,
    'body_len 不变': before.bodyLen === after.bodyLen,
    'distinct_slug 不变': before.slugs === after.slugs,
  };
  console.log('自证：' + Object.entries(invariants).map(([k, v]) => `${k}=${v ? '✅' : '❌'}`).join(' '));
  if (!Object.values(invariants).every(Boolean)) {
    console.error('自证失败：存在不变量被破坏');
    db.close();
    process.exit(1);
  }
} else {
  console.log('\n（dry-run：未写库，加 --apply 执行）');
}
db.close();
