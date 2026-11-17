import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { CommanderError, type Command } from 'commander';
import { request, CliHttpError } from '../api.js';
import { writeListJson, writeObjectJson } from '../json.js';
import { writeStderr, type Ctx } from '../io.js';
import { resolveWorkspaceId } from '../workspace.js';
import { KNOWLEDGE_DOMAIN_HINT, KNOWLEDGE_DOMAINS, KNOWLEDGE_SHORT_ID_LEN } from '@agentboard/shared';

interface ScopeOptions { scope: string; workspace?: string }
async function scopeFor(ctx: Ctx, opts: ScopeOptions, search = false): Promise<{ scope: string; workspace_id?: string }> {
  if (!(search ? ['workspace', 'common', 'both'] : ['workspace', 'common']).includes(opts.scope)) throw new Error('知识范围无效：--scope 只能是 workspace 或 common（search 另可用 both）');
  if (opts.scope === 'common') {
    if (opts.workspace) throw new Error('common 不接受 --workspace（公共知识不绑定工作区）');
    return { scope: 'common' };
  }
  // B：缺省按 cwd 解析当前工作区（与 list-tasks 同一解析器）；显式 --workspace 仍覆盖
  return { scope: opts.scope, workspace_id: await resolveWorkspaceId(ctx.base, opts.workspace) };
}
const linkRef = (raw: unknown): string | undefined => {
  // BORROW-3.1（D10）：link 已是字符串；兼容期容忍旧对象 {ref}
  const link = (raw as { link?: unknown }).link;
  if (typeof link === 'string') return link;
  return (link as { ref?: string } | undefined)?.ref;
};
const pageLine = (raw: unknown): string => { const p = raw as Record<string, unknown>; const link = linkRef(raw); return `${p.page_id ?? p.id} [${p.scope}] rev:${p.revision} ${p.title}${link ? `  link: ${link}` : ''}${p.snippet ? `\n${snippetOf(String(p.snippet))}` : ''}`; };
/** KB-CLI-3a（CLI-10）：snippet 截 120 字（含省略号），保证一屏可见 ≥5 条命中 */
const SNIPPET_MAX = 120;
const snippetOf = (raw: string): string => (raw.length > SNIPPET_MAX ? `${raw.slice(0, SNIPPET_MAX)}…` : raw);
function output(ctx: Ctx, data: unknown): void {
  // KB-CLI-3c：数组结果包信封；单对象视图（show / resolve / 分页视图）直出
  if (ctx.json) { if (Array.isArray(data)) writeListJson(ctx, data); else writeObjectJson(ctx, data); return; }
  if (Array.isArray(data)) { ctx.io.write(data.length ? data.map(pageLine).join('\n') + '\n' : '（无知识）\n'); return; }
  const p = data as Record<string, unknown>;
  if (Array.isArray(p.items)) {
    const items = p.items as unknown[];
    ctx.io.write((items.length ? items.map(pageLine).join('\n') + '\n' : '（无知识）\n') + (p.next_offset ? `下一页：--offset ${p.next_offset}\n` : ''));
    return;
  }
  const meta = [p.category !== undefined ? `category: ${String(p.category)}` : '', p.landed !== undefined ? `landed: ${p.landed === null ? '（未定）' : String(p.landed)}` : '', p.domain !== undefined ? `domain: ${String(p.domain ?? '未归类')}` : ''].filter(Boolean).join(' · ');
  const link = linkRef(data);
  ctx.io.write(renderPageDetail(data));
}
/**
 * P2-04（方向 B §7.2）：文件事实源下「写文件成败即命令成败」，每页 git 快照（page_commit）与
 * 「快照没进 git 即失败」语义随 BORROW-5.1 退役——CLI 不再读 page_commit 字段。
 */
/** KB-CLI-3a（CLI-06）：详情文本渲染单点（show --history 复用，页后追加逐条 rev 行） */
function renderPageDetail(data: unknown): string {
  const p = data as Record<string, unknown>;
  const meta = [p.category !== undefined ? `category: ${String(p.category)}` : '', p.landed !== undefined ? `landed: ${p.landed === null ? '（未定）' : String(p.landed)}` : '', p.domain !== undefined ? `domain: ${String(p.domain ?? '未归类')}` : ''].filter(Boolean).join(' · ');
  const link = linkRef(data);
  return `${p.id ?? ''} [${p.scope ?? ''}] rev:${p.revision ?? ''} ${p.title ?? ''}${meta ? `\n${meta}` : ''}${link ? `\nlink: ${link}` : ''}\n${p.body_md ?? JSON.stringify(data, null, 2)}\n`;
}
const query = (params: Record<string, string | number | undefined>) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();

// ---------------- 字段级校验（中文提示，替代 zod 英文串） ----------------

const SOURCE_TYPES = ['file', 'url', 'agent'];
const SOURCE_KEYS = ['source_id', 'source_type', 'locator', 'captured_at', 'content_hash', 'snapshot'];
const EVIDENCE_KEYS = ['source_id', 'locator', 'snapshot'];
const HEX64 = /^[a-fA-F0-9]{64}$/;

const preview = (value: unknown): string => {
  if (typeof value === 'string') return value.length > 40 ? `"${value.slice(0, 40)}…"` : `"${value}"`;
  if (value === undefined) return '缺失';
  return JSON.stringify(value) ?? String(value);
};
function fail(message: string): never { throw new Error(message); }
// C：知识页分类与落地状态（服务端 KB-MODEL 已支持；legacy 只由历史数据产生，不接受 CLI 写入）
const CATEGORIES = ['design', 'solved', 'pinned', 'open'] as const;
const LANDED_STATES = ['landed', 'partial', 'proposed'] as const;
// P2-04（M5）：link 默认产出 [[wikilink]]；token（knowledge:<uuid>）/markdown/plain 兼容保留
const LINK_FORMATS = ['wikilink', 'token', 'markdown', 'plain'] as const;

