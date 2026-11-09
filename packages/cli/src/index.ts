#!/usr/bin/env node
/** Task 10：kb CLI 入口（commander 装配 + 退出码映射）。 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { normalizeBase } from './api.js';
import { toExit } from './errors.js';
import { normalizeIssueRef } from './issueRef.js';
import { processIo, type Ctx, type Io } from './io.js';
import { CLI_VERSION } from './version.js';
import { listSpaces } from './commands/listSpaces.js';
import { grep } from './commands/grep.js';
import { createSpace } from './commands/createSpace.js';
import { deleteSpace } from './commands/deleteSpace.js';
import { createIssue } from './commands/createIssue.js';
import { moveIssue } from './commands/moveIssue.js';
import { listTasks } from './commands/listTasks.js';
import { next, NEXT_DEFAULT_LIMIT } from './commands/next.js';
import { stats } from './commands/stats.js';
import { show } from './commands/show.js';
import { claim } from './commands/claim.js';
import { release, releaseIssue } from './commands/release.js';
import { comment } from './commands/comment.js';
import { accept } from './commands/accept.js';
import { done } from './commands/done.js';
import { deleteIssue } from './commands/deleteIssue.js';
import { fail, failIssue } from './commands/fail.js';
import { registerKnowledgeCommands } from './commands/knowledge.js';
import { depAdd, depLs, depRemove } from './commands/dep.js';
import { statusAdd, statusList, statusRemove } from './commands/status.js';
import { close, closeIssueWithOwnRelease, reopen, runBulk, update } from './commands/lifecycle.js';
import { registerChangelogCommands } from './commands/changelog.js';
import { installAutostart, statusAutostart, uninstallAutostart } from './commands/autostart.js';
import { createShortcut, removeShortcut } from './commands/shortcut.js';
import { accountSwitch, accountsCapabilities, accountsList } from './commands/accounts.js';
import {
  workspaceDbCleanup,
  workspaceDbEnable,
  workspaceDbRevert,
  workspaceDbCenterSnapshotExport,
  workspaceDbCenterSnapshotValidate,
  workspaceDbSnapshotExport,
  workspaceDbSnapshotImport,
  workspaceDbSnapshotValidate,
  workspaceDbStatus,
} from './commands/workspaceDb.js';
import { registerDecisionCommands } from './commands/decision.js';
import { parseCommentLimit } from './render.js';

/** OPT-05：描述窗口参数解析；非法值报参数错误（exit 1） */
function parseDescriptionChars(
  flag: '--description-max-chars' | '--description-offset',
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  const min = flag === '--description-max-chars' ? 1 : 0;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${flag} 取值必须是${min === 1 ? '正' : '非负'}整数（当前 ${raw}）`);
  }
  return value;
}

/** OPT-10：--limit 解析（正整数，非法 → exit 1） */
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--limit 取值必须是正整数（当前 ${raw}）`);
  return value;
}

/** 全局退出码表：help 末尾与 Docs/api.md §12.1 同源口径 */
const EXIT_CODE_HELP = `
退出码：
  0  成功（--help / --version 同样 0）
  1  参数或用法错误、服务端非冲突错误（400/404/500）、看板服务不可达；命令未改动任何数据
  2  冲突：占用（已被 <agent> 占用 / 未被占用 / 非当前占用者）、状态不可领取、知识页 revision 冲突、
     幂等键复用、删除被阻塞（含子任务 / 知识页 / 运行中会话 / 占用中）、任务 id 前缀多命中；命令未改动数据，按提示处置后重试
  3  kb dep 专用：依赖参数错误（自环 / 跨工作区 / VALIDATION_ERROR）
  4  kb dep 专用：依赖边不存在
kb grep（本地检索，不适用上表）：0 命中；1 未命中；2 出错（参数非法 / 根目录不存在 / 正则无效）
约定：原因一律写 stderr（单行可读）；--json 时错误写 stdout 的 {"error":{"code","message","details"}}，退出码不变。
`;


