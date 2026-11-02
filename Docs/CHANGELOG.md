# CHANGELOG.md

## [2026-11-02] 前端顶栏与设置弹窗显示版本号（issue 287c2893 退回修复）

- 顶栏工作空间名旁显示服务端版本 `v0.1.0`（GET /api/version，react-query `['version']`，staleTime Infinity）；不可达/加载中显示 `v?`，不报错；title 含服务端名称与前端版本，两者不一致时追加警告。
- 设置弹窗底部显示「服务端 x.y.z · 前端 x.y.z」，接口失败显示「服务端 ?」。
- 前端版本取 `apps/web/package.json`（JSON 具名导入，构建期仅内联 version 字段）；共享数据源 `apps/web/src/api/version.ts`，顶栏组件 `components/topbar/VersionLabel.tsx`。
- web 测试新增 5 例（顶栏 3、设置弹窗 2）；测试默认 handler 增加 GET /api/version。

## [2026-11-02] 开机自启退回修复与真实安装（AUTOSTART-FIX）

- 根因：上轮冒烟结束时执行了 uninstall/remove 并还原 vbs 占位符，Run 键与桌面 lnk 实际从未保持安装，重启后自然无法自启。
- agentboard.vbs 增加启动期诊断：写入 autostart.log（占位符未配置时回退 %APPDATA% 推导路径）；任一启动步骤失败记录时间戳+模式+Err.Number+Err.Description；成功拉起记录 `launched pid/time`（WMI 尽力查询）；占位符未替换写日志后退出，autostart 模式开机静默、其余模式保留弹窗。
- install 写 vbs 改为 UTF-16LE+BOM（readVbsText/writeVbsText 共享读写）：wscript 对无 BOM 脚本按 ANSI 码页解码，UTF-8 直写的中文仓库路径在 ACP≠65001 机器会乱码导致启动失败。
- 实机安装并保持：Run 键 AgentBoard = `wscript.exe "D:\WorkSpaces\任务看板\scripts\agentboard.vbs" autostart`，桌面 `D:\Desktop\AgentBoard.lnk`（wscript + vbs open + ico + 仓库工作目录）。
- 冷路径实测：停服务进程后执行 Run 键原命令，8.6 秒内 /api/version 可达（≤30s 要求），autostart.log 与 server.log 均有本次记录；open 模式 cscript 退出码 0 直接开浏览器。
- 测试 71/71 全绿（+8：vbs 日志结构、BOM 回环、模板编码兼容读取），build tsc 通过；cli.test.ts 模板读取兼容已配置状态并清理重复导入。

## [2026-11-02] 评论图片选择与展示（IMG-02）

- 评论编辑区增加文件选择、粘贴和拖放图片入口，共用上传状态、预览、重试和移除操作。
- 支持纯图片评论；提交失败保留正文与已上传图片草稿，历史评论展示受控附件链接。
- 修复附件目录位于点目录路径下时 staged 与历史图片下载失败；仅允许服务端解析出的附件存储路径穿过点目录。

## [2026-11-02] 评论图片暂存与受控回收（IMG-01）

- 新增 Workspace 暂存上传、附件提交绑定与按 Workspace/Issue 作用域下载。
- 评论列表、单评论、WebSocket、CLI 与 MCP 只读结果返回图片元数据。
- 图片评论在附件交付能力验证前保留待读状态，不触发文本唤醒；领取任务与 consume 均不越过首条图片评论。
- 增加上传配额预留、暂存过期和文件清理账本；Settings 支持调整配额、暂存 TTL 与清理周期。

## [2026-11-02] CLI 图片输入契约核验（IMG-03）

- 验证 Codex 与 CodeBuddy 当前模型在首轮和续会话接收原生图片输入；OpenCode 实际结果未验证，DSH 命令入口受阻。

## [2026-11-02] 已验证图片投递与未知结果保护（IMG-04）

- CodeBuddy 的 MiniMax-M3.1-Flash 组合使用原生 stream-json 图片输入；Codex、OpenCode、DSH 未通过组合门禁时不接收附件。
- 图片评论与派发、排队唤醒及续会话共用附件交付路径；评论投递状态显示 pending、sending、unknown、delivered。
- 未知投递结果保持未读；新派发须显式确认是否重发未知图片，普通文字留言与服务启动恢复不会重发。
- 输入投递回执不表示看板任务已完成。
- 全历史 pending/unknown 图片支持分页选择；服务端按时间顺序限制每批最多 5 张、20 MiB，超出部分保留待读并在 prompt 和响应中报告剩余数。
- 派发弹窗在仍有未附图片时保留窗口并提供同一绑定会话的下一批显式派发。
- 仅 issue-bound 会话接受 `selected_attachment_ids`；自由会话请求带图片 ID 时返回校验错误。
- 图片门禁要求 CLI 探测成功并匹配已验证版本与模型；版本缺失、探测失败或不匹配时，派发、唤醒及适配器调用均拒绝图片。
- 图片轮次取得执行槽后以事务校验附件状态并切换为 sending；仅本次显式确认的 unknown ID 可重试，重复排队、sending 或 delivered ID 不会再次调用适配器。
- 派发弹窗限制在视口高度内滚动，长候选列表、unknown 确认和底部操作均可触达。

## [2026-11-02] 模型清单状态与旧缓存值处理（MODEL-01）

- 新建会话与修改模型共用字段显示加载、空列表和查询失败状态；查询失败可重试。
- 模型清单加载后可从手输返回下拉选择；不在清单内的当前值继续保留并明确标记。
- 新建会话及修改模型路径均覆盖旧缓存模型恢复、清单选择和错误恢复。

## [2026-11-02] 递归子任务数据与 API/CLI/MCP（TREE-01）

- issue 增加可空 `parent_issue_id`，增量迁移建立同工作空间约束、自引用环保护与删除限制。
- REST、CLI、MCP 支持任务父级创建、移动、读取和树分页；树页返回祖先路径与后代关闭进度。
- 父任务存在未关闭后代时禁止关闭；存在子任务时禁止删除该节点。

## [2026-11-02] 任务树界面与层级操作（TREE-02）

- 看板增加可切换的任务树视图，保留原平铺看板。
- 任务树支持递归展开、筛选保留祖先、游标续读、子任务创建、CAS 父级移动和单节点状态更新。
- 详情删除与任务树关闭控件展示父子关系阻塞状态。
- 窄屏任务行将标题与后代进度保持在完整内容列，状态和操作排列在下一行。
- 移动编辑状态跨父级实时刷新保留；CAS 冲突展示打开版本、当前版本与重开提示。

## [2026-11-01] WorkBuddy Desktop 账号捕获、切换与失败恢复（ACC-05）

