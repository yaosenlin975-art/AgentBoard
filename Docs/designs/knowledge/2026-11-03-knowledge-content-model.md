# 知识库内容模型（知识谱图的目的导向）
- status: proposed
- date: 2026-11-03
- card: -
- supersedes: -

状态：待用户批准。目的由用户明确：**让用户和 LLM 快速了解项目相关知识**。

## 1. 为什么改

现在知识页是「谁需要谁写」的自由格式，LLM 拿去当上下文时不知道该信什么、哪些已过期、哪些是未落地的设想。星图只看得到"有链接"，看不出"内容性质"。

目的倒推要求：**每页一眼能判断「这是什么 / 现在还算不算数 / 依据在哪」。**

## 2. 已确认的四类模型（用户选定）

| 类别 | `category` | 必填字段 | 用途 |
|---|---|---|---|
| 设计方案 | `design` | `landed`: `landed` \| `partial` \| `proposed`；`cards`: 关联卡 id | 记录为什么这么设计、落地到哪一步 |
| 已解决的问题 | `solved` | `symptom`、`root_cause`、`fix`、`evidence`(path:line 或提交号) | 让人不再重复踩坑 |
| 用户指定内容 | `pinned` | `source`（用户原话/指令出处） | 用户要求放进知识库的原文或规则 |
| 待决与盲区 | `open` | `question`、`blocker`、`owner` | 明确的未知项，防止 LLM 当成已知 |

`category` 缺失的旧页视为 `legacy`（不阻断，星图灰显）。

## 3. 页面骨架（四类各一套，尽量短）

- `design`：**结论先行一句话** → 方案要点 → 落地状态（`landed/partial/proposed` + 证据链接）→ 取舍与替代方案 → 未决项。
- `solved`：现象（可复现步骤）→ 根因（path:line）→ 修法（提交号）→ 如何验证不再复发。
- `pinned`：用户原话（不改写）→ 生效范围 → 出处（卡号/时间）。
- `open`：问题一句话 → 卡在哪 → 谁能解 → 当前权宜做法。

硬规则：**「设计方案」必须在正文第一段就写明落地状态**，禁止只在标题里暗示。

## 4. 与星图的关系

- 节点按 `category` 着色（design / solved / pinned / open / legacy 五色），图例固定。
- 现有按 `scope`（workspace/common）与 `kind` 的着色保留为次级维度（可切换）。
- 筛选器增加 `category:` 前缀，等价于既有 `tag:` 语法。
- 「只看未落地设计方案」= `category:design landed:proposed|partial`，作为常用预设。

## 5. 迁移既有页

- 既有页不强制重写；新增/重写页必须带 `category`。
- 现存的 `project-status-*` 与 `handoff-*` 页归为 `legacy`（handoff 页时效性强，标 `legacy` 并在 30 天后归档）。
- 一次性补录：把 `DESIGNS.md` 的 §7（任务依赖）与 §8（星图 PIXI）转成两篇 `design` 页，作为模板样例。

## 6. 非目标

- 不做全文语义搜索（既有 FTS5 中文检索够用）。
- 不做知识页自动生成（先靠人/agent 按模板写）。
- 不改 `common` / `workspace` 双 scope 语义。

## 7. 验收

- 四类的字段在 `KbPageMeta`（或等价处）有类型定义；缺 `category` 的写入被接受但标 `legacy`。
- 星图按 `category` 着色 + 图例 + `category:` 筛选可用；CDP 证据。
- 两篇样例页（design × 1、solved × 1）按模板写出并被检索命中。
- web/server test 无新增失败；build exit 0。