/** commander 可重复选项收集器（--glob / --ignore） */
function collectValue(value: string, previous: string[]): string[] {
  return [...previous, value];
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
  // OPT-06：多 id show 允许「部分失败仍输出其余块」，由命令自己返回退出码（不抛错，避免 --json 流被错误体污染）
  let commandExitCode = 0;
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
    .option('--all-status', '保留改造前口径：不按「未完成 · 无主」收敛，输出整区全状态')
    .option('--tree', '显示递归任务树；状态筛选保留祖先路径')
    .option('--full', '表格输出完整列（labels/决策/评论/parent_issue_id）；--json 时一并输出 description 正文')
    .action(async (opts: { workspace?: string; all?: boolean; status?: string; allStatus?: boolean; tree?: boolean; full?: boolean }) =>
      listTasks(makeCtx(program, io), { workspace: opts.workspace, all: opts.all === true, status: opts.status, allStatus: opts.allStatus === true, tree: opts.tree, full: opts.full === true }));

  // OPT-10：可派卡组合视图（替代 list-tasks + 逐卡 show + 逐卡 dep ls 三轮）
  program
    .command('next')
    .description('列当前工作区可派卡（待规划 · 无占用 · 前置全部解除）及其派活字段；不自动 claim')
    .option('--workspace <id|名>', '工作空间 id / 名称 / ≥8 位唯一前缀（缺省按 cwd 解析）')
    .option('--limit <n>', `最多返回几张（缺省 ${NEXT_DEFAULT_LIMIT}）`)
    .addHelpText('after', `
示例：
  kb next
  kb next --limit 5                    # 最多 5 张
  kb next --workspace e41eb0fb --json  # 机器可读：items[]，含 blockers/blocks/parent_issue_id
输出：每张卡含 状态/优先级/父卡(parent_issue_id)/前置(blockers，均应为已解除)/后继(blocked)/同标签相邻卡；
      前置未全部解除的卡不进入可派列表。
退出码：0 成功（无可派卡时输出「（无可派卡）」仍为 0）；1 参数错误 / 工作区无法解析
`)
    .action(async (opts: { workspace?: string; limit?: string }) => {
      commandExitCode = await next(makeCtx(program, io), { workspace: opts.workspace, limit: parseLimit(opts.limit) });
    });

  // OPT-11：汇总计数（替代逐状态 list-tasks 复算）
  program
    .command('stats')
    .description('工作区汇总计数：五状态 / 未完成无主 / 被阻塞（一次请求，带工作区 id 与生成时间）')
    .option('--workspace <id|名>', '工作空间 id / 名称 / ≥8 位唯一前缀（缺省按 cwd 解析）')
    .addHelpText('after', `
示例：
  kb stats
  kb stats --workspace e41eb0fb --json
输出：待规划/进行中/待验收/已关闭/已废弃 五行计数；无主（未完成）= 未完成且 claimed_by 为空；
      被阻塞（未完成，有未解除前置）= blocked_by_open_count > 0；末尾给一条复算命令。
退出码：0 成功；1 工作区无法解析 / 服务端错误
`)
    .action(async (opts: { workspace?: string }) => {
      commandExitCode = await stats(makeCtx(program, io), { workspace: opts.workspace });
    });

  // KB-GREP：本地按内容检索仓库（纯 Node；无 REST 依赖，仅默认搜索根需要解析工作区）
  program
    .command('grep')
    .description('按文件内容检索仓库（本地检索；默认搜索当前工作区根，不读 .gitignore）')
    .argument('<pattern>', 'JS 正则；配合 --fixed-strings 时按字面量匹配')
    .option('--path <dir>', '搜索根：绝对路径直接使用；相对路径相对当前工作区根')
    .option('--glob <pattern>', '包含过滤，可重复（如 **/*.ts）；模式不含 / 时只比对文件名', collectValue, [] as string[])
    .option('--ignore <pattern>', '追加忽略，可重复；同时剪枝同名目录', collectValue, [] as string[])
    .option('--no-default-ignore', '关闭内置忽略目录集（不用 --no-ignore：--ignore 已用于追加忽略模式）')
    .option('--hidden', '纳入点号开头的文件/目录')
    .option('--fixed-strings', '把 pattern 当字面量而不是正则')
    .option('-i, --ignore-case', '大小写不敏感')
    .option('-C, --context <n>', '前后各 n 行上下文', '0')
    .option('--max-count <n>', '单文件最多命中条数（默认不限）')
    .option('--max-matches <n>', '全局命中上限（默认 1000）', '1000')
    .option('--max-file-size <bytes>', '单文件大小上限（默认 2 MiB）', String(2 * 1024 * 1024))
    .option('--timeout <ms>', '总超时（默认 10000）', '10000')
    .option('--binary <skip|list>', '二进制文件处理：skip 跳过（默认）/ list 仅按路径列出', 'skip')
    .addHelpText('after', `
说明：
  默认搜索根为当前工作区根（按 cwd 解析 workspace path）；给 --path 时绝对路径直接使用，相对路径相对工作区根。
  --glob 是包含过滤（给了就必须命中至少一个），--ignore 追加忽略；两者都作用于「相对搜索根的 POSIX 路径」，
  模式不含 / 时只比对文件名。内置忽略目录：node_modules .git dist build dist-package .logs .agentboard
  coverage .next target（--no-default-ignore 关闭）。不读 .gitignore，也不读 .ignore。
  二进制（前 8 KiB 含 NUL）默认跳过；--binary list 时仅在路径命中模式下列出（line/column 记 1、text 为空）。
  UTF-8 解码并剥 BOM，CRLF 去尾部 \\r；符号链接不跟随；无权限/被占用的文件计入 files_skipped 不中断。
  单行超 4000 字符只截断展示，匹配仍按整行进行。
  截断（--max-matches / --timeout）不算错误：JSON 里 truncated.hit=true，退出码仍按是否命中给 0/1。
退出码（本地命令例外）：0 命中；1 未命中；2 出错（参数非法 / 根目录不存在 / 正则无效）。
示例：
  kb grep "createIssue" --path packages/cli/src --glob "*.ts"
  kb grep "TODO|FIXME" --glob "**/*.ts" -C 1 --max-matches 20 --json
  kb grep "kb.claim" --ignore "*.test.ts" -i
`)
    .action(async (pattern: string, opts: {
      path?: string; glob: string[]; ignore: string[]; defaultIgnore?: boolean; hidden?: boolean;
      fixedStrings?: boolean; ignoreCase?: boolean; context?: string; maxCount?: string;
      maxMatches?: string; maxFileSize?: string; timeout?: string; binary?: string;
    }) => grep(makeCtx(program, io), pattern, {
      path: opts.path,
      glob: opts.glob,
      ignore: opts.ignore,
      noDefaultIgnore: opts.defaultIgnore === false,
      hidden: opts.hidden === true,
      fixedStrings: opts.fixedStrings === true,
      ignoreCase: opts.ignoreCase === true,
      context: opts.context,
      maxCount: opts.maxCount,
      maxMatches: opts.maxMatches,
      maxFileSize: opts.maxFileSize,
      timeout: opts.timeout,
      binary: opts.binary,
    }));

  program
    .command('show')
    .description('任务完整字段 + 评论列表（含作者）；默认只读，不推进评论已读游标；多 id 时输出摘要视图')
    .argument('<issue-id...>', '任务 id（可多个）：完整 UUID，或 ≥8 位唯一前缀；多 id 时每块只给摘要')
    .option('--mark-read', '把本次读到的评论标为已读（推进本 agent 的已读游标）；缺省不推进（多 id 时忽略）')
    .option('--comments <n|all>', '评论渲染条数：最近 n 条（缺省 5，未读优先；单条按窗口截断），all = 全量原文（多 id 时忽略）')
    .option('--description-max-chars <n>', '描述窗口大小（缺省 12000，与 MCP get_task 一致；上限 40000；多 id 时忽略）')
    .option('--description-offset <n>', '描述续读偏移（从上一窗口的 next_description_offset_chars 续读；多 id 时忽略）')
    .addHelpText('after', `
示例：
  kb show 0f6ba9ab-996d-4af5-b0cd-d9208c44936f
  kb show 0f6ba9ab                      # ≥8 位前缀（唯一命中时解析为完整 id）
  kb show 0f6ba9ab --mark-read          # 明确要求推进评论已读游标
  kb show 0f6ba9ab --comments all       # 全量评论原文（与改造前逐字一致）
  kb show 0f6ba9ab --description-offset 12000   # 续读被窗口截断的描述
  kb show 0f6ba9ab 1c2d3e4f aa11bb22    # 多 id 摘要视图（id/标题/状态/占用者/评论数）
退出码：0 成功；1 参数错误 / 任务不存在 / 前缀不足 8 位 / 多 id 中有读取失败；2 前缀命中多张卡（会列出候选 id）
`)
    .action(async (ids: string[], opts: { markRead?: boolean; comments?: string; descriptionMaxChars?: string; descriptionOffset?: string }) => {
      commandExitCode = await show(makeCtx(program, io), ids, {
        markRead: opts.markRead === true,
        comments: parseCommentLimit(opts.comments),
        descriptionMaxChars: parseDescriptionChars('--description-max-chars', opts.descriptionMaxChars),
        descriptionOffset: parseDescriptionChars('--description-offset', opts.descriptionOffset),
      });
    });

  program
    .command('claim')
    .description('原子领取任务（409 → 已被占用，退出码 2）')
    .argument('<issue-id>', '任务 id：完整 UUID，或 ≥8 位唯一前缀')
    .option('--no-knowledge', '关闭任务知识检索')
    .option('--knowledge-query <query>', '自定义知识查询')
    .option('--comments <n|all>', '领取回执的评论渲染条数：最近 n 条（缺省 5，未读优先），all = 全量原文')
    .option('--request-id <uuid>', '幂等请求 id；重试必须复用同一 uuid')
    .addHelpText('after', `
说明：占用冲突（已被 <agent> 占用）与状态不可领取（无人占用但状态不是待规划/进行中，如待验收）是两条不同文案。
占用冲突时由占用者 kb release <issue-id> 或 done/fail 释放后再重试。
示例：
  kb claim 0f6ba9ab-996d-4af5-b0cd-d9208c44936f
  kb claim 0f6ba9ab --no-knowledge
  kb claim 0f6ba9ab --comments all      # 回执带全量评论原文
退出码：0 成功；2 已被 <agent> 占用 / 状态不可领取（当前=待验收…）/ 前置未解除（DEP-1）；1 任务不存在或参数错误
`)
    .action(async (id: string, opts: { knowledge?: boolean; knowledgeQuery?: string; requestId?: string; comments?: string }) =>
      claim(makeCtx(program, io), id, { ...opts, comments: parseCommentLimit(opts.comments) }));

  program
    .command('release')
    .description('释放占用 → 待规划（不是失败；只有当前占用者可执行；单张或 --ids-file 批量）')
    .argument('[issue-id]', '任务 id：完整 UUID，或 ≥8 位唯一前缀（与 --ids-file 二选一）')
    .option('--ids-file <path>', '批量释放：每行一个任务 id（≥8 位前缀），空行与 # 注释忽略')
    .option('--dry-run', '批量模式只打印将处理的清单，不写任何数据')
    .option('--request-id <uuid>', '幂等请求 id；批量时作为基底按 (动作, 任务) 派生，同输入重跑不重复写')
    .addHelpText('after', `
说明：与 fail（需写失败原因）不同，release 只退回待规划并清空占用，释放后他人可重新 claim。
示例：
  kb release 0f6ba9ab-996d-4af5-b0cd-d9208c44936f
  kb release 0f6ba9ab --request-id 11111111-1111-4111-8111-111111111111
  kb release --ids-file ids.txt --dry-run          # 批量：只打印清单
  kb release --ids-file ids.txt                    # 批量：逐条串行，末尾汇总
退出码：0 成功（状态 → 待规划）；2 非当前占用者 / fence 已过期 / 未被占用；1 参数错误、任务不存在、批量中有失败
`)
    .action(async (id: string | undefined, opts: { requestId?: string; idsFile?: string; dryRun?: boolean }) => {
      const ctx = makeCtx(program, io);
      if (opts.idsFile !== undefined) {
        if (id !== undefined) throw new Error('不能同时指定 <issue-id> 与 --ids-file');
        await runBulk(ctx, {
          action: 'release',
          idsFile: opts.idsFile,
          dryRun: opts.dryRun === true,
          requestId: opts.requestId,
          run: (ref, requestId) => releaseIssue(ctx, ref, { requestId }),
        });
        return;
      }
      if (id === undefined) throw new Error('缺少任务 id：给 <issue-id>，或用 --ids-file 批量');
      await release(ctx, id, { requestId: opts.requestId });
    });

  program
    .command('comment')
    .description('写评论，可附最多 5 张 PNG/JPEG/WebP 图片（agent 身份 KB_AGENT 优先，作者记为 agent:<id>）')
    .argument('<issue-id>', '任务 id：完整 UUID，或 ≥8 位唯一前缀')
    .argument('[text...]', '评论内容（多词以空格合并）')
    .option('--stdin', '从标准输入读取全部内容作为评论')
    .option('--image <path>', '附加图片文件（最多 5 次）', (value: string, previous: string[] = []) => [...previous, value], [])
    .option('--request-id <uuid>', '图片评论幂等请求 id；重试时复用')
    .action(async (id: string, text: string[] | undefined, opts: { stdin?: boolean; image?: string[]; requestId?: string }) =>
      comment(makeCtx(program, io), id, { text, stdin: opts.stdin === true, image: opts.image, requestId: opts.requestId }));

  program
    .command('accept')
    .description('给「待验收」卡写结构化验收记录：只写一条固定格式评论，不改卡片状态（关闭仍走 kb close）')
    .argument('<issue-id>', '任务 id：完整 UUID，或 ≥8 位唯一前缀')
    .option('--verdict <pass|fail>', '验收结论（必填；写进评论首行 verdict=…）')
    .option('--note <text>', '验收依据（必填；另起一行写入评论，写清对照的验收标准与观测结果）')
    .option('--reviewer <name>', '验收人（默认 KB_AGENT / kb-cli）')
    .option('--request-id <uuid>', '幂等请求 id；重试时复用，同一 id 不重复写评论')
    .action(async (id: string, opts: { verdict?: string; note?: string; reviewer?: string; requestId?: string }) =>
      accept(makeCtx(program, io), id, { verdict: opts.verdict, note: opts.note, reviewer: opts.reviewer, requestId: opts.requestId }));

  program
    .command('done')
    .description('完成任务 → 待验收（notes 落评论流）')
    .argument('<issue-id>', '任务 id：完整 UUID，或 ≥8 位唯一前缀')
    .option('--notes <text>', '完成备注（单行；多行或含 "- " 开头的行请用 --notes-stdin）')
    .option('--notes-stdin', '从标准输入读取完成备注（多行安全）')
    .option(
      '--scope <paths...>',
      '声明本任务改动的路径（文件或目录前缀）。**必须重复传参**：--scope a --scope b；逗号串在 PowerShell 下会被拆成多个参数（已兼容吞下，但不保证顺序与语义）',
      (value: string, previous: string[] = []) => [...previous, ...value.split(',').map(item => item.trim()).filter(Boolean)],
      [],
    )
    .option('--request-id <uuid>', '幂等请求 id；重试必须复用同一 uuid')
    .option('--all', '显式纳入工作区全部未提交改动（默认只提交 --scope 声明的卡内文件集，卡外改动只列清单）')
    .option('--close', 'done 成功后串行 close（待验收 → 已关闭），一步收口；close 阶段失败不回滚已完成的 done')
    .option('--close-record', 'OPT-09：一次完成收尾记录（先写 changelog，再挂 --knowledge-page 引用，最后 done；任一子步骤失败不落 done）')
    .option('--changelog-title <title>', 'CLOSE-RECORD 的变更日志标题（--close-record 时必填）')
    .option('--type <类型>', 'CLOSE-RECORD 的变更日志类型：新增|修复|调整（--close-record 时必填）')
    .option('--changelog-body <text>', 'CLOSE-RECORD 的变更日志正文（缺省复用 notes）')
    .option('--knowledge-page <id>', '已有知识页 id：只挂引用到 notes，不新建页')
    .addHelpText('after', `
示例：
  kb done 0f6ba9ab-996d-4af5-b0cd-d9208c44936f --notes '改完并跑通测试'
  kb done 0f6ba9ab --scope packages/cli/src/index.ts --scope Docs/api.md
  kb done 0f6ba9ab --notes '改完' --close        # 待验收 + 已关闭一步完成（父卡有未关闭后代时会停在待验收）
  kb done 0f6ba9ab --close-record --changelog-title '某项调整' --type 调整 --knowledge-page <页 id> --scope <路径>
退出码：0 成功（状态 → 待验收；带 --close 则 → 已关闭）；2 未被占用 / 非当前占用者 / 占用已改变 / close 阶段冲突；1 参数错误、任务不存在、close-record 子步骤失败（changelog/知识页失败时 done 未执行），或**done 已生效但自动提交未完成**（无基线 / 提交失败 / scope 零命中 / 并行占用未声明——此时状态已是待验收，按 stderr 里的补救命令执行即可）
GIT-ON-DONE：默认只提交 --scope 声明的卡内路径，卡外未提交改动一律不纳入（评论里列清单）；显式 --all 才连同卡外改动一起提交。
自动提交未完成时 stderr 输出「未提交 + 原因 + 可照抄的补救命令」；带 --close 时该场景会跳过 close（避免未提交的卡被关闭后无法用 done 补救），修复后执行 kb close <issue-id>。
非 git 工作区（未装 git / 非仓库 / 仓库损坏）只落 stderr 警告、退出码保持 0（结果状态 unavailable）。
`)
    .action(async (id: string, opts: { notes?: string; notesStdin?: boolean; scope?: string[]; all?: boolean; requestId?: string; close?: boolean; closeRecord?: boolean; changelogTitle?: string; type?: string; changelogBody?: string; knowledgePage?: string }) =>
      done(makeCtx(program, io), id, {
        notes: opts.notes, notesStdin: opts.notesStdin === true, scope: opts.scope, all: opts.all === true,
        requestId: opts.requestId, close: opts.close === true, closeRecord: opts.closeRecord === true,
        changelogTitle: opts.changelogTitle, changelogType: opts.type, changelogBody: opts.changelogBody,
        knowledgePage: opts.knowledgePage,
      }));

  program
    .command('close')
    .description('关闭任务：待验收 → 已关闭（占用者就是当前 agent 时自动释放自有占用再关；他人占用 409 不自动释放，需 kb release <issue-id> 或 done/fail 后重试）')
    .argument('[issue-id]', '任务 id：完整 UUID，或 ≥8 位唯一前缀（与 --ids-file 二选一）')
    .option('--ids-file <path>', '批量关闭：每行一个任务 id（≥8 位前缀），空行与 # 注释忽略')
    .option('--dry-run', '批量模式只打印将处理的清单，不写任何数据')
    .option('--request-id <uuid>', '幂等请求 id；批量时作为基底按 (动作, 任务) 派生，同输入重跑不重复写')
    .addHelpText('after', '\n示例：\n  kb close 0f6ba9ab-996d-4af5-b0cd-d9208c44936f\n  kb close 0f6ba9ab --request-id 11111111-1111-4111-8111-111111111111\n  kb close --ids-file ids.txt --dry-run            # 批量：只打印清单\n  kb close --ids-file ids.txt                      # 批量：逐条串行，末尾汇总\n退出码：0 成功；2 冲突（他人占用/状态不允许/未关闭后代）；1 其它错误（404 等）、批量中有失败')
    .action(async (id: string | undefined, opts: { requestId?: string; idsFile?: string; dryRun?: boolean }) => {
      const ctx = makeCtx(program, io);
      if (opts.idsFile !== undefined) {
        if (id !== undefined) throw new Error('不能同时指定 <issue-id> 与 --ids-file');
        await runBulk(ctx, {
          action: 'close',
          idsFile: opts.idsFile,
          dryRun: opts.dryRun === true,
          requestId: opts.requestId,
          // 批量层不经过 mapConflict：失败原因保留服务端原文，便于汇总
          run: async (ref, requestId) =>
            closeIssueWithOwnRelease(ctx, (await normalizeIssueRef(ctx, ref)).id, requestId),
        });
        return;
      }
      if (id === undefined) throw new Error('缺少任务 id：给 <issue-id>，或用 --ids-file 批量');
      await close(ctx, id, { requestId: opts.requestId });
    });

  program
    .command('reopen')
    .description('重开任务：已关闭/已废弃 → 指定状态（默认「待规划」）')
    .argument('<issue-id>', '任务 id：完整 UUID，或 ≥8 位唯一前缀')
    .option('--to <状态>', '目标状态名（须是本工作区已定义状态，含自定义状态）', '待规划')
    .option('--request-id <uuid>', '幂等请求 id；重试必须复用同一 uuid')
    .addHelpText('after', '\n示例：\n  kb reopen 0f6ba9ab                  # 回到「待规划」\n  kb reopen 0f6ba9ab --to 进行中\n退出码：0 成功；2 冲突（占用中/当前不是关闭态）；1 其它错误（400 目标状态非法 / 404）')
    .action(async (id: string, opts: { to?: string; requestId?: string }) => reopen(makeCtx(program, io), id, { to: opts.to, requestId: opts.requestId }));

  program
    .command('update')
    .description('修改任务字段与状态（内置流转仍优先用 claim/done/release/close/reopen/fail）')
    .argument('<issue-id>', '任务 id：完整 UUID，或 ≥8 位唯一前缀')
    .option('--title <text>', '标题')
    .option('--description <text>', '描述（短文本）')
    .option('--description-stdin', '从标准输入读取描述（长文本/多行）')
    .option('--priority <低|中|高>', '优先级')
    .option('--labels <a,b,c>', '标签（逗号分隔，整体替换）')
    .option('--due-date <YYYY-MM-DD>', '截止日期')
    .option('--due-time <HH:mm>', '截止时间（24h）')
    .option('--clear-due', '清空截止日期与时间')
    .option('--parent <issue-id>', '新父任务：完整 UUID，或 ≥8 位唯一前缀')
    .option('--clear-root', '移动为根任务（清空父任务）')
    .option('--status <状态>', '目标状态（须是本工作区已定义状态，含自定义状态与「已废弃」；占用中的卡会被 409 拒绝）')
    .option('--request-id <uuid>', '幂等请求 id；重试必须复用同一 uuid')
    .addHelpText('after', '\n示例：\n  kb update 0f6ba9ab --title "修好的标题"\n  Get-Content spec.md -Raw | kb update 0f6ba9ab --description-stdin\n  kb update 0f6ba9ab --priority 高 --due-date 2026-11-10 --due-time 14:30\n  kb update 0f6ba9ab --status 已废弃\n退出码：0 成功；2 冲突（占用中禁止修改状态，先 done/fail 释放）；1 其它错误（400 状态/字段非法并列出可用状态 / 404 任务不存在）')
    .action(async (id: string, opts: { title?: string; description?: string; descriptionStdin?: boolean; priority?: string; labels?: string; dueDate?: string; dueTime?: string; clearDue?: boolean; parent?: string; clearRoot?: boolean; status?: string; requestId?: string }) =>
      update(makeCtx(program, io), id, {
        title: opts.title, description: opts.description, descriptionStdin: opts.descriptionStdin,
        priority: opts.priority, labels: opts.labels, dueDate: opts.dueDate, dueTime: opts.dueTime,
        clearDue: opts.clearDue, parent: opts.parent, clearParent: opts.clearRoot,
        status: opts.status, requestId: opts.requestId,
      }));

  program
    .command('delete-issue')
    .description('删除任务（不可逆；占用中或含子任务会被拒；必须显式 --yes）')
    .argument('<issue-id>', '任务 id：完整 UUID，或 ≥8 位唯一前缀')
    .option('--yes', '确认删除；缺省时只打印标题/状态并以非 0 退出，不发请求')
    .addHelpText('after', `
示例：
  kb delete-issue 0f6ba9ab-996d-4af5-b0cd-d9208c44936f            # 只回显标题/状态，exit 1
  kb delete-issue 0f6ba9ab --yes                                 # 真删（不可恢复）
退出码：0 成功；1 缺 --yes（仅回显，不发请求）/ 参数错误 / 任务不存在；2 占用中 / 含子任务
`)
    .action(async (id: string, opts: { yes?: boolean }) =>
      deleteIssue(makeCtx(program, io), id, { yes: opts.yes === true }));

  program
    .command('fail')
    .description('标记失败 → 待规划（reason 落评论流；单张或 --ids-file 批量，批量共用同一 reason）')
    .argument('[issue-id]', '任务 id：完整 UUID，或 ≥8 位唯一前缀（与 --ids-file 二选一）')
    .requiredOption('--reason <text>', '失败原因（批量时写入每一张）')
    .option('--ids-file <path>', '批量标记失败：每行一个任务 id（≥8 位前缀），空行与 # 注释忽略')
    .option('--dry-run', '批量模式只打印将处理的清单，不写任何数据')
    .option('--request-id <uuid>', '幂等请求 id；批量时作为基底按 (动作, 任务) 派生，同输入重跑不重复写')
    .addHelpText('after', `
示例：
  kb fail 0f6ba9ab-996d-4af5-b0cd-d9208c44936f --reason '依赖未就绪，退回'
  kb fail --ids-file ids.txt --reason '批量退回' --dry-run
退出码：0 成功；2 非当前占用者 / fence 已过期 / 未被占用；1 参数错误、任务不存在、批量中有失败
`)
    .action(async (id: string | undefined, opts: { reason: string; requestId?: string; idsFile?: string; dryRun?: boolean }) => {
      const ctx = makeCtx(program, io);
      if (opts.idsFile !== undefined) {
        if (id !== undefined) throw new Error('不能同时指定 <issue-id> 与 --ids-file');
        await runBulk(ctx, {
          action: 'fail',
          idsFile: opts.idsFile,
          dryRun: opts.dryRun === true,
          requestId: opts.requestId,
          run: (ref, requestId) => failIssue(ctx, ref, { reason: opts.reason, requestId }),
        });
        return;
      }
      if (id === undefined) throw new Error('缺少任务 id：给 <issue-id>，或用 --ids-file 批量');
      await fail(ctx, id, { reason: opts.reason, requestId: opts.requestId });
    });

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
    .description('创建任务（workspace 支持 id 或名称，缺省按 cwd 解析；标题含引号被拒时改用 --title-stdin）')
    .argument('[workspace]', '工作空间 id 或名称（缺省按 cwd 解析；只给一个位置参数且匹配不上工作区时按标题处理）')
    .argument('[title]', '任务标题（与 --title-stdin 二选一）')
    .option('--workspace <id|名>', '工作空间 id 或名称（显式给出时优先于位置参数）')
    .option('--title-stdin', '从 UTF-8 stdin 读标题（PowerShell 引号吞参时用：Get-Content title.txt -Raw | kb create-issue <ws> --title-stdin）')
    .option('-d, --description <text>', '任务描述（必填；含空格用引号；多行走 UI 或 API）')
    .option('--allow-empty', '跳过空描述校验（批量建卡 / 纯父卡）；回执会提示已跳过空面校验')
    .option('--status <待规划|待验收>', '初始状态（默认待规划；待验收必须同时用 -d 写验收标准）')
    .option('-p, --priority <低|中|高>', '优先级')
    .option('-l, --labels <a,b,c>', '标签：逗号或空格分隔，会拆成多个标签（标签本身不含空格）')
    .option('--parent <issue-id>', '父任务 id：完整 UUID，或 ≥8 位唯一前缀')
    .option('--due <YYYY-MM-DD[THH:mm]>', '截止日期（可带时间）；不传 = 不设截止，不主动推断')
    .option('--request-id <uuid>', '幂等请求 id；重试时复用')
    .action(async (workspaceArg: string | undefined, titleArg: string | undefined, opts: { workspace?: string; titleStdin?: boolean; description?: string; allowEmpty?: boolean; status?: string; priority?: string; labels?: string; parent?: string; due?: string; requestId?: string }) =>
      createIssue(makeCtx(program, io), {
        workspace: opts.workspace ?? workspaceArg,
        // OPT-02：显式 --workspace 时，单个位置参数是标题
        title: opts.workspace !== undefined && titleArg === undefined ? workspaceArg : titleArg,
        titleStdin: opts.titleStdin,
        description: opts.description,
        allowEmpty: opts.allowEmpty,
        status: opts.status,
        priority: opts.priority,
        labels: opts.labels,
        parentIssueId: opts.parent,
        due: opts.due,
        requestId: opts.requestId,
      }));

  program
    .command('move-issue')
    .description('移动任务到父任务或恢复为根任务')
    .argument('<issue-id>', '任务 id：完整 UUID，或 ≥8 位唯一前缀')
    .option('--parent <issue-id>', '新父任务 id：完整 UUID，或 ≥8 位唯一前缀')
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

  // CLI-SWITCH：CLI 三来源账号查看与切换（默认 dry-run，--apply 才写本机配置）
  const accounts = program.command('accounts').description('CLI 三来源（DeepSeek / OpenCode-Go / Codex）账号与当前生效切换');
  accounts.command('list')
    .description('列出已登记的 CLI 账号（id / 来源 / 身份指纹 / 最近发现时间）')
    .action(async () => accountsList(makeCtx(program, io)));
  accounts.command('capabilities')
    .description('列出各来源是否支持切换及不可用原因')
    .action(async () => accountsCapabilities(makeCtx(program, io)));
  accounts.command('switch')
    .description('切换当前生效账号（默认 dry-run；--apply 才写入本机配置，失败自动回滚）')
    .argument('<account-id>', 'CLI 账号 id（完整 UUID，见 kb accounts list）')
    .option('--apply', '显式写入本机配置文件（默认只打印将写入的计划摘要）')
    .addHelpText('after', '\n示例：\n  kb accounts switch 0f6ba9ab-996d-4af5-b0cd-d9208c44936f            # dry-run\n  kb accounts switch 0f6ba9ab-996d-4af5-b0cd-d9208c44936f --apply    # 真正写入\n退出码：0 成功；2 不支持切换 / 预检阻断 / 已被占用 / 校验失败已回滚；1 参数或其它错误')
    .action(async (id: string, opts: { apply?: boolean }) =>
      accountSwitch(makeCtx(program, io), id, { apply: opts.apply === true }));

  // 依赖（DEP-2）：退出码由 commands/dep.ts 自带映射（0/2/3/4），这里只把结果码转成进程退出码
  const depRun = (run: (ctx: Ctx) => Promise<number>) => async () => {
    const code = await run(makeCtx(program, io));
    if (code !== 0) throw new CommanderError(code, 'agentboard.dep', '');
  };
  const dep = program.command('dep').description('任务依赖（前置 / 被阻塞）：ls 列出、add 建边、rm 删边');
  dep.command('ls')
    .description('列出任务的前置与被阻塞者（含状态与解除标记）')
    .argument('<issue-id>', '任务 id：完整 UUID，或 ≥8 位唯一前缀')
    .action(async (id: string) => depRun(ctx => depLs(ctx, id))());
  dep.command('add')
    .description('新增前置：blocker 解除（待验收/已关闭）后本卡才可 claim；--type 建标注边（related/duplicate 不阻塞领取）')
    .argument('<issue-id>', '被阻塞的任务 id：完整 UUID，或 ≥8 位唯一前缀')
    .argument('<blocker-id>', '前置任务 id：完整 UUID，或 ≥8 位唯一前缀')
    .option('--type <type>', '依赖类型：blocks（缺省，阻塞）| related | duplicate')
    .action(async (id: string, blockerId: string, opts: { type?: string }) => depRun(ctx => depAdd(ctx, id, blockerId, opts))());
  dep.command('rm')
    .description('移除前置')
    .argument('<issue-id>', '被阻塞的任务 id：完整 UUID，或 ≥8 位唯一前缀')
    .argument('<blocker-id>', '前置任务 id：完整 UUID，或 ≥8 位唯一前缀')
    .action(async (id: string, blockerId: string) => depRun(ctx => depRemove(ctx, id, blockerId))());

  // 状态字典（STATUS-2）：ls / add / rm --migrate-to
  const status = program.command('status').description('工作区状态字典：ls 列出、add 新增自定义状态、rm 删除并强制迁移');
  status.command('ls')
    .description('列出工作区状态（名字 / kind / 排序 / 内置或自定义；缺省按 cwd 解析工作区）')
    .argument('[workspace]', '工作空间 id 或名称（缺省按 cwd 解析）')
    .option('--workspace <id|名>', '工作空间 id 或名称（显式给出时优先于位置参数）')
    .action(async (workspaceArg: string | undefined, opts: { workspace?: string }) =>
      statusList(makeCtx(program, io), opts.workspace ?? workspaceArg));
  status.command('add')
    .description('新增自定义状态（名称在工作区内唯一；内置五状态不可复刻；缺省按 cwd 解析工作区）')
    .argument('[workspace]', '工作空间 id 或名称（缺省按 cwd 解析；只给一个位置参数时按状态名处理）')
    .argument('[name]', '状态名')
    .option('--workspace <id|名>', '工作空间 id 或名称（显式给出时优先于位置参数）')
    .option('--kind <kind>', '行为类别（默认 open）：open=未开始 / started=进行中 / review=待验收 / done=完成（关闭类）/ deprecated=废弃（关闭类，与 done 同级）/ blocked=阻塞（blocked 只给自定义状态用）')
    .option('--sort-order <n>', '排序值（默认最大值 +10）')
    .action(async (workspaceArg: string | undefined, nameArg: string | undefined, opts: { workspace?: string; kind?: string; sortOrder?: string }) => {
      const name = nameArg ?? workspaceArg;
      if (name === undefined || name.trim() === '') throw new Error('缺少状态名：kb status add [workspace] <name> --kind <kind>');
      const workspace = opts.workspace ?? (nameArg === undefined ? undefined : workspaceArg);
      await statusAdd(makeCtx(program, io), workspace, name, {
        kind: opts.kind,
        sortOrder: opts.sortOrder === undefined ? undefined : Number(opts.sortOrder),
      });
    });
  status.command('rm')
    .description('删除自定义状态；必须 --migrate-to 指定该状态下的卡迁移目标（内置状态不可删；缺省按 cwd 解析工作区）')
    .argument('[workspace]', '工作空间 id 或名称（缺省按 cwd 解析；只给一个位置参数时按状态名处理）')
    .argument('[status]', '状态名或状态 id')
    .option('--workspace <id|名>', '工作空间 id 或名称（显式给出时优先于位置参数）')
    .option('--migrate-to <name>', '该状态下的卡迁移到的目标状态名（必填）')
    .action(async (workspaceArg: string | undefined, statusArg: string | undefined, opts: { workspace?: string; migrateTo?: string }) => {
      const target = statusArg ?? workspaceArg;
      if (target === undefined || target.trim() === '') throw new Error('缺少状态名：kb status rm [workspace] <status> --migrate-to <name>');
      const workspace = opts.workspace ?? (statusArg === undefined ? undefined : workspaceArg);
      await statusRemove(makeCtx(program, io), workspace, target, { migrateTo: opts.migrateTo });
    });

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

  // STORE-2b/3b：工作区库下沉（localize）——服务端状态机的 CLI 编排（jobId 轮询模型），迁移 / 清理 / 回迁逻辑全在服务端
  const workspaceDb = program.command('workspace-db').description('工作区库下沉：把工作区数据从中心库迁到工作区目录独享库（<工作区>/.agentboard/agentboard.db）；含状态查询、半成品清理、反向回迁');
  workspaceDb.command('enable')
    .description('启用工作区库：迁移该工作区的卡/评论/会话/知识页等（默认真实迁移；--dry-run 只统计不动数据）')
    .argument('[workspace]', '工作空间 id 或名称（缺省按 cwd 解析）')
    .option('--workspace <id|名>', '工作空间 id 或名称（显式给出时优先于位置参数）')
    .option('--dry-run', '只统计将迁移的行数/附件/预计字节，不产生任何变更')
    .option('--overwrite', '目标库已存在或上次迁移未收尾时，清理后重来')
    .option('--resume', '从 localize.json 记录的中断阶段继续上次未完成的迁移（同给 --dry-run 时以 dry-run 为准；给 --resume 时忽略 --overwrite）')
    .addHelpText('after', `
示例：
  kb workspace-db enable 任务看板 --dry-run    # 预览将迁移的数据量（无任何变更）
  kb workspace-db enable 任务看板              # 真实迁移（预检→备份→…→收尾，进度逐阶段打印）
  kb workspace-db enable 任务看板 --resume     # 上次迁移中断/失败后从记录的阶段继续（开头打印「从<阶段>阶段继续」）
退出码：0 成功（含 dry-run / already_localized 幂等回显）；2 冲突（POST 409：该工作区已有迁移 / 清理 / 回迁任务在跑）；
1 失败（failed job 含 lastError，预检拒绝如目标库已存在 / 上次迁移未收尾 / 无中间态可恢复均在此列；工作区不存在；
轮询超时——超时会保留 jobId 供重查；400 参数类）
`)
    .action(async (workspaceArg: string | undefined, opts: { workspace?: string; dryRun?: boolean; overwrite?: boolean; resume?: boolean }) =>
      workspaceDbEnable(makeCtx(program, io), opts.workspace ?? workspaceArg, { dryRun: opts.dryRun === true, overwrite: opts.overwrite === true, resume: opts.resume === true }));
  workspaceDb.command('status')
    .description('工作区库状态（只读）：模式 / 写闸门 / 生效库 / 行数与附件 / 快照落后 / localize.json 中间态 / 活动任务')
    .option('--workspace <id|名>', '工作空间 id 或名称（缺省按 cwd 解析）')
    .addHelpText('after', `
紧急开关 AGENTBOARD_WORKSPACE_DB=disabled 生效且该区已下沉时，首行醒目提示需 revert 才能回中心库；failed 态末行提示 resume / cleanup。
退出码：0 查询成功（不论模式）；1 工作区不存在 / 服务不可达
`)
    .action(async (opts: { workspace?: string }) => workspaceDbStatus(makeCtx(program, io), opts.workspace));
  workspaceDb.command('cleanup')
    .description('清理失败迁移的半成品（工作区侧目标库 / 附件目录 / 残留快照 / localize.json）；中心库数据不动，db_mode 落回 center')
    .requiredOption('--workspace <id|名>', '工作空间 id 或名称')
    .addHelpText('after', `
退出码：0 清理完成；2 无可清理的半成品 / 已有任务在跑（409）；
1 清理被拒（已下沉的活库 / 工作区库是唯一数据副本——按提示先 revert）、工作区不存在、轮询超时
`)
    .action(async (opts: { workspace: string }) => workspaceDbCleanup(makeCtx(program, io), opts.workspace));
  workspaceDb.command('revert')
    .description('反向回迁：把已下沉工作区的数据拷回中心库（预检→回拷附件→回拷数据→收尾），工作区库移入 <工作区>/.agentboard/backup/')
    .requiredOption('--workspace <id|名>', '工作空间 id 或名称')
    .addHelpText('after', `
退出码：0 回迁完成；2 已有任务在跑（409）；
1 回迁被拒或失败（未下沉 / 中心库已有该区数据 / 校验失败等，中心库数据不变）、工作区不存在、轮询超时
`)
    .action(async (opts: { workspace: string }) => workspaceDbRevert(makeCtx(program, io), opts.workspace));

  // STORE-5：工作区文本快照（库为准，快照是派生物）——服务端单写者导出 / 只读校验 / 空库导入
  const snapshot = workspaceDb.command('snapshot').description('工作区文本快照：export 导出 / validate 校验 / import 导入（JSONL + manifest，可随仓库进 git）');
  snapshot.command('export')
    .description('导出工作区库文本快照到 <工作区>/.agentboard/snapshot（未下沉时从中心库按工作区导出；导出后回读自校验）')
    .argument('[workspace]', '工作空间 id 或名称（缺省按 cwd 解析）')
    .option('--workspace <id|名>', '工作空间 id 或名称（显式给出时优先于位置参数）')
    .option('--include-messages', '同时导出会话消息（messages.jsonl；默认不导出，体积大且敏感）')
    .option('--include-attachments', '同时导出附件本体到 snapshot/attachments/（默认只导清单行）')
    .addHelpText('after', `
示例：
  kb workspace-db snapshot export 任务看板
  kb workspace-db snapshot export 任务看板 --include-messages --include-attachments
退出码：0 成功；2 工作区库迁移进行中；1 其它错误
`)
    .action(async (workspaceArg: string | undefined, opts: { workspace?: string; includeMessages?: boolean; includeAttachments?: boolean }) =>
      workspaceDbSnapshotExport(makeCtx(program, io), opts.workspace ?? workspaceArg, {
        includeMessages: opts.includeMessages === true,
        includeAttachments: opts.includeAttachments === true,
      }));
  snapshot.command('validate')
    .description('校验快照：manifest 结构 + 每个文件 sha256/行数（只读，不写任何数据）')
    .argument('<workspace>', '工作空间 id 或名称')
    .option('--file <dir>', '快照目录（相对工作区根；缺省 .agentboard/snapshot）')
    .addHelpText('after', `
示例：
  kb workspace-db snapshot validate 任务看板
  kb workspace-db snapshot validate 任务看板 --file .agentboard/snapshot
退出码：0 校验通过；1 快照不可导入（哈希/行数/schema_version 不符）、工作区不存在
`)
    .action(async (workspace: string, opts: { file?: string }) =>
      workspaceDbSnapshotValidate(makeCtx(program, io), workspace, { dir: opts.file }));
  snapshot.command('import')
    .description('导入快照到工作区库：只允许空库；--replace 先 VACUUM INTO 备份再覆盖，失败整体回滚')
    .argument('<workspace>', '工作空间 id 或名称')
    .option('--file <dir>', '快照目录（相对工作区根；缺省 .agentboard/snapshot）')
    .option('--replace', '目标库非空时覆盖（服务端先备份到 .agentboard/backup/）；不加则拒绝非空库')
    .addHelpText('after', `
示例：
  kb workspace-db snapshot import 任务看板
  kb workspace-db snapshot import 任务看板 --file .agentboard/snapshot --replace
退出码：0 导入成功；2 该工作区尚未下沉 / 目标库非空且未加 --replace；1 快照不可导入（哈希/行数/外键校验失败）
`)
    .action(async (workspace: string, opts: { file?: string; replace?: boolean }) =>
      workspaceDbSnapshotImport(makeCtx(program, io), workspace, { dir: opts.file, replace: opts.replace === true }));
  // STORE-6：中心库全局快照（注册表/成员/账号元数据/公共知识；敏感引用脱敏为 ***）
  snapshot.command('center-export')
    .description('导出中心库全局快照到 <中心库同级>/center-snapshot（workspace 注册表、成员、账号/签到元数据、公共知识）')
    .addHelpText('after', `
示例：
  kb workspace-db snapshot center-export
退出码：0 成功；1 其它错误
`)
    .action(async () => workspaceDbCenterSnapshotExport(makeCtx(program, io)));
  snapshot.command('center-validate')
    .description('校验中心库快照：manifest + 每文件 sha256/行数 + 脱敏自检（只读）')
    .addHelpText('after', `
示例：
  kb workspace-db snapshot center-validate
退出码：0 校验通过；1 快照不可导入 / 脱敏自检失败
`)
    .action(async () => workspaceDbCenterSnapshotValidate(makeCtx(program, io)));

  // DEC-4：决策命令组（ask / decisions / decision / answer / stop-check）
  registerDecisionCommands(program, io, makeCtx);

  try {
    await program.parseAsync(argv);
    return commandExitCode;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    return toExit(err, io, program.opts<{ json?: boolean }>().json === true);
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
