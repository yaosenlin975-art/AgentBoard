# AgentBoard

本地任务看板：人管理任务流转（待规划 → 进行中 → 待验收 → 已关闭），codebuddy / codex / opencode / dsh 四家 CLI agent 经统一适配层无头执行任务。带占用锁（一任务一占用者）、评论唤醒、聊天会话与 `kb` 命令行。

## 前置要求

- Node.js ≥ 20
- pnpm（经 corepack：`corepack enable`）
- 可选：四家 CLI agent（codebuddy / codex / opencode / dsh）；未安装的项在看板中标"未安装"禁用

## 安装与使用总览（Windows / macOS / Docker）

三种运行形态：Windows 宿主（已实测）、macOS 宿主（未实测）、Docker 单容器（Windows 11 + Docker Desktop 实测 linux/amd64 镜像，Apple Silicon 未实测）。服务默认 `127.0.0.1:8787`。

### 安装

| 形态 | 安装 | 说明 |
| --- | --- | --- |
| Windows 宿主 | `corepack pnpm install` → `corepack pnpm -r build` → `pnpm server:ensure` | 详见下文「启动」「后台常驻（Windows）」；免 Node 环境用便携包，见「便携包（Windows x64）」 |
| macOS 宿主 | 同上（纯 Node 实现，未实测） | 见下文「macOS 宿主（未实测）」 |
| Docker | `docker build` + `docker run` | 详见下文「Docker（单容器）」；镜像自带 `kb` |

### 把 skills 放到哪里

8 个 agent 技能在仓库 `skills/` 下：`using-agentboard` / `writing-task` / `executing-task` / `handoff` / `swing-dev` / `ask-user` / `brainstorming` / `kb-curator`（详见下文「Skill（agent 自助领任务）」节）。

| 形态 | 放哪 | 说明 |
| --- | --- | --- |
| Windows / macOS 宿主 | 复制或软链 `skills/<技能名>/` 到 agent 生态的 skills 目录（如 `~/.agents/skills/using-agentboard`），或随工作空间提供 | macOS 用 `ln -s`，Windows 用 `mklink /J`；或设 `AGENTBOARD_SKILL_ROOT` |
| Docker | 镜像内没有（`.dockerignore` 排除了 `skills/`） | 运行时挂载或宿主 agent 直连，见「Docker（单容器）」节 |
| Windows 便携包 | 包内 `app/rules/` | 8 技能齐全自检（`check-rules.cmd`），仅 Windows x64 包 |

### 使用入口

| 形态 | 服务地址 | 使用方式 |
| --- | --- | --- |
| Windows / macOS 宿主 | `http://127.0.0.1:8787` | 浏览器开 web；agent 经 `kb` 命令行 / MCP / Skill 交互，见下文各节 |
| Docker（容器内 agent） | `http://127.0.0.1:8787`（同容器） | `docker exec agentboard kb ...`；无桌面会话，容器内 agent 派发/进程启停/autostart/shortcut 不支持 |
| Docker（宿主 agent 直连容器） | `http://127.0.0.1:<宿主映射端口>` | `KB_SERVER` 或 `kb --server` 指向容器，见「Docker（单容器）」节 |

### macOS 宿主（未实测）

前置依赖（Xcode CLT / rustup + apple target / Node ≥20 / pnpm 11.18.0）与「独立 Node 无 corepack」的安装口径见 [Docs/macos-build.md](Docs/macos-build.md)，本节命令与该文档一致。

安装/构建/启动命令与 Windows 同款：

```bash
corepack pnpm install
corepack pnpm -r build
pnpm server:ensure   # = node scripts/server-detached.mjs，纯 Node 实现，未在 macOS 实测
```

DB 默认路径在非 Windows 回退 `~/.config/AgentBoard/agentboard.db`，附件自动派生为同目录 `attachments`。后台常驻：

```bash
nohup node apps/server/dist/index.js > server.log 2>&1 &
```

