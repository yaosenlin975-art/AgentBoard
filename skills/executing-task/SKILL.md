---
name: executing-task
description: 执行明确派发的 AgentBoard 卡：核对占用、claim、实施、汇报、验证与 done/fail。触发词：执行卡、领卡、claim、收尾、executing-task。不适用：拆卡用 writing-task；自主找活用 swing-dev。
---

# Executing Task

当前卡是唯一执行源。先按 `using-agentboard` 的「权威来源」找到权威入口；不可读即停手。

## 硬门禁

- **一卡一 worker**：只执行父代理明确给出的卡，不自行换卡、续派或改别人的卡。
- **先查占用**：`kb show <完整 UUID>` 核对 `status`、`claimed_by`、决策锁；再 `kb dep ls <id>` 确认前置。
- **claim 后复读**：新派卡才 claim；已由本 worker 占用的进行中卡直接续做。成功后重拉 `kb show`。
- **同文件单 owner**：目标文件与其它在飞卡重叠时排队，不并行。
- **卡外改动先停**：发现需要改卡外文件，先补卡或回报，不先改后补。
- **接线上门禁（RULE-3）**：新增 REST 路由、WS 事件、ticker、CLI 命令或 DB 迁移，done 前必须证明真实 app 可触达，或把接线交给有 `blocks` 边的卡。
- **设计页门禁**：关联 design 页仍为 `proposed` 时，先 revise 到 `landed|partial`，或明确 `--design-not-advanced`。

## 执行环境

核对当前工作区、服务端口、DB 路径和 `APPDATA`。目标属于别的项目、正式业务库或外部工作区时停手。临时文件放当前工作区或系统临时目录。

跨区、越界目录或他人归属文件按 `using-agentboard` 的工作区规则处理。

## 开工

1. 读卡面、评论、状态、占用与依赖。
2. 新卡或父代理明确重派且无人占用时：`kb claim <id>`。
3. 以下任一即停手并回报，不换卡、不重试：
   - 他人占用；
   - 状态不可领取；
   - blocker 未解除；
   - 决策锁或 open decision。
4. claim 成功后：
   - 保存返回的 fence；
   - 切到工作区 path；
   - 重拉 `kb show`；
   - 在卡上写开工评论。
5. 开工前按需要读当前工作区知识、公共知识和最近变更；`category=open` 或 `landed=proposed|partial` 的设计页不得当作已实现事实。

## 运行中

- 开工、受阻、阶段完成、收尾前重拉 `kb show`。
- 用 `kb comment` 写进展；长文走 `--stdin`。
- 用户可能修改描述或留言，最新 `kb show` 覆盖领取时快照。
- 需要用户拍板时走 `ask-user`；收到 `LOCKED` 后停止写文件、提交和 done。
- 只跑任务和项目要求的验证；未跑的检查写「未验证」。
- 卡引用其他工作区原文时按「工作区 id + 相对路径 + 文件名」打开原文再行动。

## 超范围时拆卡

出现任一条件，先拆：

- 跨 ≥2 个包或端；
- ≥3 个独立验收步骤；
- >8 文件或 >400 行；
- ≥5 个独立验收项；
- 实际工作量超卡面 2 倍，或需要未批准的设计决策。

按依赖建子卡，父卡保持占用；子卡完成后再汇总。操作见 `references/parallel-dispatch.md`。

## 并行执行

最多同时推进 3 张卡，含父会话自己执行的那张。领取前逐卡列目标文件集并两两求交；同文件或目录前缀重叠即串行。跨工作区并行逐区授权。

父代理的续派、文件冲突检查、worker 输出格式见 `references/parallel-dispatch.md`。

## 收尾

有用户可见改动：

```powershell
Get-Content -Raw notes.md |
  kb done <id> --close-record --changelog-title '<标题>' --type 新增|修复|调整 `
    --notes-stdin --scope <path> --scope <path>
```

无用户可见改动：

```powershell
Get-Content -Raw notes.md | kb done <id> --no-changelog --notes-stdin --scope <path>
```

- `--scope` 只列本卡实际改动，逐条传。
- 有可复用结论时写/改知识页；没有则在 notes 写「未沉淀知识页：原因」。
- notes 带知识页 id（或原因）和变更日志 id。
- done 后核对 `status=待验收`、占用为空。
- 无法完成或自验失败：`kb fail <id> --reason '<具体阻塞>'`。
- 不要把未验证写成通过；不要手动 `git commit`。

完整收尾清单、提交原因码与状态回读见 `references/finish-checklist.md`。

## 停止条件

- 工作区、运行环境或卡归属不一致。
- 他人占用、blocker、open decision。
- 需要新的产品或数据决策。
- 收尾报告缺工作区、改动清单、跨区声明或验证结果。
