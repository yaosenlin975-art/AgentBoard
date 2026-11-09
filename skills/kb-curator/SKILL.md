---
name: kb-curator
description: 把用户投喂的链接/文档读成摘要，征询是否入库，并按「一个主题一页、新链接作新证据追加」维护知识库与快速查找。触发词：存进知识库、帮我入库、投喂链接、这个链接记一下、整理成知识页、主题页、知识库维护、kb knowledge、知识页追加、重复主题合并、按主题查知识。不适用：纯网页搜索/抓取/下载（用 web-scout）、需求澄清与设计批准（用 brainstorming）、执行已派卡（用 executing-task）。
---

# kb-curator：链接 → 摘要 → 入库 → 主题页维护

本技能只负责「知识库内容运营」这一层：读内容、总结、征询、写页/追加、查找。抓取本身复用 `web-scout`（或环境的 `WebFetch`），不重写反爬与浏览器自动化；知识页存储与检索复用 `kb knowledge` 命令族，不改 schema。

## 0. 前置：绑定工作区

任何写入前按 `using-agentboard` 的「工作区边界（强制）」完成绑定（`kb list-spaces --current`）。知识页挂 `--scope workspace --workspace <当前工作区>`；只有用户明确说「放公共知识」才用 `--scope common`。跨工作区写入需当轮显式授权。

## 1. 与相邻技能的分工

| 场景 | 用谁 |
| --- | --- |
| 搜网页、绕过 403、抓公众号/小红书、下载资源 | `web-scout` |
| 已给链接/文件，要读内容、总结、入库、维护主题页 | 本技能 |
| 需求没澄清、要对比方案、要设计批准 | `brainstorming` |
| 把知识页结论落实成代码改动 | `writing-task` → `executing-task`（并先建卡） |

本技能不发起搜索，只处理用户已给出的 URL/文件；需要补搜时先请用户确认或显式转 `web-scout`。

## 2. 读取与摘要

1. 用 `WebFetch`（或 `web-scout` 的抓取）拿到正文；记录 URL、抓取时刻 `epoch ms`、正文 sha256（`content_hash` 必填）。
2. 摘要按「一句话结论 / 关键事实 3–6 条 / 适用与限制 / 与既有知识的差异」四段写；保留可复算的数字与版本号，不写个人感想。
3. 摘要先发给用户看，**不要直接写库**。

## 3. 征询（入库前唯一确认点）

给用户一屏决策信息，问「入库 / 不入库 / 只记到任务卡评论」：

- 建议标题与 slug、`--domain` 与 `--category`、scope（workspace / common）；
- 判定结果：命中既有主题页（给 id）还是新主题；
- 若命中：说明将追加到哪一页、会新增哪条来源与哪段正文。

用户未明确同意就只输出摘要，不写库。

## 4. 主题页判定（先查后写）

按顺序查，任一命中即视为同主题：

1. `kb knowledge search "<核心关键词>" --scope workspace --workspace <id>`（再加一次 `--scope common`）；
2. `kb knowledge list --scope workspace --workspace <id> --status all --include-expired` 看标题/slug 近似项；
3. `kb knowledge resolve <slug>` 精确探测拟用 slug（404 才是新主题）。

判定口径：**同一对象/同一问题**才算同主题（例：同一个 HTTP 状态码、同一个库的同一机制）；只是「领域相同」不算，应新建页。

- 命中既有页 → 走第 6 节 revise 追加。
- 未命中 → 走第 5 节 create。
- 命中多页且都像同主题 → 走第 7 节合并，不新建第三页。

## 5. 新主题：create

必须显式给出 `--category`（`design|solved|pinned|open`）与 `--domain`（`accounts|knowledge|board|chat|ui|infra`），`sources`、`evidence` 各 ≥1：

```powershell
Get-Content body.md -Raw | kb knowledge create --scope workspace --workspace <id> `
  --title '<主题名>' --slug <稳定-slug> --domain <域> --category <分类> `
  --stdin --sources-file sources.json --evidence-file evidence.json
```

- 正文首段写一句话结论；来源与证据的字段按 `kb knowledge create --help`。
- url 来源：`source_id = "url:<完整URL>"`、`source_type = "url"`、`locator = <完整URL>`、`content_hash` 用抓取正文 sha256；`snapshot` 只放 ≤2 KiB 的摘要片段。
- evidence 的 `source_id` 必须精确对应上面某条 sources；url/agent 证据可用 URL 或 `agent:` 前缀作 locator。
- slug 语义化且稳定，同主题后续只改内容不改 slug。

## 6. 同主题追加：revise（不是新建）

1. `kb knowledge show <page-id> --scope workspace --workspace <id>` 拿当前 `revision` 与正文。
2. 在正文对应章节追加「新来源带来的事实/差异」，不覆盖旧结论；有冲突时并列写「A 来源说… / B 来源说…」并标注日期。
3. `sources`/`evidence` 是**整组替换**：把旧条目与新条目合并后一起传（同一 `source_id` 不重复登记）；`--expected-revision` 必须等于第 1 步读到的值。
4. 冲突处理：409 `KNOWLEDGE_REVISION_CONFLICT`（exit 2）→ 重新 `show` 取新 revision 再改，不盲目重试；409 `KNOWLEDGE_EXISTS` → 说明 slug 已被占用，按第 7 节判定合并，不换 slug 硬建。

```powershell
Get-Content body.md -Raw | kb knowledge revise <page-id> --scope workspace --workspace <id> `
  --expected-revision <n> --stdin --sources-file sources-merged.json --evidence-file evidence-merged.json
```

验收信号：`kb knowledge list` 中该主题仍只有一页，`revision` 从 n 变为 n+1，`sources` 条数增加。

## 7. 重复主题合并

1. 选保留页：优先 slug 稳定、引用多、正文完整的那页；不按创建时间自动取旧。
2. 把其余页的独有事实并入保留页（和第 6 节同一 revise 流程），来源合并去重。
3. 被合并页用 `kb knowledge action <dup-id> archive --scope workspace --workspace <id> --expected-revision <n>` 归档，不删除。
4. 在保留页正文末尾记一行「合并记录：<dup-id> → 本页（日期）」，便于追溯。

## 8. 快速查找

```powershell
kb knowledge search "<关键词>" --scope workspace --workspace <id>
kb knowledge show <page-id> --scope workspace --workspace <id>
kb knowledge link <page-id>          # 对外引用一律 knowledge:<uuid>
```

查找结果要能落到正文片段：先 `search` 命中 id/title，再 `show` 并引用具体章节；不要只回一个 slug 或文件路径。

## 9. 命令映射

| 动作 | 命令 |
| --- | --- |
| 判重/找主题 | `kb knowledge search` / `list` / `resolve` |
| 新建主题页 | `kb knowledge create`（`--domain`、`--category`、`--sources-file`、`--evidence-file`、`--stdin`） |
| 追加来源/正文 | `kb knowledge revise --expected-revision` |
| 归档重复页 | `kb knowledge action <id> archive --expected-revision` |
| 读正文 | `kb knowledge show <id>` |
| 对外引用 | `kb knowledge link <id>` → `knowledge:<uuid>` |

## 10. 质量红线

- 不把整篇网页粘进正文：只留结论、关键事实、限制与来源。
- 不省略 `sources`/`evidence`；file 来源不带 snapshot，url 来源才可带简短 snapshot。
- 不同主题不硬塞进同一页；同主题不因「换个标题」新建第二页。
- 写入后必须回读一次（`show`）确认 revision、标题、来源数与正文落盘；失败如实报「未保存」。
