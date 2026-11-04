import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CommanderError, type Command } from 'commander';
import { request } from '../api.js';
import type { Ctx } from '../io.js';
import { resolveWorkspaceId } from '../workspace.js';
import { KNOWLEDGE_DOMAIN_HINT } from '@agentboard/shared';

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
const linkRef = (raw: unknown): string | undefined => (raw as { link?: { ref?: string } }).link?.ref;
const pageLine = (raw: unknown): string => { const p = raw as Record<string, unknown>; const link = linkRef(raw); return `${p.page_id ?? p.id} [${p.scope}] rev:${p.revision} ${p.title}${link ? `  link: ${link}` : ''}${p.snippet ? `\n${p.snippet}` : ''}`; };
function output(ctx: Ctx, data: unknown): void {
  if (ctx.json) { ctx.io.write(`${JSON.stringify(data, null, 2)}\n`); return; }
  if (Array.isArray(data)) { ctx.io.write(data.length ? data.map(pageLine).join('\n') + '\n' : '（无知识）\n'); return; }
  const p = data as Record<string, unknown>;
  if (Array.isArray(p.items)) {
    const items = p.items as unknown[];
    ctx.io.write((items.length ? items.map(pageLine).join('\n') + '\n' : '（无知识）\n') + (p.next_offset ? `下一页：--offset ${p.next_offset}\n` : ''));
    return;
  }
  const meta = [p.category !== undefined ? `category: ${String(p.category)}` : '', p.landed !== undefined ? `landed: ${p.landed === null ? '（未定）' : String(p.landed)}` : '', p.domain !== undefined ? `domain: ${String(p.domain ?? '未归类')}` : ''].filter(Boolean).join(' · ');
  const link = linkRef(data);
  ctx.io.write(`${p.id ?? ''} [${p.scope ?? ''}] rev:${p.revision ?? ''} ${p.title ?? ''}${meta ? `\n${meta}` : ''}${link ? `\nlink: ${link}` : ''}\n${p.body_md ?? JSON.stringify(data, null, 2)}\n`);
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
const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 读 `--sources` / `--sources-file` 二选一（同时给视为用法错误，避免静默取一个） */
function readJsonArg(flag: string, inline: string | undefined, file: string | undefined): unknown {
  if (inline !== undefined && file !== undefined) fail(`${flag} 与 ${flag}-file 只能给一个（推荐用 ${flag}-file 避免 Windows 引号转义）`);
  if (inline === undefined && file === undefined) fail(`缺少 ${flag}（或 ${flag}-file）：见 kb knowledge create --help 的字段说明与示例`);
  const text = file !== undefined ? (() => {
    const path = resolve(process.cwd(), file);
    try { return readFileSync(path, 'utf8'); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'ERR';
      return fail(`${flag}-file 读取失败：${path}（${code}）`);
    }
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
  if (!Array.isArray(raw)) fail(`${flag} 必须是数组，例如 [{"source_id":"file:README.md","locator":"file:1-20"}]（当前：${preview(raw)}）`);
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

// ---------------- help 文案 ----------------

const FIELD_HELP = `
字段说明（--sources / --evidence；服务端要求各 ≥1 条）
  --sources 数组，每条对象：
    source_id    字符串 1–200        必填  来源稳定标识，如 "file:README.md" / "url:https://…" / "agent:board-server"
    source_type  file | url | agent  必填
    locator      字符串 1–2000       必填  定位：文件相对路径 / URL / agent 名
    captured_at  非负整数            必填  采集时刻 epoch 毫秒（PowerShell：[DateTimeOffset]::Now.ToUnixTimeMilliseconds()）
    content_hash 64 位十六进制       必填  来源内容 sha256（PowerShell：Get-FileHash -Algorithm SHA256 <文件> 取 .Hash）
    snapshot     字符串 可选         快照内容（≤100000 字符）
  --evidence 数组，每条对象：
    source_id    字符串 1–200        必填  必须指向上面某个 source_id
    locator      字符串 1–2000       必填  证据定位，如 "file:12-30" / "issue:<uuid>" / "cmd:npm test"
    snapshot     字符串 可选
  其它字段一律拒绝（服务端 .strict()），错误会指出具体字段名与期望格式。
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
    --evidence '[{"source_id":"file:README.md","locator":"file:1-20"}]' \`
    注：上面这种写法在 PowerShell 里需要把正文用管道送进来，完整可复制版本见示例 C。

示例 B（cmd：双引号包 JSON，内部双引号写 \\"，正文用 \`<\` 重定向）：
  kb knowledge create --scope common --title "缓存策略" --slug cache-policy --domain knowledge --stdin ^
    --sources "[{\\"source_id\\":\\"file:README.md\\",\\"source_type\\":\\"file\\",\\"locator\\":\\"README.md\\",\\"captured_at\\":1763000000000,\\"content_hash\\":\\"<64位hex>\\"}]" ^
    --evidence "[{\\"source_id\\":\\"file:README.md\\",\\"locator\\":\\"file:1-20\\"}]" < body.md

示例 C（**推荐**，零引号转义；把两个 JSON 存成文件后，PowerShell 可直接复制）：
  Get-Content body.md -Raw | kb knowledge create --scope common --title '缓存策略' --slug cache-policy --domain knowledge --stdin \`
    --sources-file sources.json --evidence-file evidence.json

最小文件样例 sources.json：
  [{"source_id":"file:README.md","source_type":"file","locator":"README.md","captured_at":1763000000000,"content_hash":"0000000000000000000000000000000000000000000000000000000000000000"}]
最小文件样例 evidence.json：
  [{"source_id":"file:README.md","locator":"file:1-20"}]

输出：文本模式在标题后补一行 link: knowledge:<uuid>（--json 中为 link 对象，可直接发给别人打开）；
      引用串也可单独用 kb knowledge link <page-id> 生成。
退出码：0 成功；1 参数/服务端错误（含字段级提示）；2 任务占用或知识 revision 冲突（KNOWLEDGE_*）

${CONTENT_GUIDE}
${GUIDE_POINTER}
`;

const REVISE_HELP = `${FIELD_HELP}
说明：只改提供的字段（--title / --stdin / --sources / --evidence / --expires-at 均可选），但 --expected-revision 必填（CAS）。
示例（PowerShell，正文用管道；cmd 下可换成 \`< body.md\`）：
  Get-Content body.md -Raw | kb knowledge revise <page-id> --scope common --expected-revision 3 --stdin --title '新标题'
  Get-Content body.md -Raw | kb knowledge revise <page-id> --scope workspace --workspace 任务看板 --expected-revision 3 --stdin \`
    --sources-file sources.json --evidence-file evidence.json
同主题内容演进用 revise（同一 page-id 累加 revision），不要为「更新版内容」新建页。
--expected-revision 是 CAS：必须与库内 revision 一致，旧值以退出码 2 退出并提示「知识页已更新，请重新读取」。
输出：文本模式在标题后补一行 link: knowledge:<uuid>（--json 中为 link 对象）。
退出码：0 成功；1 参数/服务端错误；2 版本冲突（KNOWLEDGE_REVISION_CONFLICT，stderr 给当前 revision 与「知识页已更新，请重新读取」）

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
  archive   归档（status → archived）
  restore   恢复（status → active）
  delete    删除（status → deleted；不可逆，服务端会保留历史）
必填：<page-id> <action> --scope <workspace|common> [--workspace <id|名>] --expected-revision <n>（CAS）
示例：
  kb knowledge action <page-id> archive --scope common --expected-revision 2
  kb knowledge action <page-id> restore --scope workspace --workspace 任务看板 --expected-revision 3
退出码：0 成功；1 参数/服务端错误；2 版本冲突（KNOWLEDGE_REVISION_CONFLICT）
`;

/** KB-CLI-IMPORT：导入本地文件为知识页（服务端 KBIMP-1 已支持 md/txt/json） */
const IMPORT_HELP = `
支持格式：
  md / markdown  → format=md（标题取第一个 # 标题，兜底文件名）
  txt            → format=txt（标题取首行，兜底文件名）
  json           → format=json（单对象或数组 ≤100 条，数组逐条建页）
  --format 可覆盖扩展名推断（md|txt|json）。

上限（与服务端一致）：
  单文件 ≤ 10 MB（UTF-8 字节，超了本地就拦，不会发请求）
  单页正文 ≤ 200 万字符

sources 自动构造：
  CLI 把文件的**绝对路径**作为 filename 传给服务端，服务端据此生成
  { source_type: 'file', locator: <路径>, content_hash: <sha256>, captured_at }，
  file 来源不带 snapshot（带了会被拒）。所以这里没有 --sources 参数。

slug 冲突（409 KNOWLEDGE_EXISTS）怎么办：
  - 传 --title 换标题（标题不同即生成不同 slug）
  - 或传 --slug 显式指定一个未被占用的 slug
  - 或先 ` + '`kb knowledge show <slug> --scope ...`' + ` 看已有页要不要直接 revise

示例：
  kb knowledge import Docs/写时复制.md
  kb knowledge import notes.json --scope common --category design --landed proposed
  kb knowledge import a.txt --format md --title 自定义标题 --labels 设计,缓存
退出码：0 成功；1 参数/文件/服务端错误（含 413 IMPORT_TOO_LARGE / IMPORT_BODY_TOO_LONG）；2 slug 冲突（KNOWLEDGE_EXISTS）
`;

const SHOW_HELP = `
必填：<page-id>
可选：--scope <workspace|common>（**可省略**：省略时内部走 resolve，按 both 先解析 id / ≥8 位前缀 / slug，歧义 409 不猜；
      显式给出 --scope 时行为与旧版一致）；--workspace <id|名>、--history 同时输出全部版本历史
输出：非 --json 时打印 id/scope/revision/title + link: knowledge:<uuid> + 正文；--json 打印服务端原对象
示例：
  kb knowledge show <page-id>
  kb knowledge show <page-id> --scope common
  kb --json knowledge show <page-id> --scope workspace --workspace 任务看板 --history
退出码：0 成功；1 不存在或参数错误；2 resolve 歧义或跨范围（仅省略 --scope 时会返回 2）
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

const LIST_HELP = `
必填：--scope <workspace|common>（workspace 范围缺省按 cwd 解析，可用 --workspace 覆盖）
可选：--status active|archived|deleted|all（默认 active）、--offset <n>（默认 0）、--limit <n>（默认 20，上限 100）、--include-expired
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
可选：--scope workspace|common|both（默认 both）、--workspace <id|名>（scope=workspace 时缺省按 cwd 解析）、--limit <n>（默认 5）
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
必填：<ref> --scope <workspace|common>（workspace 缺省按 cwd 解析，可用 --workspace 覆盖）
输出：解析成功 → id/title/scope/revision + link（knowledge:<uuid>）；--json 打印服务端原对象
错误码与退出码：404 KNOWLEDGE_NOT_FOUND → 1；409 KNOWLEDGE_REF_AMBIGUOUS → 2（不猜第一条，给候选 id）；
             410 KNOWLEDGE_DELETED → 1（已删除，可看历史）；403 KNOWLEDGE_SCOPE_FORBIDDEN → 2（不回显标题）
示例：
  kb knowledge resolve 3f8da34e --scope common
  kb --json knowledge resolve cache-policy --scope workspace --workspace 任务看板
`;

const LINK_HELP = `
KB-PAGE-2：产出知识页的引用串（权威标识是 page.id，slug 只作输入别名）。
必填：<page-id|slug> --scope <workspace|common>；--format token|markdown|plain（默认 token）
输出：token = knowledge:<uuid>；markdown = [标题](knowledge:<uuid>)；plain = 标题 + 空格 + token
agent 对外约定（A8）：
  Markdown：[知识卡：{title}](knowledge:{id})
  纯文本：知识卡《{title}》 knowledge:{id} · rev:{n}
  禁止用 knowledge:<slug> 或 Docs 文件路径当知识引用；slug 只作输入别名。
示例：
  kb knowledge link 3f8da34e-… --scope common
  kb knowledge link cache-policy --scope workspace --format markdown
  kb knowledge link 缓存策略 --scope workspace --format plain
`;

export function registerKnowledgeCommands(program: Command, context: () => Ctx): void {
  const knowledge = program.command('knowledge').description('共享知识库（项目与公共范围显式指定）')
    .addHelpText('after', `
常用流程：
  1) Get-Content body.md -Raw | kb knowledge create --scope common --title '…' --slug some-slug --domain knowledge --stdin --sources-file sources.json --evidence-file evidence.json
  2) kb knowledge show <page-id> --scope common
  3) Get-Content body.md -Raw | kb knowledge revise <page-id> --scope common --expected-revision 1 --stdin
  4) kb knowledge action <page-id> archive --scope common --expected-revision 2
  5) kb knowledge show <page-id>（可省 --scope，自动 resolve）；引用串用 kb knowledge link <page-id>
  6) kb knowledge find-source Docs/api.md（反查哪些知识页引用了该文件）