`kb autostart` 已支持 macOS（写 `~/Library/LaunchAgents/com.agentboard.server.plist` 并 `launchctl bootstrap`，见下文「macOS 开机自启」）；`kb shortcut` 仍是 Windows-only。macOS 也可临时用上面的 nohup。已知缺口（均属「暂时不支持」清单）：账号凭据 vault 走 Windows DPAPI，非 Windows 一律 503，账号相关功能（凭据捕获/切换/签到）不可用，服务本体可正常启动；WorkBuddy 桌面探针（user32/UIA）不可用；MiniMax 客户端探测走注册表/盘符不可用。

### 桌面壳打包与分发（macOS）

桌面壳是 Tauri v2 工程（`desktop/src-tauri`），macOS 打包统一走 `scripts/desktop/build-macos.mjs`。先明确手上产物属于哪条路径：

| 路径 | 用途 | 凭据 | 产物能给别人吗 |
| --- | --- | --- | --- |
| 本机自用（未签名） | 自己这台 Mac 上用 | 不需要 | 不能：外部分发会被 Gatekeeper 拦 |
| 外部分发（Developer ID + 公证） | 发给别人 / 公开下载 | `APPLE_SIGNING_IDENTITY` + 公证凭据 | 能：签名 + notarize + staple 后 `spctl` 判 accepted |

**本机自用（未签名）**

```bash
node scripts/desktop/build-macos.mjs --dry-run   # 任意平台可跑：只核查并打印计划，不构建
node scripts/desktop/build-macos.mjs             # 仅 macOS：构建 → 尝试签名/公证（无凭据则跳过）
```

- 不设任何 Apple 凭据时脚本会 skip 签名与公证，产物是未签名 `.app` / `.dmg`。**本机构建、本机安装没有 quarantine 属性，可直接运行**；Gatekeeper 拦截只发生在「下载来的文件」场景，所以这条路径不能用于外部分发。
- 产物位置：`desktop/src-tauri/target/<rust-target>/release/bundle/macos/AgentBoard.app` 与 `.../bundle/dmg/*.dmg`（`<rust-target>` 为 `aarch64-apple-darwin` / `x86_64-apple-darwin`）。
- 只要 `.app`/`.dmg` 但不想走公证时用 `--no-notarize`（dmg 仍会构建；有签名身份时签名照常）。

**外部分发（Developer ID 签名 + notarytool 公证）**

前置：Apple Developer Program 账号，钥匙串里有 `Developer ID Application: <你的名字> (<TEAMID>)` 证书。

```bash
# 1) 签名身份（脚本在 bundle 完成后用它 codesign --force 重签，并加 hardened runtime）
export APPLE_SIGNING_IDENTITY='Developer ID Application: Your Name (TEAMID)'

# 2) 公证凭据：二选一
export APPLE_ID='you@example.com'
export APPLE_TEAM_ID='TEAMID'
export APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx'   # appleid.apple.com 生成的 App 专用密码

# 或者 API Key 三件套（CI 推荐）
export APPLE_API_KEY='/path/to/AuthKey_XXXX.p8'
export APPLE_API_KEY_ID='XXXXXXXXXX'
export APPLE_API_ISSUER='xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'

# 3) 构建 + 签名 + 公证 + staple（脚本内依次执行）
node scripts/desktop/build-macos.mjs --arch universal
```

脚本实际执行的动作（与代码逐条对应）：

1. `pnpm --dir desktop exec tauri build --bundles app,dmg --target <target>`（`--arch arm64|x64|universal`；universal 会按 `aarch64-apple-darwin` + `x86_64-apple-darwin` 各跑一次）；
2. `codesign --force --deep --options runtime --sign <APPLE_SIGNING_IDENTITY> AgentBoard.app`（存在 `desktop/src-tauri/entitlements.plist` 时附带 `--entitlements`）；
3. `xcrun notarytool submit <dmg> --wait` + `xcrun stapler staple <dmg>`（凭据取上面的 Apple ID 三件套或 API Key 三件套；都没有则跳过公证并打 `SKIP`）。

**判定产物属于哪条路径**（在 mac 上可复算）：

```bash
codesign --verify --deep --strict --verbose=2 AgentBoard.app
# 已签名：AgentBoard.app: valid on disk / satisfies its Designated Requirement
# 未签名：code object is not signed at all

spctl -a -vv AgentBoard.app
# 已签名+公证：accepted / source=Notarized Developer ID
# 未签名或被拦：rejected

xcrun stapler validate AgentBoard_*.dmg
# 已 staple：The validate action worked!
# 未 staple：does not have a ticket stapled or stapling check failed
```

