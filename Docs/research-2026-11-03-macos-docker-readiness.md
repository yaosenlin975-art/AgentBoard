# macOS + Docker 支持：平台耦合点调研与分层方案

状态：调研完成（2026-11-03，只读，未改任何代码）
范围：`apps/server`、`apps/mcp`、`packages/*`、`apps/web` 构建与运行形态
结论口径：能作为**容器/桌面启动阻塞**的算 P0；某功能在非 Windows 上不可用但服务能跑算 P1；纯命名/文档/可选优化算 P2

## 1. 结论摘要

| 级别 | 条数 | 含义 |
| --- | --- | --- |
| P0 | 6 | 不改则 mac / 容器根本跑不起来（或生产安装不可用）：#1 #2 #3 #5 #6 #17 |
| P1 | 7 | 服务能跑，但账号、额度、自启、git 自动提交等具体功能在非 Windows 上有缺口：#4 #7 #8 #9 #10 #14 #20 |
| P2 | 7 | 已兼容 / 仅需文档说明 / 可选优化：#11 #12 #13 #15 #16 #18 #19 |

- **Docker 单容器最小改造集合 = 3 项代码改动 + 1 个 Dockerfile + 3 条运行参数**（见 §4），估算 0.5–1 人日。
- **macOS 桌面**的主要成本不在服务端启动，而在两处 Windows 独占能力：DPAPI vault 与 WorkBuddy 桌面探针（§3）。
- 最小可行顺序：**先 Docker（改动最小、可先交付）→ 再 macOS 桌面（需要替换 vault 与客户端探测）**。

## 2. 平台耦合点清单（20 条，含 path:line 证据）

### 2.1 数据层（SQLite / 附件）

| # | 现状（证据） | 级别 | 阻塞点 | 改造思路 | 估算 |
| --- | --- | --- | --- | --- | --- |
| 1 | 配置目录按 `%APPDATA%` 取，非 Windows 已回退 `~/.config`：`apps/server/src/config.ts:27-28`、`configDir()` `:31-32`、`defaultDbPath()` `:39-40`；`AGENTBOARD_DB` 可覆盖 `:116-117` | P0（容器） | 容器内 `$APPDATA` 不存在 → DB 落到 `/root/.config/AgentBoard`，不挂卷则数据丢 | 运行参数用 `AGENTBOARD_DB=/data/agentboard.db`（**已支持**，零改动）+ 镜像声明 `VOLUME /data` | 0.1 人日（配置） |
| 2 | 附件目录生产装配写死 `configDir()/attachments`：`apps/server/src/index.ts:179`；但 `createApp` 默认按 DB 同目录派生 `dirname(db.name)/attachments` `:100` | P0（容器） | 与 1 同因：附件不进数据卷；且容器内 `/root/.config` 可能不可写 | 生产装配改为「与 DB 同目录派生」或新增 `AGENTBOARD_ATTACHMENTS_DIR`；容器只挂 `/data` 即可 | 0.2 人日 |
| 3 | `better-sqlite3` 原生模块 + WAL/busy_timeout/FK：`apps/server/src/db/connection.ts:1-10` | P0（未证实） | darwin-arm64 与 linux-musl(Alpine) 是否有可用预编译二进制未证实；Alpine + musl 常需 `--build-from-source` 与构建工具链 | 优先 Debian slim 基础镜像（glibc，预编译命中率高）；Alpine 需 `apk add python3 make g++` 与 `pnpm rebuild better-sqlite3` | 0.3 人日 + 验证 |
| 4 | WAL 模式（`connection.ts:8`）落在 bind mount 上 | P1（未证实） | Docker Desktop for macOS 的 virtiofs/osxfs 卷上 WAL 有已知锁语义风险 | 默认用 named volume；若必须 bind mount，先做写入压测 + `PRAGMA wal_checkpoint(TRUNCATE)` | 验证 0.5 人日 |

### 2.2 Windows 独占能力

