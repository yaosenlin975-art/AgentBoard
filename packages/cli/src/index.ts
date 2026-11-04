#!/usr/bin/env node
/** Task 10：kb CLI 入口（commander 装配 + 退出码映射）。 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { DEFAULT_BASE, CliHttpError, normalizeBase, ServerUnreachableError } from './api.js';
import { processIo, type Ctx, type Io } from './io.js';
import { CLI_VERSION } from './version.js';
import { listSpaces } from './commands/listSpaces.js';
import { createSpace } from './commands/createSpace.js';
import { deleteSpace } from './commands/deleteSpace.js';
import { createIssue } from './commands/createIssue.js';
import { moveIssue } from './commands/moveIssue.js';
import { listTasks } from './commands/listTasks.js';
import { show } from './commands/show.js';
import { claim } from './commands/claim.js';
import { comment } from './commands/comment.js';
import { done } from './commands/done.js';
import { deleteIssue } from './commands/deleteIssue.js';
import { fail } from './commands/fail.js';
import { registerKnowledgeCommands } from './commands/knowledge.js';
import { depAdd, depLs, depRemove } from './commands/dep.js';
import { statusAdd, statusList, statusRemove } from './commands/status.js';
import { close, reopen, update } from './commands/lifecycle.js';
import { registerChangelogCommands } from './commands/changelog.js';
import { installAutostart, statusAutostart, uninstallAutostart } from './commands/autostart.js';
import { createShortcut, removeShortcut } from './commands/shortcut.js';

/** 全局退出码表：help 末尾与 Docs/api.md §12.1 同源口径 */
const EXIT_CODE_HELP = `
退出码：
  0  成功（--help / --version 同样 0）
  1  参数或用法错误、服务端非冲突错误（400/404/500）、看板服务不可达；命令未改动任何数据
  2  冲突：占用（已被 <agent> 占用 / 未被占用 / 非当前占用者）、状态不可领取、知识页 revision 冲突、
     幂等键复用、删除被阻塞（含子任务 / 知识页 / 运行中会话 / 占用中）；命令未改动数据，按提示处置后重试
  3  kb dep 专用：依赖参数错误（自环 / 跨工作区 / VALIDATION_ERROR）
  4  kb dep 专用：任务或依赖不存在
约定：原因一律写 stderr（单行可读）；--json 只改 stdout 结构，不改退出码。
`;