- 新增 `apps/server/src/services/accounts/workbuddyDesktopProvider.ts`：按 `Docs/verification/2026-11-01-workbuddy-desktop-contract.md` 授权观测实现 `getCurrentIdentity`（只读 `$.account.uid`，信封不读不入库）、`captureCurrent`（preflight→快照两文件 DPAPI 加密→复读身份→同身份换引用）、`switchAccount`（preflight→safe-exit 两段式→backup→validate-target 三元组校验→atomic-write→restart 三信号→identity-verify；写后失败 rollback，回滚核验通过 `SWITCH_ROLLED_BACK` 收尾，失败置 `recovery_required` 冻结实例）、`canCloseSafely`（契约不可判定恒 false）；safe-exit=UIA 托盘退出≤10s→WS `account.notice` 提示手动退出+轮询退出签名（进程清零+window-state≥auth），绝不 taskkill；契约路径常量+探针全可注入，默认探针走 PowerShell 只读探测。
- `registry.ts` 注册 workbuddy_desktop（capture/switch 开、checkin 关 CHECKIN_PROVIDER_UNVERIFIED；codebuddy_desktop 维持关闭）；`operationRunner.ts` 扩安全错误码白名单（provider 固定码）并新增 `SWITCH_ROLLED_BACK` 已核验回滚例外（写后失败默认冻结语义不变）与 `onOperationCreated` 钩子（切换 API 立即返回 operation id）；`managedAccount.ts` 增 `findManagedAccountByIdentity` / `attachClientSnapshot`。
- 新增 `apps/server/src/api/accountRoutes.ts` 并挂载：`GET /api/managed-accounts?app=`（PublicManagedAccount+is_current）、`POST /api/managed-accounts/:app/capture-current`、`POST /api/managed-accounts/:id/switch`（202+operation_id）、`GET /api/account-operations/:id`；shared 增 WS 事件 `account.notice`（web wsBus 忽略 invalidation）。
- 测试：新增 `test/fakeWorkbuddy.ts`（fake 客户端：.info/skeleton/退出签名时序/启动日志/托盘注入）+ `test/workbuddyDesktopProvider.test.ts` 11 例（版本/实例不支持、缺 uid、v1 schema、三元组不符不写、退出未确认不写、verify 失败回滚成功、回滚失败冻结、UIA 失败手动退出降级、串行锁互斥等）+ `test/accountApi.test.ts` 4 例；server 全套 192 例通过，`pnpm -r test` 无回归，tsc 构建通过。
- 只读冒烟：真实实例 instance_id 复算=9cb538c4…、uid sha256_8=f5d89346（与契约一致）、版本 5.9.3.0、运行态 8 进程；未改客户端任何数据。双账号真实闭环（登录 B→捕获→切 A→核验→回滚演练、UIA 托盘退出真机观察）转 PENDING_TESTS。

## [2026-11-01] 开机自启与桌面快捷方式（kb autostart / kb shortcut）

- kb autostart install/uninstall/status：HKCU Run 键写 wscript.exe 启动 scripts/agentboard.vbs autostart；install 前置检查 apps/server/dist/index.js（缺失提示 corepack pnpm -r build），端口读 %APPDATA%\AgentBoard\config.json（缺省 8787）并连同 node 路径/仓库/日志目录正则重写进 vbs 顶部 Const 区（重复 install 刷新端口，Run 键同值跳过 reg add）；uninstall 仅删含 agentboard.vbs 的自家值；status 报自启状态 + GET /api/version 可达性 + 日志路径（支持 --json）。
- scripts/agentboard.vbs 模板续用并改造：双模式 autostart/open；open 以 MSXML2.ServerXMLHTTP（超时 1500ms×≤20 次）探测就绪后开默认浏览器，未起按 autostart 同款隐藏拉起（cmd.exe /c 包装实现日志 >> 与 2>&1 重定向），30s 不通 MsgBox 报日志路径；uninstall 不动 vbs。
- kb shortcut create/remove：PowerShell WScript.Shell COM 建桌面 AgentBoard.lnk（GetFolderPath 兼容 OneDrive 重定向；TargetPath=wscript.exe、Arguments=vbs open、图标 apps/web/public/agentboard.ico、工作目录=仓库根）；create 前置 ico 存在与 vbs 已配置（未 install 拒绝）。
- 图标 apps/web/public/agentboard.png（1024）+ agentboard.ico（256/64/48/32/16）：gemini-image 两次网络失败（cookie 池不可达），按任务规则 Pillow 兜底纯代码绘制四列看板扁平图标。
- 零依赖基建：packages/cli/src/winrun.ts 统一 spawn 封装（stdin ignore、error 事件必挂、windowsHide、OEM/GBK 回退解码），autostart/shortcut 共用；三命令非 Windows 报「仅支持 Windows」退出 1。
- 测试：cli.test.ts 新增 14 例（命令/vbs 常量重写/端口解析/注册表解析/uninstall 判定/status 可达分支/快捷方式脚本构造与守卫），全套 63 例通过，tsc 构建通过；实机冒烟 status/install 幂等/注册表值/lnk 属性/remove/uninstall/vbs open 全通过。
- 文档：README「后台常驻（Windows）」改为推荐 kb autostart install / kb shortcut create（schtasks 保留备选）+ 改端口需重装 + 日志位置；DESIGNS.md 增「运维工具：自启与桌面快捷方式」；PENDING_TESTS 增重启自启与快捷方式拉起两项人工验收。

## [2026-11-01] 统一版本 0.1.0 + kb --version 真实版本 + 服务端版本端点/响应头 + CLI 版本比对警告（issue 287c2893）

- 7 个 package.json（根、apps/{server,web,mcp}、packages/{shared,cli,adapters}）version 0.0.0 → 0.1.0；workspace:* 内部依赖不受影响，`pnpm install --lockfile-only` 复核 lockfile 正常。
- kb `--version` 改读真实版本：`packages/cli/src/version.ts` 用 `createRequire(import.meta.url)` + `require('../package.json')` 定位本包 package.json（src/ 与 dist/ 均在其上一级，跟随打包），`index.ts` `.version(CLI_VERSION)` 不再硬编码。
- 服务端：`apps/server/src/version.ts` 同法读包版本；新增 `GET /api/version` → `{ name: 'agentboard-server', version }`（routes.ts:190）；`index.ts` 全局中间件给所有 `/api` 响应加 `x-agentboard-version` 头（含 404/错误路径，index.ts:73-77）。
- MCP 握手版本同法接入：`apps/mcp/src/index.ts` McpServer version 改读本包 package.json（原硬编码 0.0.0）。
- kb 版本比对（`packages/cli/src/api.ts`）：每次请求读 `x-agentboard-version` 响应头，与 CLI 版本比对——major 不同、双方 0.x 且 minor 不同、头缺失/不可解析 → stderr 一行警告「版本不匹配：CLI x.y.z / 服务端 a.b.c（或服务端未上报版本），可能出现字段不兼容」；patch 差异不警告；模块级标志每进程最多警告一次；仅警告不阻断，--json 下 stdout 不受污染。旧服务端（无头）降级为警告，不报错。
- 测试：server 新增 test/version.test.ts 2 例（/api/version 返回包版本；任意 /api 响应含版本头，含 404 路径）；cli.test.ts 新增 5 例（--version 与 package.json 一致、缺头警告、minor/major 不同警告、一致与仅 patch 差异不警告、每进程最多一次）+ mock 服务端支持注入响应头；entry.test.ts 改为断言 package.json 版本。
- 文档：README「kb 命令行」加版本说明一行；Docs/api.md §2 通用约定加版本协商条目、§4 system 表加 GET /api/version 行。