function validateLimit(value: string, max = 100): string {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    fail(`--limit 必须是 1–${max} 的整数（当前：${preview(value)}）`);
  }
  return String(n);
}
function validateOffset(value: string): string {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) fail(`--offset 必须是 ≥0 的整数（当前：${preview(value)}）`);
  return String(n);
}
function validateFormat(value: string): string {
  if (!(LINK_FORMATS as readonly string[]).includes(value)) {
    fail(`--format 只能是 ${LINK_FORMATS.join(' | ')}（当前：${preview(value)}）；省略时为 wikilink`);
  }
  return value;
}
function validateCategory(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!(CATEGORIES as readonly string[]).includes(value)) fail(`--category 只能是 ${CATEGORIES.join(" | ")}（当前：${preview(value)}）`);
  return value;
}
function validateLanded(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!(LANDED_STATES as readonly string[]).includes(value)) fail(`--landed 只能是 ${LANDED_STATES.join(" | ")}（当前：${preview(value)}）`);
  return value;
}
/** CLI-03：--domain 先于 sources/evidence 校验，非法域先报词表，不被「缺少 sources」抢先盖住 */
function validateDomain(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!(KNOWLEDGE_DOMAINS as readonly string[]).includes(value)) fail(`--domain 只能是 ${KNOWLEDGE_DOMAIN_HINT}（当前：${preview(value)}）`);
  return value;
}
const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 读 `--sources` / `--sources-file` 二选一（同时给视为用法错误，避免静默取一个） */
function readJsonArg(flag: string, inline: string | undefined, file: string | undefined, warn: (message: string) => void): unknown {
  if (inline !== undefined && file !== undefined) fail(`${flag} 与 ${flag}-file 只能给一个（推荐用 ${flag}-file 避免 Windows 引号转义）`);
  if (inline === undefined && file === undefined) fail(`缺少 ${flag}（或 ${flag}-file）：见 kb knowledge create --help 的字段说明与示例`);
  const text = file !== undefined ? (() => {
    const path = resolve(process.cwd(), file);
    let raw: Buffer;
    try { raw = readFileSync(path); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'ERR';
      return fail(`${flag}-file 读取失败：${path}（${code}）`);
    }
    // KB-CREATE-ERGO：Windows 记事本/PowerShell 5.1 存的 JSON 常带 UTF-8 BOM，直接 JSON.parse 报 `Unexpected token`
    const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
    if (hasBom) warn(`提示：检测到 UTF-8 BOM，已剥离后解析（${flag}-file）\n`);
    return (hasBom ? raw.subarray(3) : raw).toString('utf8');
  })() : inline!;
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${flag} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}\n提示：Windows 下改用 ${flag}-file <路径> 可完全避开引号转义`);
  }
}

function expectString(flag: string, path: string, value: unknown, max: number): void {
  if (typeof value !== 'string' || value.length === 0) fail(`${flag}${path} 必须是 1–${max} 字符的字符串（当前：${preview(value)}）`);
  if (value.length > max) fail(`${flag}${path} 超长：最多 ${max} 字符（当前 ${value.length}）`);
}

function validateSources(flag: string, raw: unknown): void {
  if (!Array.isArray(raw)) fail(`${flag} 必须是数组，例如 [{"source_id":"file:README.md",...}]（当前：${preview(raw)}）`);
  if (raw.length === 0) fail(`${flag} 至少要有 1 条来源`);
  if (raw.length > 100) fail(`${flag} 最多 100 条（当前 ${raw.length}）`);
  raw.forEach((item: unknown, index: number) => {
    const at = `[${index}]`;
    if (!isPlainObject(item)) fail(`${flag}${at} 必须是对象（当前：${preview(item)}）`);
    for (const key of Object.keys(item)) {
      if (!SOURCE_KEYS.includes(key)) fail(`${flag}${at}.${key} 不是允许的字段；允许：${SOURCE_KEYS.join(' / ')}`);
    }
    expectString(flag, `${at}.source_id`, item.source_id, 200);
    if (!SOURCE_TYPES.includes(String(item.source_type))) {
      fail(`${flag}${at}.source_type 必须是 ${SOURCE_TYPES.join(' | ')}（当前：${preview(item.source_type)}）`);
    }
    expectString(flag, `${at}.locator`, item.locator, 2000);
    if (typeof item.captured_at !== 'number' || !Number.isInteger(item.captured_at) || item.captured_at < 0) {
      fail(`${flag}${at}.captured_at 必须是 epoch 毫秒的非负整数（当前：${preview(item.captured_at)}）；PowerShell 取法：[DateTimeOffset]::Now.ToUnixTimeMilliseconds()）`);
    }
    if (typeof item.content_hash !== 'string' || !HEX64.test(item.content_hash)) {
      fail(`${flag}${at}.content_hash 必须是 64 位十六进制 sha256（当前：${preview(item.content_hash)}）；命令行取法：Get-FileHash -Algorithm SHA256 <文件> 取 Hash`);
    }
    if (item.snapshot !== undefined) expectString(flag, `${at}.snapshot`, item.snapshot, 100000);
  });
}

function validateEvidence(flag: string, raw: unknown): void {
  if (!Array.isArray(raw)) fail(`${flag} 必须是数组，例如 [{"source_id":"file:README.md","locator":"README.md:1-20"}]（当前：${preview(raw)}）`);
  if (raw.length === 0) fail(`${flag} 至少要有 1 条证据`);
  if (raw.length > 100) fail(`${flag} 最多 100 条（当前 ${raw.length}）`);
  raw.forEach((item: unknown, index: number) => {
    const at = `[${index}]`;
    if (!isPlainObject(item)) fail(`${flag}${at} 必须是对象（当前：${preview(item)}）`);
    for (const key of Object.keys(item)) {
      if (!EVIDENCE_KEYS.includes(key)) fail(`${flag}${at}.${key} 不是允许的字段；允许：${EVIDENCE_KEYS.join(' / ')}`);
    }
    expectString(flag, `${at}.source_id`, item.source_id, 200);
    expectString(flag, `${at}.locator`, item.locator, 2000);
    if (item.snapshot !== undefined) expectString(flag, `${at}.snapshot`, item.snapshot, 100000);
  });
}

/**
 * KB-CREATE-ERGO：`--hash-from-file <source_id>=<path>`（可重复）按 source_id 精确回填 content_hash。
 * 只认 source_id，不按 locator 猜；未匹配或文件读不到都 fail（退出码 1）并点名。
 */
function applyHashFromFiles(flag: string, raw: unknown, specs: string[] | undefined): void {
  if (specs === undefined || specs.length === 0) return;
  if (!Array.isArray(raw)) fail(`${flag} 需要配合 --sources / --sources-file 使用`);
  const items = raw.filter(isPlainObject);
  for (const spec of specs) {
    const eq = spec.indexOf('=');
    if (eq <= 0 || eq === spec.length - 1) {
      fail(`${flag} 用法：<source_id>=<path>（当前：${preview(spec)}）；可重复，例如 --hash-from-file file:README.md=README.md`);
    }
    const sourceId = spec.slice(0, eq).trim();
    const relPath = spec.slice(eq + 1).trim();
    const hit = items.find(item => item.source_id === sourceId);
    if (hit === undefined) {
      const known = items.map(item => String(item.source_id)).join(' / ');
      fail(`${flag} 未匹配到 source_id：「${sourceId}」（现有：${known === '' ? '（无）' : known}）`);
    }
    const absolute = resolve(process.cwd(), relPath);
    let bytes: Buffer;
    try { bytes = readFileSync(absolute); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'ERR';
      fail(`${flag} 读不到文件：${absolute}（${code}）`);
    }
    hit.content_hash = createHash('sha256').update(bytes).digest('hex');
  }
}

// ---------------- help 文案 ----------------

const FIELD_HELP = `
字段说明（--sources / --evidence；服务端要求各 ≥1 条）
  --sources 数组，每条对象：
    source_id    字符串 1–200        必填  来源稳定标识，如 "file:README.md" / "url:https://…" / "agent:board-server"
    source_type  file | url | agent  必填
    locator      字符串 1–2000       必填  定位：文件相对路径 / URL / agent 名
    captured_at  非负整数            必填  采集时刻 epoch 毫秒（PowerShell：[DateTimeOffset]::Now.ToUnixTimeMilliseconds()）
    content_hash 64 位十六进制       必填  来源内容 sha256（可用 --hash-from-file <source_id>=<path> 自动填，见下）
    snapshot     字符串 可选         仅 url / agent 来源可带；file 来源带 snapshot 会被服务端拒（「本地代码来源只保存路径和 hash」）
  --evidence 数组，每条对象：
    source_id    字符串 1–200        必填  必须精确指向上面某个 source_id（不要拿 locator 猜对应关系）
    locator      字符串 1–2000       必填  证据书写约定：仓库相对路径 + 可选行号区间，如 "apps/web/src/x.ts:125-137"；
                                          非文件证据用 cmd: / issue: / agent: 前缀，如 "cmd:npm test" / "issue:<uuid>"。
                                          「file:12-30」这类只有行号没有路径的是畸形条目，不要这样写（格式 CLI 不拦截，靠约定）
    snapshot     字符串 可选         同 sources：file 来源的证据不带摘录；带则必须非空且 ≤2 KiB
  snapshot 约定：只放简短摘要或 diff 片段，禁止把工具报告 JSON 整段塞入（服务端只查非空与 ≤2 KiB，不校验格式）。
  去重约定：同一 evidence 不重复登记；同一提交（同一 sha）有多条时只保留一条。
  其它字段一律拒绝（服务端 .strict()），错误会指出具体字段名与期望格式。
  --hash-from-file  <source_id>=<path>，可重复：按 source_id 精确匹配 sources 条目并写入该文件 sha256（小写 64 位）；
                   不按 locator 猜、不跨条目复用；未匹配或文件读不到都退出码 1 并点名。

维度说明（--domain 与 --scope 是两个正交维度，不要混）：
  --domain  知识领域：accounts | knowledge | board | chat | ui | infra（create 必填；表示这条知识属于哪个业务域）
  --scope   页归属范围：workspace（挂到某个工作区，须配 --workspace）| common（公共，不绑工作区）
  示例：--scope common --domain infra 是「公共范围里的基础设施知识」；同一 domain 可同时有 workspace 与 common 两页。
`;

/**
 * KBGUIDE：知识页「内容口径」。CLI help 是多数人唯一的入口，口径必须写在这里，
 * 并与 skills/using-agentboard 的「知识页写什么（内容口径）」保持同一份说法。
 */
const CONTENT_GUIDE = `内容口径（写什么 / 不写什么）：
  写：设计点、技术点、注意点——结论、约束、坑、取舍与理由、可复用的做法
  不写：完成情况、剩余待办、个人进度、日报式「今天做了什么」（这些属任务评论与变更日志，不属知识页）
  按领域分页：一个领域一页（如「知识库导入」「DB 迁移」），不要把多个主题塞进一页
  slug 语义化：用主题词（cache-policy / db-migration）；**禁用 handoff-<uuid>** 这类一次性流水号
  已有同主题页用 revise 演进，不新建重复页（先 kb knowledge list --status all --include-expired 找同主题）`;
const GUIDE_POINTER = '详见 skills/using-agentboard 的「知识页写什么（内容口径）」';
const CREATE_HELP = `${FIELD_HELP}
示例 A（PowerShell：单引号包 JSON、反引号续行；**PowerShell 不支持 \`<\` 重定向**，正文用管道喂 --stdin；实测可直接复制）：
  kb knowledge create --scope common --title '缓存策略' --slug cache-policy --domain knowledge --stdin \`
    --sources '[{"source_id":"file:README.md","source_type":"file","locator":"README.md","captured_at":1763000000000,"content_hash":"'"$((Get-FileHash README.md -Algorithm SHA256).Hash.ToLower())"'"}]' \`
    --evidence '[{"source_id":"file:README.md","locator":"README.md:1-20"}]' \`
    注：上面这种写法在 PowerShell 里需要把正文用管道送进来，完整可复制版本见示例 C。

示例 B（cmd：双引号包 JSON，内部双引号写 \\"，正文用 \`<\` 重定向）：
  kb knowledge create --scope common --title "缓存策略" --slug cache-policy --domain knowledge --stdin ^
    --sources "[{\\"source_id\\":\\"file:README.md\\",\\"source_type\\":\\"file\\",\\"locator\\":\\"README.md\\",\\"captured_at\\":1763000000000,\\"content_hash\\":\\"<64位hex>\\"}]" ^
    --evidence "[{\\"source_id\\":\\"file:README.md\\",\\"locator\\":\\"README.md:1-20\\"}]" < body.md

示例 C（**推荐**，零引号转义；把两个 JSON 存成文件后，PowerShell 可直接复制）：
  Get-Content body.md -Raw | kb knowledge create --scope common --title '缓存策略' --slug cache-policy --domain knowledge --stdin \`
    --sources-file sources.json --evidence-file evidence.json \`
    --hash-from-file 'file:README.md=README.md'
  （--sources-file 带 UTF-8 BOM 也能读：CLI 会先剥 BOM 再解析，并在 stderr 提示；--hash-from-file 可重复）

最小文件样例 sources.json：
  [{"source_id":"file:README.md","source_type":"file","locator":"README.md","captured_at":1763000000000,"content_hash":"0000000000000000000000000000000000000000000000000000000000000000"}]
最小文件样例 evidence.json：
  [{"source_id":"file:README.md","locator":"README.md:1-20"}]

输出：文本模式在标题后补一行 link: knowledge:<uuid>（--json 中为 link 对象，可直接发给别人打开）；
      引用串也可单独用 kb knowledge link <page-id> 生成（P2-04：默认产出 [[wikilink]]，--format token 取 knowledge:<uuid>）。
退出码：0 成功；1 参数/服务端错误（含字段级提示）；2 任务占用、知识 revision 冲突或文件冲突（KNOWLEDGE_*，409）

${CONTENT_GUIDE}
${GUIDE_POINTER}
`;

