#!/usr/bin/env node
/** Task 10：kb CLI 入口（commander 装配 + 退出码映射）。 */
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { DEFAULT_BASE, CliHttpError, normalizeBase, ServerUnreachableError } from './api.js';
import { processIo, type Ctx, type Io } from './io.js';
import { listSpaces } from './commands/listSpaces.js';
import { listTasks } from './commands/listTasks.js';
import { show } from './commands/show.js';
import { claim } from './commands/claim.js';
import { comment } from './commands/comment.js';
import { done } from './commands/done.js';
import { fail } from './commands/fail.js';

/** 错误 → (stderr, 退出码)：连接拒绝 1；409 已被占用 2；其余 1 */
export function toExit(err: unknown, io: Io): number {
  if (err instanceof ServerUnreachableError) {
    io.writeErr(`${err.message}\n`);
    return 1;
  }
  if (err instanceof CliHttpError) {
    if (err.status === 409) {
      io.writeErr(err.message === '已被占用' ? '已被占用\n' : `已被占用（${err.message}）\n`);
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
    .version('0.0.0')
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
    .action(async (opts: { workspace?: string; status?: string }) =>
      listTasks(makeCtx(program, io), { workspace: opts.workspace, status: opts.status }));

  program
    .command('show')
    .description('任务完整字段 + 评论列表（含作者）')
    .argument('<issue-id>', '任务 id')
    .action(async (id: string) => show(makeCtx(program, io), id));

  program
    .command('claim')
    .description('原子领取任务（409 → 已被占用，退出码 2）')
    .argument('<issue-id>', '任务 id')
    .action(async (id: string) => claim(makeCtx(program, io), id));

  program
    .command('comment')
    .description('写评论（text 与 --stdin 二选一；长文/中文建议 --stdin；置 KB_AGENT 声明 agent 身份，作者记为 agent:<KB_AGENT>，缺省 user）')
    .argument('<issue-id>', '任务 id')
    .argument('[text...]', '评论内容（多词以空格合并）')
    .option('--stdin', '从标准输入读取全部内容作为评论')
    .action(async (id: string, text: string[] | undefined, opts: { stdin?: boolean }) =>
      comment(makeCtx(program, io), id, { text, stdin: opts.stdin === true }));

  program
    .command('done')
    .description('完成任务 → 待验收（notes 落评论流）')
    .argument('<issue-id>', '任务 id')
    .option('--notes <text>', '完成备注')
    .action(async (id: string, opts: { notes?: string }) =>
      done(makeCtx(program, io), id, { notes: opts.notes }));

  program
    .command('fail')
    .description('标记失败 → 待规划（reason 落评论流）')
    .argument('<issue-id>', '任务 id')
    .requiredOption('--reason <text>', '失败原因')
    .action(async (id: string, opts: { reason: string }) =>
      fail(makeCtx(program, io), id, { reason: opts.reason }));

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    return toExit(err, io);
  }
}

/** 仅作为 bin 直接执行时自动运行（vitest 导入不触发） */
const invoked =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  void main().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