## [2026-11-01] kb 401 误连 DSH web server 提示 + 文档边界说明（issue 8de26588）

- README「启动」节下新增「与 DSH 任务看板插件的边界」：AgentBoard（8787 + SQLite）与 DSH 插件 @linxin666/dsh-client-ui-task-board（ledger-v2.json + PROXY_TOKEN）两套独立服务/数据源对照；DSH 端口在监听 ≠ 看板服务已启动，kb 连 DSH 端口报 unauthorized；两边任务互不可见，同步需桥接未做。
- kb CLI：`--server` 指向非默认基址且收到 HTTP 401 时，错误信息末尾追加一行「该端口可能是 DSH web server（需 DSH_TASK_BOARD_PROXY_TOKEN），不是 AgentBoard 服务；AgentBoard 默认 http://127.0.0.1:8787」；默认基址的 401 不加提示（真鉴权问题）。实现于 `packages/cli/src/api.ts` request 非 2xx 路径（DSH_SERVER_HINT 常量），其余错误处理未动。
- `Docs/api.md` §1 服务与配置加一句端口误判交叉引用。
- 测试：cli.test.ts 新增 2 例（401 + 非默认 base → stderr 含 DSH 提示；401 + 默认 base → 不含，经 stub fetch 免绑 8787）。

## [2026-11-01] README 补 MSYS/Git Bash 两处坑（issue 188026ec）