const REVISE_HELP = `${FIELD_HELP}
说明：只改提供的字段（--title / --stdin / --sources / --evidence / --expires-at 均可选），但 --expected-revision 必填（CAS）。
必填：<page-id>（支持完整 UUID / ≥8 位唯一 id 前缀 / slug；前缀先 resolve 成完整 id，多命中 exit 2 不猜）
可选：--scope <workspace|common>（**可省略**：省略时内部走 resolve，按 both 解析 id / ≥8 位前缀 / slug，歧义 exit 2）、--workspace <id|名>
示例（PowerShell，正文用管道；cmd 下可换成 \`< body.md\`）：
  Get-Content body.md -Raw | kb knowledge revise <page-id> --scope common --expected-revision 3 --stdin --title '新标题'
  Get-Content body.md -Raw | kb knowledge revise <page-id> --scope workspace --workspace 任务看板 --expected-revision 3 --stdin \`
    --sources-file sources.json --evidence-file evidence.json
  kb knowledge revise 3f8da34e --expected-revision 3 --landed landed（省略 --scope + 前缀）
同主题内容演进用 revise（同一 page-id 累加 revision），不要为「更新版内容」新建页。
--expected-revision 是 CAS：必须与库内 revision 一致，旧值以退出码 2 退出并提示「知识页已更新，请重新读取」。
输出：文本模式在标题后补一行 link: knowledge:<uuid>（--json 中为 link 对象）。
退出码：0 成功；1 参数/服务端错误（含「引用无法唯一解析」）；2 版本冲突（KNOWLEDGE_REVISION_CONFLICT）或前缀歧义

${GUIDE_POINTER}
`;

/** KB-CLI-IMPORT：与服务端一致的上限 */
const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
const IMPORT_MAX_CHARS = 2_000_000;
const IMPORT_FORMATS = ['md', 'txt', 'json'];
/** 扩展名 → format；不支持返回 'unknown'（由调用方给中文提示） */
function detectImportFormat(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
  if (lower.endsWith('.txt')) return 'txt';
  if (lower.endsWith('.json')) return 'json';
  return 'unknown';
}

const ACTION_HELP = `合法动作（第 2 个位置参数，只能取）：
  archive   归档（status → archived；front matter 重写，文件保留）
  restore   恢复（status → active）
  delete    删除（撤文件，不可逆：文件事实源下软删即删除 Docs/<slug>.md；旧库只读历史可用 export-legacy 兜底）
必填：<page-id> <action> --expected-revision <n>（CAS，比对 front matter revision）
      <page-id> 支持完整 UUID / ≥8 位唯一 id 前缀 / slug，前缀会先 resolve 成完整 id
可选：--scope <workspace|common>（**可省略**：省略时内部走 resolve，按 both 先解析 id / ≥8 位前缀 / slug，歧义 409 不猜；
      显式给出 --scope 时同样先 resolve 前缀，歧义同样 exit 2）、--workspace <id|名>
示例：
  kb knowledge action <page-id> archive --scope common --expected-revision 2
  kb knowledge action <page-id> restore --scope workspace --workspace 任务看板 --expected-revision 3
  kb knowledge action <page-id> archive --expected-revision 2（省略 --scope，自动 resolve）
退出码：0 成功；1 参数/服务端错误；2 版本冲突或文件冲突（KNOWLEDGE_REVISION_CONFLICT / KNOWLEDGE_FILE_CONFLICT，409）；
        resolve 歧义或跨范围也返回 2（仅省略 --scope 时会发生）
`;

/** P2-04（M10）：rename 帮助 */
const RENAME_HELP = `
P2-04（M10）：重命名知识页 slug——原子 rename 文件 + 全库扫描批量重写 [[old]]→[[new]]（含 [[a|b]] / [[a#h]] / [[a#h|b]] 与页嵌入 ![[a]] 形态），页面 id 不变，revision +1（CAS）。
必填：<page-id> <new-slug> --expected-revision <n>
      <page-id> 支持完整 UUID / ≥8 位唯一 id 前缀 / slug（前缀先 resolve，多命中 exit 2 不猜）
可选：--scope <workspace|common>（**可省略**：省略时自动 resolve）、--workspace <id|名>
行为约定：
  - 页面 id 不变：历史 knowledge:<uuid> 引用继续解析到同一页；
  - 引用重写覆盖改名页所在目录与（公共页改名时）各工作区目录里解析到本页的引用；
    目标目录若存在自己的同名页，其 [[old]] 指向它自己的页，不改写；
  - 代码块/行内代码里的 [[...]] 不重写；![[x.png]] 附件引用不重写；
  - 直接改文件名（不走本命令）→ reconcile 报「slug 与文件名不一致」冲突，由人裁决。
示例：
  kb knowledge rename <page-id> cache-policy-v2 --scope common --expected-revision 3
  kb knowledge rename 3f8da34e cache-policy-v3 --expected-revision 4（省略 --scope + 前缀）
退出码：0 成功；1 参数/服务端错误（含「引用无法唯一解析」）；2 版本冲突 / slug 冲突 / 文件冲突（409 KNOWLEDGE_*）/ 前缀歧义
`;

/** KB-CLI-IMPORT：P2-04（M11）语义反转：外部 md 规范化为 Docs/<slug>.md 并补齐 front matter */
const IMPORT_HELP = `
P2-04（M11）：导入语义已反转——不再是「导入到 DB」，而是把外部 md/txt/json **规范化为 Docs/<slug>.md 并补齐 front matter**（sources/evidence/revision/content_hash 等字段由服务端生成）。

支持格式：
  md / markdown  → format=md（标题取第一个 # 标题，兜底文件名）
  txt            → format=txt（标题取首行，兜底文件名）
  json           → format=json（单对象或数组 ≤100 条，数组逐条建页）
  --format 可覆盖扩展名推断（md|txt|json）。

上限（与服务端一致）：
  单文件 ≤ 10 MB（UTF-8 字节，超了本地就拦，不会发请求）
  单页正文 ≤ 200 万字符

落盘（文件事实源）：
  服务端把每条内容写成 <Docs>/<slug 归一>.md（front matter 契约见 kb knowledge create --help 与 Docs/api.md「文件事实源」章节）；
  sources 自动构造：{ source_type: 'file', locator: <文件路径>, content_hash: <sha256>, captured_at }，file 来源不带 snapshot。
  落盘成功即导入成功，不再有 page_commit 快照语义。

slug 冲突（409 KNOWLEDGE_EXISTS）怎么办：
  - 传 --title 换标题（标题不同即生成不同 slug）
  - 或传 --slug 显式指定一个未被占用的 slug
  - 或先 ` + '`kb knowledge show <slug> --scope ...`' + ` 看已有页要不要直接 revise

示例：
  kb knowledge import Docs/写时复制.md --domain knowledge
  kb knowledge import notes.json --scope common --category design --landed proposed --domain infra
  kb knowledge import a.txt --format md --title 自定义标题 --labels 设计,缓存 --domain board
退出码：0 成功；1 参数/文件/服务端错误（含 413 IMPORT_TOO_LARGE / IMPORT_BODY_TOO_LONG）；2 slug 冲突（KNOWLEDGE_EXISTS）
`;

const SHOW_HELP = `
必填：<page-id>（支持完整 UUID / ≥8 位唯一 id 前缀 / slug）
可选：--scope <workspace|common>（**可省略**：省略时内部走 resolve，按 both 先解析 id / ≥8 位前缀 / slug，歧义 409 不猜；
      显式给出 --scope 时前缀同样先 resolve，歧义同样 exit 2）；--workspace <id|名>、--history 同时输出全部版本历史
输出：非 --json 时打印 id/scope/revision/title + link: knowledge:<uuid> + 正文；--json 打印服务端原对象
示例：
  kb knowledge show <page-id>
  kb knowledge show 3f8da34e --scope common
  kb --json knowledge show <page-id> --scope workspace --workspace 任务看板 --history
退出码：0 成功；1 不存在 / 引用无法唯一解析 / 参数错误；2 resolve 歧义或跨范围
`;

const FIND_SOURCE_HELP = `
KB-PAGE-2b：只读反查「哪些知识页的 sources 引用了这个文件」——改完代码想知道哪些知识页要同步时用。
必填：<path>（精确匹配 sources[].locator / content_hash / source_id，如 Docs/api.md）
可选：--scope workspace|common|both（默认 both）、--workspace <id|名>（scope 含 workspace 时缺省按 cwd 解析）
输出：每页一行 id/scope/revision/slug/title + link；--json 打印 { path, items }
示例：
  kb knowledge find-source Docs/api.md
  kb knowledge find-source docs/design-2026-11-04-knowledge-taxonomy.md --scope common
`;