退出码：`0` 成功 / `1` 前置缺失或步骤失败 / `2` 非 darwin 且未加 `--dry-run`。`--json` 输出机器可读步骤报告。

**macOS 开机自启**

```bash
kb autostart install     # 写 ~/Library/LaunchAgents/com.agentboard.server.plist 并 launchctl bootstrap gui/<uid>
kb autostart status      # plist/加载状态 + 服务可达性 + 日志路径
kb autostart uninstall   # launchctl bootout 后删除 plist
```

端口取自 `~/.config/AgentBoard/config.json`（缺失回 8787），日志在 `~/.config/AgentBoard/logs/server.log`；前置是 `apps/server/dist` 已构建。`kb shortcut` 仍只支持 Windows。

## 启动

```bash
corepack pnpm install
corepack pnpm -r build
node apps/server/dist/index.js
```

打开 http://127.0.0.1:8787 （web 已随 server 静态托管；未构建 web 时仅 API 可用）。

- **重启/拉起服务统一用 `pnpm server:ensure`**（= `node scripts/server-detached.mjs`）：探活 `/api/version`，健康则复用不重启进程，未监听则后台拉起并轮询到健康（≤30s），日志追加到 `.logs/server.log`。退出码 0 健康／1 拉起失败／2 端口被非看板服务占用／3 dist 缺失／4 已健康但需重启（dist 早于源码，或运行进程早于 dist／未上报 `started_at`）。不要手工 `Stop-Process` + `start /b`（停止成功而启动失败会留下无人监听且无日志的空窗）。
- **产物陈旧自检用 `pnpm check:stale`**（= `node scripts/check-stale.mjs`）：跑 5 条 `--help` 冒烟（`kb` / `knowledge` / `create-issue` / `dep` / `list-spaces`），并比对各包 `dist` 与 `src` 的 mtime；产物缺失/陈旧时 exit 1 并打印重建命令（`pnpm -r build` 或单包 `pnpm --filter <包名> build`）。
- 中心库默认 `%APPDATA%\AgentBoard\agentboard.db`（界面与文档称「中心库路径」）；工作区库在 `<workspace>/.agentboard/agentboard.db`，用 `kb workspace-db enable` 开启后才存在，未开启时该工作区数据仍在中心库。配置 `config.json` 与中心库同目录。生效顺序：`AGENTBOARD_DB`（env）→ `config.json` 的 `dbPath`（设置项 / `PATCH /api/settings` 的 `db_path`，字段名不变）→ 默认路径；启动首行日志会打印实际生效路径与 `db_source=<env|settings|default>`，附件目录恒为 `dirname(db)/attachments` 自动跟随。
- 环境变量覆盖：`AGENTBOARD_PORT`、`AGENTBOARD_DB`、`AGENTBOARD_HOST`（监听地址，缺省 `127.0.0.1`；容器里设 `0.0.0.0`，非法值启动即报错）。
- 附件目录无需单独配置：恒为 DB 文件所在目录下的 `attachments`（本机即 `%APPDATA%\AgentBoard\attachments`）。

### 快照进 git 与 clone 后恢复（STORE-5/6）

数据形态是「库为准、快照是派生物」：`.agentboard/` 目录可随仓库进 git，运行态数据库与附件本体不进。

```bash
kb workspace-db snapshot export <工作区> --include-attachments   # 服务端单写者导出，写完回读自校验
kb workspace-db snapshot validate <工作区>                        # 只读校验：manifest + 每文件 sha256/行数 + 附件
kb workspace-db snapshot import <工作区>                          # 只允许空工作区库
kb workspace-db snapshot export <工作区> --include-messages        # 需要会话正文时显式打开
```

导出会同时落 `<工作区>/.agentboard/.gitignore`（排除 `*.db` / `-wal` / `-shm` / `localize.json` / `attachments/`）与 `.agentboard/README.md`（事实源与恢复命令），内容不变不重写；根 `.gitignore` 已有 `*.db`，不要加反向规则。

