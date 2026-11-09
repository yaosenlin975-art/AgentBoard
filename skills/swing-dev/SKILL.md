---
name: swing-dev
description: 机动开发巡检班次：把各工作区「待规划」且无需人工参与的任务尽量做完。用户说「跑一班机动开发」「机动巡检」「把待规划清一清」或 /swing-dev 时使用。不适用：单卡执行（用 executing-task）、需求未澄清或方案未批准（先 brainstorming）、纯咨询与只读盘点（直接回答）。
---

# 机动开发巡检班次（swing-dev）

一次调用 = 一个班次。父智能体只做调度、分派、验收、报告；实施全部由 worker 子代理完成。worker ≤ 3，每个 worker 绑定一个工作区，区内任务串行、区间并行。

## 班次参数

| 参数 | 默认 | 说明 |
|---|---|---|
| 工作区范围 | 全部 | 点名工作区 = 只扫点名区；明确说「某区不动 / 先别动」= 该区整班次剔除、其余照扫 |
| 卡数上限 | 12 | 只计 done 的完成卡；fail 与跳过不占额度；「连班」模式 = 不设上限，持续到无可做卡收班 |
| 熔断 | 连续 3 fail | 单 worker 相邻 3 个 fail 停该 worker（跳过不计数也不重置）；熔断线不换实例续命；3 个 worker 全停则停班 |
| 并发 | ≤ 3 worker | 启动被宿主并发上限拒绝 → 该分派排队，任一 worker 收队即按队列补派；宿主完全没有子代理能力 → 降级为父代理单线程执行第 6 节（并发=1，身份仍用 `swing-w1`） |
| 复用预算 | 连续 2–3 批 | 同一实例连续续批上限；超预算或回报出现上下文吃紧迹象 → 新实例接管绑定（身份与绑定不变，账本更新 agentId） |

用户显式指定的值覆盖默认。

## 绑定账本

父代理全程维护：工作区 ↔ worker 实例（agentId）↔ 身份（`KB_AGENT=swing-wN`）↔ 状态（在飞 / 已收 / 熔断 / 僵死嫌疑）↔ 已做卡单。绑定挂工作区、不绑死实例；换代只更新 agentId，身份与绑定保持。账本用于续批判定、并发补派、僵尸核对与班次报告。

## 班次流程

### 0. 班次启动确认

🔴 CHECKPOINT · 🛑 STOP：首次扫描前向用户展示本班次参数（范围 / 上限 / 熔断 / 并发 / 复用预算，未指定项用默认值）与目标工作区清单，确认后进入自主循环，此后仅停班事件再停。用户发起指令已含明确参数（如「跑一班，××区不动」「连班」）时视为已确认，不再追问。

### 1. 环境自检（班次启动必做，结果写进报告开头）

1. `kb list-spaces`；退出码 1（服务不可达）→ 🛑 停班，报告「看板服务未启动」，不做任何卡。
2. `GET http://127.0.0.1:8787/api/version` 读 `db_path`（有 `db_scope` 一并读）；把实际 db 路径写进班次报告开头，禁止默认「就是中心库」。查不到 → 记为「db 路径未确认」，不得当作已确认。
3. 对每个目标工作区跑 `git -C <path> rev-parse --is-inside-work-tree`：输出 `true` = 走 GIT-ON-DONE；非 git 仓库或命令失败 = 走无提交降级路径，报告开头逐区写明「非 git 仓库，本班次无自动提交」。
4. 以上三项未记录前，不得进入扫描。

### 2. 扫描（禁用旧快照）

逐工作区：`kb next --workspace <id> --limit <n> --json`（OPT-10）一次拿到「待规划 · 无占用 · 前置全部解除」的候选与派活字段（`parent_issue_id` / `blockers` / `blocked` / `siblings_by_label`），替代「list-tasks 初筛 + 逐卡 dep ls」两轮；需要整区全状态盘点时仍用 `kb list-tasks --workspace <id> --status 待规划`（`kb list-spaces` 输出含 id / name / path，直接可用）。扫描触发时机：班次启动；worker 回报（先扫其绑定区）；并发槽位释放需选新区（全局扫未绑定区）。worker 区内执行期间不重扫、不向在飞队列补发卡。