- README「后台常驻（Windows）」节末尾新增「MSYS/Git Bash 注意」：① curl 内联 JSON 带 Windows 路径经 `bash -c` 调起时 `\\` 被折成 `\` 致 `INVALID_JSON`，改用 Python `json.dumps` 生成请求体文件 + `--data-binary @body.json`；② 后台启动接管道致输出不可见、`head` 退出后服务退出且 8787 不监听，改为日志重定向文件（bash `> server.log 2>&1 &`；PowerShell `Start-Process -RedirectStandardOutput/-RedirectStandardError -WindowStyle Hidden`）。
- SKILL.md、Docs/api.md 无 curl 示例，未改。

## [2026-11-01] 新增 Docs/api.md 完整 REST/WS 接口参考（issue 748baab7）

- 新建 `Docs/api.md`：以 routes.ts / knowledgeRoutes.ts 为准的 36 个 HTTP 端点参考（workspaces / system / settings / issues / comments / 占用事务 / clis / sessions / knowledge），每端点含请求字段（类型、可选性、枚举）、响应要点、400/404/409 触发条件与源码行号锚点。
- 含通用约定（错误信封与 code 表、分页、正文窗口、workspace_id 守卫、Idempotency-Key）、响应对象字段、WS 九类事件（载荷 + 触发时机）、枚举汇总、env 与 config.json 说明。
- README「文档」节链接 `Docs/api.md`；设计文档 §6.1 表前加「完整实时参考见 Docs/api.md，本表为设计概要」指引，旧表未改。
- 源码级核对修订：占用事务 release/done/fail 按是否带 `workspace_id` 区分两条路径的错误语义（scopedFinish vs doneIssue/failIssue/releaseIssue，NOT_TASK_OWNER 与 'user' 豁免差异）；claim 限定 status∈{待规划,进行中}；knowledge PUT 增加 deleted 页 `KNOWLEDGE_STATE_CONFLICT`、actions 写明状态前置；自由会话路径不校验 cli（首轮置失败）；POST workspaces path 重复未映射 → 500；issues PATCH `updated_at` 单调性、clis.changed 仅启动一次。

## [2026-11-01] kb CLI 新增 create-space / create-issue（issue 8f154330）

- cli 新增 `kb create-space <name> <path>`：POST /api/workspaces {name, path}；成功输出「已创建工作空间: <id> <name>（<path>）」，`--json` 输出原始 Workspace；服务端 400（路径不存在等）错误透传。
- cli 新增 `kb create-issue <workspace> <title>`：先 GET /api/workspaces 按 id/名称匹配（复用 workspace.ts resolveWorkspaceId，未命中报「工作空间不存在: x」不发 POST）再 POST /api/issues {workspace_id, title, description?, priority?, labels?}；选项 `-d, --description`、`-p, --priority`、`-l, --labels`（逗号拆分去空格）；成功输出「已创建任务: <id> <title>」+ 状态行，`--json` 输出原始 Issue。
- `index.ts` 注册两命令；README 命令清单、SKILL.md 命令速查各补两行。
- 测试：cli.test.ts 新增 6 例（请求体/输出、按名称解析与 id 直用、未命中报错、labels 逗号拆分、--json）。

## [2026-11-01] 服务未启动报错附启动指引

- kb 连接被拒报错（默认与自定义 --server 地址两种）末尾附一行启动命令 `pnpm --filter @agentboard/server start`（或 `node apps/server/dist/index.js`），退出码与失败判定逻辑不变。
- README 启动节新增 Windows 后台常驻与 schtasks 开机自启示例。
- SKILL.md 前置条件改为 `kb --version` / `kb list-spaces` 可执行自检，故障分支与退出码说明同步启动命令。

## [2026-11-01] MCP任务与知识工具

- 新增官方 MCP SDK 2.4.0 stdio server，暴露 12 个任务工具与 6 个共享知识工具。
- 所有任务/知识操作复用 loopback REST API；知识读结果限制 40,000 个序列化字符并提供正文、来源、证据与历史续读。
- 知识 revision 冲突返回当前 revision 数字；SDK 参数 schema 错误保留 SDK 输入校验响应。

## [2026-11-01] 账号恢复与知识来源证据修复

- 待确认幂等操作不因保留期到期而重放；写入异常保留账号冻结状态，恢复仅解除明确关联的操作。
- 非文件知识来源必须保存摘录，历史版本详情显示各自来源证据。

## [2026-11-01] 账号安全存储与操作基础

- 新增账号安全元数据、操作状态与恢复引用存储。
- 新增 Windows 当前用户 DPAPI Vault、scope 绑定及实例/账号操作串行锁。
- 新增中断操作恢复分类；客户端写入中断冻结后续操作，签到中断保持 unknown。
- 未通过客户端与签到契约门禁的 provider 保持不可用。

## [2026-11-01] MCP 分页与正文续读

- 新增工作空间、任务、评论的稳定 ID 排序分页。
- 新增任务描述和评论正文的 Unicode 字符窗口、截断标记和续读偏移。
- 保留未携带分页参数的旧 API 数组响应。

## [2026-11-01] 写操作幂等账本

- 新增 Idempotency-Key 事务账本与 24 小时结果保留、过期回收。
- 任务与知识写入支持原结果重放，拒绝同 key 的不同 payload、actor 或操作。
- 评论重放不重复唤醒；中断后的待确认唤醒返回结果未知。

## [2026-11-01] MCP 任务接口前置契约

- 新增按工作空间的任务校验、原子 owner 操作与任务编辑 CAS。
- 新增任务更新时间单调递增迁移触发器，覆盖同毫秒修改。
- 保留原有人类强制释放与完成入口；带工作空间的 MCP 操作始终要求当前占用者。

## [2026-11-01] 知识浏览与任务参考

- 新增知识浏览、来源历史、归档恢复、软删除确认和有效期编辑。
- 新增派发知识开关与查询，任务领取支持知识结果与显式关闭。
- 新增引用上下文长度限制与检索失败警告。
- 窄屏使用工作空间选择框并允许顶部操作换行。

## [2026-11-01] 共享知识 REST 与 CLI

- 新增知识搜索、分页列表、读取、历史、创建、修订和生命周期 API。
- 新增 `kb knowledge` 子命令，支持显式范围、UTF-8 stdin、来源证据和版本冲突。
- 工作空间有知识页及历史时拒绝删除。

## [2026-11-01] 共享知识中文检索

- 新增 FTS5 trigram 中英文检索、短词字面 LIKE 回退及项目/公共联合检索。
- 页面变更通过数据库触发器同步索引，默认排除过期、归档和软删除内容。

## [2026-11-01] 共享知识存储与版本

- 新增知识页、来源证据、不可变版本历史及增量迁移。
- 新增项目/公共范围校验、revision CAS、归档、恢复与软删除。
- 限制证据摘录为 2 KiB，本地代码来源仅保留定位与内容 hash。

## [2026-11-01] 聊天视图补「标记待验收」入口（issue 0699a18c）

- web `ChatPanel.tsx`：顶部工具条停止按钮左侧新增「标记待验收」（`chat-done-btn`）；显示条件为会话 `issue_id` 非空、关联任务占用中（`claimed_by` 非空，经 DetailPanel 同款 `['issue', issue_id]` query 取数）且会话非已结束/失败；点击 POST `/api/issues/:id/done` `{agent_id:'user'}`，onSuccess 失效 `['issue', id]` 与 `['sessions']`，错误走现有 actionError，成功后占用释放按钮自然消失（看板卡片经既有 WS issue.changed 失效刷新）；自由会话与无 issue 数据不渲染；停止按钮与其逻辑未动。
- web `chat.test.tsx`：mockChatApi 补 GET `/api/issues/:id` 与 POST `/api/issues/:id/done`（含服务端占用释放模拟）；新增 3 例——占用中显示按钮、点击调用正确端点与 body 且成功后按钮消失、自由会话不渲染且不拉取 issue。web 全量 105 例通过，tsc 通过。设计文档 §5.2 已有「会话与任务详情提供标记待验收」表述未改。

## [2026-11-01] kb list-tasks 输出补齐 labels 与评论（issue e5c6609c）

- cli `listTasks.ts`：文本表格新增 labels（逗号连接，空显示 `-`）与评论（`comment_count` 数字）两列；`--json` 输出不变（透传 Issue，天然含 `comment_count`）。
- cli `cli.test.ts`：ISSUE 夹具补 `comment_count`；list-tasks 表格用例覆盖多标签逗号连接、空标签 `-`、评论数渲染；对齐沿用 render.ts 现状（`table()` 不做 CJK 宽度修正）。

## [2026-11-01] thinking 事件贯通到聊天折叠块（issue 92b9e5a0）

- adapters `types.ts`：UnifiedEvent 新增 `{type:'thinking'; delta:string}`。
- adapters `dsh.ts`：行协议 `thinking` 事件（text 字段）归一为 thinking 事件，不再忽略；text/tool_call/final 等其余行为不变。
- adapters `codex.ts`：`item.completed` 且 `item.type==='reasoning'` 时取 `text` 摘要字段归一为一条 thinking 终值事件（与 agent_message 同为终值路径，无重复风险）；无 text 字段/空文本不映射；`item.started`/`item.updated` 的 reasoning 中间态维持忽略。
- adapters codebuddy/opencode：行协议无 thinking/reasoning 事件（codebuddy 仅 assistant text/tool_use；opencode 仅 text/tool_use/error），维持不动，补轻量忽略断言。
- server `sessionManager.ts`：thinking delta 缓冲 thinkingBuf，tool/error/end 及无 end 兜底处与 text 同点位 flushThinking——落一条 `role='event'`、`content=JSON.stringify({kind:'thinking', text})` 消息；空缓冲不落；session.event 广播照常（web 流式区不渲染 thinking）。
- shared `types.ts`：WsEvent `session.event` 事件类型并集补 `'thinking'`（广播 UnifiedEvent 直传，类型必需）；Message role 枚举与 message 表 schema 未动。
- web `MessageList.tsx`：event 消息 content JSON 解析归类——`kind==='thinking'` 渲染「思考」折叠块（details 默认收起，`data-testid=thinking-block-<id>`，正文纯文本）；含 name/input 走既有工具块；两者不匹配按原文展示（兜底不变）。
- 测试：adapters dsh/codex thinking 映射用例更新（含 started/updated reasoning 忽略、无文本字段不发）、codebuddy/opencode 补不发断言；server sessionManager 新增 thinking 聚合/切分/广播与无 thinking 不落空块 2 例；web chat 新增思考折叠块开合与旧格式渲染 2 例。设计文档 §7.5 已有「tool/thinking 事件折叠块」表述未改。

## [2026-11-01] 「有新消息」未读统计脱离聊天面板存活（issue 6def6819）

- web 新增 `state/unreadCollector.ts`：message.added → markUnread 从 ChatPanel 提升到 wsBus 全局层（模块加载即 `subscribeWsEvents`，非组件生命周期），面板收起、切 detail 视图等 ChatPanel 未挂载期间的新消息同样计数；当前会话消息不计；session.deleted → clearUnread（非当前会话被删时未读条目不再残留）。
- `ChatPanel.tsx`：静态 import unreadCollector（模块图加载即生效，与 streamingStore 同路径）；删除 useWsEvent 内 markUnread 分支（防双计），其余 WS 处理分支不动。
- `panelStore.ts`：unread 随 `agentboard.panel` 持久化（zustand persist partialize 增 unread），重水合经 sanitizeUnread 容错（非对象回空对象、非正整数条目剔除），刷新后未读恢复。
- 清零路径核查：全部入口（TopBar 聊天按钮、RightPanel 窄条、切换器选项、新建会话、派发对话框、详情 SessionList）均经 openChat 打开对应会话即清零，无绕过入口。
- 被删会话未读条目取舍：session.deleted 即 clearUnread 置 0（非删除键），0 值不显示徽标、不进 TopBar 总数，重水合 sanitize 顺带剔除；非当前会话被删时 ChatPanel 不挂载也覆盖。
- 新增/更新测试：web `unreadCollector.test.tsx` 4 例（ChatPanel 未挂载计数 + TopBar/切换器徽标 + openChat 清零；多会话独立；当前会话不计；session.deleted 清条目）、`panelStore.test.ts` 改 2 例（unread 持久化与 rehydrate 恢复；脏数据回空/剔除）；web 全量 100 例通过，tsc 通过。

## [2026-11-01] 看板卡片显示评论数徽标（issue f40adf54）

- shared：`Issue` 新增必填 `comment_count: number`（查询列非落库列，CLI --json 输出附加该字段）。
- server `db/repos/issue.ts`：getIssue/listIssues SQL 加子查询 `(SELECT COUNT(*) FROM issue_comment c WHERE c.issue_id = i.id) AS comment_count`；IssueRow/rowToIssue 同步映射。
- web `IssueCard.tsx`：`comment_count > 0` 渲染 `💬 N` 徽标（title 提示保留），0 条整块隐藏。
- web `api/ws.ts`：`comment.added` 失效范围从仅 `['comments', issue_id]` 扩为 `['comments', issue_id]` + `['issues']`（载荷无 workspace_id，按前缀失效全部看板列表，与 DetailPanel 既有 `['issues']` 粒度一致）+ `['issue', issue_id]`（详情 issue 对象含 comment_count）。
- 新增测试：server `db.test.ts` 1 例（无评论 0、加 2 条后 getIssue/listIssues 均 2 且不串到其他任务）；web `board.test.tsx` 1 例（💬 2 显示、0 条隐藏）+ 1 例（comment.added 按 eventToQueryKeys 失效后评论数刷新）、`ws.test.ts` comment.added 断言更新；Issue 测试夹具（ws/detail/board/WorkspaceList）补 comment_count。全仓 343 例通过（shared 3 / adapters 91 / cli 27 / web 95 / server 127）；web/server/cli tsc 通过。

## [2026-11-01] kb comment 默认 agent 身份 kb-cli（issue a5481220）

- `packages/cli/src/commands/comment.ts`：请求体 `agent_id` 改恒传 `ctx.agentId`（KB_AGENT 优先，默认 kb-cli），不再直读环境变量；未设 KB_AGENT 时服务端作者记为 `agent:kb-cli` 而非 `user`，修正此前默认身份触发唤醒的问题。服务端唤醒逻辑不动（仅 author=user 唤醒，语义正确）。
- `packages/cli/src/index.ts`：comment 命令 `--help` 描述同步新语义；Ctx 结构与默认值逻辑不变。
- claim/done/fail 已统一走 `ctx.agentId`，无需改动。
- 测试：cli.test.ts comment 默认路径与 --stdin 用例改断言 `{ content, agent_id: 'kb-cli' }`，KB_AGENT=coder-bot 覆盖用例保留；服务端 `comments.test.ts` 已有「agent/system 作者不触发唤醒」用例，不重复新增。

## [2026-11-01] 运行中会话后台流式内容不丢（issue cc97a886）

- web 新增 `state/streamingStore.ts`：`Map<sessionId, string>` 模块级单例（zustand）缓存各会话流式文本，API `appendDelta`/`clearStream`/`getStream`/`useStream`；收流挂在 wsBus 全局层（模块加载即 `subscribeWsEvents`，非组件生命周期）：session.event text delta → `appendDelta(session_id, delta)`，assistant `message.added` → `clearStream(session_id)`，与当前选中会话无关。
- `ChatPanel.tsx`：移除本地 `streaming` state 与 useWsEvent 内按「当前会话」过滤的 text 累积分支（避免双计）；流式区改渲染 `useStream(sessionId)`——切会话即读对应累积、面板收起/切视图/组件卸载内容不丢；mergeMessages 收到 assistant 消息按 `message.session_id` 清对应会话 buffer（覆盖 WS 断连期间 catchUp 补齐落库后的残留场景）。
- 服务端 flush 时机与 WS 事件结构不变；切会话不再清空流式内容（原 `setStreaming('')` 移除，改为按会话读取 store）。
- 新增测试：web `chat.test.tsx` 2 例（流式期间切到 B 后台继续累积且不串显、切回显示完整累积；收起面板再展开内容不丢且收起期间 delta 继续累积）+ beforeEach 重置 streaming store 隔离用例；web 全量 94 例通过。

## [2026-11-01] 队列长度与等待槽位状态可见（issue 6778718c）

- shared：`WsEvent` 新增 `session.runtime`（载荷 session_id、queued_count、waiting_slot）；`Session` 类型增可选运行时字段 `queued_count`/`waiting_slot`（不入库，sessions 接口响应时合并）。
- `sessionManager.ts`：`SessionState` 增 `waitingSlot`；`acquireSlot` 增 onWait 回调（确需排队时同步触发，排队顺序与并发上限语义不变），beginTurn 在真等待时置位、获槽后复位（含 stop 弃轮）；新增导出 `getSessionRuntime(sessionId)` 返回队列长度/等待标志/排队文本副本；新增 `broadcastRuntime`，触发点：sendToSession 入队后、等待置位/复位后、轮尾队列合并清空后、stop 使等待标志复位时（stop 后计数未变则不发）。
- `routes.ts`：GET /api/sessions 列表与 GET /api/sessions/:id 合并 `queued_count`/`waiting_slot`（不回传文本）；新增 GET /api/sessions/:id/queue → `{texts}`（只读，停止后可查，会话不存在 404）。
- web：ChatPanel 订阅 `session.runtime` 校正本地计数与等待标志（入队乐观 +1 保留，事件到达即校正为服务端值）；切换会话/刷新从 sessions query 字段初始化（修复此前纯本地计数切会话即丢的缺陷）；轮 end 不再本地清零，等服务端合并后 runtime(queued_count=0) 校正；顶部工具条 waiting_slot 时显示「等待槽位」徽标；queuedCount>0 展示「查看队列内容」折叠面板（GET /sessions/:id/queue 打开即拉，只读）；`eventToQueryKeys` 对 session.runtime 不触发 invalidation。
- 新增测试：server `sessionManager.test.ts` 2 例（入队计数/副本/广播与轮尾归零广播；maxConcurrentTurns=1 等待置位复位广播、等槽位期间 stop 复位且队列保留）、`api.test.ts` 2 例（sessions 字段合并 + runtime 广播 + /queue 文本；=1 时 waiting_slot 响应可见与释放复位）；web `chat.test.tsx` 改 1 例（end 清零改等服务端 runtime）+ 增 2 例（sessions 字段回填与 runtime 校正、队列内容展开查看）、`ws.test.ts` 1 例（session.runtime 不失效查询）。

## [2026-11-01] dsh 模型只读：能力位 supportsModelSelection + UI 禁用模型选择（issue 35202421）

- shared `CliInfo` 与 adapters `AgentAdapter` 新增 `supportsModelSelection` 能力位：codebuddy/codex/opencode=true，dsh=false（dsh 无模型 CLI flag，模型由 CLI profile 配置决定；进程级全局共享状态，不做按次派发改写）。
- `dsh.ts` runTurn：删除「model 非空发提示 error 事件」逻辑，opts.model 静默忽略（不进参数，其余行为不变）。
- server `cliDetect.ts` refreshClis 载荷透传能力位，GET /api/clis 携带该字段。
- web：`ModelField`（新建会话/修改模型弹窗共用）对 supportsModelSelection=false 的 CLI 渲染禁用控件 + 标注「由 profile 配置决定」；`DispatchDialog` 同规则禁用 select/手输切换、不预填、提交不带 model。
- 新增测试：adapters registry 能力位 1 例、dsh runTurn model 静默用例改断言；server `cliDetect.test.ts` 载荷透传 1 例、`api.test.ts` /api/clis 载荷断言更新；web `ModelField.test.tsx` 3 例（dsh select/输入框禁用+文案、非 dsh 行为不变）、`detail.test.tsx` 1 例（dsh 控件禁用+提交 model=null、非只读不受影响）。

## [2026-11-01] 派发弹窗预填可编辑历史备注（issue ce182056）

- `DispatchDialog.tsx`：打开时经 `GET /api/issues/:id/comments` 拉取评论，最近 10 条 ts 升序渲染为 `## 历史备注\n- [author] content` 追加到预填 prompt 末尾（`dispatchTemplate.ts` 新增 `renderHistoryNotes`，与服务端输出逐字符一致）；无评论不追加该段、不显示提示，原静态"后端自动追加"提示改为有评论时显示可删改说明；提交时 prompt 原样上传。
- `dispatch.ts` `dispatchIssue`：追加前检测渲染结果已含 `## 历史备注` 则跳过追加、原样使用（含 promptTemplate 整体替换路径），避免前端预填后服务端双份；`renderHistoryNotes` 格式与 10 条上限不变，缺失时仍由服务端补齐。
- 新增测试：server `test/dispatch.test.ts` 2 例（prompt 已含历史备注段不追加、已含且有评论仍原样）；web `src/test/detail.test.tsx` 3 例（3 条评论预填升序、编辑后提交体携带编辑文本、无评论不含历史备注）+ 既有默认值用例改断言无评论不预填不显示提示。

