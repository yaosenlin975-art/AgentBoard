# PENDING_TESTS.md

需开发者自行人工验收的项。

- [ ] AgentBoard CodeBuddy 原生图片输入合成图复验（IMG-04）
  - 步骤1：仅在 CodeBuddy adapter 调用可禁用 tools 并限制为只读执行时，使用独立临时数据库、合成工作空间、合成 issue 和标记图；工作目录固定在临时工作空间，KB_SERVER 固定到隔离 18788 fixture
  - 步骤2：经 AgentBoard adapter 派发首轮图片和同一绑定会话的第二批图片，不执行模型写入或业务任务
  - 步骤3：核对每批最多 5 张/20 MiB、提示与响应剩余数、selected-ID 回执、unknown 显式确认与幂等重放
  - 预期结果：图像输入准确进入两轮模型请求；超限尾项保持待读；失败后不自动重发；该回执只表示 CLI 轮次返回成功
  - 阻塞：当前 CodeBuddy adapter 的 `-p` 调用未证明 tools 可禁用或只读；完成权限隔离前不运行 AgentBoard 模型调用

- [ ] IMG-03 OpenCode 与 DSH 原生图片输入复验
  - 步骤1：OpenCode 首轮用 `run --file` 提交合成标记图，读取实际模型结果；用 `--session` 对同一会话提交第二张标记图
  - 步骤2：DSH 命令入口恢复后，用其原生图片参数重复首轮与续会话标记图测试
  - 预期结果：每个成功支持的模型准确识别图片标记；未授权、无图片能力或入口缺失继续标为未知/受阻

- [ ] 真实四家 CLI 各一次完整派发
  - 步骤1：起服务（默认端口 8787），在看板建测试工作空间与 issue
  - 步骤2：逐家派发最小任务（如"回复两个字：完成"），观察聊天视图流式输出与会话结束状态
  - 步骤3：确认 agent 执行 `kb done` 后 issue 进"待验收"、占用释放、notes 落评论流
  - 预期结果：四家均有 assistant 回复渲染，会话状态"已结束"，issue 占用释放
  - 说明：codex 2026-10-31 已经服务端端到端验证通过（派发→thread.started→assistant"OK"→已结束→强制释放；本轮耗时 138s 系本机代理网络超时重连）。codebuddy 本机 401（CODEBUDDY_AUTH_TOKEN 对 CLI 直连失效，stderr 已可在会话消息中看到该诊断）——修复登录后重测；opencode 未跑端到端（run --format json 实测有 JSONL 输出）

- [ ] dsh 实机派发
  - 步骤1：修复本机 dsh.cmd（当前运行即 node loader 报错；/api/clis 中 dsh 版本字段读到该报错文本）
  - 步骤2：按"真实四家 CLI"步骤重跑 dsh 一项
  - 预期结果：dsh 会话可建立并产出回复，版本徽标显示正常版本号

- [ ] 拖拽手感与占用禁拖
  - 步骤1：跨列与列内拖拽排序，刷新后顺序保持
  - 步骤2：派发后（卡片显示占用徽标）尝试拖出该卡片
  - 预期结果：普通拖拽正常落位；占用卡光标禁止、无法拖出

- [ ] 评论唤醒运行中合并
  - 步骤1：派发一个稍长任务，会话运行中在评论区发一条留言
  - 步骤2：观察提示"将唤醒 <agent>"；当轮结束后聊天视图自动续轮并包含留言内容
  - 预期结果：不产生并行轮次，留言合并为一条 prompt 进入下一轮

- [ ] 停止与恢复
  - 步骤1：运行中会话点停止按钮，确认进程终止、状态"已结束"、排队消息保留可编辑
  - 步骤2：续聊发送新消息，确认 resume 续上下文正常
  - 预期结果：停止后不丢排队消息；恢复后 agent 保有此前上下文

- [ ] 聊天流式渲染视觉
  - 步骤1：派发任务观察流式输出：markdown 渲染、代码高亮、tool/thinking 折叠块开合
  - 步骤2：确认运行中底部流式指示、结束后内容落定
  - 预期结果：无闪烁/错位，折叠块展开收起正常

- [ ] 主题切换
  - 步骤1：设置入口切换浅色/深色/跟随系统
  - 步骤2：刷新页面确认持久
  - 预期结果：切换即时生效并持久化

- [ ] 重启系统后服务自启
  - 步骤1：确认 Run 键存在：`reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v AgentBoard`（已安装，勿执行 uninstall）
  - 步骤2：重启 Windows 并登录（不手动启动服务）
  - 步骤3：访问 http://127.0.0.1:8787
  - 预期结果：登录后约 10 秒内页面可访问；%APPDATA%\AgentBoard\logs\autostart.log 有 `mode=autostart launched` 记录，无闪窗

- [ ] 双击桌面快捷方式拉起并打开网页
  - 步骤1：先执行 kb autostart install，再 kb shortcut create，确认桌面出现 AgentBoard 图标快捷方式
  - 步骤2：停止看板服务（或重启后未自启场景）后双击快捷方式
  - 步骤3：观察默认浏览器打开看板页面
  - 预期结果：服务未起时双击先隐藏拉起（无闪窗）再自动打开 http://127.0.0.1:8787；服务已起时直接打开


- [ ] WorkBuddy Desktop UIA 托盘退出真机观察（ACC-05）
  - 步骤1：WorkBuddy 运行中，发起一次切换（POST /api/managed-accounts/:id/switch 或账号页），观察是否自动弹出托盘右键菜单并点到「退出」
  - 步骤2：若 UIA 未生效，观察收到 WS account.notice 提示「请手动退出 WorkBuddy」后手动托盘退出，切换是否继续
  - 步骤3：对照 `~/.workbuddy/logs`、任务管理器进程数与 auth/window-state 文件时间戳
  - 预期结果：自动或手动退出后切换继续；全程无 taskkill/强杀；退出签名（进程清零 + window-state mtime 晚于 auth）可复现