**相邻卡取数口径**：worker 回报后决定「续做同一张还是派下一张」，一律按第 7 节「续派判定」现场取数（`kb show` 回读 status/claimed_by、`kb next --json` 取同区可派卡与 `parent_issue_id`/`blockers`/`blocked`/`siblings_by_label`、`kb dep ls` 复核被阻塞者与解除标记），不引用首次派发的队列快照——队列在班次中会因他人 claim / done / 新卡入池而变化。`kb next` 已过滤占用非空与前置未解除，但仍须按第 7 节现场复核（竞态下状态可能已变）。

### 3. 排除（硬规则，命中即跳过并记原因）

对候选卡执行 `kb show <id>`，读描述、标签、评论与状态（`status`）；候选来自 `kb next`（已按 待规划/无占用/前置全解除 预过滤），规则 4 的占用与规则 6 的前置仍须现场复核一次（扫描与派发之间可能被他人 claim / 新增依赖）：

1. 该卡 `status` 在状态字典里对应 `kind=blocked` → 跳过（阻塞待人工解除）。**只按 kind 判定，不看标签/标题/描述关键词**：`blocked-external`、待决策之类字样本身不构成排除。班次启动时按工作区取一次阻塞状态集合，后续用 `kb show <id> --json` 的 `status` 比对：
   ```powershell
   kb status ls <工作区 id> --json | node -pe "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));const items=j.items||j;items.filter(s=>s.kind==='blocked').map(s=>s.name).join('\n')"
   ```
   集合为空 = 该区没有阻塞类状态；有自定义阻塞状态（如「等外部确认」）时其名字会列在输出里。无人值守班次不替用户拍板：`kb decisions --state open --stale` 有 open 决策的卡按 `ask-user` 只读核对后跳过（决策锁不是 kind，仍按决策状态判定）
2. 验收要求真人参与：目视、听感、人工点击、真机操作、截图对比评审 → 跳过（需人工验收）
3. 涉及生产密钥、对外发送/发布、push 远端、数据库迁移 → 跳过（需授权）
4. 占用者非空 → 跳过（他人占用）；目标文件与其他在飞卡重叠 → 跳过（同文件单 owner，不得并行）
5. 父卡存在未终态（非已关闭）子卡 → 跳过（父卡只汇总）
6. `kb dep ls <id>` 前置未解除：前置卡与本卡同工作区且可做 → 前置卡插到本卡前面执行；前置卡在其他工作区、被占或命中本节任一排除项 → 跳过本卡（前置不可用），班次报告列出
7. 本班次已 fail 过的卡不再重试

排除判定以卡面语义为准，不按关键词字面命中：卡面模板用语（如「所需人工步骤」「引用迁移」）不构成排除；「人工」排除只指验收需真人执行，「迁移」排除只指数据库迁移。

相邻卡取数口径（排除侧）：

- 规则 4 的「占用者非空」只看 `claimed_by` 不看 `status`：`进行中` 且 `claimed_by` 为空 = worker 掉线遗留卡，属可续做卡，不得按「他人占用」跳过（处理分析见第 7 节续派判定第 1 条）；排除判定一律用当次命令回读、不吃扫描旧快照——`kb show <id> --json` 看 `status` / `claimed_by` / `decision_locked`，`kb dep ls <id>` 看前置是否已解除。

### 4. 排序

优先级（高 > 中 > 低）→ 同级创建时间旧者优先。候选集取自 `kb next --json` 的 `items`（`kb next` 按服务端顺序输出，本地按本节重排）；需要「父卡后继 → 同父兄弟 → 已解除后继 → 同 labels」时直接用 items 里的 `parent_issue_id` / `blocks` / `siblings_by_label` 字段，不必再逐卡取数。