/** P2-02 export-legacy：一次性迁移（旧库行集 → Docs/*.md；fan-out 中心库 + 各 localized 工作区库） */
const EXPORT_HELP = `
P2-02：把旧库知识页一次性导出为文件事实源 Docs/*.md（§7.7 / M12 / C8 / US-7 / R3 混合态迁移）。
数据源（fan-out，防丢页）：中心库（common 页 + 未下沉工作区的区页）+ 每个 db_mode=localized 的工作区库。
目标布局：common 页 → ~/.agentboard/Docs；工作区页 → <工作区>/.agentboard/Docs；文件名 = slug 归一.md。
可选参数：
  --scope <all|center|workspace>  导出范围（默认 all）
                                  center=只导中心库；workspace=只导指定工作区（需 --workspace）
  --workspace <id|名>             scope=workspace 时必填
  --to <dir>                      重定向输出根（默认按标准布局）：common → <dir>/Docs，
                                  工作区 → <dir>/ws-<工作区id>/Docs（便于演练/验证，不进真实目录）
  --dry-run                       只打印待导出清单与源库分布，不写任何文件
行为约定：
  - 写后逐文件回读校验（正文逐字节 + front matter 字段逐项），manifest（sha256）落 <Docs>/.export-manifest.json；
  - 幂等：重复跑目标文件已一致 → 跳过不新增；冲突（目标已存在且内容不同）→ 备份到
    <Docs>/.export-backup/<时间>/ 后整体暂停（退出码 2），绝不静默覆盖；
  - 旧库只读保留：不 DROP 表、不删行、不 UPDATE；回退靠旧库 + manifest 兜底（不做反向导入）。
示例：
  kb knowledge export-legacy --dry-run          # 待导出清单 + 源库分布
  kb knowledge export-legacy                    # 真实导出（幂等可重跑）
  kb knowledge export-legacy --scope center --to D:/tmp/export-staging --dry-run
退出码：0 成功（含 dry-run）；1 参数/服务端错误；2 目标文件冲突（KNOWLEDGE_EXPORT_CONFLICT，409）
`;

const LIST_HELP = `
必填：--scope <workspace|common>（workspace 范围缺省按 cwd 解析，可用 --workspace 覆盖）
可选：--status active|archived|deleted|all（默认 active）、--offset <n>（默认 0，≥0 整数）、--limit <n>（默认 20，1–100 整数）、--include-expired
输出：每页一行「<id> [scope] rev:<n> <title>」；有下一页时追加「下一页：--offset <n>」；--json 打印服务端原响应
示例：
  kb knowledge list --scope common --status active --limit 50
  kb knowledge list --scope workspace --workspace 任务看板 --include-expired
找同主题的既有页（含已归档/软删/过期，决定 revise 还是 create）：--status all --include-expired
退出码：0 成功；1 参数或服务端错误

${GUIDE_POINTER}
`;

const SEARCH_HELP = `
必填：<query>（1–500 字符）
可选：--scope workspace|common|both（默认 both）、--workspace <id|名>（scope=workspace 时缺省按 cwd 解析）、--limit <n>（默认 5，1–100 整数）
输出：命中页列表（每行 id/scope/revision/title + 摘要）；--json 打印服务端原响应
示例：
  kb knowledge search '缓存' --scope both --limit 5
  kb knowledge search 'vault' --scope workspace --workspace 任务看板
引用命中页时用 id 拼卡链接（每条结果都带 link）：[知识卡：{title}](knowledge:{id})；
纯文本降级：知识卡《{title}》 knowledge:{id} · rev:{n}。不要用 slug 或文件路径对外引用。
退出码：0 成功；1 参数或服务端错误
`;


const RESOLVE_HELP = `
KB-PAGE-2：按 id / ≥8 位 id 前缀 / slug 解析知识页引用（统一 resolve，四态固定）。
必填：<ref>；--scope <workspace|common> 可省略（省略时按 both 解析，歧义 exit 2 不猜）
输出：解析成功 → id/title/scope/revision + link（knowledge:<uuid>）；--json 打印服务端原对象
错误码与退出码：404 KNOWLEDGE_NOT_FOUND → 1；409 KNOWLEDGE_REF_AMBIGUOUS → 2（不猜第一条，给候选 id）；
             410 KNOWLEDGE_DELETED → 1（已删除，可看历史）；403 KNOWLEDGE_SCOPE_FORBIDDEN → 2（不回显标题）
示例：
  kb knowledge resolve 3f8da34e --scope common
  kb --json knowledge resolve cache-policy --scope workspace --workspace 任务看板
`;

/** C3：前缀/slug 解析失败的统一文案——不把「前缀解析不了」说成「页不存在」（后者把人引向「是不是删了」） */
const PREFIX_REF_LIKE = /^[0-9a-f]{1,35}$/i;

function prefixHint(ref: string): string {
  const raw = ref.trim();
  if (!PREFIX_REF_LIKE.test(raw)) return '';
  // ≥8 位前缀本身合法，只是没命中——别再说「请给 ≥8 位」（位数已经够了）
  if (raw.length >= KNOWLEDGE_SHORT_ID_LEN) return '；该前缀没有任何命中（页可能已改名/删除，用 kb knowledge list 核对）';
  return `；若这是 id 前缀，请给 ≥${KNOWLEDGE_SHORT_ID_LEN} 位（当前 ${raw.length} 位）唯一前缀或完整 UUID`;
}

const RECONCILE_HELP = `
P2：知识页文件只读检查（**不改任何文件**），是 KNOWLEDGE_FILE_CONFLICT（409）的标准处置入口。
检查项：front matter 必填/类型、文件名 vs slug 不一致、id 重复、content_hash 不符（外部编辑）、
        [[...]] 目标缺失、残留 tmp / lock。
必填：无。--scope 缺省 workspace（按 cwd 解析当前工作区，可用 --workspace 覆盖）；both 需 --workspace。
输出：N 页检查完成，M 处冲突；逐条列 [kind] slug / 文件 / 详情 / 建议。无冲突打印（无冲突）并 exit 0。
说明：本命令只读报告，不修复。冲突由人裁决（绝不自动改写正文）。
示例：
  kb knowledge reconcile
  kb knowledge reconcile --scope common
  kb --json knowledge reconcile --scope both --workspace 任务看板
`;

const LINK_HELP = `
P2-04（M5）：产出知识页的引用串。wikilink 已是主键形态，**默认 --format wikilink** 输出 [[slug]]；
uuid 仍是稳定标识（改名不变），token 格式保留给需要跨改名的场景。
可选：--format wikilink|token|markdown|plain（缺省 wikilink，其它值本地报错不请求）
输出：wikilink = [[slug]]（Obsidian 可点）；token = knowledge:<uuid>；
      markdown = [知识卡：标题](knowledge:<uuid>)；plain = 标题 + 空格 + token
agent 对外约定（A8 / M5）：
  看板内/知识正文引用：[[slug]]（wikilink 主键；改名由 kb knowledge rename 全库重写）
  跨改名稳定引用或机器可读：knowledge:<uuid>（uuid 是稳定标识，改名不变）
  禁止用 Docs 文件路径当知识引用。
示例：
  kb knowledge link cache-policy --scope common            # → [[cache-policy]]
  kb knowledge link cache-policy --scope common --format token
  kb knowledge link 3f8da34e --scope workspace --format markdown
`;

