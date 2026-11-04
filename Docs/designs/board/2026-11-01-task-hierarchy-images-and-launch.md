# 递归子任务、评论图片与启动体验设计
- status: proposed
- date: 2026-11-01
- card: -
- supersedes: -

日期：2026-11-01

状态：需求与增量路线已确认。TREE-01/02 实现、自动检查及真实浏览器验收完成；IMG-01/02 实现与自动检查完成，IMG-02 隔离浏览器验收完成；IMG-03 完成 CLI 图片输入核验；IMG-04 实现与定向自动检查完成，父代理审阅待完成；AgentBoard 中的真实 CodeBuddy 适配器模型调用未验证。MODEL-01 隔离浏览器验收完成；Windows 冷启动仍待验收。

## 1. 需求与范围

已确认需求：

- 支持递归子任务；父任务保留单独验收。
- 评论支持图片；图片须交付给 CLI 模型。
- Windows 登录后隐藏启动服务，不弹出网页。
- 桌面快捷方式启动服务并打开网页。
- 修复新建会话选择 CLI/model 后退化为只能手输的问题。

实施按任务卡拆分。TREE-01 与 TREE-02 已实现；IMG-01/02 的存储、评论编辑和历史图片展示已实现；IMG-03 核验部分 CLI 输入契约与当前模型能力；IMG-04 已实现已验证图片模型的派发、唤醒和会话集成。

## 2. 方案选型

用户选择：现有 Web、Express、SQLite、CLI adapter 增量扩展。

| 方案 | 范围与成本 | 决策 |
| --- | --- | --- |
| 现有 Web 增量 | 扩展任务关系、附件接口和 adapter；复用启动器 | 已选择 |
| 桌面壳 | 新增打包、升级、窗口与服务生命周期 | 本次不采用 |

依赖建议：不新增依赖。单图上传使用 Express raw 二进制请求；树使用 SQLite 与现有 React/dnd-kit；启动复用现有 Windows 原生实现。