clone 后取回数据与图片：

1. `kb workspace-db enable <工作区>`（或对已存在的空工作区库直接 `import`）；
2. `kb workspace-db snapshot import <工作区> --replace` 导入行集，`--include-attachments` 导出的快照会把附件本体还原到 `<工作区>/.agentboard/attachments/<storage_key>`，图片接口即可 200；缺文件时 import 直接 422 `SNAPSHOT_ATTACHMENT_MISSING` 并列出 storage_key，不做「尽量导入」；
3. 快照里没有附件本体（未加 `--include-attachments`）时，行在而文件不在，图片仍是 404 —— 需要图片就重新带开关导出/导入。

中心库（注册表、成员、账号元数据、公共知识页）另有一套只读快照：`kb workspace-db snapshot center-export` / `center-validate`，落在中心库同级的 `center-snapshot/`，账号凭据引用一律脱敏为 `***`，不提供导入。

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

**容器里没有 skills**：`.dockerignore` 排除了 `skills/`，镜像内无技能目录。两种解法：

a) 运行时挂载宿主 skills 目录，给容器内 agent 设技能根：

```bash
docker run -d --name agentboard --restart unless-stopped -p 8788:8787 -v agentboard-data:/data \
  -v ./skills:/app/skills:ro -e AGENTBOARD_SKILL_ROOT=/app/skills agentboard:local
```

`AGENTBOARD_SKILL_ROOT` 是技能权威解析第一优先级环境变量，可指向技能根或 SKILL.md 全路径。

b) agent 留在宿主机跑，只把 `KB_SERVER=http://127.0.0.1:<宿主映射端口>` 指向容器。

**宿主 agent 直连容器**：`KB_SERVER` 环境变量或 `kb --server <url>`（见「kb 命令行」节），指向宿主映射端口即可；容器内无桌面会话，agent 派发/进程启停/autostart/shortcut 不支持。

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

## 便携包（Windows x64）

对外打包固定入口，产物 = 可运行单机包 + 配套工作流规则，对方机器无需安装 Node：

```bash
pnpm package:portable                                  # 默认出 AgentBoard-win-x64-<HEAD>.zip
node scripts/package-portable.mjs --skip-build --no-zip  # 只重组装、不构建、不打 zip（验证用）
```

- 固定携带到包内 `app\rules\`：`AGENTS.md`、`README.md`、`Docs/api.md` 与 8 个技能（`using-agentboard` / `writing-task` / `executing-task` / `handoff` / `swing-dev` / `ask-user` / `brainstorming` / `kb-curator`）。
- 技能来源：仓库 `skills/` 优先；缺失项从 `%USERPROFILE%\.agents\skills` 取（外部路径不受 git 跟踪），来源逐条写入 `app/rules-manifest.json`。禁用 `AGENTBOARD_SKILLS_SRC` 可改外部技能根。
- 包内自检：`app/rules-manifest.json` 记录文件清单与 sha256；解压后跑 `check-rules.cmd`（或 `runtime\node.exe app\verify-rules.mjs`），校验完整性、8 个技能与 `kb --help` 可用性，失败退出码 1。
- 不打包：`node_modules`（仅保留 better-sqlite3 / bindings / file-uri-to-path / sherpa 原生依赖）、测试文件、`.logs`、`Temp`、`Docs` 草稿、`.git`。
- 冒烟用独立端口，不动 8787 生产实例。

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
kb create-issue <workspace> <title> -d '<描述>'  # 创建任务；workspace 用 id 或名称，描述必填（长描述先建卡再 kb update --description-stdin）
kb list-spaces
kb list-tasks [--workspace <id|名>] [--status 待规划] [--all-status]  # 缺省只列未完成无主卡
kb next [--workspace <id|名>]      # 下一张可领取的卡
kb stats --workspace <id>          # 五状态计数 + 未完成无主 + 被阻塞（收尾复算用）
kb show <issue-id> [--mark-read]
kb claim <issue-id>                # 原子领取；已被占用退出码 2
kb comment <issue-id> "内容"       # 长文/中文用 --stdin
kb accept <issue-id>               # 待验收卡写结构化验收记录（不改状态）
kb done <issue-id> --notes "..."   # 完成 → 待验收；自动提交未完成时 exit 1 并附补救命令（非 git 仓库只警告、exit 0）
kb fail <issue-id> --reason "..."  # 失败 → 待规划
```