| # | 现状（证据） | 级别 | 阻塞点 | 改造思路 | 估算 |
| --- | --- | --- | --- | --- | --- |
| 5 | 凭据 vault 走 DPAPI（PowerShell + `ProtectedData`），非 Windows 直接 503：`apps/server/src/services/accounts/secretVault.ts:14-30`（平台门 `:24`、powershell 路径 `:28`） | P0（macOS/容器） | 所有账号写能力（捕获/切换/签到凭据）依赖 vault；虽然**不阻塞服务启动**（503 降级），但等于账号子系统全灭 | 抽象 `VaultBackend`：Windows 保留 DPAPI；macOS 用 Keychain（`security add-generic-password`）或 `AES-256-GCM + scrypt` 本地密钥；容器用同文件级实现 + 卷权限 600 | 2–3 人日 |
| 6 | WorkBuddy 桌面探针/切换全走 PowerShell + `user32.dll` UIA/鼠标模拟：`apps/server/src/services/accounts/workbuddyDesktopProvider.ts:412-461`（`:457-461` 为 DllImport） | P0（macOS） | 该 provider 在 mac 无法工作（无 UIA/无 user32） | 平台门：macOS 上把 workbuddy 能力标为不可用（与 `registry.ts` 的 reason_code 机制同款），不进 Windows 代码路径 | 0.5 人日 |
| 7 | MiniMax 客户端探测走卸载注册表 + 盘符枚举：`apps/server/src/services/accounts/minimaxClientProbe.ts:46-52`（Uninstall 根）、`:74`（`CDEFGHIJKLMNOPQRSTUVWXYZ` 盘符）、`:88-92`（LOCALAPPDATA/ProgramFiles 候选） | P1 | macOS 无注册表；容器内无客户端（自然得 `CLIENT_NOT_INSTALLED`，语义正确） | 按平台切候选：macOS 用 `/Applications/MiniMax Code.app/Contents/MacOS/*` + `mdfind "kMDItemCFBundleIdentifier == *minimax*"`；探测结果已有三分原因码，可直接复用 | 1 人日 |
| 8 | opencode 用量服务发现依赖 `netstat -ano` + `tasklist /FO CSV`：`apps/server/src/services/quotas/quotaService.ts:179-215`（平台说明 `:203`） | P1 | 容器内无宿主进程可见性；macOS 无 netstat/tasklist 输出格式 | 抽 `discoverServiceUrl(platform)`：POSIX 用 `lsof -nP -iTCP -sTCP:LISTEN` + `ps -axo pid,comm`；容器内直接返回 `unsupported`（现状已能把失败降级为 `OPENCODE_SERVER_NOT_RUNNING`） | 1 人日 |
| 9 | 原生文件夹选择用 PowerShell `FolderBrowserDialog`：`apps/server/src/api/routes.ts:207-215`、端点 `:368-375` | P1 | macOS/容器无此对话框；仅影响 UI 的「选择工作区目录」 | 非 win32 时端点回 501 并由前端降级为手输路径（前端已有输入框形态可复用） | 0.5 人日 |
| 10 | `kb autostart` 写 HKCU Run + 生成 vbs：`packages/cli/src/commands/autostart.ts:2-3,16,40,67,93-94`；`scripts/agentboard.vbs` 为 Windows 脚本 | P1（macOS） | macOS 需 LaunchAgent（`~/Library/LaunchAgents/*.plist`） | 新增 `autostart` 平台实现：macOS 生成 plist + `launchctl bootstrap`；容器内该命令返回「不支持，请用编排层 restart policy」 | 1 人日 |
| 11 | `kb shortcut` 生成 Windows `.lnk` + 图标 | P2（macOS） | macOS 无 .lnk | macOS 可选：生成 `.command` 脚本或 `.app` 包；不做也不阻塞 | 0.5 人日（可选） |
| 12 | CLI 原生执行封装 `reg.exe`/`powershell.exe` 与 GBK 输出解码：`packages/cli/src/winrun.ts:1-14,29-36` | P2 | 仅 autostart/shortcut 使用；POSIX 不调用 | 保持现状即可（调用点按平台分支） | 0 |
| 13 | 服务自重启 `spawn(process.execPath, argv)`：`apps/server/src/api/systemRoutes.ts:22-23` 起 | P2 | 容器内自重启会脱离编排层（进程退出后由 restart policy 拉起），语义可接受 | 容器内建议把 `/api/system/restart` 标记为「由编排层重启」；或保持现状（进程退出 → `restart: unless-stopped` 拉起） | 0.2 人日 |

### 2.3 git 基线机制

