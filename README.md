# AgentBoard

本地任务看板：人管理任务流转（待规划 → 进行中 → 待验收 → 已关闭），codebuddy / codex / opencode / dsh 四家 CLI agent 经统一适配层无头执行任务。带占用锁（一任务一占用者）、评论唤醒、聊天会话与 `kb` 命令行。

## 前置要求

- Node.js ≥ 20
- pnpm（经 corepack：`corepack enable`）
- 可选：四家 CLI agent（codebuddy / codex / opencode / dsh）；未安装的项在看板中标"未安装"禁用

## 启动

```bash
corepack pnpm install
corepack pnpm -r build
node apps/server/dist/index.js
```

打开 http://127.0.0.1:8787 （web 已随 server 静态托管；未构建 web 时仅 API 可用）。

- **重启/拉起服务统一用 `pnpm server:ensure`**（= `node scripts/server-detached.mjs`）：探活 `/api/version`，健康则复用不重启进程，未监听则后台拉起并轮询到健康（≤30s），日志追加到 `.logs/server.log`。退出码 0 健康／1 拉起失败／2 端口被非看板服务占用／3 dist 缺失。不要手工 `Stop-Process` + `start /b`（停止成功而启动失败会留下无人监听且无日志的空窗）。
- 数据库默认 `%APPDATA%\AgentBoard\agentboard.db`，配置 `config.json` 同目录。生效顺序：`AGENTBOARD_DB`（env）→ `config.json` 的 `dbPath`（设置项 / `PATCH /api/settings` 的 `db_path`）→ 默认路径；启动首行日志会打印实际生效路径与 `db_source=<env|settings|default>`，附件目录恒为 `dirname(db)/attachments` 自动跟随。
- 环境变量覆盖：`AGENTBOARD_PORT`、`AGENTBOARD_DB`、`AGENTBOARD_HOST`（监听地址，缺省 `127.0.0.1`；容器里设 `0.0.0.0`，非法值启动即报错）。
- 附件目录无需单独配置：恒为 DB 文件所在目录下的 `attachments`（本机即 `%APPDATA%\AgentBoard\attachments`）。

### Docker（单容器）

```bash
docker build -t agentboard:local .
docker run -d --name agentboard --restart unless-stopped -p 8788:8787 -v agentboard-data:/data agentboard:local
curl -fsS http://127.0.0.1:8788/api/version
```

宿主 8787 常被本机服务占用，容器冒烟请用别的宿主端口（上例 `8788`）。DB 与附件都在 `/data` 一个卷里；
bind mount 变体、冒烟 6 步、回滚与未证实项见 `Docs/decisions/2026-11-03-docker.md`。

镜像自带 `kb`（`/usr/local/bin/kb`，默认 `KB_SERVER=http://127.0.0.1:8787` 指向同容器的 server），容器内可直接操作看板：

```bash
docker run --rm agentboard:local kb --version
docker exec agentboard kb list-spaces
docker exec -e KB_AGENT=cagent agentboard kb create-issue docker-cli-ws 'container kb smoke'
```

镜像内没有 git，`kb done` 会提示「跳过自动提交：环境未安装 git（GIT_NOT_INSTALLED）」（与「工作区不是 git 仓库（NOT_A_GIT_REPO）」分开报；自动提交仍需宿主执行或另装 git）。

### 后台常驻（Windows）

前台 `node apps/server/dist/index.js` 关终端即停。当前会话后台运行：

```bat
start /b node apps\server\dist\index.js
```

推荐用 CLI 配置开机自启与桌面快捷方式（先 `corepack pnpm -r build`；无需管理员权限）：

```bat
node packages\cli\dist\index.js autostart install
node packages\cli\dist\index.js shortcut create
```

- `autostart install` 写 HKCU Run 键（`wscript.exe ...\scripts\agentboard.vbs autostart`，登录即隐藏拉起服务，无闪窗），并把 node 路径/仓库/端口/日志写进 vbs 顶部常量区；日志在 `%APPDATA%\AgentBoard\logs\server.log`。
- `autostart status` 查看自启安装状态、服务可达性与日志路径；`autostart uninstall` 仅删自家 Run 键值（vbs 文件保留）。
- `shortcut create` 在桌面建 `AgentBoard.lnk`（图标 `apps\web\public\agentboard.ico`；双击时服务未起会先隐藏拉起再打开默认浏览器），需先 `autostart install` 配置 vbs；`shortcut remove` 移除。
- **改端口后需重新执行 `autostart install`**（端口写死在 vbs 常量区；重复 install 会刷新）。
- **安装后请勿卸载**：Run 键、`scripts\agentboard.vbs`（已配置状态）与桌面 lnk 是自启的组成部分，卸载任一环开机即不自启。
- 排障：`reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v AgentBoard` 看 Run 键是否在（无输出 = 未安装，重跑 `autostart install`）；启动错误看 `%APPDATA%\AgentBoard\logs\autostart.log`（记录时间戳/模式/Err.Number/Err.Description）；服务运行日志看 `%APPDATA%\AgentBoard\logs\server.log`。