## [2026-11-01] done/fail/release 自动评论补 WS 推送（issue d3e137d2）

- `claim.ts` 的 `doneIssue`/`failIssue`/`releaseIssue` 返回值改为 `{ issue, comment }`（导出类型 `ClaimActionResult`）：`comment` 为本次自动评论（done 无 notes 时为 null）；签名参数、状态流转、事务原子性不变。
- `routes.ts` 三端点（POST /issues/:id/done|fail|release）：`comment` 非空时在既有广播外补 `comment.added`，顺序与手动评论端点一致（先 comment.added 后 issue.changed）。
- 响应 JSON 保持 issue 字段平铺 + 附加 `comment` 字段（无评论为 null）：CLI done/fail 与 web DetailPanel 按顶层 issue 字段消费，不受影响；未改 `{issue, comment}` 包裹结构以免破坏既有消费方。
- 新增测试：`api.test.ts` 1 例（done 带 notes → comment.added 内容为 notes 且先于 issue.changed、done 无 notes 不广播、fail reason 评论广播、release system 评论广播、响应 comment 附加）；`claim.test.ts` 三函数用例补返回 comment 断言。

## [2026-11-01] 删除任务级联清理关联会话与消息（issue 4908a07e）

- `DELETE /api/issues/:id`（非占用中）改为级联清理：先逐个 `stopSession` 停掉绑定会话的运行中轮次（无在途轮次时幂等，不 kill、仅状态落库已结束），再在同一事务内按会话显式删 message → 删 session → 删 issue（不依赖 FK CASCADE 语义）；占用中仍 409 且不删。
- session repo 新增 `listSessionsByIssue`/`deleteSession`；message repo 新增 `deleteMessagesBySession`；表 DDL 与既有 FK 行为不变。
- 新增 WS 事件 `issue.deleted`（载荷 issue_id、workspace_id）与 `session.deleted`（载荷 session_id），事务提交成功后广播；shared WsEvent 类型同步补充。
- web 接入：`eventToQueryKeys` 对 `issue.deleted` 失效看板 issue 缓存、对 `session.deleted` 失效会话列表；ChatPanel 收到当前会话 `session.deleted` 后经 panelStore 新增 `removeSession` 清选中与未读计数回空态（详情页删除入口的二次确认 UI 既有，未改动）。
- 新增测试：server `test/deleteCascade.test.ts` 3 例（级联删除无残留+广播载荷、占用中 409 不删、运行中绑定会话先停后删）；web `ws.test` 2 例、`panelStore.test` 2 例、`chat.test` 2 例（当前/非当前会话删除后切换器剔除与空态）。

