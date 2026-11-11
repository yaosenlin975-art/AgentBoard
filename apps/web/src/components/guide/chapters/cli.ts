/**
 * 第 11 章：进阶 · CLI 与 MCP（GUIDE-6）。
 * 命令取自 README.md「kb 命令行」与「MCP（stdio）」两节，以及 kb --help 的实际子命令。
 */
import type { GuideChapter } from '../types';

export const chapter: GuideChapter = {
  id: 'cli',
  order: 11,
  title: '进阶：CLI 与 MCP',
  intro:
    '终端和 agent 走的是同一条 REST 接口：CLI（kb）与 MCP 都只是本机薄适配器，不另存一份数据。会用界面之后，这两个入口适合批量与自动化。',
  blocks: [
    {
      kind: 'code',
      lines: ['# 确认服务与身份（默认 http://127.0.0.1:8787）', 'kb --version', 'kb list-spaces'],
    },
    {
      kind: 'steps',
      items: [
        {
          do: '先用 `kb list-spaces` 看清有哪些工作空间；服务不在默认端口时加 `--server <url>` 或设环境变量 `KB_SERVER`。',
          result: '输出 id 与名称，后续命令的 workspace 参数可以写 id 或名称。',
        },
        {
          do: '建工作空间与任务：`kb create-space <name> <path>`（path 必须已存在且是目录）、`kb create-issue <workspace> <title> -d \'<描述>\'`。',
          result: '任务创建成功会打印任务 id；长描述可以先建卡再 `kb update --description-stdin` 补。',
        },
        {
          do: '找活：`kb list-tasks [--workspace <id|名>] [--status 待规划] [--all-status]`、`kb next`、`kb stats --workspace <id>`。',
          result: '`next` 只列「待规划 · 无占用 · 前置全部解除」的卡且不自动领取；`stats` 给五状态计数、未完成无主与被阻塞数。',
        },
        {
          do: '领取并记录：`kb claim <issue-id>`，被占用时退出码是 2；用 `kb show <issue-id>` 读全字段，用 `kb comment <issue-id> "内容"` 追加评论（长文用 `--stdin`）。',
          result: '写操作的审计身份取环境变量 `KB_AGENT`，未设时默认 `kb-cli`。',
        },
        {
          do: '收尾：`kb accept <issue-id>` 只给待验收卡写结构化验收记录、不改状态；`kb done <issue-id> --notes "..."` 把卡推进到待验收；`kb close <issue-id>` 再关闭；失败则 `kb fail <issue-id> --reason "..."` 退回待规划。',
          result: '`done` 会自动提交未暂存改动，失败时退出码 1 并给出补救命令；`close` 遇到他人占用返回 409，需先 `kb release` 或走 done/fail。',
        },
        {
          do: '接 MCP：构建后运行 `corepack pnpm --filter @agentboard/mcp list-tools` 查看真实工具清单（会拉起 stdio 服务走 initialize + tools/list）。',
          result: 'MCP 只经 `http://127.0.0.1:8787/api` 调 REST，不直连数据库、不启动服务。',
        },
        {
          do: '给 MCP 配写工具身份：设置环境变量 `AGENTBOARD_AGENT_ID`。',
          result: '缺失时写工具直接返回 `AGENT_ID_REQUIRED`；错误一律按 `error.code` 判断，不按文案语言判断（中英混排）。',
        },
      ],
    },
    {
      kind: 'code',
      lines: [
        '# 常见闭环',
        'kb next --workspace 任务看板',
        'kb claim <issue-id>',
        'kb comment <issue-id> "开始处理"',
        'kb done <issue-id> --notes "已完成，构建通过"',
        'kb close <issue-id>',
      ],
    },
    {
      kind: 'note',
      tone: 'info',
      text: 'MCP 只暴露任务板与共享知识，不提供会话执行、任意终端/文件读写、账号凭据、桌面切换与工作区创建/删除——这些仍然只能在界面或 CLI 做。',
    },
    {
      kind: 'note',
      tone: 'warn',
      text: 'CLI 与 MCP 改动和界面看到的是同一份数据：命令行 claim 之后卡片会立即显示占用，不要在两边同时改同一张卡。',
    },
  ],
};
