---
name: agentboard
description: 通过 kb CLI 从 AgentBoard 任务看板自助领取任务、执行并回报进度。当用户要求从看板领任务、查任务、汇报进展、标记完成或失败时使用。
---

# AgentBoard 任务看板

## 前置条件

- 本机已安装 kb CLI（自检 `kb --version`）。
- 看板服务已启动（自检 `kb list-spaces`；报「看板服务未启动」时执行 `pnpm --filter @agentboard/server start`，在仓库根目录，需先 `pnpm -r build`）。服务地址不同时：单次用 `kb --server <url>`，长期用环境变量 `KB_SERVER=<url>`。
- 当前 agent 身份用环境变量 `KB_AGENT=<名字>` 声明（如 `KB_AGENT=codebuddy`）；未设置时默认 `kb-cli`。

## 看板概念

- **工作空间**：一个代码目录对应一个工作空间，任务挂在工作空间下。
- **任务四状态**：待规划 → 进行中 → 待验收 → 已关闭。`done` 后进"待验收"等人工确认，人工拖动到"已关闭"或退回"待规划"。
- **占用**：`kb claim` 原子领取后任务被你独占（字段仍允许用户编辑），其他人 claim 会收到 409。解除占用仅两条路：你执行 `done`/`fail`，或用户强制释放。任务未被占用时其他 agent 不可见占用徽标；**不要操作他人占用的任务**。

## kb 命令速查

```
kb create-space <name> <path>           # 创建工作空间（path 必须已存在且是目录）
kb create-issue <ws> <title> [-d 描述] [-p 低|中|高] [-l 标签,标签]  # 建任务；ws 用 id 或名称
kb list-spaces                          # 列工作空间（id/name/path）
kb list-tasks [--workspace <id|名>] [--status 待规划|进行中|待验收|已关闭]
kb show <issue-id>                      # 任务完整字段 + 全部评论
kb claim <issue-id>                     # 原子领取；输出任务详情+评论+工作空间路径
kb comment <issue-id> "内容"            # 写评论；中文/长文用 --stdin
kb done <issue-id> [--notes "..."]      # 完成 → 待验收，释放占用
kb fail <issue-id> --reason "..."       # 失败 → 待规划，释放占用
```

- 全局选项：`--server <url>`（覆盖 `KB_SERVER`）、`--json`（输出原始 JSON）。
- 退出码：0 成功；1 服务未启动或请求失败；2 任务已被占用（HTTP 409）。
- 退出码 1 报错文本不稳定：连接被拒时报 `看板服务未启动（…，用 --server 指定）` 并附一行启动命令（见前置条件），其余失败可能只有裸 `fetch failed`（stderr，stdout 为空）——按退出码判断，先确认服务地址，不要自行猜测端口重试超过一次。

## 故障分支

命令不存在（127）→ 装 CLI；服务未启动（1）→ 执行 `pnpm --filter @agentboard/server start`（仓库根目录，需先 `pnpm -r build`）；已被占用（2）→ 换任务。

- **CLI 缺失**：`kb` 命令不存在（command not found，退出码 127）。按顺序尝试 `cd <仓库>/packages/cli && npm link`（仓库指 AgentBoard 仓库根），装完用 `kb --version` 复验；复验不过才停止并报告。agent 工作空间内没有该仓库时，向用户报告"kb CLI 未安装"并给出该安装命令，不自行猜测安装来源。

## 领任务 → 执行 → 汇报

1. **领任务**：`kb list-tasks --status 待规划` 选一个，执行 `kb claim <id>`。
   - 退出码 2 或报"已被占用"→ 该任务已被他人领取，**立即换下一个任务**，不等待、不重试、不释放他人任务。
   - 领取输出含任务详情、评论与工作空间路径；工作目录切到该路径下干活。
2. **执行**：任务内容以 `kb show <id>` 实时返回为准——开工前拉一次；执行期间用户可能编辑标题/描述/优先级/标签或在评论区留言，**关键节点重新 `kb show` 拉取最新内容**，不要用领取时的旧快照。
3. **汇报**：关键节点（开工、受阻、阶段性完成）用 `kb comment` 写进展总结；中文多行内容用 stdin：
   ```
   kb comment <id> --stdin <<'EOF'
   （多行中文总结）
   EOF
   ```
   注意：CLI 领取（kb claim）无实时唤醒；用户留言会被标记为待读，你的下一次 `kb show` 会以 `[新]` 标注返回——关键节点重拉 `kb show` 并响应。
4. **收尾**：
   - 完成且自验通过 → `kb done <id> --notes "完成说明"`，状态进"待验收"，释放占用。之后不要继续动该任务。
   - 无法完成或自验失败 → `kb fail <id> --reason "失败原因"`，状态回"待规划"，释放占用。reason 必填，写清卡在哪。
   - 拿不准/需用户决策 → 先 `kb comment` 说明问题后保持占用继续等；只有确定失败才 `fail`。

## 占用规则

- 同一时刻你只能占用 claim 成功的那些任务；claim 是排他的，第二个 claimer 得到 409。
- 占用期间任务不可被拖拽流转（服务端 409 兜底），但字段与评论可被用户编辑——以 `kb show` 为准。
- `done`/`fail` 之后占用即释放；释放前确认 notes/reason 已写清楚，避免人工验收缺少上下文。