本节排序只用于「回到池子」后的重扫（班次启动、绑定释放、无可续派后继）。worker 回报后的续派不先按本节重排，而是按第 7 节续派判定的固定顺序（父卡后继 → 同父兄弟 → 已解除后继 → 同 labels/同目录）取下一张。

### 5. 分派

- 按工作区分组过滤后候选；组数 > 空闲槽位时取候选数最多的组优先派发，未入选区在槽位释放或重扫时重新参与（用户剔除区除外），报告注明未轮到的区。
- 每组派 1 个 worker 子代理，一次给全组卡队列（含顺序与前置关系），worker 区内串行执行。
- worker 提示必须自包含：工作区 id/name/path、全组卡**完整 36 位 UUID** + 标题（CLI 认 ≥8 位唯一前缀，但 worker 提示里必须给全长 id，避免卡量增长后前缀歧义）、第 6 节执行规则全文、安全红线、该项目规则入口（工作区根 AGENTS.md / CLAUDE.md）；不得只发截断 id。
- worker 身份：`KB_AGENT=swing-w1` / `swing-w2` / `swing-w3`。设置方式按宿主：Git Bash `KB_AGENT=swing-w1 kb claim <id>`；PowerShell 先 `$env:KB_AGENT='swing-w1'` 再 `kb claim <id>`（一行写完会报错）。身份与工作区绑定、整班次保持，换代不换身份。
- 首次派发写入绑定账本；卡面描述截断过的提示词一律标注「以 kb show 全文为准」。

### 6. worker 执行循环

**状态回读硬规则（不可跳过，适用于父代理与 worker；定义见 `using-agentboard`「收尾与提交」的「收尾状态回读」）**：

- `done` / `fail` / `close` 之后必须核对同一张卡的 `status`（预期：待验收 / 待规划 / 已关闭），取值与兜底一律按上述定义执行（优先命令输出的 `状态:` / `--json` 的 `status`，异常补 `kb show --json`，仍不符按未完成记账并记入第 9 节「尝试但未成功」栏）。
- `close` / `done` / `fail` 只接受 36 字符全长 UUID（8 位短码报「任务不存在」退出 1），禁止短码；命令报「任务不存在」「409」时把 stderr 原文抄进班次报告与卡内 `kb comment`，禁止改写成「已完成 / 已关闭」。

逐卡：

1. `$env:KB_AGENT='swing-wN'`（或 Git Bash `KB_AGENT=swing-wN`），再 `kb claim <id>`；成功后 `kb show <id>` 复核描述、验收标准与评论里用户最新要求
   - 退出码 2 → 按 stderr 文案分流：已被占用 / 状态不可领取 → 记入收尾回报清单，下一张；前置未解除 → 回到该卡 dep 检查（同区可做前置先做，跨区或不可做则跳过）；不等待、不强制释放他人占用（`kb release` 只能释放自己占用的卡并退回待规划；回收僵尸 worker 的卡仍必须在班次启动确认时拿到用户显式授权）
   - 退出码 1（服务不可达 / 参数错误）→ 停该 worker，回报父代理；输出含关联知识页提示 → 先读提示页再实施
2. 实施：
   - 遵守该工作区项目规则（工作区根 AGENTS.md / CLAUDE.md）与 `executing-task` 的收尾口径；父代理派发已按 `using-agentboard` 的 SUBAGENT-STOP 例外授权你 claim/done/fail，除此之外不自行改卡；最小改动、复用现有实现、不动本工作区外文件
   - 非 git 仓库（第 1 节判定）：不执行任何 git 命令；本卡自验证据（日志/快照/输出文件）归档到该工作区 `Docs/evidence/swing-<date>/<card-id>/`（或班次参数指定路径），done notes 写「无提交 + 证据路径」
   - git 仓库：实施前查该工作区 git status；本卡目标文件已有未提交改动 → `kb fail <id> --reason '目标文件存在班次外未提交改动，需先收尾'`，下一张（GIT-ON-DONE 按 --scope 提交，scope 外脏文件不受影响，同文件必混入）
   - 需超出卡面范围的设计决策 → 按 `ask-user` 用 `kb ask <id> --grace 0` 立项并立即落锁停手（无人值守不建宽限期），原因写「需设计决策：<具体问题>」，下一张