字段说明：kb knowledge create --help（含 --sources/--evidence 每个字段与三种引号写法）
`);
  knowledge.command('search <query>').description('按文本检索知识页（默认 both）').option('--scope <scope>', 'workspace|common|both', 'both').option('--workspace <id|名>').option('--limit <n>', '结果数量', '5')
    .addHelpText('after', SEARCH_HELP)
    .action(async (q: string, opts: ScopeOptions & { limit: string }) => { const ctx = context(); output(ctx, await request(ctx.base, 'GET', `/api/knowledge/search?${query({ ...await scopeFor(ctx, opts, true), q, limit: opts.limit })}`)); });
  const scoped = (command: Command) => command.requiredOption('--scope <scope>', 'workspace|common').option('--workspace <id|名>');
  // KB-PAGE-2：统一 resolve（四态退出码固定：0 / 1(404,410) / 2(409,403)）
  const resolveExit = (error: unknown): number => {
    const status = (error as { status?: number }).status;
    return status === 409 || status === 403 ? 2 : 1;
  };
  // 注意：resolve/link 的 --scope 可省略（默认 both）——只在单 scope 里找会漏掉「同 slug 两份」的歧义
  knowledge.command('resolve <ref>').description('按 id / ≥8 位 id 前缀 / slug 解析知识页引用（默认跨 common + 当前工作区）')
    .option('--scope <scope>', 'workspace|common|both', 'both')
    .option('--workspace <id|名>')
    .addHelpText('after', RESOLVE_HELP)
    .action(async (ref: string, opts: ScopeOptions) => {
      const ctx = context();
      try {
        const scope = await scopeFor(ctx, opts, true);
        const res = await request<{ id: string; title: string; scope: string; revision: number; status: string; link: { ref: string; markdown: string } }>(ctx.base, 'GET', `/api/knowledge/resolve?${query({ ...scope, ref })}`);
        if (ctx.json) { ctx.io.write(`${JSON.stringify(res)}\n`); return; }
        ctx.io.write(`${res.id} [${res.scope}] rev:${res.revision} ${res.title}\n`);
        ctx.io.write(`link: ${res.link.ref}\n`);
      } catch (error) {
        ctx.io.writeErr(`${error instanceof Error ? error.message : String(error)}\n`);
        throw new CommanderError(resolveExit(error), 'agentboard.knowledge.resolve', '');
      }
    });

  // KB-PAGE-2：产出引用串（token / markdown / plain）——不手拼串，统一由服务端给 link
  knowledge.command('link <page-id>').description('产出知识页引用串（token / markdown / plain，默认跨 common + 当前工作区）')
    .option('--scope <scope>', 'workspace|common|both', 'both')
    .option('--workspace <id|名>')
    .option('--format <fmt>', 'token|markdown|plain', 'token')
    .addHelpText('after', LINK_HELP)
    .action(async (refOrId: string, opts: ScopeOptions & { format: string }) => {
      const ctx = context();
      try {
        const scope = await scopeFor(ctx, opts, true);
        const res = await request<{ id: string; title: string; link: { ref: string; markdown: string } }>(ctx.base, 'GET', `/api/knowledge/resolve?${query({ ...scope, ref: refOrId })}`);
        if (ctx.json) { ctx.io.write(`${JSON.stringify(res)}\n`); return; }
        const text = opts.format === 'markdown' ? res.link.markdown : opts.format === 'plain' ? `${res.title} ${res.link.ref}` : res.link.ref;
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
      const res = await request<{ path: string; items: Array<{ id: string; slug: string; title: string; scope: string; revision: number; status: string; link: { ref: string } }> }>(ctx.base, 'GET', `/api/knowledge/find-source?${query({ ...await scopeFor(ctx, opts, true), path: pathArg })}`);
      if (ctx.json) { ctx.io.write(`${JSON.stringify(res)}\n`); return; }
      if (res.items.length === 0) { ctx.io.write('（无引用该文件的知识页）\n'); return; }
      for (const item of res.items) ctx.io.write(`${item.id} [${item.scope}] rev:${item.revision} ${item.slug}  ${item.title}  link: ${item.link.ref}\n`);
    });

  // KB-PAGE-2b：--scope 可省略——省略时先 resolve（both + 当前工作区），再按解析出的 scope 取页；显式给出时与旧版逐字一致
  knowledge.command('show <page-id>').description('读单个知识页（--scope 可省略，自动 resolve）')
    .option('--scope <scope>', 'workspace|common（省略则自动 resolve）')
    .option('--workspace <id|名>')
    .option('--history', '同时读取版本历史')
    .addHelpText('after', SHOW_HELP)
    .action(async (id: string, opts: { scope?: string; workspace?: string; history?: boolean }) => {
      const ctx = context();
      let scope: { scope: string; workspace_id?: string };
      if (opts.scope === undefined) {
        try {
          const resolved = await request<{ scope: 'workspace' | 'common'; workspace_id: string | null }>(ctx.base, 'GET', `/api/knowledge/resolve?${query({ ref: id, scope: 'both', workspace_id: await resolveWorkspaceId(ctx.base, opts.workspace) })}`);
          scope = resolved.scope === 'common' ? { scope: 'common' } : { scope: 'workspace', workspace_id: resolved.workspace_id ?? undefined };
        } catch (error) {
          ctx.io.writeErr(`${error instanceof Error ? error.message : String(error)}\n`);
          throw new CommanderError(resolveExit(error), 'agentboard.knowledge.show', '');
        }
      } else {
        scope = await scopeFor(ctx, { scope: opts.scope, workspace: opts.workspace });
      }
      const suffix = query(scope); const path = `/api/knowledge/pages/${encodeURIComponent(id)}`;
      const page = await request(ctx.base, 'GET', `${path}?${suffix}`);
      if (opts.history) output(ctx, { page, history: await request(ctx.base, 'GET', `${path}/revisions?${suffix}`) }); else output(ctx, page);
    });
  scoped(knowledge.command('list').description('列出知识页（默认只看 active）').option('--status <status>', 'active|archived|deleted|all', 'active').option('--offset <n>', '分页偏移', '0').option('--limit <n>', '分页数量（上限 100）', '20').option('--include-expired', '包含过期页面'))
    .addHelpText('after', LIST_HELP)
    .action(async (opts: ScopeOptions & { status: string; offset: string; limit: string; includeExpired?: boolean }) => {
      const ctx = context(); output(ctx, await request(ctx.base, 'GET', `/api/knowledge/pages?${query({ ...await scopeFor(ctx, opts), status: opts.status, offset: opts.offset, limit: opts.limit, include_expired: String(!!opts.includeExpired) })}`));
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
    .option('--landed <状态>', 'landed|partial|proposed（design 缺省时服务端记 proposed）');

  async function content(ctx: Ctx, opts: { stdin?: boolean; sources?: string; sourcesFile?: string; evidence?: string; evidenceFile?: string; expiresAt?: string; category?: string; landed?: string; domain?: string }) {
    const sourcesRaw = (opts.sources !== undefined || opts.sourcesFile !== undefined) ? readJsonArg('--sources', opts.sources, opts.sourcesFile) : undefined;
    const evidenceRaw = (opts.evidence !== undefined || opts.evidenceFile !== undefined) ? readJsonArg('--evidence', opts.evidence, opts.evidenceFile) : undefined;
    if (sourcesRaw !== undefined) validateSources('--sources', sourcesRaw);
    if (evidenceRaw !== undefined) validateEvidence('--evidence', evidenceRaw);
    return {
      ...(opts.stdin ? { body_md: await ctx.io.readStdin() } : {}),
      ...(sourcesRaw !== undefined ? { sources: sourcesRaw } : {}),
      ...(evidenceRaw !== undefined ? { evidence: evidenceRaw } : {}),
      ...(opts.expiresAt !== undefined ? { expires_at: JSON.parse(opts.expiresAt) } : {}),
      ...(validateCategory(opts.category) !== undefined ? { category: validateCategory(opts.category) } : {}),
      ...(opts.domain !== undefined && opts.domain !== '' ? { domain: opts.domain } : {}),
      ...(validateLanded(opts.landed) !== undefined ? { landed: validateLanded(opts.landed) } : {}),
      actor: ctx.agentId,
    };
  }

  scoped(contentOptions(knowledge.command('create')).description('新建知识页（需要 --stdin/--sources/--evidence）').requiredOption('--title <title>').requiredOption('--slug <slug>'))
    .addHelpText('after', CREATE_HELP)
    .action(async (opts: ScopeOptions & { category?: string; landed?: string; domain?: string; title: string; slug: string; stdin?: boolean; sources?: string; sourcesFile?: string; evidence?: string; evidenceFile?: string; expiresAt?: string }) => {
      // C：先做客户端校验，非法值不发请求
      validateCategory(opts.category); validateLanded(opts.landed);
      const ctx = context();
      const missing: string[] = [];
      if (!opts.stdin) missing.push('--stdin（正文从 stdin 读，例：< body.md）');
      if (opts.sources === undefined && opts.sourcesFile === undefined) missing.push('--sources 或 --sources-file（见 create --help 的字段说明）');
      if (opts.evidence === undefined && opts.evidenceFile === undefined) missing.push('--evidence 或 --evidence-file（见 create --help 的字段说明）');
      if (missing.length > 0) fail(`create 缺少必填项：\n  - ${missing.join('\n  - ')}\n完整示例：kb knowledge create --help`);
      output(ctx, await request(ctx.base, 'POST', '/api/knowledge/pages', { ...await scopeFor(ctx, opts), ...await content(ctx, opts), title: opts.title, slug: opts.slug }));
    });
  scoped(contentOptions(knowledge.command('revise <page-id>')).description('修订知识页（只改给出的字段，需 CAS）').requiredOption('--expected-revision <n>', '当前 revision，必须与库内一致').option('--title <title>'))
    .addHelpText('after', REVISE_HELP)
    .action(async (id: string, opts: ScopeOptions & { expectedRevision: string; title?: string; stdin?: boolean; sources?: string; sourcesFile?: string; evidence?: string; evidenceFile?: string; expiresAt?: string }) => {
      const ctx = context(); output(ctx, await request(ctx.base, 'PUT', `/api/knowledge/pages/${encodeURIComponent(id)}`, { ...await scopeFor(ctx, opts), ...await content(ctx, opts), ...(opts.title !== undefined ? { title: opts.title } : {}), expected_revision: Number(opts.expectedRevision) }));
    });
  scoped(knowledge.command('action <page-id> <action>').description('改知识页状态：archive | restore | delete').requiredOption('--expected-revision <n>', '当前 revision，必须与库内一致'))
    .addHelpText('after', ACTION_HELP)
    .action(async (id: string, action: string, opts: ScopeOptions & { expectedRevision: string }) => {
      const allowed = ['archive', 'restore', 'delete'];
      if (!allowed.includes(action)) fail(`action 只能是 ${allowed.join(' | ')}（当前：${preview(action)}）；详见 kb knowledge action --help`);
      const ctx = context(); output(ctx, await request(ctx.base, 'POST', `/api/knowledge/pages/${encodeURIComponent(id)}/actions`, { ...await scopeFor(ctx, opts), action, expected_revision: Number(opts.expectedRevision), actor: ctx.agentId }));
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
      if (hasBom) process.stderr.write('提示：检测到 UTF-8 BOM，已在导入前剥离（正文首字符不会是 U+FEFF）\n');
      if (content.length > IMPORT_MAX_CHARS) {
        fail(`正文超长：当前 ${content.length} 字符 / 上限 ${IMPORT_MAX_CHARS} 字符`);
      }
      const format = opts.format ?? detectImportFormat(absolute);
      if (!IMPORT_FORMATS.includes(format)) {
        fail(`--format 只能是 ${IMPORT_FORMATS.join(' | ')}（当前：${preview(opts.format)}）；也可用 .md/.txt/.json 扩展名自动推断`);
      }
      const ctx = context();
      // sources 由服务端依 filename 构造（source_type=file、locator=路径、content_hash=sha256、无 snapshot）
      const body = {
        ...await scopeFor(ctx, opts),
        format,
        content,
        filename: absolute,
        ...(opts.title !== undefined ? { title: opts.title } : {}),
        ...(opts.slug !== undefined ? { slug: opts.slug } : {}),
        ...(opts.category !== undefined ? { category: opts.category } : {}),
        ...(opts.landed !== undefined ? { landed: opts.landed } : {}),
        ...(opts.domain !== undefined ? { domain: opts.domain } : {}),
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