- 服务地址：`--server <url>` 或环境变量 `KB_SERVER`（默认 `http://127.0.0.1:8787`）。
- agent 身份：环境变量 `KB_AGENT=<名字>`；未设 KB_AGENT 时默认 kb-cli，agent 评论不触发唤醒。
- 版本：`kb --version` 输出 CLI 包版本；服务端所有 `/api` 响应带 `x-agentboard-version` 头并暴露 `GET /api/version`。CLI 每次请求比对响应头，major 不同、双方 0.x 且 minor 不同或服务端未上报版本时在 stderr 警告一次（仅警告不阻断，patch 差异不警告）。

## MCP（stdio，给 Codex / DSH / WorkBuddy 等客户端）

`apps/mcp` 是本机 stdio MCP 服务，作为看板与共享知识库的薄适配器：只经 `http://127.0.0.1:8787/api` 调现有 REST，不直连数据库、不复制业务逻辑、不启动服务。协议版本、契约、错误码与分页/截断规则见 [统一 MCP 设计](Docs/designs/infra/2026-11-01-unified-mcp.md)。

构建并现场查看真实工具清单（会拉起 `apps/mcp/dist/index.js` 走 initialize + tools/list，不维护静态清单）：

```bash
corepack pnpm --filter @agentboard/mcp build
corepack pnpm --filter @agentboard/mcp list-tools          # 人读表格
corepack pnpm --filter @agentboard/mcp list-tools --json   # 机器可读
```

工具总数以 `list-tools` 的实时输出为准，本文不写死数量：它输出当前主名清单，并额外标注每个主名对应的 `agentboard_*` 兼容 alias（`tools/list` 条目数因此约为主名的两倍）。alias 用于兼容旧客户端，计划在下个大版本移除（卡 `f78d7465`），届时应同步跑一次 `list-tools` 核对。

环境变量：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `AGENTBOARD_BASE_URL` | 否 | 看板服务基址，默认 `http://127.0.0.1:8787`；仅接受 loopback HTTP origin，带路径、凭据或远程主机启动即报 `INVALID_CONFIG`。 |
| `AGENTBOARD_WORKSPACE_ID` | 否 | 进程级工作区绑定：项目类工具省略 `workspace_id` 时使用它；显式传不同 id 返回 `WORKSPACE_BOUND`。未绑定时项目类工具必须显式传 `workspace_id`。 |
| `AGENTBOARD_AGENT_ID` | 写工具必填 | claim / 评论 / 完成等写操作的审计标签（自报，不是鉴权）；缺失时写工具返回 `AGENT_ID_REQUIRED`。 |

客户端 `mcpServers` 配置样例（路径与工作区 id 换成你自己的）：

```json
{
  "mcpServers": {
    "agentboard": {
      "command": "node",
      "args": ["D:/WorkSpaces/任务看板/apps/mcp/dist/index.js"],
      "env": {
        "AGENTBOARD_BASE_URL": "http://127.0.0.1:8787",
        "AGENTBOARD_WORKSPACE_ID": "e41eb0fb-c367-43cf-a99d-6dc5239a5694",
        "AGENTBOARD_AGENT_ID": "codex"
      }
    }
  }
}
```

工具面按域分组，只列主名并标注读/写；完整清单（含 alias 与 read-only 标记）以 `list-tools` 输出为准，新增工具会先出现在输出里。实测口径（2026-11-10 修订）：

- **`request_id`**：写工具（如 `create_task`）必传 uuid 幂等键，缺失直接校验失败；**例外**是 `delete_task`、`remove_dependency`——它们是 DELETE 语义、没有幂等键，传了反而报错，不要给这两个工具补 `request_id`。
- **返回结构**：业务数据在 `structuredContent.data`（`content` 只有一句状态文案，从 text 抽不到 id）。
- **错误文案语言**：MCP 侧**中英混排**（实测）——`DECISION_HUMAN_ONLY` / `DECISION_LOCKED` 的 message 与 CLI 同为中文；`ISSUE_CLAIMED` 与 zod 参数校验（`request_id` / `task_id` 等）为英文。同一业务错误语义与 CLI 一致、措辞可能不同，**一律按 `error.code` 匹配，不按语言或文案判断**（zod 校验错误没有业务 code，按 message 关键字兜底）。

