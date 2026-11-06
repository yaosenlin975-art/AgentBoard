---
name: ask-user
description: 在 AgentBoard 任务执行中遇到只有用户能拍板的取舍时，按宽限流程提问并安全停手。触发词：ask-user、待决策、提问、卡住、需要用户拍板、宽限、stop-check、LOCKED。不适用：对话里一句话能回答的问题、能靠读代码/文档/知识页得出答案的问题、验收/失败回报。
---

# ask-user

本技能规定「什么时候可以把问题交给用户、怎么问、问完怎么停、之后怎么续跑」。
数字口径与设计 v3 一致：**默认宽限 180 秒，可配 0–600 秒；`--grace 0` 是独立的「立即落锁」分支；
宽限内 CLI 每 2 秒轮询一次；`kb stop-check` 也是 2 秒级可读**。禁止把默认写回 60 秒。

## 何时用（必须同时满足）

1. 已 `kb claim` 一张卡，且卡状态是「进行中」；
2. 已经读过相关代码 / 文档 / 知识页，仍缺一个**只有用户能拍板**的事实或取舍；
3. 这个答案会改变接下来写什么代码（不是审美问题、不是「要不要继续」）；
4. 能给出至少 2 个具体选项，每个选项都有一句「选了会怎样」。

## 何时禁用

- 用户正在对话里，能用一句话回答 → 直接在聊天里问，不得进待决策区；
- 能靠读仓库 / 知识页 / 文档得出答案；
- 想用提问逃避执行、验收或失败回报；
- 同一张卡已有 grace / open 决策（先等这一轮宽限，不要重复问）；
- 一次想问多个问题，或给不出选项、想自问自答、想替用户选答案。

## 流程

1. **先写断点**，再提问。断点至少包含：
   - `stash` 创建结果的 SHA（`git stash create` 的返回值；**不自动提交**、不清理工作树）；
   - `git status` / `git diff --stat` 摘要；
   - 已完成步骤、未完成步骤、`next_step`；
   - 仍在跑的后台进程 PID（没有就写空）。
   通过 `kb ask --checkpoint-file <path>` 或 `kb ask --checkpoint-stdin` 随提问一起落库。
2. 提问（默认同步等待一轮宽限，默认 180 秒）：

   ```
   kb ask <issue-uuid> --question "<一句话问题>" \
     --option '<label>|<选了会怎样>' --option '<label>|<选了会怎样>' \
     --trigger blocked|scope_change|irreversible|missing_input \
     --checkpoint-file <path>
   ```

   - 宽限值可用 `--grace <s>` 覆盖工作区默认，服务端 clamp 到 0–600；非整数 / 负数 / >600 由 CLI 直接拒绝（退出码 3）。
   - 无人值守 / 夜间批处理用 `--grace 0`：不建宽限期，事务内直接开锁并释放占用，立刻返回 `LOCKED`。
   - 异步模式用 `--no-wait`：拿到 `decision_id` 后先写评论再停手，不得继续跑完整任务。
3. 返回 `answered`：**立即继续**。不释放占用、不重新 claim，按答案接着做。
4. 返回 `LOCKED`：**立即停止**。不再改文件、不再提交、不 `kb done`；在卡上写一条评论说明停在断点的 `next_step`，结束本轮。
   宽限超时的停止信号由服务端在事务内落锁（释放占用 + bump fence + 写 `stop_requested`），旧 agent 之后的任何收尾都会被 409 拒绝。
5. 用户回答后（可能几小时后）：
   - 重新 `kb claim` 拿新 fence；
   - `kb decision <id|前缀>` 读答案与修订历史；
   - `git status` 复核工作树（断点可能被人动过）；
   - 从 checkpoint 的 `next_step` 续跑。
6. 若答案在开工后被修订（卡面标记 `answer_stale`），必须重读最新 `revision` 再继续。

## 延长宽限（宽限中才可用）

宽限内确实还需要时间、且**没有新信息要问**时，可以延长，而不是重复 `kb ask`（同卡已有 grace/open 会被 409 拒绝）：

```
kb ask-extend <decision-id|≥8 位前缀> --seconds 60 [--by <actor>] [--fence <n>]
```

- 单次 1–300 秒；「原宽限 + 累计延长」上限 600 秒（`--grace 600` 时不可延），超出 409 `EXTEND_LIMIT_EXCEEDED`；
- `grace_until = max(now, 原值) + seconds`：已过截止但尚未落锁的决策从当前时间起续，不会更早；
- 只动宽限截止与 `extended_seconds` / `extension_count` / `extended_by`：**不续 fence、不改卡状态、不改原 `grace_seconds`**；
- 只对 `grace` 有效；`open` / `answered` / `withdrawn` → 409 `DECISION_NOT_GRACE`；
- 跨区（决策不属于当前工作区）→ 403，CLI 退出码 2；
- 已收到 `LOCKED` 后**不要**用延长续命：重新 `kb claim` 拿新 fence 再接着做；
- 延长后继续按 2 秒轮询等待，不要借延长继续写代码或提交。

## 命令速查

| 命令 | 用途 |
| --- | --- |
| `kb ask <issue-uuid> ...` | 建决策；`grace` 默认 180 秒，`--grace 0` 立即落锁；默认同步等待 |
| `kb decisions [--state grace\|open\|answered\|withdrawn] [--stale]` | 列待决策（宽限剩余秒数由 `grace_until` 派生） |
| `kb decision <id\|前缀>` | 详情：选项、答案、修订历史、断点摘要 |
| `kb ask-extend <id\|前缀> [--seconds 60]` | 延长宽限（仅 `grace`；1–300 秒/次，累计 ≤600 秒；不续 fence） |
| `kb answer <id> --option <ord\|label>` | 首次回答；`grace` 内放行，`open` 后解锁 |
| `kb answer <id> --revise --expected-revision <n>` | 修订答案（CAS，冲突退出码 2） |
| `kb decision withdraw <id> --reason "<text>"` | 撤回问题并解锁 |
| `kb stop-check <issue-uuid> [--json]` | 步骤间 / 写文件前 / 提交前检查 `stop_requested`（2 秒级可读） |

退出码：`0` 成功（`answered` / `locked` / `pending` 都是正常结果，看结构化输出区分）；`1` 任务或决策不存在、服务不可达；
`2` 409（非占用者、已有在途、限流、状态非进行中、已回答/已撤回、CAS 冲突、决策锁、延长上限）/ 403（跨区延长）；`3` 选项/grace/seconds 参数非法。

## 禁止

- 一次提多个问题；无选项的问题；自问自答；替用户选答案；
- 提问后继续提交代码；
- 把「长任务」当免罪符：短任务里真正卡住也可以问，长任务里不需要问就不许问；
- 收到 `LOCKED` 后继续改文件或 `kb done`；
- 忽略 `kb stop-check` 的停止信号。