3. 自验：按卡内验收标准执行；测试从定向开始，项目强制检查或共享基础设施变更才跑全量；如实区分通过 / 未验证 / 失败
4. 完成：`kb done <id> --notes-stdin --scope <路径> --scope <路径>`，完成后按 §6「状态回读硬规则」核对「待验收 + 占用已释放」
   - 提交口径（GIT-ON-DONE）与 CLOSE-RECORD 按 `using-agentboard` 的「收尾与提交（GIT-ON-DONE）」及「领任务 → 执行 → 汇报」第 4 步执行：`--scope` 逐条传、只声明真正改动（非 git 文件也写进 notes）、纯看板任务不传并写「本轮无文件改动」、不手动 `git commit`
   - notes 含：做了什么、自验结果、遗留项、知识页/变更日志 id；非 git 仓库注明「未自动提交 + 证据路径」（按上条归档）；一次收口可用 `kb done <id> --close-record --changelog-title … --type … --knowledge-page … --notes-stdin --scope …`（changelog 先写、失败不落 done，`--knowledge-page` 只挂引用）
5. 无法完成：`kb fail <id> --reason '<具体原因>'`，读输出里的 `状态:`（`--json` 读 `status`）确认 = 「待规划」；输出缺失或状态未变 → 补 `kb show <id> --json` 复核，仍不符按未完成记账
6. 关键节点（方案取舍、阻塞、部分完成）用 `kb comment <id>` 记录；done / fail 已有自动评论，不重复刷屏
7. worker 收尾（含熔断或异常退出前）：未到终态的自占卡必须先 `kb fail <id> --reason '...'` 再退出；回报父代理：完成 / 失败 / 跳过清单（卡 id + 标题 + 原因）、改动文件清单、验证命令与结果、跨区声明（工作区 id + 绝对路径 + 是否写区外文件）

### 7. 回报处理与实例复用（父代理）

#### 续派判定：worker 回到 inactive 后（先判定，再执行下面 1–6）

worker 回合结束或宿主报 inactive **不等于卡完成**。唯一事实源是 `kb show <卡全长 UUID> --json` 的 `status`（必要时叠加 `claimed_by`）；不得按宿主状态、worker 自述或首次派发队列决定下一步。worker 一停，先回读它手上最后一张卡，再按下列固定顺序判定：