| # | 现状（证据） | 级别 | 阻塞点 | 改造思路 | 估算 |
| --- | --- | --- | --- | --- | --- |
| 14 | 声明路径归一化按 Windows 语义：反斜杠转 `/` `apps/server/src/services/gitBaseline.ts:126`、拒绝盘符 `:127`、目录前缀匹配 `:142` | P1（macOS） | POSIX 下反斜杠是合法文件名字符，`:126` 会把它改写成路径分隔符 → 含 `\` 的文件名永远匹配不上；macOS APFS 默认大小写不敏感，声明大小写与实际不一致时 `:142` 前缀匹配会失败 | 归一化按 `process.platform` 分支：POSIX 不做反斜杠替换、不做大小写折叠；Windows 保持现状。**不要**全局引入 `path.sep`（git 输出恒为 `/`） | 0.5 人日 |
| 15 | porcelain 解析 `token.slice(3)`：`gitBaseline.ts:56-63`，`-z` 模式无引号 | P2 | POSIX 与 Windows 格式一致（`XY <path>`），无需改 | 保持；建议补一条 POSIX 路径用例 | 0.2 人日 |

### 2.4 构建 / 依赖 / 测试

| # | 现状（证据） | 级别 | 阻塞点 | 改造思路 | 估算 |
| --- | --- | --- | --- | --- | --- |
| 16 | 前端静态托管已内置：`apps/server/src/index.ts:137-146`（`express.static(webDist)` + SPA fallback）、`:171-178`（自动解析 `../../web/dist`） | P2（已支持） | 容器只需在镜像里跑 `pnpm -r build` 产出 `apps/web/dist` | 无需代码改动 | 0 |
| 17 | 监听地址写死 `127.0.0.1`：`apps/server/src/index.ts:205`（日志 `:214` 同） | P0（容器） | 容器内外网隔离 → 宿主/端口映射访问不到 | 新增 `AGENTBOARD_HOST`（默认 `127.0.0.1` 保持既有安全口径，容器传 `0.0.0.0`） | 0.2 人日 |
| 18 | 依赖面扫描：7 个 `package.json` 共 64 个依赖，无 Windows-only 包（`node-windows`/`registry`/`node-pty`/`ps-node` 等均为 0）；`apps/web` 命中关键词的 `tailwindcss` 为误报 | P2（已支持） | 无 Windows 绑定依赖 | 无 | 0 |
| 19 | pixi 前端依赖：`apps/web/package.json:15-21`（`@pixi/*@7.2.4`） | P2（已支持） | 纯前端包，与 runner 平台无关 | 无 | 0 |
| 20 | 测试隐含 Windows 假设：53 个 server 测试文件中 11 个含 `C:\`/`%APPDATA%`/`SystemRoot`/`powershell`/`reg.exe`/`tasklist`/`netstat` 字样（`quotaService` 12 处、`workbuddyDesktopProvider` 9、`minimaxClientProbe` 5、`accountApi` 4、`pickFolder` 3、`skills`/`accountFoundation` 各 2、`settings`/`attachments`/`minimaxProviderClientPath`/`accountQuotas` 各 1）；另 76 处 `mkdtempSync` 使用点（Windows 上偶发 `EPERM` 清理信号） | P1 | 在 macOS/容器内跑 CI 会有一批平台相关失败 | 平台相关断言加 `describe.skipIf(process.platform !== 'win32')` 或注入 fake；先在不同平台跑一遍全量取得基线 | 1–2 人日 |

## 3. 三套运行形态的目标路径

### A. macOS 桌面（原生）

| 项 | 目标 |
| --- | --- |
| 数据目录 | `~/Library/Application Support/AgentBoard/agentboard.db`（`config.ts:28` 现有 `homedir()/.config` 回退可直接改指向） |
| 附件 | `<数据目录>/attachments`（配合 §2 #2 的「与 DB 同目录派生」） |
| 凭据 | Keychain 或 `AES-256-GCM` 本地密钥文件（替换 DPAPI，§2 #5） |
| 自启 | `~/Library/LaunchAgents/com.agentboard.server.plist`（`RunAtLoad=true`，`KeepAlive` 可选） |
| 前端 | 同一个 node 进程托管 `apps/web/dist`（现状已支持） |
| 客户端探测 | MiniMax：`/Applications/*.app` + `mdfind`；WorkBuddy：标记不可用 |
| 进程/端口发现 | `lsof -nP -iTCP -sTCP:LISTEN` + `ps -axo pid,comm` |

### B. Docker 单容器（推荐先做）

| 项 | 目标 |
| --- | --- |
| 基础镜像 | `node:22-bookworm-slim`（glibc，`better-sqlite3` 预编译命中率高；Alpine 需自建工具链） |
| 数据 | `VOLUME /data`，`AGENTBOARD_DB=/data/agentboard.db`（附件随 DB 同目录） |
| 监听 | `AGENTBOARD_HOST=0.0.0.0`，`AGENTBOARD_PORT=8787`，`-p 8787:8787` |
| 进程 | 前台 `node apps/server/dist/index.js`（PID 1，无 supervisor） |
| 健康检查 | `HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8787/api/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"` |
| 账号子系统 | 无桌面会话 → vault 走文件级实现或整体禁用（404/503 已可降级） |
| 派发/CLI | 容器内无 codex/claude 等 CLI → 派发能力文档标注「容器形态不支持」，不进 P0 |

### C. Docker + 宿主机 DB 卷

- 同 B，`-v $HOME/agentboard-data:/data`（bind mount）。
- 额外风险：WAL over virtiofs（§2 #4）。落地前必须做写入压测；不通过则退回 named volume + 定时 `sqlite3 .backup`。
- 该形态的价值是「备份/迁移方便」，不建议作为默认形态。

## 4. Docker 单容器最小改造集合（3 项代码 + 1 个 Dockerfile + 3 条参数）

1. `apps/server/src/config.ts`：读 `AGENTBOARD_HOST`（默认 `127.0.0.1`），与既有 `AGENTBOARD_PORT`/`AGENTBOARD_DB` 同款。
2. `apps/server/src/index.ts:205`：`server.listen(config.port, config.host)`；日志 `:214` 同步用 `config.host`。
3. `apps/server/src/index.ts:179`：附件目录改为「与 DB 同目录派生」（或读 `AGENTBOARD_ATTACHMENTS_DIR`）。
4. 新增 `Dockerfile`（多阶段草案，未实现）：

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile && pnpm -r build

FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY --from=build /app ./
ENV AGENTBOARD_HOST=0.0.0.0 AGENTBOARD_PORT=8787 AGENTBOARD_DB=/data/agentboard.db NODE_ENV=production
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/api/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]
```

5. 运行参数（3 条）：`-p 8787:8787`、`-v agentboard-data:/data`、`--restart unless-stopped`。
6. 冒烟命令（草案）：

```bash
docker build -t agentboard:local .
docker run -d --name agentboard -p 8787:8787 -v agentboard-data:/data agentboard:local
curl -fsS http://127.0.0.1:8787/api/version
curl -fsS "http://127.0.0.1:8787/api/workspaces"
```

## 5. 建议落地顺序

1. **P0-容器三件**（§4 的 1/2/3）→ 出镜像 → 冒烟（半天）。
2. **验证 P0-未证实两项**：`better-sqlite3` 在 debian-slim 的行为、WAL 在 named volume 的稳定性（需在卡上申请装依赖/起容器）。
3. **P1-测试平台化**：macOS/容器内跑全量 server 测试，按失败清单加 `skipIf`/注入 fake，取得跨平台基线（1–2 天）。
4. **P1-macOS 桌面**：vault 后端抽象（最大成本）→ 客户端探测与进程发现平台化 → LaunchAgent。
5. **P2 收尾**：`/api/system/pick-folder` 平台分支、`kb shortcut`、`/api/system/restart` 容器语义说明。

## 6. 暂时不支持（防范围蔓延）

- Windows DPAPI 密文在 macOS/容器上的**交叉读取**（不做兼容层，不做迁移工具）。
- macOS / 容器内的 **WorkBuddy 桌面快照与账号切换**（UIA + user32 无对应实现）。
- 容器内的**客户端进程启停**（MiniMax / WorkBuddy，无桌面会话与可执行文件）。
- 容器内的 `kb autostart` / `kb shortcut`（桌面概念，编排层用 restart policy 代替）。
- 容器内的 **agent 派发**（无 codex/claude/opencode CLI 时由用户自行挂载，首版不做镜像内置）。
- 容器内的 **git 自动提交**（GIT-ON-DONE）：需要挂载仓库 + git 身份 + `.git` 归属，作为第二阶段单独评估。
- **Windows ↔ macOS 数据库文件直接互换**（账号表含平台相关密文）。
- 原生安装包（dmg/pkg / MSI 改造）不在本轮范围。

## 7. 未证实项与验证方式

| 项 | 为什么未证实 | 验证方式 |
| --- | --- | --- |
| `better-sqlite3@12` 在 darwin-arm64 与 linux-musl 的预编译可用性 | 本机只有 win32 环境，无法实测 | macOS：`pnpm install` → `node -e "require('better-sqlite3')"`；Alpine：`docker run --rm -v $PWD:/w node:22-alpine sh -c 'cd /w && corepack pnpm install --filter @agentboard/server'`（需先获批装依赖/起容器） |
| WAL 在 Docker Desktop bind mount（virtiofs）上的锁行为 | 无容器环境 | 起容器后写 10 万行 + 并发读，观察 `SQLITE_BUSY`/`database is locked` 与 `PRAGMA wal_checkpoint` |
| macOS 上 MiniMax 客户端的稳定定位方式（`mdfind`/LaunchServices/`/Applications` 扫描） | 无 macOS 机器 | 在目标 mac 上跑 `mdfind "kMDItemFSName == 'MiniMax Code.app'"` 与 `ls /Applications` 比对 |
| macOS 默认 APFS 大小写不敏感对 git 声明路径匹配的影响 | 未在 mac 上复现 | 在 mac 上造 `Docs/A.md` 与声明 `docs/a.md` 的用例，看 `withinDeclaredScope` 命中情况 |
| 容器内 `pnpm install --frozen-lockfile` 是否会触发原生模块重编译 | 未实测 | 构建镜像时观察输出是否出现 `node-gyp`/`prebuild-install` 下载 |