## [2026-11-01] 设置入口接入真实配置（端口/并发上限/主题，issue 65898a1b）

- 服务端新增 `GET /api/settings`：返回 config.json 持久化值与默认合并结果（环境变量覆盖不参与，端点只反映持久化值）；新增 `PATCH /api/settings`：zod 校验（port 1-65535、dbPath 非空、maxConcurrentTurns ≥1，至少一个字段，未知键忽略）后写回 config.json 并返回新值。
- `config.ts` 新增 `readSettings`/`writeSettings`；字段级容错合并提取为 loadConfig/readSettings 共用，loadConfig 既有语义（缺失写回、环境变量覆盖）不变。
- `sessionManager` 新增 `setMaxConcurrentTurns`：PATCH 并发上限变更时即时生效，校验同 init（非法 ValidationError、未装配报错）。
- 设置弹窗重写：打开拉取真实配置回填端口/并发上限/DB 路径，保存走 PATCH（400 展示服务端错误，成功静默关闭）；提示"端口 / DB 路径修改后需重启服务生效；并发上限即时生效"；主题并入弹窗三选项（浅色/深色/跟随系统，选中态高亮），localStorage 持久化与即时切换保留，顶栏循环按钮行为不变。
- `theme.ts` 主题状态改模块级单一来源（useSyncExternalStore）：弹窗显式选择后顶栏循环按钮标签同步刷新，`setTheme`/`cycleTheme`/`useTheme` 对外行为不变。
- 新增测试：server `test/settings.test.ts` 7 例（GET 默认值/文件值/env 不参与、PATCH 持久化回读、四类非法值 400、并发上限=1 后第二会话轮次排队、setter 装配与校验；配置隔离用 APPDATA 指向临时目录）；web `src/test/SettingsDialog.test.tsx` 4 例（回填、PATCH 请求体、400 错误展示、主题三选项即时生效+localStorage+选中态）。