- [ ] WorkBuddy Desktop 双账号真实闭环（ACC-05，需第二个已授权测试账号）
  - 步骤1：账号 A 登录 WorkBuddy → 账号页「保存当前账号」捕获 A（is_current=true）
  - 步骤2：客户端内退出登录、登录账号 B → 再次「保存当前账号」捕获 B（A 转 false）
  - 步骤3：切换到 A：等待自动/手动退出 → 写入 → 重启 → 核验；看板与客户端显示 A
  - 步骤4：切换回 B 核验；随后再次切换 A 中途观察失败路径（可选：切换前把 A 的快照文件改名制造 validate 失败）确认拒绝不写
  - 步骤5：回滚演练：制造写后失败（如断网/改端口等导致启动超时），确认自动回滚恢复 B 并核验、operation 显示 SWITCH_ROLLED_BACK
  - 预期结果：A/B 往返切换后客户端登录身份与所选账号一致；validate 失败时 .info 字节不变；回滚后原账号可正常使用；数据库/日志无 token 原文或信封字节

- [ ] IMG-04 真实 CodeBuddy 原生图片交付（人工验收 / 需真实账号授权｜2026-11-02）
  - 前置：`codebuddy --version` == `2.179.2`（2026-11-02 本机只读探测实测 2.179.2，与已验证门禁一致）；模型须为 `minimax-m3.1-flash`；服务用隔离实例（AGENTBOARD_PORT=18789 + 独立 AGENTBOARD_DB/APPDATA/附件根），避免污染正式 8787 数据
  - 步骤1：生成合成标记图（不调用任何 CLI/模型）
    `node apps/server/test/fixtures/img04ManualImages.mjs apps/server/test/.fixture-img04/manual-images`
    → 生成 marker-1..6.png：绿底 + 左上角洋红方块 + 方块内黑色数字=标记值，每个 196957 字节
  - 步骤2：上传并挂到同一合成 issue 的评论（单条评论 ≤5 张）
    `curl.exe -s -X POST "http://127.0.0.1:18789/api/workspaces/<wsId>/attachments" -H "Content-Type: image/png" -H "X-File-Name: marker-1.png" --data-binary "@<marker-1.png 路径>"` → 返回 `{"id":"<attachmentId>","size_bytes":196957,...}`
    `curl.exe -s -X POST "http://127.0.0.1:18789/api/issues/<issueId>/comments" -H "Content-Type: application/json" -d '{"content":"标记图 1-5","attachment_ids":["<id1>","<id2>","<id3>","<id4>","<id5>"],"agent_id":"mcode","workspace_id":"<wsId>"}'`
  - 步骤3：首轮派发（提交 6 张 → 服务端只发 ≤5 张且 ≤20 MiB 的有界前缀）
    `curl.exe -s -X POST http://127.0.0.1:18789/api/sessions -H "Content-Type: application/json" -d '{"issue_id":"<issueId>","cli":"codebuddy","model":"minimax-m3.1-flash","selected_attachment_ids":["<id1>","<id2>","<id3>","<id4>","<id5>","<id6>"]}'`
    → 预期：响应含 `"remaining_attachment_count":1`；会话 prompt 尾段出现「## 图片派发状态 / 另有 1 张未附，仍保持待读。」；模型回复中出现前 5 张的标记数字（1..5）
  - 步骤4：同一绑定会话续批第 6 张
    `curl.exe -s -X POST http://127.0.0.1:18789/api/sessions -H "Content-Type: application/json" -d '{"issue_id":"<issueId>","cli":"codebuddy","model":"minimax-m3.1-flash","reuse_session":"last","selected_attachment_ids":["<id6>"]}'`
    → 预期：返回同一 session id（不新建会话）；模型回复出现第 6 张的标记数字（6）
  - 步骤5：回执与上限核对
    `curl.exe -s "http://127.0.0.1:18789/api/issues/<issueId>/pending-attachments"` → 预期：已交付 5 张不再出现，剩余待读仅第 6 张
    `curl.exe -s "http://127.0.0.1:18789/api/sessions/<sessionId>/messages"` → 预期：user 消息里可见「## 本批随附图片评论引用」与「另有 N 张未附」；实际发送图片数以适配器 stdin 的 base64 image 块数为准（≤5、合计 ≤20 MiB）
  - 预期结果：首轮与续批两轮模型回复都能读出合成标记数字；超限尾图保持待读；selected-ID 回执只标记本批已交付图片
  - 实际状态：**未执行**（2026-11-02）。任务卡「执行条件」写明「不执行真实账号操作；人工模型调用未验证项明确标记」，故本轮只做只读能力探测（`codebuddy --version`）+ 测试替身端到端验证，未发起任何真实模型推理请求
  - 阻塞原因：需用户显式授权真实账号调用（消耗账号额度）。AgentBoard adapter 的 CLI 调用形态为 `codebuddy -p [--model ...] [--resume ...] --output-format stream-json --input-format stream-json --verbose`（图片以 base64 image 块走 stdin），**没有可验证的 tool-disable / 只读参数**，故在授权前不宜由 agent 自行发起推理
  - 已具备的替代证据：假适配器隔离 fixture 59/59 断言通过（见任务卡 2026-11-02 mcode 评论）：有界前缀 ≤5 张/≤20 MiB、prompt「另有 N 张未附」、remaining_attachment_count、只标记本批已交付 ID、失败转 unknown 且待读游标不推进不自动重发、retry_unknown_images 显式确认才重发、幂等重放不重复创建评论