工具清单（按域分组）：

- 工作区与任务：读 `list_workspaces`、`list_tasks`（可列平铺或一层任务树）、`get_task`、`get_task_comments`、`get_task_comment`；写 `create_task`、`update_task`、`claim_task`、`release_task`、`add_task_comment`、`complete_task`、`fail_task`、`delete_task`、`close_task`、`reopen_task`、`accept_task`
- 依赖：读 `list_dependencies`；写 `add_dependency`、`remove_dependency`
- 状态字典：读 `list_statuses`；写 `add_status`、`remove_status`
- 知识库：读 `search_knowledge`、`list_knowledge`、`find_knowledge_sources`、`read_knowledge`；写 `create_knowledge`、`revise_knowledge`、`archive_knowledge`、`restore_knowledge`
- 待决策：读 `list_decisions`、`get_decision`、`stop_check`；写 `ask_decision`、`answer_decision`、`extend_decision_grace`、`withdraw_decision`
- 变更日志：读 `list_changelog`、`get_changelog`；写 `create_changelog`
- 收尾门禁：`complete_task` 前须满足三者之一——① `create_changelog` 传 `issue_id=<本任务>` 先写本卡日志；② `complete_task` 传 `changelog_id=<本工作区已有日志>`；③ 本次确实没有用户可见变更时传 `skip_changelog: true`。都不满足时服务端返回 400 `CHANGELOG_ACK_REQUIRED`（任务状态不变）

边界与缺口：MCP 只暴露任务板与共享知识，不提供会话执行、任意终端/文件读写、账号/凭据、桌面切换、工作区创建/删除；评论图片仍走 UI/CLI。原裁决要补的收口（close/reopen/accept）、变更日志、待决策读取/答复/宽限、知识 list/find-source 已全部落地（卡 `f504f61d`、`6a2ded57`、`64acde61`、`d6753e4c`、`4e009883`）；账号、工作区治理、grep、评论附件、知识 delete/import 明确不补。

## Skill（agent 自助领任务）

8 个 agent 技能在仓库 `skills/` 下：`using-agentboard` / `writing-task` / `executing-task` / `handoff` / `swing-dev` / `ask-user` / `brainstorming` / `kb-curator`。放置方式按运行形态：

| 形态 | 放哪 | 说明 |
| --- | --- | --- |
| Windows / macOS 宿主 | 把仓库 `skills/<技能名>/` 复制或软链到 agent 生态的 skills 目录（如 `~/.agents/skills/using-agentboard`），或随工作空间提供 | macOS 用 `ln -s`，Windows 用 `mklink /J` |
| 任何形态 | 设 `AGENTBOARD_SKILL_ROOT` | 技能权威解析第一优先级环境变量，可指向技能根或 SKILL.md 全路径 |
| Docker | 镜像内没有（`.dockerignore` 排除了 `skills/`） | 见上文「Docker（单容器）」节 |
| Windows 便携包 | 包内 `app/rules/` | 8 技能齐全自检，仅 Windows x64 包 |

SKILL.md 定义领取 → 执行（以 `kb show` 实时拉取为准）→ `kb comment` 汇报 → `kb done`/`kb fail` 收尾的完整流程与占用规则。

## 文档

- [Docs/INDEX.md](Docs/INDEX.md)：唯一入口（现行文档 / 设计 / 调研 / 决策 / 证据 / 知识页索引）
- `Docs/设计文档.md`：需求、方案、接口、UI 布局
- `Docs/api.md`：REST + WebSocket 完整接口参考（端点、请求/响应字段、错误码、WS 事件、枚举；启动与 env 见上文「启动」节）
- `Docs/DESIGNS.md`：落地架构与数据流
- `Docs/CHANGELOG.md`：变更记录
- `Docs/PENDING_TESTS.md`：人工验收清单
