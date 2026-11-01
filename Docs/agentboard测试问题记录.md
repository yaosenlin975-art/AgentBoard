# agentboard 测试问题记录

- 日期：2026-10-31
- 测试对象：agentboard skill（`C:\Users\31633\.agents\skills\agentboard\SKILL.md`）
- 测试目标：读取本项目未完成的 issue 并逐个完成（端到端走"领任务 → 执行 → 汇报"流程）
- 环境：Windows 10.0.26200 x64，Git Bash，工作目录 `D:\WorkSpaces\任务看板`

## 结果

第 1 步 `kb list-spaces` 即阻塞，未能列出工作空间、未领取任何 issue。服务端正常，故障全部在客户端 CLI 层。

## 问题清单

### 1. kb CLI 不存在（阻断）

- 现象：`kb list-spaces` 退出码 127，`kb: command not found`。
- 已排查项：
  - `where.exe kb` 无结果（系统 PATH 无 kb）。
  - `npm ls -g @agentboard/cli` 为空（npm 全局未安装）。
  - npm 全局 bin 目录 `C:\Users\31633\AppData\Roaming\npm` 无 kb/kb.cmd/kb.ps1。
  - `D:\tools` 不存在或为空。
- 结论：`@agentboard/cli` 未在本机安装，或已安装但 bin 目录不在 PATH。

### 2. skill 无"CLI 缺失"处理分支（skill 缺陷）

- skill 退出码约定只覆盖 1（服务未启动/请求失败）、2（任务被占用 409），错误恢复指引只写了"看板服务未启动"场景。
- 本次实际先遇到 127（命令本身不存在），skill 无对应动作指引，只能由 agent 自行排查安装。
- 前置条件"本机已安装 kb CLI"未附自检命令，无法在流程第一步快速区分"CLI 缺失"与"服务未启动"两种故障。

## 正常项

- 看板服务 `127.0.0.1:8787` 正常：HTTP 200，进程 60304 LISTENING。skill 中的服务地址约定与实际一致。

## 修复方向

1. 安装 `@agentboard/cli` 并使 bin 可达：`npm i -g @agentboard/cli`（写入 npm 全局 bin），或安装到 `D:\tools` 后把 bin 目录加入 PATH；装完用 `kb --version` 复验。
2. SKILL.md 前置条件补自检命令（如 `kb --version`），并增加"CLI 缺失 → 安装指引"分支，与现有 exit 1 / exit 2 分支并列。
3. 修复后重测入口：`kb list-spaces` → `kb list-tasks --status 待规划` → `kb claim <id>`，验证退出码 0/1/2 路径均可达。