备选：开机自启用计划任务（schtasks 无工作目录参数，用 `cd /d` 内嵌；需管理员权限执行，`node` 需在系统 PATH，否则换成 `where node` 查到的完整路径）：

```bat
schtasks /create /tn AgentBoard /sc onstart /tr "cmd /c cd /d D:\WorkSpaces\任务看板 && node apps\server\dist\index.js"
```

**MSYS/Git Bash 注意**

- curl 内联 JSON 带 Windows 路径（如 `-d '{"path":"D:\\WorkSpaces\\REA"}'`）报 `INVALID_JSON`：agent/脚本经 `bash -c` 调起 Git Bash 时 MSYS 先把 `\\` 折成 `\`，用 `echo` 写请求体文件同样中招。

  正确写法：Python `json.dumps` 生成请求体文件（路径用 raw 字符串写单反斜杠），`--data-binary @文件` 发送：

  ```bash
  python -c "import json;print(json.dumps({'name':'REA','path':r'D:\WorkSpaces\REA'}))" > body.json
  curl -X POST -H "Content-Type: application/json" --data-binary @body.json http://127.0.0.1:8787/api/workspaces
  ```

- 后台启动接管道（如 `node apps/server/dist/index.js | head -20 &`）：输出被管道缓冲看不到，`head` 退出后服务随 SIGPIPE 退出、8787 不再监听；管道下 AgentBoard 会话后台流同样会挂。

  正确写法：后台启动不接管道，日志重定向到文件（PowerShell 的 stdout/stderr 须分两个文件）：

  ```bash
  node apps/server/dist/index.js > server.log 2>&1 &
  ```

  ```powershell
  Start-Process node -ArgumentList 'apps\server\dist\index.js' -RedirectStandardOutput server.log -RedirectStandardError server.err.log -WindowStyle Hidden
  ```

### 与 DSH 任务看板插件的边界

- AgentBoard（默认 `http://127.0.0.1:8787`，SQLite `%APPDATA%\AgentBoard\agentboard.db`）与 DSH 桌面端插件 @linxin666/dsh-client-ui-task-board（读写 `~/.dsh/task-board/ledger-v2.json`，经 DSH web server + `DSH_TASK_BOARD_PROXY_TOKEN` 鉴权暴露）是两套独立服务与数据源。
- DSH 端口在监听 ≠ 看板服务已启动：`kb --server http://127.0.0.1:<DSH端口> list-spaces` 对着 DSH web server 报 unauthorized（HTTP 401），不是 AgentBoard 的鉴权问题。
- 两边任务互不可见；同步需额外桥接，暂未实现。

## kb 命令行

agent 或脚本经 `kb` 与看板交互：

```bash
corepack pnpm --filter @agentboard/cli build
cd packages/cli && npm link   # 或直接 node packages/cli/dist/index.js <命令>
```

```bash
kb create-space <name> <path>        # 创建工作空间；path 必须已存在且是目录
kb create-issue <workspace> <title>  # 创建任务；workspace 用 id 或名称
kb list-spaces
kb list-tasks [--workspace <id|名>] [--status 待规划]
kb show <issue-id>
kb claim <issue-id>                # 原子领取；已被占用退出码 2
kb comment <issue-id> "内容"       # 长文/中文用 --stdin
kb done <issue-id> --notes "..."   # 完成 → 待验收
kb fail <issue-id> --reason "..."  # 失败 → 待规划
```

- 服务地址：`--server <url>` 或环境变量 `KB_SERVER`（默认 `http://127.0.0.1:8787`）。
- agent 身份：环境变量 `KB_AGENT=<名字>`；未设 KB_AGENT 时默认 kb-cli，agent 评论不触发唤醒。
- 版本：`kb --version` 输出 CLI 包版本；服务端所有 `/api` 响应带 `x-agentboard-version` 头并暴露 `GET /api/version`。CLI 每次请求比对响应头，major 不同、双方 0.x 且 minor 不同或服务端未上报版本时在 stderr 警告一次（仅警告不阻断，patch 差异不警告）。

## Skill（agent 自助领任务）

把 `skills/agentboard/` 目录复制或链接到 agent 生态的 skills 目录（如 `~/.agents/skills/agentboard`），或随工作空间提供。SKILL.md 定义领取 → 执行（以 `kb show` 实时拉取为准）→ `kb comment` 汇报 → `kb done`/`kb fail` 收尾的完整流程与占用规则。

## 文档

- `Docs/设计文档.md`：需求、方案、接口、UI 布局
- `Docs/api.md`：REST + WebSocket 完整接口参考（端点、请求/响应字段、错误码、WS 事件、枚举；启动与 env 见上文「启动」节）
- `Docs/DESIGNS.md`：落地架构与数据流
- `Docs/CHANGELOG.md`：变更记录
- `Docs/PENDING_TESTS.md`：人工验收清单