/** 错误 → (stderr, 退出码)：连接拒绝 1；409 冲突 2；其余 1 */
export function toExit(err: unknown, io: Io): number {
  if (err instanceof ServerUnreachableError) {
    io.writeErr(`${err.message}\n`);
    return 1;
  }
  if (err instanceof CliHttpError) {
    if (err.status === 409) {
      // 服务端已给出自解释文案的 409 原样透传（删除被占用/含子任务等），不再包装成「已被占用（…）」
      const raw = err.code.startsWith('KNOWLEDGE_') || err.code.startsWith('CHANGELOG_')
        || err.code === 'CONFLICT' || err.code === 'IDEMPOTENCY_KEY_REUSED'
        // CLAIM-MSG：占用冲突与「状态不可领取」自带自解释文案，原样透传
        || err.code === 'ISSUE_CLAIMED' || err.code === 'ISSUE_STATUS_NOT_CLAIMABLE' || err.code === 'NOT_TASK_OWNER';
      // CLI-CRASH：done/fail 报「未被占用」时给可操作下一步，而不是让人卡在最后一步
      const hint = err.message === '未被占用'
        ? '未被占用：如需推进请先 kb claim，或使用 kb close（待验收 → 已关闭）\n'
        : raw ? `${err.message}\n` : err.message === '已被占用' ? '已被占用\n' : `已被占用（${err.message}）\n`;
      io.writeErr(hint);
      return 2;
    }
    io.writeErr(`${err.message}\n`);
    return 1;
  }
  io.writeErr(`${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}

function makeCtx(program: Command, io: Io): Ctx {
  const opts = program.opts<{ server?: string; json?: boolean }>();
  return {
    base: normalizeBase(opts.server),
    json: opts.json === true,
    agentId: process.env.KB_AGENT || 'kb-cli',
    io,
  };
}

/** 返回退出码（0 成功）；--help/--version → 0；用法错误 → commander 自带 stderr + 1 */
export async function main(argv: string[] = process.argv, io: Io = processIo): Promise<number> {
  const program = new Command();
  program
    .name('kb')
    .description('AgentBoard 任务看板 CLI（走本地 HTTP API）')
    .version(CLI_VERSION)
    .exitOverride()
    // KBGUIDE：把 commander 的 help/version 输出也接到注入的 io 上（生产 io 就是 process 流，行为不变；
    // 进程内调用可捕获 --help，help 文案才可被单测覆盖）
    .configureOutput({ writeOut: (text: string) => io.write(text), writeErr: (text: string) => io.writeErr(text) })
    .option('--server <url>', '看板服务基址（默认取 KB_SERVER，再默认 http://127.0.0.1:8787）', process.env.KB_SERVER)
    .option('--json', '输出原始 JSON 响应')
    .addHelpText('after', EXIT_CODE_HELP);

  program
    .command('list-spaces')
    .description('列出全部工作空间（id / name / path）；--current 只列 cwd 解析到的当前工作区')
    .option('--current', '只输出当前工作区（按 cwd 实体路径解析，JSON 仍为单元素数组）')
    .action(async (opts: { current?: boolean }) => listSpaces(makeCtx(program, io), { current: opts.current === true }));

  program
    .command('list-tasks')
    .description('列任务（缺省按 cwd 解析当前工作区；跨区盘点用 --all）')
    .option('--workspace <id|名>', '工作空间 id 或名称')
    .option('--all', '聚合全部工作空间；只读盘点，与 --workspace 互斥')
    .option('--status <状态>', '按当前筛选范围已定义的状态过滤；非法值会列出可用状态')
    .option('--tree', '显示递归任务树；状态筛选保留祖先路径')
    .option('--full', '--json 时一并输出 description 正文（默认裁剪，只输出元数据）')
    .action(async (opts: { workspace?: string; all?: boolean; status?: string; tree?: boolean; full?: boolean }) =>
      listTasks(makeCtx(program, io), { workspace: opts.workspace, all: opts.all === true, status: opts.status, tree: opts.tree, full: opts.full === true }));

  program
    .command('show')
    .description('任务完整字段 + 评论列表（含作者）')
    .argument('<issue-id>', '任务 id')
    .action(async (id: string) => show(makeCtx(program, io), id));

  program
    .command('claim')
    .description('原子领取任务（409 → 已被占用，退出码 2）')
    .argument('<issue-id>', '任务 id')
    .option('--no-knowledge', '关闭任务知识检索')
    .option('--knowledge-query <query>', '自定义知识查询')
    .option('--request-id <uuid>', '幂等请求 id；重试必须复用同一 uuid')
    .addHelpText('after', `
说明：占用冲突（已被 <agent> 占用）与状态不可领取（无人占用但状态不是待规划/进行中，如待验收）是两条不同文案。
示例：
  kb claim 0f6ba9ab-996d-4af5-b0cd-d9208c44936f
  kb claim 0f6ba9ab-… --no-knowledge
退出码：0 成功；2 已被 <agent> 占用 / 状态不可领取（当前=待验收…）/ 前置未解除（DEP-1）；1 任务不存在或参数错误
`)
    .action(async (id: string, opts: { knowledge?: boolean; knowledgeQuery?: string; requestId?: string }) => claim(makeCtx(program, io), id, opts));

  program
    .command('comment')
    .description('写评论，可附最多 5 张 PNG/JPEG/WebP 图片（agent 身份 KB_AGENT 优先，作者记为 agent:<id>）')
    .argument('<issue-id>', '任务 id')
    .argument('[text...]', '评论内容（多词以空格合并）')
    .option('--stdin', '从标准输入读取全部内容作为评论')
    .option('--image <path>', '附加图片文件（最多 5 次）', (value: string, previous: string[] = []) => [...previous, value], [])
    .option('--request-id <uuid>', '图片评论幂等请求 id；重试时复用')
    .action(async (id: string, text: string[] | undefined, opts: { stdin?: boolean; image?: string[]; requestId?: string }) =>
      comment(makeCtx(program, io), id, { text, stdin: opts.stdin === true, image: opts.image, requestId: opts.requestId }));

  program
    .command('done')
    .description('完成任务 → 待验收（notes 落评论流）')
    .argument('<issue-id>', '任务 id')
    .option('--notes <text>', '完成备注（单行；多行或含 "- " 开头的行请用 --notes-stdin）')
    .option('--notes-stdin', '从标准输入读取完成备注（多行安全）')
    .option(
      '--scope <paths...>',
      '声明本任务改动的路径（文件或目录前缀）。**必须重复传参**：--scope a --scope b；逗号串在 PowerShell 下会被拆成多个参数（已兼容吞下，但不保证顺序与语义）',
      (value: string, previous: string[] = []) => [...previous, ...value.split(',').map(item => item.trim()).filter(Boolean)],
      [],
    )
    .option('--request-id <uuid>', '幂等请求 id；重试必须复用同一 uuid')
    .addHelpText('after', `
示例：
  kb done 0f6ba9ab-996d-4af5-b0cd-d9208c44936f --notes '改完并跑通测试'
  kb done 0f6ba9ab-… --scope packages/cli/src/index.ts --scope Docs/api.md
退出码：0 成功（状态 → 待验收）；2 未被占用 / 非当前占用者 / 占用已改变；1 参数错误或任务不存在
GIT-ON-DONE：非 git 工作区会留一行「跳过自动提交：工作区不是 git 仓库」并回显 --scope；静默跳过已取消。
`)
    .action(async (id: string, opts: { notes?: string; notesStdin?: boolean; scope?: string[]; requestId?: string }) =>
      done(makeCtx(program, io), id, { notes: opts.notes, notesStdin: opts.notesStdin === true, scope: opts.scope, requestId: opts.requestId }));

  program
    .command('close')
    .description('关闭任务：待验收 → 已关闭（占用中会 409，先 release）')
    .argument('<issue-id>', '任务 id')
    .option('--request-id <uuid>', '幂等请求 id；重试必须复用同一 uuid')
    .addHelpText('after', '\n示例：\n  kb close 0f6ba9ab-996d-4af5-b0cd-d9208c44936f\n  kb close 0f6ba9ab-… --request-id 11111111-1111-4111-8111-111111111111\n退出码：0 成功；2 冲突（占用中/状态不允许）；1 其它错误（404 等）')
    .action(async (id: string, opts: { requestId?: string }) => close(makeCtx(program, io), id, { requestId: opts.requestId }));

  program
    .command('reopen')
    .description('重开任务：已关闭/已废弃 → 指定状态（默认「待规划」）')
    .argument('<issue-id>', '任务 id')
    .option('--to <状态>', '目标状态名（须是本工作区已定义状态，含自定义状态）', '待规划')
    .option('--request-id <uuid>', '幂等请求 id；重试必须复用同一 uuid')
    .addHelpText('after', '\n示例：\n  kb reopen 0f6ba9ab-…                  # 回到「待规划」\n  kb reopen 0f6ba9ab-… --to 进行中\n退出码：0 成功；2 冲突（占用中/当前不是关闭态）；1 其它错误（400 目标状态非法 / 404）')
    .action(async (id: string, opts: { to?: string; requestId?: string }) => reopen(makeCtx(program, io), id, { to: opts.to, requestId: opts.requestId }));

  program
    .command('update')
    .description('修改任务字段（不含状态；状态请用 claim/done/close/reopen/fail）')
    .argument('<issue-id>', '任务 id')
    .option('--title <text>', '标题')
    .option('--description <text>', '描述（短文本）')
    .option('--description-stdin', '从标准输入读取描述（长文本/多行）')
    .option('--priority <低|中|高>', '优先级')
    .option('--labels <a,b,c>', '标签（逗号分隔，整体替换）')
    .option('--due-date <YYYY-MM-DD>', '截止日期')
    .option('--due-time <HH:mm>', '截止时间（24h）')
    .option('--clear-due', '清空截止日期与时间')
    .option('--parent <issue-id>', '新父任务')
    .option('--clear-root', '移动为根任务（清空父任务）')
    .option('--request-id <uuid>', '幂等请求 id；重试必须复用同一 uuid')
    .addHelpText('after', '\n示例：\n  kb update 0f6ba9ab-… --title "修好的标题"\n  cat spec.md | kb update 0f6ba9ab-… --description-stdin\n  kb update 0f6ba9ab-… --priority 高 --due-date 2026-11-10 --due-time 14:30\n退出码：0 成功；1 其它错误（400 字段非法 / 404 任务不存在；占用中改状态会 409，本命令不含状态）')
    .action(async (id: string, opts: { title?: string; description?: string; descriptionStdin?: boolean; priority?: string; labels?: string; dueDate?: string; dueTime?: string; clearDue?: boolean; parent?: string; clearRoot?: boolean; requestId?: string }) =>
      update(makeCtx(program, io), id, {
        title: opts.title, description: opts.description, descriptionStdin: opts.descriptionStdin,
        priority: opts.priority, labels: opts.labels, dueDate: opts.dueDate, dueTime: opts.dueTime,
        clearDue: opts.clearDue, parent: opts.parent, clearParent: opts.clearRoot, requestId: opts.requestId,
      }));

  program
    .command('delete-issue')
    .description('删除任务（不可逆；占用中或含子任务会被拒；必须显式 --yes）')
    .argument('<issue-id>', '任务 id')
    .option('--yes', '确认删除；缺省时只打印标题/状态并以非 0 退出，不发请求')
    .addHelpText('after', `
示例：
  kb delete-issue 0f6ba9ab-996d-4af5-b0cd-d9208c44936f            # 只回显标题/状态，exit 1
  kb delete-issue 0f6ba9ab-… --yes                                 # 真删（不可恢复）
退出码：0 成功；1 缺 --yes（仅回显，不发请求）/ 参数错误 / 任务不存在；2 占用中 / 含子任务
`)
    .action(async (id: string, opts: { yes?: boolean }) =>
      deleteIssue(makeCtx(program, io), id, { yes: opts.yes === true }));

  program
    .command('fail')
    .description('标记失败 → 待规划（reason 落评论流）')
    .argument('<issue-id>', '任务 id')
    .requiredOption('--reason <text>', '失败原因')
    .option('--request-id <uuid>', '幂等请求 id；重试必须复用同一 uuid')
    .action(async (id: string, opts: { reason: string; requestId?: string }) =>
      fail(makeCtx(program, io), id, { reason: opts.reason, requestId: opts.requestId }));

  program
    .command('create-space')
    .description('创建工作空间（path 必须已存在且是目录）')
    .argument('<name>', '工作空间名称')
    .argument('<path>', '工作空间目录路径')
    .action(async (name: string, path: string) => createSpace(makeCtx(program, io), { name, path }));

  program
    .command('delete-space')
    .description('删除工作空间登记（不可逆；不动磁盘目录；占用校验由服务端拒绝）')
    .argument('<workspace>', '工作空间 id 或名称')
    .option('--yes', '确认删除；缺省时只回显名称/路径并以非 0 退出，不发请求')
    .addHelpText('after', `
示例：
  kb delete-space kb-docs-sandbox          # 只回显，exit 1
  kb delete-space 37b6faf0-abd2-47e9-8764-eabb9d355c31 --yes
退出码：0 成功；1 缺 --yes（仅回显）/ 工作空间不存在 / 参数错误；2 被阻塞（仍有知识页 / 运行中会话 / 未解除子任务）
说明：409 原因由服务端给出（例：该空间仍有 1 个知识页及 1 条历史 revision，请先删除或迁移知识页后再移除）。
`)
    .action(async (workspace: string, opts: { yes?: boolean }) =>
      deleteSpace(makeCtx(program, io), workspace, { yes: opts.yes === true }));

  program
    .command('create-issue')
    .description('创建任务（workspace 支持 id 或名称）')
    .argument('<workspace>', '工作空间 id 或名称')
    .argument('<title>', '任务标题')
    .option('-d, --description <text>', '任务描述（含空格用引号；多行走 UI 或 API）')
    .option('-p, --priority <低|中|高>', '优先级')
    .option('-l, --labels <a,b,c>', '标签：逗号或空格分隔，会拆成多个标签（标签本身不含空格）')
    .option('--parent <issue-id>', '父任务 id')
    .option('--due <YYYY-MM-DD[THH:mm]>', '截止日期（可带时间）；不传 = 不设截止，不主动推断')
    .option('--request-id <uuid>', '幂等请求 id；重试时复用')
    .action(async (workspace: string, title: string, opts: { description?: string; priority?: string; labels?: string; parent?: string; due?: string; requestId?: string }) =>
      createIssue(makeCtx(program, io), {
        workspace,
        title,
        description: opts.description,
        priority: opts.priority,
        labels: opts.labels,
        parentIssueId: opts.parent,
        due: opts.due,
        requestId: opts.requestId,
      }));

  program
    .command('move-issue')
    .description('移动任务到父任务或恢复为根任务')
    .argument('<issue-id>', '任务 id')
    .option('--parent <issue-id>', '新父任务 id')
    .option('--root', '移动为根任务')
    .option('--expected-updated-at <timestamp>', 'CAS 版本；重试时复用原值')
    .option('--request-id <uuid>', '幂等请求 id；重试时复用')
    .action(async (id: string, opts: { parent?: string; root?: boolean; expectedUpdatedAt?: string; requestId?: string }) =>
      moveIssue(makeCtx(program, io), id, {
        parentIssueId: opts.parent, root: opts.root,
        expectedUpdatedAt: opts.expectedUpdatedAt === undefined ? undefined : Number(opts.expectedUpdatedAt),
        requestId: opts.requestId,
      }));

  registerKnowledgeCommands(program, () => makeCtx(program, io));
  registerChangelogCommands(program, () => makeCtx(program, io));

  // 依赖（DEP-2）：退出码由 commands/dep.ts 自带映射（0/2/3/4），这里只把结果码转成进程退出码
  const depRun = (run: (ctx: Ctx) => Promise<number>) => async () => {
    const code = await run(makeCtx(program, io));
    if (code !== 0) throw new CommanderError(code, 'agentboard.dep', '');
  };
  const dep = program.command('dep').description('任务依赖（前置 / 被阻塞）：ls 列出、add 建边、rm 删边');
  dep.command('ls')
    .description('列出任务的前置与被阻塞者（含状态与解除标记）')
    .argument('<issue-id>', '任务 id')
    .action(async (id: string) => depRun(ctx => depLs(ctx, id))());
  dep.command('add')
    .description('新增前置：blocker 解除（待验收/已关闭）后本卡才可 claim')
    .argument('<issue-id>', '被阻塞的任务 id')
    .argument('<blocker-id>', '前置任务 id')
    .action(async (id: string, blockerId: string) => depRun(ctx => depAdd(ctx, id, blockerId))());
  dep.command('rm')
    .description('移除前置')
    .argument('<issue-id>', '被阻塞的任务 id')
    .argument('<blocker-id>', '前置任务 id')
    .action(async (id: string, blockerId: string) => depRun(ctx => depRemove(ctx, id, blockerId))());

  // 状态字典（STATUS-2）：ls / add / rm --migrate-to
  const status = program.command('status').description('工作区状态字典：ls 列出、add 新增自定义状态、rm 删除并强制迁移');
  status.command('ls')
    .description('列出工作区状态（名字 / kind / 排序 / 内置或自定义）')
    .argument('<workspace>', '工作空间 id 或名称')
    .action(async (workspace: string) => statusList(makeCtx(program, io), workspace));
  status.command('add')
    .description('新增自定义状态（名称在工作区内唯一；内置五状态不可复刻）')
    .argument('<workspace>', '工作空间 id 或名称')
    .argument('<name>', '状态名')
    .option('--kind <kind>', '行为类别（默认 open）：open=未开始 / started=进行中 / review=待验收 / done=完成（关闭类）/ deprecated=废弃（关闭类，与 done 同级）')
    .option('--sort-order <n>', '排序值（默认最大值 +10）')
    .action(async (workspace: string, name: string, opts: { kind?: string; sortOrder?: string }) =>
      statusAdd(makeCtx(program, io), workspace, name, {
        kind: opts.kind,
        sortOrder: opts.sortOrder === undefined ? undefined : Number(opts.sortOrder),
      }));
  status.command('rm')
    .description('删除自定义状态；必须 --migrate-to 指定该状态下的卡迁移目标（内置状态不可删）')
    .argument('<workspace>', '工作空间 id 或名称')
    .argument('<status>', '状态名或状态 id')
    .option('--migrate-to <name>', '该状态下的卡迁移到的目标状态名（必填）')
    .action(async (workspace: string, nameOrId: string, opts: { migrateTo?: string }) =>
      statusRemove(makeCtx(program, io), workspace, nameOrId, { migrateTo: opts.migrateTo }));

  const autostart = program.command('autostart').description('开机自启（Windows：HKCU Run 键经 scripts/agentboard.vbs 隐藏拉起服务，日志在 %APPDATA%\\AgentBoard\\logs）');
  autostart.command('install').description('安装自启（前置 apps/server/dist 已构建；node/仓库/端口/日志写进 vbs）')
    .action(async () => installAutostart(io));
  autostart.command('uninstall').description('移除自启（仅删自家 Run 键值，vbs 文件保留）')
    .action(async () => uninstallAutostart(io));
  autostart.command('status').description('自启安装状态 + 服务可达性 + 日志路径')
    .action(async () => statusAutostart(makeCtx(program, io)));

  const shortcut = program.command('shortcut').description('桌面快捷方式（Windows：AgentBoard.lnk 双击拉起服务并打开看板）');
  shortcut.command('create').description('创建桌面快捷方式（需先 kb autostart install 配置 vbs 与图标）')
    .action(async () => createShortcut(makeCtx(program, io)));
  shortcut.command('remove').description('移除桌面快捷方式')
    .action(async () => removeShortcut(makeCtx(program, io)));

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    return toExit(err, io);
  }
}

/** 仅作为 bin 直接执行时自动运行（vitest 导入不触发）；两侧按 realpath 归一（npm link 的 junction/符号链接），argv[1] realpath 失败视为不匹配 */
const invoked = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invoked) {
  void main().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