## [2026-11-01] kb claim 占用任务的用户评论留言游标（issue 0afcf471）

- issue 表加列 `last_seen_comment_id TEXT`（NULL=无游标）：建表 DDL 同步更新；`initSchema` 启动时 `PRAGMA table_info` 检查缺列则 `ALTER TABLE ADD COLUMN`（存量库自动迁移）。
- `claimIssue` 同一 UPDATE 内将游标置为当前最新评论 id（领取输出视为已读，无评论为 NULL）；release/done/fail 释放 UPDATE 内游标置 NULL。
- 新端点 `POST /api/issues/:id/comments/consume`：事务内读全部评论、计算游标后的新评论 id 数组（时间序；游标 NULL 或失效视为全部待读）、推进游标到最后一条（无评论置 NULL）；重复调用第二次 new 必为空（恰好一次）。返回 `{comments, new_comment_ids}`；web 详情页 `GET /api/issues/:id/comments` 保持纯读。
- kb CLI `show`：评论改经 consume 端点拉取并标注——文本模式新评论行 `[新] ` 前缀，`--json` 每条评论加 `is_new` 布尔；consume 返回 404 等 HTTP 层失败（旧服务端）降级 GET comments 纯读不标注。
- web 评论区 hint 三态：绑定会话占用"将唤醒 <agent>"（woke 展示不变）/ kb 自助领取占用（session_id=null）"留言待 agent 下次读取" / 未占用"仅留言"。
- 新增测试：server `test/consume.test.ts` 6 例（claim 前评论视为已读、恰好一次、404、绑定会话 woke 回归、release/done 重置）；web 三态 hint 覆盖（新增 kb 占用态 1 例）；cli show consume 主路径/is_new/降级 4 例。
- 文档：设计文档 §5.8 用户发评论改双通道表述（绑定会话实时唤醒 / kb 占用待读恰好一次消费）、UI 提示三态；§6.1 接口表补 consume 行；agentboard SKILL.md 汇报节改为"CLI 领取无实时唤醒，留言 [新] 标注待下一次 kb show 消费"。

## [2026-10-31] 修复 kb CLI 网络层失败裸输出无上下文

- `packages/cli/src/api.ts`：fetch 网络层失败（TypeError，非 HTTP 非 2xx）在非 ECONNREFUSED 时不再直抛裸 `fetch failed`，统一包装为 `看板服务不可达（<服务地址>，用 --server 指定；<原始 message>）`，原始 message 取 cause 链各层去重拼接（undici 外层常为 "fetch failed"，真实原因在 cause）；原错误挂 `cause` 保留。ECONNREFUSED 分支"看板服务未启动"文案与 HTTP 非 2xx 行为不变。
- 新增测试：非法端口（99999）触发网络层失败 → 退出码 1，stderr 含友好文案、服务地址与原始 message。

## [2026-10-31] 修复 kb CLI 经 npm link 启动静默失效

- CLI 入口守卫（`packages/cli/src/index.ts`）改两侧 realpath 归一比较：argv[1] 经 `realpathSync` 归一后与 `import.meta.url` 比较，npm link 装机（junction/符号链接）启动时不再因链接路径与真实路径严格不等而跳过 `main()`；argv[1] realpath 失败视为不匹配，vitest 直接导入仍不触发。
- 新增回归测试 `packages/cli/test/entry.test.ts`：临时目录建 dist 目录 junction（Windows junction 仅目录目标可用，文件 symlink 需特权），真实进程 `node <链接>/index.js --version` 断言输出 0.0.0、退出码 0；dist 未构建时跳过。旧守卫下该测试失败、新守卫通过（已做负向验证）。

## [2026-10-31] agentboard skill 补 kb CLI 缺失处理分支

- SKILL.md 前置条件补自检命令 `kb --version`（流程第一步，输出版本号即 CLI 可用）。
- 新增"故障分支"：命令不存在（127）→ 在 AgentBoard 仓库 `packages/cli` 执行 `npm link` 装机并复验，工作空间无该仓库时报告"kb CLI 未安装"并给出安装命令；与服务未启动（1）查服务、任务被占用（2）换任务并列区分。
- exit 1 报错识别由匹配错误文本改为按退出码判断：实测连接被拒（ECONNREFUSED）才报"看板服务未启动（…）"，其余失败（如端口 1 的 `bad port`）stderr 只有裸 `fetch failed`。

## [2026-10-31] 修复看板卡片标题被裁与聊天会话刷新丢失

- 看板列卡片列表容器加 `overflow-y-auto`（列内滚动），IssueCard 根加 `shrink-0`（内容超高不再被等比压缩），标题第二行与底部元信息行不再被卡片底边裁掉；空列占位与 dnd-kit 拖拽行为不变。
- 服务端新增 `GET /api/sessions/:id`：返回完整 Session，不存在 404（复用 getSession，语义同 `/sessions/:id/messages`）。
- panelStore 接入 zustand persist（localStorage 键 `agentboard.panel`）：持久化 view/issueId/sessionId/chatSession/rightOpen，unread 不持久化；新增 `clearSession` 动作。
- ChatPanel 会话解析改三态：liveSession ?? 匹配的 chatSession ?? 按 sessionId 拉 `GET /api/sessions/:id`；拉取 404/失败清空 sessionId 回空态，不悬挂"会话加载中…"；当前工作空间暂无会话时空态提示"会话归属创建时所选的工作空间，可切换左侧工作空间查找"。
- DetailPanel 持久化 issueId 失效（issue 已删除）沿用既有错误处理；新增测试：server `/api/sessions/:id` 两例（存在/404）、web panelStore 持久化一例、ChatPanel 按 id 恢复一例（404 回空态）与空态归属提示一例。