export function registerKnowledgeCommands(program: Command, context: () => Ctx): void {
  const knowledge = program.command('knowledge').description('共享知识库（项目与公共范围显式指定）')
    .addHelpText('after', `
常用流程：
  1) Get-Content body.md -Raw | kb knowledge create --scope common --title '…' --slug some-slug --domain knowledge --stdin --sources-file sources.json --evidence-file evidence.json
  2) kb knowledge show <page-id> --scope common
  3) Get-Content body.md -Raw | kb knowledge revise <page-id> --scope common --expected-revision 1 --stdin
  4) kb knowledge action <page-id> archive --scope common --expected-revision 2
  5) kb knowledge show <page-id>（可省 --scope，自动 resolve）；引用串用 kb knowledge link <page-id>（默认 [[wikilink]]）
  6) kb knowledge find-source Docs/api.md（反查哪些知识页引用了该文件）
  7) kb knowledge rename <page-id> <new-slug> --scope common --expected-revision 3（改名 + 全库重写引用）
字段说明：kb knowledge create --help（含 --sources/--evidence 每个字段与三种引号写法）
`);
  knowledge.command('search <query>').description('按文本检索知识页（默认 both）').option('--scope <scope>', 'workspace|common|both', 'both').option('--workspace <id|名>').option('--limit <n>', '结果数量', '5')
    .addHelpText('after', SEARCH_HELP)
    .action(async (q: string, opts: ScopeOptions & { limit: string }) => { const ctx = context(); output(ctx, await request(ctx.base, 'GET', `/api/knowledge/search?${query({ ...await scopeFor(ctx, opts, true), q, limit: validateLimit(opts.limit) })}`)); });
  const scoped = (command: Command) => command.requiredOption('--scope <scope>', 'workspace|common').option('--workspace <id|名>');
  // KB-PAGE-2：统一 resolve（四态退出码固定：0 / 1(404,410) / 2(409,403)）
  // K3：新增 invalid（422）——文件存在但校验失败，归入 2（「对象存在但不可用」，与 403/409 同档），
  // 避免排障时把「坏页」误当成「不存在」。
  const resolveExit = (error: unknown): number => {
    const status = (error as { status?: number }).status;
    return status === 409 || status === 403 || status === 422 ? 2 : 1;
  };
  /**
   * C3：知识页引用的**唯一解析入口**（show / action / revise / rename 共用）。
   *
   * 改前是「省略 --scope 才 resolve」：显式给 --scope 时把原始输入（≥8 位前缀或 slug）直接拼进
   * `/api/knowledge/pages/:id`，服务端只认完整 uuid → 404「知识页不存在」。同一族三套行为
   * （show/resolve/action 认前缀、revise/rename 不认）就是这么来的。
   *
   * 现在无论是否给 --scope 都先 resolve：前缀 → 完整 id、slug → id、歧义 → 409 带候选。
   * 显式 --scope 仍生效（单 scope 解析，不跨 common+workspace 找），行为与旧版一致的部分不变。
   */
  async function resolvePageRef(ctx: Ctx, ref: string, opts: { scope?: string; workspace?: string }): Promise<{ id: string; scope: { scope: string; workspace_id?: string } }> {
    const trimmed = ref.trim();
    // 只有这两种情况需要 resolve：
    // ① 省略 --scope → 必须先解析才知道页在 common 还是 workspace；
    // ② 引用像 ≥8 位 id 前缀（1–35 位十六进制）→ 服务端只认完整 id。
    // 完整 UUID 与「显式 --scope + slug」保持旧路径（不多发请求，旧的 404 口径不变）。
    const needsResolve = opts.scope === undefined || PREFIX_REF_LIKE.test(trimmed);
    if (!needsResolve) {
      return { id: trimmed, scope: await scopeFor(ctx, { scope: opts.scope!, workspace: opts.workspace }) };
    }
    const scope = opts.scope === undefined
      ? { scope: 'both', workspace_id: await resolveWorkspaceId(ctx.base, opts.workspace) }
      : await scopeFor(ctx, { scope: opts.scope, workspace: opts.workspace });
    const resolved = await request<{ id: string; scope: 'workspace' | 'common'; workspace_id: string | null }>(ctx.base, 'GET', `/api/knowledge/resolve?${query({ ...scope, ref: trimmed })}`);
    return {
      id: resolved.id,
      scope: resolved.scope === 'common' ? { scope: 'common' } : { scope: 'workspace', workspace_id: resolved.workspace_id ?? undefined },
    };
  }

  /** 解析失败：把服务端文案补上前缀提示（前缀位数不足 / 无命中都不再只说「不存在」） */
  function resolveFailure(ctx: Ctx, error: unknown, ref: string, command: string): never {
    const message = error instanceof Error ? error.message : String(error);
    const isNotFound = error instanceof CliHttpError && error.status === 404;
    // 只有「像 id 前缀」的输入才改写措辞：说「引用无法唯一解析」，不让人以为页被删了。
    // slug 未命中的「知识页不存在」是准确文案，保持不动。
    const looksLikePrefix = PREFIX_REF_LIKE.test(ref.trim());
    const head = isNotFound && looksLikePrefix
      ? `${message}（引用「${ref.trim()}」无法唯一解析；可用完整 id、≥8 位唯一 id 前缀或 slug）`
      : message;
    const suffix = isNotFound && looksLikePrefix ? prefixHint(ref) : '';
    ctx.io.writeErr(`${head}${suffix}\n`);
    if (error instanceof CliHttpError && error.code === 'KNOWLEDGE_REF_AMBIGUOUS') {
      const candidates = (error.details as { candidates?: string[] } | undefined)?.candidates;
      if (Array.isArray(candidates) && candidates.length > 0) {
        ctx.io.writeErr(`候选（${candidates.length} 个）：\n`);
        for (const candidate of candidates) ctx.io.writeErr(`  ${candidate}\n`);
      }
    }
    throw new CommanderError(resolveExit(error), command, '');
  }
  // 注意：resolve/link 的 --scope 可省略（默认 both）——只在单 scope 里找会漏掉「同 slug 两份」的歧义
  knowledge.command('resolve <ref>').description('按 id / ≥8 位 id 前缀 / slug 解析知识页引用（默认跨 common + 当前工作区）')
    .option('--scope <scope>', 'workspace|common|both', 'both')
    .option('--workspace <id|名>')
    .addHelpText('after', RESOLVE_HELP)
    .action(async (ref: string, opts: ScopeOptions) => {
      const ctx = context();
      try {
        const scope = await scopeFor(ctx, opts, true);
        const res = await request<{ id: string; title: string; scope: string; revision: number; status: string; link: string; link_info: { markdown: string; text: string } }>(ctx.base, 'GET', `/api/knowledge/resolve?${query({ ...scope, ref })}`);
        if (ctx.json) { ctx.io.write(`${JSON.stringify(res)}\n`); return; }
        ctx.io.write(`${res.id} [${res.scope}] rev:${res.revision} ${res.title}\n`);
        ctx.io.write(`link: ${linkRef(res)}\n`);
      } catch (error) {
        ctx.io.writeErr(`${error instanceof Error ? error.message : String(error)}\n`);
        // BORROW-3.1（CLI-07）：resolve 409 歧义 → 打印候选 id 列表（服务端 details.candidates）
        if (error instanceof CliHttpError && error.code === 'KNOWLEDGE_REF_AMBIGUOUS') {
          const candidates = (error.details as { candidates?: string[] } | undefined)?.candidates;
          if (Array.isArray(candidates) && candidates.length > 0) {
            ctx.io.writeErr(`候选（${candidates.length} 个）：\n`);
            for (const candidate of candidates) ctx.io.writeErr(`  ${candidate}\n`);
          }
        }
        throw new CommanderError(resolveExit(error), 'agentboard.knowledge.resolve', '');
      }
    });

  // P2-04（M5）：产出引用串——默认 [[wikilink]]；token/markdown/plain 兼容保留（统一由服务端给 link）
  knowledge.command('link <page-id>').description('产出知识页引用串（wikilink / token / markdown / plain，默认 wikilink，默认跨 common + 当前工作区）')
    .option('--scope <scope>', 'workspace|common|both', 'both')
    .option('--workspace <id|名>')
    .option('--format <fmt>', 'wikilink|token|markdown|plain', 'wikilink')
    .addHelpText('after', LINK_HELP)
    .action(async (refOrId: string, opts: ScopeOptions & { format: string }) => {
      const ctx = context();
      const format = validateFormat(opts.format);
      try {
        const scope = await scopeFor(ctx, opts, true);
        const res = await request<{ id: string; title: string; slug: string; link: string; link_info: { markdown: string; text: string } }>(ctx.base, 'GET', `/api/knowledge/resolve?${query({ ...scope, ref: refOrId })}`);
        if (ctx.json) { ctx.io.write(`${JSON.stringify(res)}\n`); return; }
        const info = (res as { link_info?: { markdown: string; text: string } }).link_info;
        const ref = linkRef(res) ?? '';
        const slug = (res as { slug?: string }).slug ?? info?.markdown ?? '';
        const text = format === 'wikilink'
          ? `[[${slug}]]`
          : format === 'markdown'
          ? (info?.markdown ?? `[知识卡：${res.title}](${ref})`)
          : format === 'plain'
            ? (info?.text ?? `知识卡《${res.title}》 ${ref}`)
            : ref;
        ctx.io.write(`${text}\n`);
      } catch (error) {
        ctx.io.writeErr(`${error instanceof Error ? error.message : String(error)}\n`);
        throw new CommanderError(resolveExit(error), 'agentboard.knowledge.resolve', '');
      }
    });

  // KB-PAGE-2b：只读反查 sources 引用（不建表；改完代码想知道哪些知识页要同步）
  knowledge.command('find-source <path>').description('反查哪些知识页的 sources 引用了该文件（只读）')
    .option('--scope <scope>', 'workspace|common|both', 'both')
    .option('--workspace <id|名>')
    .addHelpText('after', FIND_SOURCE_HELP)
    .action(async (pathArg: string, opts: ScopeOptions) => {
      const ctx = context();
      const res = await request<{ path: string; items: Array<{ id: string; slug: string; title: string; scope: string; revision: number; status: string; link: string }> }>(ctx.base, 'GET', `/api/knowledge/find-source?${query({ ...await scopeFor(ctx, opts, true), path: pathArg })}`);
      if (ctx.json) { ctx.io.write(`${JSON.stringify(res)}\n`); return; }
      if (res.items.length === 0) { ctx.io.write('（无引用该文件的知识页）\n'); return; }
      // BORROW-3.1（D10）补漏：link 已是引用串，旧 item.link.ref 文本输出会变 undefined
      for (const item of res.items) ctx.io.write(`${item.id} [${item.scope}] rev:${item.revision} ${item.slug}  ${item.title}  link: ${linkRef(item)}\n`);
    });

  // KB-PAGE-2b：--scope 可省略——省略时先 resolve（both + 当前工作区），再按解析出的 scope 取页。
  // C3：显式 --scope 时也 resolve（前缀/slug 同样可用），四条命令口径一致。
  knowledge.command('show <page-id>').description('读单个知识页（支持 ≥8 位 id 前缀 / slug；--scope 可省略，自动 resolve）')
    .option('--scope <scope>', 'workspace|common（省略则自动 resolve）')
    .option('--workspace <id|名>')
    .option('--history', '同时读取版本历史')
    .addHelpText('after', SHOW_HELP)
    .action(async (id: string, opts: { scope?: string; workspace?: string; history?: boolean }) => {
      const ctx = context();
      let scope: { scope: string; workspace_id?: string };
      let pageId = id;
      try {
        const resolved = await resolvePageRef(ctx, id, opts);
        scope = resolved.scope;
        pageId = resolved.id;
      } catch (error) {
        resolveFailure(ctx, error, id, 'agentboard.knowledge.show');
      }
      const suffix = query(scope); const path = `/api/knowledge/pages/${encodeURIComponent(pageId)}`;
      const page = await request(ctx.base, 'GET', `${path}?${suffix}`);
      if (!opts.history) { output(ctx, page); return; }
      // KB-CLI-3a（CLI-06/L-04）：文本模式逐条 rev 行（每页 1 行），不再倒整包 JSON；--json 仍整包供脚本消费
      const history = await request<{ items: Array<{ revision: number; title_snapshot: string | null; change_kind: string; actor: string | null; created_at: number }> }>(ctx.base, 'GET', `${path}/revisions?${suffix}`);
      if (ctx.json) { ctx.io.write(`${JSON.stringify({ page, history }, null, 2)}\n`); return; }
      ctx.io.write(renderPageDetail(page));
      for (const rev of history.items) {
        ctx.io.write(`rev:${rev.revision}  ${rev.change_kind}  ${rev.actor ?? '-'}  ${new Date(rev.created_at).toISOString()}  ${rev.title_snapshot ?? ''}\n`);
      }
    });
  scoped(knowledge.command('list').description('列出知识页（默认只看 active）').option('--status <status>', 'active|archived|deleted|all', 'active').option('--invalid', 'K3：只列「文件存在但校验失败」的坏页（排障入口）').option('--offset <n>', '分页偏移', '0').option('--limit <n>', '分页数量（上限 100）', '20').option('--include-expired', '包含过期页面'))
    .addHelpText('after', LIST_HELP)
    .action(async (opts: ScopeOptions & { status: string; offset: string; limit: string; includeExpired?: boolean; invalid?: boolean }) => {
      const ctx = context();
      // 新增查询参数必须「只在用户显式要求时才发」：旧服务端的 query schema 是 strict，
      // 无条件带新键会让整个命令被 Unrecognized key 拒绝（连普通 list 都挂）。
      const res = await request<{ items: unknown[]; next_offset: number | null; invalid_count?: number; invalid?: Array<{ slug: string | null; file_name: string; issues: string[] }> }>(ctx.base, 'GET', `/api/knowledge/pages?${query({ ...await scopeFor(ctx, opts), status: opts.status, offset: validateOffset(opts.offset), limit: validateLimit(opts.limit), include_expired: String(!!opts.includeExpired), invalid_only: opts.invalid ? 'true' : undefined })}`);
      // K3：--invalid 只列坏页（JSON 原样出信封）
      if (opts.invalid) {
        if (ctx.json) { ctx.io.write(`${JSON.stringify(res)}\n`); return; }
        const rows = res.invalid ?? [];
        if (rows.length === 0) { ctx.io.write('（无损坏页）\n'); return; }
        ctx.io.write(rows.map(file => `${file.slug ?? '(无 slug)'}  ${file.file_name}\n  ${file.issues.join('；')}`).join('\n') + '\n');
        return;
      }
      output(ctx, res);
      // K3：坏页不再静默——列表成功后追加一行提示，退出码仍 0（列表本身成功）
      if (!ctx.json && (res.invalid_count ?? 0) > 0) {
        ctx.io.write(`（另有 ${res.invalid_count} 个知识页损坏，运行 kb knowledge list --invalid 查看）\n`);
      }
    });

  /**
   * P2：reconcile 只读报告（`KNOWLEDGE_FILE_CONFLICT` 的标准处置入口）。
   * 默认 `--scope workspace` + cwd 解析当前工作区；`--scope both` 走 search 口径（允许 both 且需 workspace）。
   */
  knowledge.command('reconcile').description('只读检查知识页文件（front matter / 文件名 / id 重复 / content_hash / 缺失链接 / 残留 tmp·lock）')
    .option('--scope <scope>', 'workspace|common|both', 'workspace')
    .option('--workspace <id|名>')
    .addHelpText('after', RECONCILE_HELP)
    .action(async (opts: ScopeOptions) => {
      const ctx = context();
      const res = await request<{
        scope: string; workspace_id: string | null; checked: number; valid: number;
        issues: Array<{ fileName: string; kind: string; detail: string; suggestion?: string; docs_dir?: string }>;
        stale_tmp: Array<{ name: string; docs_dir: string }>;
        stale_locks: Array<{ name: string; docs_dir: string }>;
        docs_dirs: string[]; duration_ms: number;
      }>(ctx.base, 'GET', `/api/knowledge/reconcile?${query(await scopeFor(ctx, opts, true))}`);
      if (ctx.json) { ctx.io.write(`${JSON.stringify(res)}\n`); return; }
      ctx.io.write(`${res.checked} 页检查完成，${res.issues.length} 处冲突\n`);
      if (res.issues.length === 0 && res.stale_tmp.length === 0 && res.stale_locks.length === 0) {
        ctx.io.write('（无冲突）\n');
        return;
      }
      for (const issue of res.issues) {
        // slug 取文件名去扩展名（文件名即 slug 的归一结果）；details 逐条列出，suggestion 单独一行
        const slug = issue.fileName.replace(/\.md$/i, '');
        ctx.io.write(`  [${issue.kind}] slug: ${slug}  文件: ${issue.fileName}\n`);
        ctx.io.write(`    ${issue.detail}\n`);
        if (issue.suggestion !== undefined) ctx.io.write(`    建议: ${issue.suggestion}\n`);
      }
      for (const tmp of res.stale_tmp) ctx.io.write(`  [stale_tmp] ${tmp.name}  (${tmp.docs_dir})\n`);
      for (const lock of res.stale_locks) ctx.io.write(`  [stale_lock] ${lock.name}  (${lock.docs_dir})\n`);
    });

  const contentOptions = (cmd: Command) => cmd
    .option('--stdin', '从 UTF-8 stdin 读取正文 body_md（create 必填；revise 只在改正文时用）')
    .option('--sources <json>', '来源数组 JSON（字段见 create --help）')
    .option('--sources-file <path>', '从 UTF-8 文件读来源数组 JSON（推荐，避免转义）')
    .option('--evidence <json>', '证据数组 JSON（字段见 create --help）')
    .option('--evidence-file <path>', '从 UTF-8 文件读证据数组 JSON（推荐，避免转义）')
    .option('--expires-at <ms>', '过期时间 epoch 毫秒；null 表示清除期限')
    .option('--category <分类>', 'design|solved|pinned|open（缺省由服务端归一）')
    .option('--domain <域>', `${KNOWLEDGE_DOMAIN_HINT}（KB-CR-1：创建必填；修订缺省=不改）`)
    .option('--landed <状态>', 'landed|partial|proposed（与 category 独立，任意分类都可显式指定；design 缺省时服务端记 proposed）')
    // Commander 重复同名单值选项默认只留最后一个，这里用累加器显式收集成数组
    .option('--hash-from-file <source_id=path>', '按 source_id 精确匹配，把该文件 sha256 填进对应 sources 条目（可重复）',
      (value: string, previous: string[]) => [...previous, value], [] as string[]);

  async function content(ctx: Ctx, opts: { stdin?: boolean; sources?: string; sourcesFile?: string; evidence?: string; evidenceFile?: string; expiresAt?: string; category?: string; landed?: string; domain?: string; hashFromFile?: string[] }) {
      // KB-CLI-1：--stdin 读到空正文 → 本地中文报错（先于 sources 校验：空正文是更早的失败点），不再把空串发给服务端吃「body_md 不能小于 1」
    let bodyMd: string | undefined;
    if (opts.stdin) {
      bodyMd = await ctx.io.readStdin();
      if (bodyMd.trim() === '') {
        fail('--stdin 读到的正文为空：PowerShell 用「Get-Content body.md -Raw -Encoding UTF8 | kb knowledge create … --stdin」喂入正文，或检查文件是否为空');
      }
    }
    const warn = (message: string) => ctx.io.writeErr(message);
    const sourcesRaw = (opts.sources !== undefined || opts.sourcesFile !== undefined) ? readJsonArg('--sources', opts.sources, opts.sourcesFile, warn) : undefined;
    const evidenceRaw = (opts.evidence !== undefined || opts.evidenceFile !== undefined) ? readJsonArg('--evidence', opts.evidence, opts.evidenceFile, warn) : undefined;
    if (opts.hashFromFile !== undefined && opts.hashFromFile.length > 0 && sourcesRaw === undefined) {
      fail('--hash-from-file 需要配合 --sources / --sources-file 使用');
    }
    // 先回填 sha256 再校验：避免用户为了通过 content_hash 校验手工算 hash
    if (sourcesRaw !== undefined) applyHashFromFiles('--hash-from-file', sourcesRaw, opts.hashFromFile);
    if (sourcesRaw !== undefined) validateSources('--sources', sourcesRaw);
    if (evidenceRaw !== undefined) validateEvidence('--evidence', evidenceRaw);
    return {
      ...(opts.stdin ? { body_md: bodyMd } : {}),
      ...(sourcesRaw !== undefined ? { sources: sourcesRaw } : {}),
      ...(evidenceRaw !== undefined ? { evidence: evidenceRaw } : {}),
      ...(opts.expiresAt !== undefined ? { expires_at: JSON.parse(opts.expiresAt) } : {}),
      ...(validateCategory(opts.category) !== undefined ? { category: validateCategory(opts.category) } : {}),
      ...(validateDomain(opts.domain) !== undefined ? { domain: opts.domain } : {}),
      ...(validateLanded(opts.landed) !== undefined ? { landed: validateLanded(opts.landed) } : {}),
      actor: ctx.agentId,
    };
  }

  scoped(contentOptions(knowledge.command('create')).description('新建知识页（需要 --stdin/--sources/--evidence）').requiredOption('--title <title>').requiredOption('--slug <slug>'))
    .addHelpText('after', CREATE_HELP)
    .action(async (opts: ScopeOptions & { category?: string; landed?: string; domain?: string; title: string; slug: string; stdin?: boolean; sources?: string; sourcesFile?: string; evidence?: string; evidenceFile?: string; expiresAt?: string }) => {
      // C：先做客户端校验，非法值不发请求（CLI-03：domain 先于 sources/evidence 缺项检查）
      validateCategory(opts.category); validateLanded(opts.landed); validateDomain(opts.domain);
      const ctx = context();
      const missing: string[] = [];
      if (!opts.stdin) missing.push('--stdin：正文（最小例：Get-Content body.md -Raw -Encoding UTF8 | kb knowledge create --scope common --title "标题" --slug some-slug --domain knowledge --stdin --sources-file sources.json --evidence-file evidence.json --category design）');      if (opts.sources === undefined && opts.sourcesFile === undefined) missing.push('--sources-file sources.json：文件内容是最小数组 [{"source_id":"file:Docs/api.md","source_type":"file","locator":"Docs/api.md","captured_at":1763000000000,"content_hash":"<64 位 hex>"}]（也可用 --sources \'<同一 JSON>\'）');      if (opts.evidence === undefined && opts.evidenceFile === undefined) missing.push('--evidence-file evidence.json：文件内容是最小数组 [{"source_id":"file:Docs/api.md","locator":"Docs/api.md:1-20"}]（也可用 --evidence \'<同一 JSON>\'）');      if (missing.length > 0) fail(`create 缺少必填项（逐项补齐后重跑）：\n  - ${missing.join('\n  - ')}\n完整字段说明：kb knowledge create --help`);
      const data = await request(ctx.base, 'POST', '/api/knowledge/pages', { ...await scopeFor(ctx, opts), ...await content(ctx, opts), title: opts.title, slug: opts.slug });
      output(ctx, data);
    });
  // C3：revise 也走统一 resolve（此前 --scope 是必填且不 resolve，≥8 位前缀一律 404）
  contentOptions(knowledge.command('revise <page-id>').description('修订知识页（支持 ≥8 位 id 前缀 / slug；只改给出的字段，需 CAS）').requiredOption('--expected-revision <n>', '当前 revision，必须与库内一致').option('--scope <scope>', 'workspace|common（省略则自动 resolve）').option('--workspace <id|名>').option('--title <title>', '新标题'))
    .addHelpText('after', REVISE_HELP)
    .action(async (id: string, opts: ScopeOptions & { expectedRevision: string; title?: string; stdin?: boolean; sources?: string; sourcesFile?: string; evidence?: string; evidenceFile?: string; expiresAt?: string; category?: string; landed?: string; domain?: string; hashFromFile?: string[] }) => {
      const ctx = context();
      let pageId = id;
      let scope: { scope: string; workspace_id?: string };
      try {
        const resolved = await resolvePageRef(ctx, id, opts);
        pageId = resolved.id;
        scope = resolved.scope;
      } catch (error) {
        resolveFailure(ctx, error, id, 'agentboard.knowledge.revise');
      }
      const data = await request(ctx.base, 'PUT', `/api/knowledge/pages/${encodeURIComponent(pageId)}`, { ...scope, ...await content(ctx, opts), ...(opts.title !== undefined ? { title: opts.title } : {}), expected_revision: Number(opts.expectedRevision) });
      output(ctx, data);
    });
  // C4：--scope 可省略（与 show 同一 resolve 路径）；--expected-revision 改为手动校验——
  // commander 的 requiredOption 报错只回「缺少必填参数 --expected-revision」，说不出「--scope 可省略」，
  // 用户于是以为这命令非得先猜 scope。手动报错一次讲清两个口径。
  knowledge.command('action <page-id> <action>').description('改知识页状态：archive | restore | delete（支持 ≥8 位 id 前缀 / slug；--scope 可省略，自动 resolve）')
    .option('--expected-revision <n>', '当前 revision，必须与库内一致')
    .option('--scope <scope>', 'workspace|common（省略则自动 resolve）')
    .option('--workspace <id|名>')
    .addHelpText('after', ACTION_HELP)
    .action(async (id: string, action: string, opts: { scope?: string; workspace?: string; expectedRevision?: string }) => {
      const allowed = ['archive', 'restore', 'delete'];
      if (!allowed.includes(action)) fail(`action 只能是 ${allowed.join(' | ')}（当前：${preview(action)}）；详见 kb knowledge action --help`);
      if (opts.expectedRevision === undefined) {
        fail('缺少必填参数 --expected-revision <n>：CAS 必须带当前 revision（kb knowledge show <page-id> 可读到 rev）。'
          + '注意 --scope 可省略（省略时自动 resolve id / ≥8 位 id 前缀 / slug），不必先猜 scope；详见 kb knowledge action --help');
      }
      const ctx = context();
      let pageId = id;
      let scope: { scope: string; workspace_id?: string };
      try {
        const resolved = await resolvePageRef(ctx, id, opts);
        pageId = resolved.id;
        scope = resolved.scope;
      } catch (error) {
        resolveFailure(ctx, error, id, 'agentboard.knowledge.action');
      }
      const data = await request(ctx.base, 'POST', `/api/knowledge/pages/${encodeURIComponent(pageId)}/actions`, { ...scope, action, expected_revision: Number(opts.expectedRevision), actor: ctx.agentId });
      output(ctx, data);
    });

  // P2-04（M10）：rename——原子换文件 + 全库扫描重写 [[old]]→[[new]]（含 alias/heading 形态；id 不变）
  // C3：--scope 改为可省略并走统一 resolve（此前必填且不 resolve，≥8 位前缀一律 404）
  knowledge.command('rename <page-id> <new-slug>')
    .description('重命名知识页 slug：换文件名 + 全库重写 [[old]]→[[new]]（id 不变；支持 ≥8 位 id 前缀 / slug；CAS）')
    .requiredOption('--expected-revision <n>', '当前 revision，必须与库内一致')
    .option('--scope <scope>', 'workspace|common（省略则自动 resolve）')
    .option('--workspace <id|名>')
    .addHelpText('after', RENAME_HELP)
    .action(async (id: string, newSlug: string, opts: { scope?: string; workspace?: string; expectedRevision: string }) => {
      const ctx = context();
      interface RenameReport { id: string; slug: string; old_slug: string; scope: string; revision: number; title: string; link: string; rewritten: Array<{ dir: string; file_name: string; page_id: string; slug: string }> }
      let pageId = id;
      let scope: { scope: string; workspace_id?: string };
      try {
        const resolved = await resolvePageRef(ctx, id, opts);
        pageId = resolved.id;
        scope = resolved.scope;
      } catch (error) {
        resolveFailure(ctx, error, id, 'agentboard.knowledge.rename');
      }
      try {
        const report = await request<RenameReport>(ctx.base, 'POST', `/api/knowledge/pages/${encodeURIComponent(pageId)}/rename`, { ...scope, expected_revision: Number(opts.expectedRevision), new_slug: newSlug, actor: ctx.agentId });
        if (ctx.json) { ctx.io.write(`${JSON.stringify(report, null, 2)}\n`); return; }
        ctx.io.write(`${report.id} [${report.scope}] rev:${report.revision} ${report.slug}（原 slug：${report.old_slug}；id 不变）\n`);
        ctx.io.write(`link: ${report.link}\n`);
        if (report.rewritten.length === 0) ctx.io.write('全库没有引用旧 slug 的 wikilink，未改写任何文件\n');
        else {
          ctx.io.write(`已重写 ${report.rewritten.length} 个文件的 [[${report.old_slug}]] 引用：\n`);
          for (const item of report.rewritten) ctx.io.write(`  ${item.file_name}（页 ${item.page_id.slice(0, 8)} ${item.slug}）\n`);
        }
        ctx.io.write('提示：直接改文件名（不走本命令）会由 reconcile 报「slug 与文件名不一致」冲突\n');
      } catch (error) {
        ctx.io.writeErr(`${error instanceof Error ? error.message : String(error)}\n`);
        const status = (error as { status?: number }).status;
        throw new CommanderError(status === 409 || status === 403 ? 2 : 1, 'agentboard.knowledge.rename', '');
      }
    });

  // P2-02：export-legacy 一次性迁移（旧库行集 → Docs/*.md；fan-out 中心库 + 各 localized 工作区库）
  knowledge.command('export-legacy')
    .description('一次性迁移：把旧库知识页导出为 Docs/*.md（fan-out 中心库 + 各 localized 工作区库；manifest + 回读校验）')
    .option('--scope <scope>', 'all|center|workspace（默认 all）', 'all')
    .option('--workspace <id|名>', 'scope=workspace 时必填：工作空间 id 或名称')
    .option('--to <dir>', '重定向输出根（common → <dir>/Docs，工作区 → <dir>/ws-<id>/Docs）')
    .option('--dry-run', '只打印待导出清单与源库分布，不写任何文件')
    .addHelpText('after', EXPORT_HELP)
    .action(async (opts: { scope: string; workspace?: string; to?: string; dryRun?: boolean }) => {
      const EXPORT_SCOPES = ['all', 'center', 'workspace'];
      if (!EXPORT_SCOPES.includes(opts.scope)) {
        fail(`--scope 只能是 ${EXPORT_SCOPES.join(' | ')}（当前：${preview(opts.scope)}）；详见 kb knowledge export-legacy --help`);
      }
      let workspaceId: string | undefined;
      if (opts.scope === 'workspace') {
        if (opts.workspace === undefined) fail('--scope workspace 必须配 --workspace <id|名>');
        const ctx = context();
        workspaceId = await resolveWorkspaceId(ctx.base, opts.workspace);
      } else if (opts.workspace !== undefined) {
        fail('--workspace 只在 --scope workspace 时接受（all/center 的源库由服务端 fan-out 枚举）');
      }
      const ctx = context();
      const body = {
        scope: opts.scope,
        dry_run: opts.dryRun === true,
        ...(workspaceId !== undefined ? { workspace_id: workspaceId } : {}),
        ...(opts.to !== undefined ? { to: resolve(opts.to) } : {}),
      };
      interface ExportReport {
        dry_run: boolean;
        scope: string;
        workspace_id: string | null;
        sources: Array<{ source_db: string; path: string | null; pages: number }>;
        targets: Array<{ dir: string; create: number; unchanged: number; conflicts: number; skipped: number }>;
        pages: Array<{ id: string; slug: string; title: string; scope: string; workspace_id: string | null; status: string; revision: number; source_db: string; target_dir: string; file: string; action: string; reason?: string }>;
        conflicts: Array<{ dir: string; file: string; page_id: string; source_db: string; existing_sha256: string; incoming_sha256: string; backup_path?: string }>;
        manifests: Array<{ dir: string; file: string; files: number; written: boolean }>;
        summary: { total: number; create: number; unchanged: number; conflicts: number; skipped: number; duplicates: number };
      }
      const actionLabel = (action: string): string => ({
        'create': '新增', 'skip-unchanged': '已一致', 'conflict': '冲突',
        'skip-deleted': '软删跳过', 'skip-invalid': '契约跳过',
      }[action] ?? action);
      try {
        const report = await request<ExportReport>(ctx.base, 'POST', '/api/knowledge/export-legacy', body);
        if (ctx.json) { ctx.io.write(`${JSON.stringify(report, null, 2)}\n`); return; }
        const mode = report.dry_run ? '（dry-run 预览，未写入任何文件）' : '（已写入）';
        ctx.io.write(`export-legacy ${mode}  scope=${report.scope}${report.workspace_id !== null ? ` workspace=${report.workspace_id}` : ''}\n`);
        ctx.io.write('源库分布：\n');
        for (const source of report.sources) {
          ctx.io.write(`  ${source.source_db}${source.path !== null ? `  ${source.path}` : ''}：${source.pages} 行\n`);
        }
        ctx.io.write('目标：\n');
        if (report.targets.length === 0) ctx.io.write('  （无待导出目标）\n');
        for (const target of report.targets) {
          ctx.io.write(`  ${target.dir}：新增 ${target.create} / 已一致 ${target.unchanged} / 冲突 ${target.conflicts} / 跳过 ${target.skipped}\n`);
        }
        ctx.io.write('待导出清单：\n');
        // P2-5：pages[] 不再含 id='' 的合成行，无需过滤（服务端契约保证每项都有非空 id）
        const pages = report.pages;
        if (pages.length === 0) ctx.io.write('  （旧库无知识页行集）\n');
        for (const item of pages) {
          ctx.io.write(`  ${item.id.slice(0, 8)} [${item.scope}${item.workspace_id !== null ? ` ${item.workspace_id.slice(0, 8)}` : ''}] rev:${item.revision} ${item.slug} → ${item.target_dir !== '' ? `${item.target_dir}/${item.file}` : '（无目标）'}（${actionLabel(item.action)}${item.reason !== undefined ? `：${item.reason}` : ''}）\n`);
        }
        if (report.conflicts.length > 0) {
          ctx.io.writeErr(`⚠ ${report.conflicts.length} 个冲突（未写入任何文件）：\n`);
          for (const conflict of report.conflicts) {
            ctx.io.writeErr(`  ${conflict.dir}/${conflict.file}  已有 ${conflict.existing_sha256.slice(0, 12)}… / 导入 ${conflict.incoming_sha256.slice(0, 12)}…（页 ${conflict.page_id}，源 ${conflict.source_db}）${conflict.backup_path !== undefined ? `  已备份：${conflict.backup_path}` : ''}\n`);
          }
        }
        if (!report.dry_run) {
          for (const manifest of report.manifests) {
            ctx.io.write(`manifest：${manifest.dir}/${manifest.file}（${manifest.files} 个文件${manifest.written ? '，已更新' : '，未变化'}）\n`);
          }
        }
        ctx.io.write(`汇总：行集 ${report.summary.total} 页 = 新增 ${report.summary.create} + 已一致 ${report.summary.unchanged} + 冲突 ${report.summary.conflicts} + 跳过 ${report.summary.skipped}\n`);
        // duplicates 是行集之外的独立计数（C8 混合态同 id 页多源库出现），不计入上面的等式
        if (report.summary.duplicates > 0) ctx.io.write(`另有 ${report.summary.duplicates} 个重复页已跳过（同 id 在多个源库出现，以 localized 工作区库副本为准）\n`);
        if (report.conflicts.length > 0) throw new CommanderError(2, 'agentboard.knowledge.export', '');
      } catch (error) {
        if (error instanceof CommanderError) throw error;
        ctx.io.writeErr(`${error instanceof Error ? error.message : String(error)}\n`);
        if (error instanceof CliHttpError && error.code === 'KNOWLEDGE_EXPORT_CONFLICT') {
          const conflicts = (error.details as { conflicts?: ExportReport['conflicts'] } | undefined)?.conflicts;
          if (Array.isArray(conflicts)) {
            for (const conflict of conflicts) {
              ctx.io.writeErr(`  ${conflict.dir}/${conflict.file}（页 ${conflict.page_id}，源 ${conflict.source_db}）${conflict.backup_path !== undefined ? `  已备份：${conflict.backup_path}` : ''}\n`);
            }
          }
          throw new CommanderError(2, 'agentboard.knowledge.export.conflict', '');
        }
        throw new CommanderError(1, 'agentboard.knowledge.export', '');
      }
    });

  // KB-CLI-IMPORT：把本地文件导入为知识页（服务端 KBIMP-1 已有能力，这里只做 CLI 封装）
  scoped(knowledge.command('import <file>')
    .description('导入本地 md/txt/json 文件为知识页（sources 自动构造，支持 json 数组）')
    .option('--format <fmt>', 'md|txt|json（默认按扩展名推断）')
    .option('--title <title>', '标题（默认取 md 首个标题 / txt 首行 / 文件名）')
    .option('--slug <slug>', '显式 slug（默认由标题派生；冲突时给未占用的值）')
    .option('--category <category>', 'design|solved|pinned|open')
    .option('--landed <landed>', 'landed|partial|proposed')
    .option('--domain <domain>', `域（必填，json 条目内可逐条覆盖）：${KNOWLEDGE_DOMAIN_HINT}`)
    .option('--labels <csv>', '逗号分隔标签')
    .addHelpText('after', IMPORT_HELP)
    .action(async (file: string, opts: ScopeOptions & {
      format?: string; title?: string; slug?: string; category?: string; landed?: string; labels?: string; domain?: string;
    }) => {
      validateCategory(opts.category);
      validateLanded(opts.landed);
      const absolute = resolve(file);
      let raw: Buffer;
      try {
        raw = readFileSync(absolute);
      } catch {
        fail(`读不到文件：${absolute}（检查路径是否存在、是否有读权限）`);
      }
      const bytes = raw.length;
      if (bytes > IMPORT_MAX_BYTES) {
        fail(`文件过大：当前 ${(bytes / 1024 / 1024).toFixed(2)} MB / 上限 ${IMPORT_MAX_BYTES / 1024 / 1024} MB（单文件上限 10 MB，正文上限 200 万字符）`);
      }
      // IMPORT-BOM（N-02）：先按字节剥掉 UTF-8 BOM 再解码。带 BOM 时正文首字符是 U+FEFF：
      // md 的 `# 标题` 会被顶掉导致标题解析失败、Markdown 首行渲染异常、diff/搜索整体偏移；带 BOM 的 JSON 直接 parse 失败。
      // 落点选 CLI：它是本地文件的唯一读入口；服务端还服务前端导入对话框与 MCP，不该替调用方改内容。
      const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
      const content = (hasBom ? raw.subarray(3) : raw).toString('utf8');
      if (hasBom) writeStderr('提示：检测到 UTF-8 BOM，已在导入前剥离（正文首字符不会是 U+FEFF）\n');
      if (content.length > IMPORT_MAX_CHARS) {
        fail(`正文超长：当前 ${content.length} 字符 / 上限 ${IMPORT_MAX_CHARS} 字符`);
      }
      const format = opts.format ?? detectImportFormat(absolute);
      if (!IMPORT_FORMATS.includes(format)) {
        fail(`--format 只能是 ${IMPORT_FORMATS.join(' | ')}（当前：${preview(opts.format)}）；也可用 .md/.txt/.json 扩展名自动推断`);
      }
      const ctx = context();
      // KB-CR-1：导入即建页，domain 必填（文件事实源下同样进 front matter）
      const domain = validateDomain(opts.domain);
      if (domain === undefined) fail('import 缺少 --domain（导入即建页必填）：--domain 只能是 ' + KNOWLEDGE_DOMAIN_HINT);
      // sources 由服务端依 filename 构造（source_type=file、locator=路径、content_hash=sha256、无 snapshot）
      const body = {
        ...await scopeFor(ctx, opts),
        format,
        content,
        filename: absolute,
        domain,
        ...(opts.title !== undefined ? { title: opts.title } : {}),
        ...(opts.slug !== undefined ? { slug: opts.slug } : {}),
        ...(opts.category !== undefined ? { category: opts.category } : {}),
        ...(opts.landed !== undefined ? { landed: opts.landed } : {}),
        ...(opts.labels !== undefined ? { labels: opts.labels.split(',').map((label) => label.trim()).filter((label) => label !== '') } : {}),
        actor: ctx.agentId,
      };
      const result = await request<{ pages?: unknown[]; warnings?: string[] }>(ctx.base, 'POST', '/api/knowledge/pages/import', body);
      if (ctx.json) {
        ctx.io.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      const pages = Array.isArray(result.pages) ? result.pages : [];
      if (pages.length === 0) {
        ctx.io.write('（没有新建知识页）\n');
      } else {
        for (const raw of pages) {
          const page = raw as Record<string, unknown>;
          const body = String(page.body_md ?? '');
          ctx.io.write(`${page.id} [${page.scope}] ${page.slug} ${body.length} 字符  rev:${page.revision}\n`);
        }
      }
      for (const warning of result.warnings ?? []) ctx.io.writeErr(`warning: ${warning}\n`);
    }));
}