1. **卡仍「进行中」** → 同一实例续做同一张：不 `release`、不换实例重派、不重复 `claim`（占用仍在，重 claim 会 409）；续批只补「继续同一张 + 最新进度要求」。`kb show <卡全长 UUID> --json` 看 `status=进行中` 且 `claimed_by=<本班次身份>` → 续做；若 `claimed_by` 为空（worker 异常退出、租约清扫后的掉线遗留卡）→ 它不是他人占用，而是可续做卡：`kb claim <卡全长 UUID>` 后由本实例接着做完（claim 接受「进行中且无人占用」），不得按第 3 节规则 4 永久跳过，也不得释放或覆盖他人占用。
2. **卡已「待验收」/「已关闭」** → 按下列顺序取下一张，命中即派、不跳步：
   1. 父卡后继（本卡父卡下，按 `sort_order` 排在本卡之后的未完成子卡）：
      ```
      kb show <完成卡全长 UUID> --json | node -pe "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));const i=j.issue||j;i.parent_issue_id||''"
      kb list-tasks --workspace <区 id> --all-status --json | node -pe "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));(j.items||j).filter(i=>i.parent_issue_id==='<父卡全长 UUID>'&&!['待验收','已关闭','已废弃'].includes(i.status)).map(i=>[i.status,i.claimed_by||'-',i.sort_order,i.id,i.title].join('\t')).join('\n')"
      ```
   2. 同父兄弟（父卡下其余未完成子卡，含排在本卡之前的；无父卡则跳过本步）：
      ```
      kb list-tasks --workspace <区 id> --all-status --json | node -pe "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));(j.items||j).filter(i=>i.parent_issue_id==='<父卡全长 UUID>'&&i.id!=='<完成卡全长 UUID>'&&!['待验收','已关闭','已废弃'].includes(i.status)).map(i=>[i.status,i.claimed_by||'-',i.id,i.title].join('\t')).join('\n')"
      ```
   3. 被本卡 blocks 且已解除的后继（完成卡变「待验收/已关闭」即解除其阻塞）：
      ```
      kb dep ls <完成卡全长 UUID>    # 看「被阻塞者（blocked）」：取状态为待规划或进行中无主、且未被他人占用的卡
      ```
   4. 同 `labels` / 同目录（前三条都空时）：按完成卡的 `labels` 或目标目录前缀，在当前区待规划卡中筛选：
      ```
      kb list-tasks --workspace <区 id> --status 待规划 --json | node -pe "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));(j.items||j).filter(i=>!i.claimed_by&&i.labels.some(l=>['<labels 逐项>'].includes(l))).map(i=>i.id+'\t'+i.title).join('\n')"
      ```
3. **以上都没有** → 回第 2–4 节重扫池子；确认无可做卡后按下面第 3、4 条释放绑定。

每条判定都要把「回读到的 status + 命中的分支 + 依据卡 id」写进「绑定账本」与班次报告，不能用「worker 说做完了」代替。

下列 1–6 为回报核对与实例复用流程（续派判定已在上方完成）：

1. worker 回报到达：**逐卡**核对回报与看板实际状态——对回报里每张 done / fail / close，先核对 worker 附带的命令输出 `状态:`（`--json` 的 `status`）与预期一致；回报未附状态、输出不可解析或与预期不符时，跑一次 `kb show <全长 UUID> --json` 比对 `status`，不许抽查、不许按 worker 自述采信。状态不符的卡按「未完成」退回补做或记入失败栏。验证深度按风险定，证据有效即复用，不机械重跑
2. 绑定区重扫（按第 2–4 节）：仍有可做卡 → 用宿主对应的续批工具（如 `SendMessage`）续批同一实例（只附新队列与区特有约束，第 6 节规则沿用首次派发不重发）；连续续批达复用预算，或回报出现上下文吃紧迹象（回报显著变短、丢细节、自述压缩）→ 派新实例接管绑定（提示重新自包含，账本更新 agentId，身份不变）
3. 绑定区无可做卡 → 释放绑定；按第 2–4 节取候选数最多的未绑定工作区 → 新实例新身份派发
4. 无可派区 → 槽位待命；占用解除、新卡入池由重扫触发补派
5. 僵尸检测：在飞 worker 超预期时长（重实现卡按 30–60 分钟/卡量级）且占用卡零进度评论 → 判僵死：`kb comment` 说明释放原因 → 释放占用 → 绑定区派新实例重派 → 报告注明。**释放只有在班次启动时用户已显式授权自动释放（如「可以自动释放僵尸卡」）才执行**：用 REST `POST /api/issues/<id>/release`（不带 workspace 时不要求占用者匹配，服务端落 system 评论「用户强制释放」）。未获显式授权时只标记「遗留占用卡」并停线，不代为释放；用户未表态不等于默许。父代理不是占用者，`kb fail` 会 409「只有当前占用者可执行此操作」，不要拿它兜底。本段不构成 `using-agentboard`「强制释放需用户当轮授权」的例外。
6. 熔断 worker：停该线，绑定释放，剩余卡进班次报告；不派新实例续命

### 8. 待验收卡关闭（逐卡 close + 回读）