## [2026-10-31] 修复聊天区新增消息顶开整页布局

- App 根容器 `min-h-screen` → `h-screen overflow-hidden`：恢复高度链（根有确定高度 → 中区 flex-1 生效），消息增长不再撑开整页滚动，各区域改为内部滚动。
- 左栏工作空间 aside 加 `overflow-y-auto`（列表过长自身滚动）；Board / RightPanel / ChatPanel / DetailPanel / MessageList 各级链核对无需改动（TopBar 已有 shrink-0，Board 列行与 DetailPanel/MessageList 已有 overflow 内滚结构）；新增 `App.test.tsx` 断言根容器与左栏滚动类。

## [2026-10-31] spawn 崩溃防御与模型真下拉

- 适配器 spawn 崩溃防御：`spawnLineChild` 挂 child `'error'` 处理器，spawn 失败（如 ENOENT）按异常退出归一——error.message 写入 stderr 尾部环形缓冲、failure promise 以 `SpawnFailedError`（code `SPAWN_FAILED`，message 含命令名与原始原因）reject、exit/close 事件流照常触发；`collectOutput` 据此 reject，`whereCommand` 把 finder 自身 spawn 失败归一为空结果（探测不抛错）。CLI 不存在时 `GET /api/clis/:id/models` 走 detect 未安装 → 200 空数组，服务进程不再因 unhandled `'error'` 崩溃。
- opencode `listModels`：`models` 两步探测改经 `resolveSpawnForm` 解析后的 cmd/prefix（与 detect/runTurn 一致），修复 win32 下裸 `opencode` 直 spawn 必 ENOENT。其余三家适配器核对无同类问题（codex/dsh listModels 为静态清单，codebuddy 已走解析 form）。
- web 模型字段改真下拉：新增共享组件 `ModelField`（react-query 拉 `/api/clis/{cliId}/models`；models 非空渲染 select——空值选项 + 模型列表 + 末尾"手动输入…"，选手动切文本输入、旁有"返回列表"回下拉；models 空/查询失败/cliId 空渲染纯文本输入）。`NewSessionDialog` 与 `ModelSelector`"修改模型"弹窗接入（testid 不变；留空清除与 loadLastModel/saveLastModel 语义保留）。

## [2026-10-31] 工作空间创建体验

- 新增工作空间弹窗加"浏览…"按钮：服务端 `POST /api/system/pick-folder` 经 PowerShell（`-NoProfile -NonInteractive -STA -Command` 参数数组、不经 shell）弹 `FolderBrowserDialog`，选中返回 `{path}`、取消返回 `{path:null}`、spawn/脚本失败 500 `PICK_FOLDER_FAILED`、已有窗口打开 409 `PICK_FOLDER_BUSY`（模块级 in-flight 守卫，finally 复位）；请求中按钮禁用并提示"请在弹出的窗口中选择文件夹"。
- 工作空间名称留空兜底：`POST /api/workspaces` name 允许空串（缺键仍 400），空 → 从 path basename（去尾部 `/`、`\` 后取最后一段）命名；弹窗内 name 未手动改过时随路径实时预填 basename，手动改过不再覆盖。

## [2026-10-31] 初版实现

- 脚手架：pnpm monorepo（apps/server、apps/web、packages/adapters、packages/cli、packages/shared、Docs）。
- 契约：shared 类型包（Issue/Workspace/Session/Message/Comment、统一事件协议）。
- 服务端数据层：SQLite（better-sqlite3）建表 + claim 原子领取事务（并发仅一成功）。
- 适配器：codebuddy / codex / opencode / dsh 四家无头执行器，统一事件协议（text/tool/error/end），win32 .cmd 垫片经 cmd.exe 包装；codex 选用 `exec --json`（实机验证 session_id 取 thread.started.thread_id）。
- 会话管理：轮次编排（新建/resume）、运行中消息排队与合并、停止（kill 当轮保留队列）、并发槽位上限默认 3、异常退出按失败处理并释放占用。
- 评论服务：评论入库与唤醒路由同函数完成（占用中起轮/入队合并，未占用仅留言）；CLI 探测缓存（四家版本号）。
- REST + WS 装配：工作空间/issue/claim/release/done/fail/comments/sessions/messages/stop 接口；WS 推送看板变更与会话事件流；POST /api/sessions 支持 model 留空与 reuse_session。
- kb CLI：list-spaces / list-tasks / show / claim / comment（--stdin）/ done（--notes）/ fail（--reason）；`--server` > `KB_SERVER` > 默认 8787；409 → 退出码 2；`--json` 原始输出。
- Web：Vite + React 19 脚手架、顶栏（工作空间/CLI 徽标/状态）、工作空间列表；四列看板 + dnd-kit 拖拽（乐观排序、占用卡禁拖）；右侧面板双视图（任务详情：字段编辑/评论时间线/会话列表/条件操作区/派发弹窗；聊天视图）。
- 聊天视图：流式渲染（ws delta 拼接）、tool/thinking 折叠块、排队计数、停止按钮、会话切换器、模型修改下一轮生效。
- 构建：server 静态托管 apps/web/dist（存在时启用 SPA fallback）。
- Skill：`skills/agentboard/SKILL.md`（领取→执行→汇报流程、占用规则、kb 用法）。
- 文档：DESIGNS.md / CHANGELOG.md / PENDING_TESTS.md / README.md；全链路冒烟（kb CLI 全命令、REST、web 托管、codebuddy 最小派发）。

## [2026-10-31] 完成审计修复

- 适配器：LineChild 增加 stderr 尾部 30 行环形缓冲；exitCode≠0 或 exit 0 零事件且无会话 ID 时，发送含 stderr 尾部的诊断 error 事件并落会话消息。
- 适配器：.cmd/.bat 垫片改为解析 shim 内容直取 node 入口启动（替代 cmd.exe 包装；实测 cmd.exe 包装丢参数致交互模式挂死）；spawn stdin 改为 ignore，防 CLI 等待输入。
- 评论：POST comments 支持可选 agent_id → author=`agent:<id>`；kb comment 经 `KB_AGENT` 环境变量上报作者。
- 接口：补 `GET /api/issues/:id`（kb show 用）；`PATCH /api/sessions/:id` 支持修改 model（下一轮生效）。
- 冒烟结论：codex 端到端闭环（派发→真实执行→assistant 内容"OK"→会话"已结束"→强制释放回收）；codebuddy 本机 401（CODEBUDDY_AUTH_TOKEN 对 CLI 直连失效），转人工项；dsh 本机 shim 损坏，转人工项。
- 顶栏聊天入口与右缘常驻窄条（首次进入即可达聊天视图）。