| 候选 | 核对版本与许可证 | 匹配、兼容、采用成本及验证 | 推荐 |
| --- | --- | --- | --- | --- |
| [multer](https://raw.githubusercontent.com/expressjs/multer/main/package.json) | main 声明 2.5.0，MIT，Node ≥10.16 | Express multipart；当前项目 Express 5.3.0，实际集成未验证；需增加依赖与上传中间件 | 当前采用 raw；需要 multipart 时重新评估 |
| [auto-launch](https://raw.githubusercontent.com/Teamwork/node-auto-launch/master/package.json) | master 声明 6.0.0-rc.2，MIT，Node ≥14 | 支持 Windows 登录启动；引入 winreg 等依赖并替换现有实现；未安装验证 | 复用现有 HKCU + WSH |
| [open](https://raw.githubusercontent.com/sindresorhus/open/main/package.json) | main 声明 11.0.4，MIT，Node ≥20 | 跨平台打开 URL；Node 范围匹配，增加多个依赖；未安装验证 | 复用 WSH 打开默认浏览器 |

版本来自核查时仓库分支声明，不等同已发布最新版。本文不复制候选代码。

## 3. 当前证据

以下路径相对于项目根目录；本轮为静态核查，未重跑测试。

| 文件 | 已核实事实 |
| --- | --- |
| apps/server/src/db/schema.ts:10 | issue 无父任务字段；:19 评论只有文本内容 |
| apps/server/src/db/repos/issue.ts:50 | 创建无父任务字段；:174 删除当前 issue |
| packages/cli/src/commands/comment.ts:5 | 仅 text/stdin；:29 POST 仅 content/agent_id |
| packages/adapters/src/types.ts:10 | RunTurnOptions 无附件 |
| apps/server/src/services/dispatch.ts:98 | 构造文本派发内容；:129 发送 prompt |
| packages/adapters/src/opencode.ts:111 | 模型探测 JSON 失败后尝试纯文本；:131 run 无附件参数 |
| apps/web/src/components/chat/ModelField.tsx:38 | 查询模型列表；:56 当前值不在列表时转手输；:146 列表非空才显示返回按钮 |
| apps/web/src/components/chat/NewSessionDialog.tsx:49 | 恢复 localStorage 上次模型 |
| scripts/agentboard.vbs:37 | autostart 隐藏启动；:43 open 探测后打开网页；文件为安装前占位模板 |
| packages/cli/src/commands/shortcut.ts:25 | WSH COM 快捷方式；:56 检查启动器已配置 |

Docs/CHANGELOG.md:264 已记录模型下拉、手输及返回列表；不能重复将按钮列为未实现功能。

## 4. 递归任务的数据与接口

- issue 增加可空 parent_issue_id，引用同 workspace 的 issue；增加父字段索引。
- 根任务 parent_issue_id=null；一个任务最多一个父任务。
- 创建或改父级时在统一 service 事务中验证父节点存在、同 workspace、无自引用、无环；同步校验整个移动子树。
- 不设置业务固定层数；查询使用有界分页或遍历，循环数据报完整性错误。
- status、claim、评论、派发和验收按节点独立；父任务可继续汇总工作。
- 未全部后代关闭时，禁止父任务转为已关闭；待验收仍独立存在。
- 删除有直接子任务的节点返回冲突；先移动或删除子任务。外键采用 RESTRICT，不级联删除任务树。
- 创建/更新/读取任务 API、共享类型、CLI 和 MCP 同步 parent_issue_id；统一走 service，保持 workspace 作用域、owner 守卫、CAS 和幂等契约。
- 原平铺列表保留；树查询以固定 sort_order、created_at、id 复合键确定性排序，使用包含排序键及查询范围的续读游标；每页携带该页命中项的祖先上下文与子项续读信息。祖先上下文不计入命中项分页数量。分页不得产生无祖先的孤立子项；查询条件变化时丢弃旧游标重新读取。
- UI 支持展开子项、独立状态、祖先路径和后代关闭进度；过滤命中子项时保留祖先上下文。

已落地的服务接口：

- `POST /api/issues` 可选 `parent_issue_id`；未传或传 null 创建根任务。
- `PATCH /api/issues/:id` 可选 `parent_issue_id`；未传不改变父级，传 null 移至根任务。
- `GET /api/issues` 保持平铺；返回每个任务的 `parent_issue_id`。
- `GET /api/issues/tree?workspace=<id>&parent_issue_id=<id>&limit=<n>&status=<状态>&cursor=<值>` 分页读取指定父任务的直接子项。根任务查询省略 `parent_issue_id`。响应 `{ items, ancestors, next_cursor }`；每个 item 含 `child_count`、`descendant_count`、`descendants_closed_count`。
- cursor 绑定 workspace、父任务、状态筛选和上一项的 `sort_order`、`created_at`、`id`；排序键按三字段升序。状态筛选作用于直接子项，ancestors 返回未按状态筛选的根到父路径。
- `kb create-issue --parent` 创建子任务；`kb move-issue --parent` 移动，`--root` 移至根任务；`kb list-tasks --tree` 遍历续读页并保留命中子项祖先。
- MCP `agentboard_list_tasks` 支持 `tree=true`、`parent_issue_id` 和 `cursor`；create/update task 支持父字段，root 使用 null。
- SQLite 增量迁移添加 nullable self-FK 与 `ON DELETE RESTRICT`；同空间关系和更新防环由触发器保护。workspace 整体删除先清空内部父引用，再依原级联删除。

错误：父任务不存在返回 404；跨空间、环或非法字段返回校验错误；版本冲突、删除有子节点或关闭条件未满足返回 409，并携带可操作原因。

迁移：增加幂等增量迁移，不改 pinned DDL；旧任务均为根任务；旧调用方未传父字段保持行为。

## 5. 评论图片的数据与接口

当前限制：PNG/JPEG/WebP，单图 10 MiB，每评论最多 5 张；允许纯图片评论。

- 附件元数据：随机 id、workspace_id、受控存储键、清理后的文件名、检测 MIME、字节数、创建时间、提交状态（staged → attached）。
- comment_attachment 关联 comment_id、attachment_id、展示顺序；附件不可跨 workspace 绑定；每附件由单个评论拥有，禁止跨评论重复绑定。
- 私有附件目录不挂静态资源；服务端以随机存储键写入，拒绝客户端文件路径。
- 新增单张 raw 上传接口、受控下载接口；具体路由与现有 API 命名对齐后登记。
- 上传验证请求体大小、文件 magic、MIME 一致性和允许类型；校验失败不落正式附件。
- 评论提交接收 content 与 attachment_ids；至少有正文或一个有效附件。正文和附件关联事务提交；仅允许绑定同 workspace、未过期、尚未绑定的 staged 附件并转为 attached。提交使用幂等请求键；相同请求重放返回原结果，不重复绑定。
- 下载检查附件对应 workspace/任务访问范围；不向 API 返回私有文件绝对路径。
- 评论列表、WS 推送、consume 和 MCP 只读结果返回附件 metadata 与受控引用。
- CLI comment 扩展附件上传/引用入口，禁止直接接受服务端任意文件路径。

前端：文件选择、粘贴和拖拽统一进入同一 pending attachment 状态；按当前 Workspace raw 上传并显示本地预览、上传状态、删除与重试。所有附件上传完成后与正文一同提交；提交失败保留正文和已上传附件草稿；历史图片使用 Issue 作用域下载 URL，WebSocket 评论事件刷新同一评论查询。

回收：评论/任务删除事务内移除关联与附件 metadata，同时写入受控待清理记录；文件仅在 commit 后按存储键回收。失败保留待清理记录并重试，回收前在 SQLite immediate 事务内确认无活跃引用；事务失败不删除文件。staged 草稿默认保留 24 小时，每 1 小时清理；附件磁盘配额默认 1 GiB，超限拒绝上传并保留已有草稿。以上参数可在持久设置中调整；并发上传使用 immediate 事务预留配额，避免突破上限。

IMG-01 已落地：新增 `/api/workspaces/:workspaceId/attachments` raw 上传、Workspace staged 下载和 Issue 关联下载；PNG/JPEG/WebP 魔数与 MIME 校验。附件评论在同一事务绑定并可重放幂等请求；评论列表、WS、consume、CLI show 和 MCP 只读评论工具带附件元数据。IMG-04 仅对已验证的 CodeBuddy/MiniMax-M3.1-Flash 组合启用原生图片输入；未验证组合阻止图片派发/唤醒。投递状态可见；pending、sending、unknown 评论均阻止 consume 游标前进。

IMG-02 已落地并通过隔离浏览器验收：文件选择、剪贴板与拖放共用附件草稿；支持纯图/图文提交、失败保留、重试和 Issue 作用域历史图。历史图首次加载及刷新后均可见。下载只使用服务端解析的 UUID 存储键；附件目录含点目录段时仍能读取，不暴露私有绝对路径。

## 6. 图片交付模型

- adapter 统一输入增加 attachments；服务端从已授权附件引用解析本地文件，不接收调用方任意 path。
- 对 codex、opencode、codebuddy、dsh 分别记录本机 CLI 版本、首次轮次及续会话原生图片输入契约、模型视觉能力与验证结果。
- 能力支持且已验证时，使用 CLI 原生附件参数交付；当前启用组合为成功探测到 CodeBuddy Code 2.179.2 + MiniMax-M3.1-Flash 的 stream-json 图片块输入。版本缺失、探测失败或版本不匹配均按不支持处理；派发、评论唤醒、排队起轮和适配器调用使用同一版本+模型门禁。
- 能力未知或不支持时阻止含图片派发/唤醒，明确提示更换 CLI 或模型；保留评论、附件与待读状态。Codex CLI 的合成图片输入虽有识别结果，但本机未返回模型名，AgentBoard 不启用该组合。
- 附件状态使用 pending/sending/unknown/delivered；在途请求于进程重启后转为 unknown。unknown 阻止 consume 游标推进，显示在评论图片下。
- unknown 不自动重发；再次派发包含 unknown 图片必须由用户勾选 `retry_unknown_images` 确认。纯文字留言不夹带历史图片。
- `GET /api/issues/:id/pending-attachments?limit&offset` 按评论时间、评论 ID、附件位置升序分页，只返回 pending/unknown 的图片 metadata、关联评论作者/时间和正文片段；每页默认 20、最大 100，片段最多 500 Unicode code points，不返回私有路径。
- 派发请求传 `selected_attachment_ids`（最多 100 个显式 opaque ID，仅 issue-bound session 可用）与 `retry_unknown_images`。服务端按 issue/workspace 重新校验每个提交 ID 的归属与状态，再按评论时间、评论 ID、附件位置排序；实际投递为所选列表中最多 5 张且总大小 ≤20 MiB 的有界前缀，遇到超限即停止，不跳过超限项。其余 pending/unknown 保持待读；提示标注 `另有 N 张未附`，响应返回 `remaining_attachment_count`。
- 派发弹窗逐页展示所有 pending/unknown 图；默认按最旧顺序选择，最多 5 张且总量 ≤20 MiB。用户可加载更多并选择超限集合；服务端仅派发有界前缀，界面说明其余仍待读。选中实际投递前缀中的 unknown 时须显式确认；未进入前缀的 unknown 不需要本批确认。
- 用户确认 unknown 重试时记录对应的实际 unknown attachment IDs。全局槽位取得后、调用适配器前，在 SQLite immediate 事务内重新检查所选 IDs 并原子切换为 sending；pending 可发送，unknown 仅允许本次明确授权的 IDs，重复、sending 或 delivered IDs 拒绝且不调用适配器。
- 适配器输入仅含实际投递前缀的附件受控路径；提示中只附这些图片关联评论的作者、时间和最多 500 字符片段。成功回执仅标记本批 attachment IDs。响应的剩余数包括未选与被截断图片；下一次显式派发可选择下一批旧图。
- delivered 表示支持的 CLI/model 轮次成功返回的输入投递回执，不表示看板业务任务已完成。未知模型、非零退出或轮次结果异常均保持待读并显示 unknown。
- 活跃会话唤醒只传本次新评论附件；初始派发只传 UI 显式选择的图片，不限最近 10 条评论窗口。旧图分页选择并分批发送；每批最多 5 张且 ≤20 MiB。
- 派发弹窗限制在视口高度内并提供内部纵向滚动，长列表、错误提示、unknown 确认和底部操作均可触达。

[OpenCode CLI 文档](https://dev.opencode.ai/v2/docs/cli/commands/)列出 run --file；[附件文档](https://dev.opencode.ai/v2/docs/attachments/)要求图像输入模型。不支持的附件可能仅得到说明。本机参数、续会话和截图所选模型的视觉能力尚未验证；把路径写入 prompt 不构成图片交付验收。

IMG-03 核验结果见 `Docs/verification/2026-11-02-image-cli-contracts.md`。Codex CLI 0.166.0 的 `exec --image` 与 `exec resume --image`、CodeBuddy Code 2.179.2 的 stream-json image block 均完成合成图首轮/续会话识图；CodeBuddy 当前模型为 MiniMax-M3.1-Flash。OpenCode CLI v2.2.0 的 `run --file` 首轮调用未返回 assistant 内容，续会话未验证；DSH 0.2.1-rc.5 命令入口因缺失模块不能运行。模型标签未返回的会话不推断具体模型；上述结果只代表本次 CLI 与当前选中模型，不代表同产品所有模型或桌面客户端。

IMG-04 将 CodeBuddy verified model gate、首轮/续会话 stream-json 输入、服务端派发/唤醒/排队、投递状态、consume 游标、显式旧图分批选择和 retry_unknown_images 接入 AgentBoard。适配器和 server/web 定向测试覆盖失败保留和幂等评论行为；未通过真实 AgentBoard CodeBuddy 模型调用复验。

## 7. Windows 启动

复用既有卡 a0550248-8d98-4fea-bbee-c4f2ab63c655（待验收、核查时未占用）。

- 登录启动复用 kb autostart install/uninstall/status、HKCU Run 和 WSH 隐藏启动。
- 快捷方式复用 kb shortcut create/remove 和 vbs open；服务可达直接开页，不可达先启动并等就绪。
- 安装配置状态与源码模板分别报告；本轮不修改注册表或创建快捷方式。
- 引用 Docs/PENDING_TESTS.md 现有真实重启与双击冷启动项。

旧卡评论报告 CLI 63/63、tsc 与部分冒烟通过；本轮未独立复验。真实重启自启与双击冷启动不得据此宣告通过。

## 8. 模型选择修复边界

- 复现记录 CLI 版本、部署版本、模型探测 API 响应、localStorage 模型值和查询状态；截图仅作症状证据。
- 区分加载、失败、空列表、缓存旧模型与用户主动手输。
- 列表非空时始终允许返回列表；保留旧模型值，并明确其不在当前列表的状态，避免旧值永久占用输入模式。
- 提供刷新模型与主动自定义入口；空列表或探测失败显示原因和重试入口。
- 修改共享 ModelField，覆盖新建会话及修改模型等消费路径；保持只读 CLI 能力位。
- 本次不归因于特定 CLI 的探测故障；真实 CLI 清单探测仍单独保留为未验证项。
- MODEL-01 已实现：加载、失败、空清单和旧缓存值在公共 ModelField 中分别呈现；新建会话及修改模型两条路径已覆盖。隔离浏览器 mock 验证通过；未做真实 CLI 探测。

## 9. 验收与待验证

| 任务线 | 可复现验收 |
| --- | --- |
| 递归任务 | 三层以上创建/移动/筛选/续读；拒绝跨空间、自引用、间接环；子任务独立 claim；后代未关闭不能关父；删除有子节点返回冲突；旧任务读取兼容 |
| 评论图片 | IMG-01/02 自动/API检查与隔离浏览器验收已覆盖选择、粘贴、拖放、纯图/图文提交、历史图刷新、失败保留与重试、5 张上限、键盘和窄屏；10 MiB 上限由定向测试覆盖，浏览器未实际上传超限文件。IMG-04 服务端及界面定向测试覆盖已验证模型派发、唤醒、排队、续会话、游标门禁、未知状态和显式分批；每批≤5张且≤20 MiB，未选图片保持待读 |
| 模型交付 | Codex 与 CodeBuddy 当前模型已用两张合成标记图验证首轮及续会话输入；OpenCode 与 DSH 结果未知/受阻。Codex 模型标签未知所以 AgentBoard 禁止其图片输入；CodeBuddy 的实际图片支持仅限 MiniMax-M3.1-Flash。未通过 AgentBoard 真实 CLI/model 调用复验 |
| Windows | 复用旧卡人工验收：重启登录后隐藏服务且无网页；服务未运行时双击快捷方式后服务就绪并开页 |
| 模型控件 | 已完成隔离浏览器验证：模拟旧缓存值、清单选择、失败重试与窄屏状态；新建与修改模型共用 ModelField。真实 CLI 探测仍未验证 |

未验证：OpenCode 与 DSH 的模型图像输入、Codex 会话所选模型的具体名称、AgentBoard 中真实 CodeBuddy adapter/model 调用、Windows 重启/冷启动、真实 CLI 模型清单探测、上传限制的使用适配性。

## 10. 任务卡去重与后续

- 自启与快捷方式引用 a0550248-8d98-4fea-bbee-c4f2ab63c655，不新建重复实现卡，不重开已完成实现。
- 递归任务、评论附件/交付与模型控件已按功能线拆卡；后续状态以实时看板为准。
- 模型卡描述复现证据和目标行为，不写“新增返回列表按钮”。
- 不操作他人占用任务；创建前再次读取最新任务列表。
- 实时状态以看板为准。TREE-01/02、IMG-01/02 与 MODEL-01 已完成对应实现及验收；IMG-03 完成能力矩阵核验；IMG-04 实现和定向自动检查完成，真实 AgentBoard CodeBuddy 调用与父代理审阅仍待完成；Windows 自启和快捷方式冷启动保持待验收。

## 11. 任务卡映射

- f5e2d993-25eb-4733-9f2a-24f34325e6ad：【TREE-01】递归子任务数据与 API/CLI/MCP 统一契约
- a4cb8c1b-ff3d-499d-8762-8cc06695892a：【TREE-02】任务树界面与层级操作
- df9de099-6784-493f-b904-1b32110a9044：【IMG-01】评论图片存储、API 与事务回收
- aa26d495-674d-45e1-a688-85815f9193b3：【IMG-02】评论图片选择、粘贴和拖拽界面
- 5399e104-bebf-4a70-a1d9-e8ab16242095：【IMG-03】CLI 首次与续会话图片及模型视觉能力核验
- 077ece77-75d3-40cf-adcc-c8b08b731e84：【IMG-04】已验证图片能力的派发、唤醒与会话集成
- ec1ce806-6c2b-4d45-b425-36aa7367f5d7：【MODEL-01】模型下拉退手输真实复现与公共控件修复

依赖：TREE-02 → TREE-01；IMG-02 → IMG-01；IMG-04 → IMG-01、IMG-03（完整 UI 验收依赖 IMG-02）；TREE-01、IMG-01、IMG-03、MODEL-01 可独立启动。

Windows 登录自启与桌面开页：复用 a0550248-8d98-4fea-bbee-c4f2ab63c655（开机自启与桌面快捷方式，待验收）；未改状态、未重复建卡。真实重启与双击冷启动仍待人工验收。