只处理本班次实际产出、且回读状态确为「待验收」的卡；不批量关闭、不按计划清单关闭。

1. 逐卡执行 `kb close <完整 UUID>`（CLI 认 ≥8 位唯一前缀，但流水线记录写全长 id）。close 时占用者就是当前 agent 会自动释放自有占用；被他人占用才 409，按 7.5 的授权口径处置，不强行绕过、不改用 `fail` 兜底。
2. 按 §6「状态回读硬规则」核对 `kb close` 输出为「已关闭」（异常补 `kb show <同一 UUID> --json` 以其 `status` 为准）；分类记账：确认「已关闭」→「已回读确认关闭」，close 非 0 或回读状态未变 →「尝试但未成功」，从未发出 close 的卡 →「未尝试」。
3. 三栏数字只能来自逐卡回读记录（每卡：全长 UUID + 回读到的 `status` + 命令退出码与 stderr 原文），禁止用计划、claim 结果、worker 自述或预估填写。

### 9. 收尾（父代理）

1. 收班条件：全部工作区扫描无可做卡（全完成 / 排除 / 占用 / 熔断线停）且无在飞 worker；卡数上限模式达上限即收班。未收齐 worker 的占用卡会被排除规则 4 挡住 → 报告列「遗留占用卡」提醒用户，父代理不代 `kb fail`（409）或强制释放（见 7.5）
2. 班次报告（固定结构）：
   - 报告开头：实际 `db_path`（来自 `GET /api/version` 的 `db_path` / `db_scope`）、每工作区 git 判定（仓库 / 非仓库无提交降级）
   - 每工作区三栏硬计数：**已回读确认关闭 N / 尝试但未成功 M / 未尝试 K**；另列完成（done 且回读为「待验收」）n（id + 标题；git 仓库附提交号、非 git 仓库附证据路径）、失败 n（原因 + stderr 原文）、跳过 n（按原因分类计数）、未动（被占 / 超并发未轮到）
   - 每个数字必须能追到逐卡回读记录（全长 UUID + 回读 status + 退出码），追不回的按 0 计
   - 全班改动文件清单；跨区声明（是否写工作区外文件，有则列出）；每卡验证命令与结果（或「未验证：原因」）
   - 剩余阻塞、遗留占用卡；绑定账本终态（每 worker：续批次数 / 换代 / 熔断 / 僵死）
3. 收班自检清单（逐项确认，缺一项不得宣布收班）：
   - [ ] 每张 done / fail / close 都有回读记录（§6 硬规则），状态与预期一致；报告里每个关闭数字都能指到一条记录（全长 UUID + status + 退出码）
   - [ ] 全程无短码进入 close / done / fail；所有报错命令的 stderr 原文已进报告与卡内评论，未被改写成完成
   - [ ] 报告开头已写明 `db_path` 与各区 git 判定
   - [ ] 未回读的卡一律按未完成 / 未尝试计，报告里不存在「计划已关闭」

## 安全红线（父代理与 worker 同守）

- 只写任务卡所属工作区内的文件与看板数据（边界细则按 `using-agentboard`「工作区边界（强制）」）；跨区零写入，临时文件只放该区或系统临时目录、班次结束清理
- 不 push 远端、不 force 操作 git、不动生产密钥、不做数据库迁移、不对外发送任何内容；`delete-issue` / `delete-space` 禁用
- worker 不再派生子代理；不新建分支（卡面明确要求除外）
- 不顺手修复卡外问题；发现新问题 → 新建卡或写进班次报告，不扩卡

## 退出条件

- 扫描无可做卡（全部完成 / 跳过 / 占用）→ 正常收尾
- 🛑 达卡数上限（连班模式无此条）/ 🔴 3 worker 全熔断 / 🛑 服务不可达 → 提前收尾并出报告
- 用户中断 → 通知各 worker 按收尾规则 fail 自占未终态卡后退出，收齐回报再出报告
