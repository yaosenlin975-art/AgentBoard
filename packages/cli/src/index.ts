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
import { registerChangelogCommands } from './commands/changelog.js';
import { installAutostart, statusAutostart, uninstallAutostart } from './commands/autostart.js';
import { createShortcut, removeShortcut } from './commands/shortcut.js';

/** 错误 → (stderr, 退出码)：连接拒绝 1；409 已被占用 2；其余 1 */
export function toExit(err: unknown, io: Io): number {
  if (err instanceof ServerUnreachableError) {
    io.writeErr(`${err.message}\n`);
    return 1;
  }
  if (err instanceof CliHttpError) {
    if (err.status === 409) {
      // 服务端已给出自解释文案的 409 原样透传（删除被占用/含子任务等），不再包装成「已被占用（…）」
      const raw = err.code.startsWith('KNOWLEDGE_') || err.code.startsWith('CHANGELOG_')
        || err.code === 'CONFLICT' || err.code === 'IDEMPOTENCY_KEY_REUSED';
      io.writeErr(raw ? `${err.message}\n` : err.message === '已被占用' ? '已被占用\n' : `已被占用（${err.message}）\n`);
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
    .option('--server <url>', '看板服务基址（默认取 KB_SERVER，再默认 http://127.0.0.1:8787）', process.env.KB_SERVER)
    .option('--json', '输出原始 JSON 响应');

  program
    .command('list-spaces')
    .description('列出全部工作空间（id / name / path）')
    .action(async () => listSpaces(makeCtx(program, io)));

  program
    .command('list-tasks')
    .description('列任务（--workspace 支持 id 或名称；缺省聚合全部工作空间）')
    .option('--workspace <id|名>', '工作空间 id 或名称')
    .option('--status <状态>', '按状态过滤: 待规划|进行中|待验收|已关闭')
    .option('--tree', '显示递归任务树；状态筛选保留祖先路径')
    .action(async (opts: { workspace?: string; status?: string; tree?: boolean }) =>
      listTasks(makeCtx(program, io), { workspace: opts.workspace, status: opts.status, tree: opts.tree }));

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
    .option('--notes <text>', '完成备注')
    .option('--request-id <uuid>', '幂等请求 id；重试必须复用同一 uuid')
    .action(async (id: string, opts: { notes?: string; requestId?: string }) =>
      done(makeCtx(program, io), id, { notes: opts.notes, requestId: opts.requestId }));

  program
    .command('delete-issue')
    .description('删除任务（不可逆；占用中或含子任务会被拒；必须显式 --yes）')
    .argument('<issue-id>', '任务 id')
    .option('--yes', '确认删除；缺省时只打印标题/状态并以非 0 退出，不发请求')
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
    .command('create-issue')
    .description('创建任务（workspace 支持 id 或名称）')
    .argument('<workspace>', '工作空间 id 或名称')
    .argument('<title>', '任务标题')
    .option('-d, --description <text>', '任务描述（含空格用引号；多行走 UI 或 API）')
    .option('-p, --priority <低|中|高>', '优先级')
    .option('-l, --labels <a,b,c>', '标签（逗号拆分）')
    .option('--parent <issue-id>', '父任务 id')
    .option('--request-id <uuid>', '幂等请求 id；重试时复用')
    .action(async (workspace: string, title: string, opts: { description?: string; priority?: string; labels?: string; parent?: string; requestId?: string }) =>
      createIssue(makeCtx(program, io), {
        workspace,
        title,
        description: opts.description,
        priority: opts.priority,
        labels: opts.labels,
        parentIssueId: opts.parent,
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
