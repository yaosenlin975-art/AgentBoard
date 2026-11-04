# PALETTE-BOARD-LOG 定性表与验证（2026-11-04）

收敛口径（照设置线 `8d1ea82`）：主操作 `bg-accent text-accent-ink`；选中/标签底 `bg-accent-soft text-accent`；中性文字 `ink`/`ink-2`/`ink-3`；面 `surface-page`/`surface-raised`/`surface-card`；边框 `hairline`；输入 `focus:border-accent`。语义色保留：`red`（错误）、`amber`（警告/阻塞）。**不改布局尺寸**。

## 定性表（改前 → 处置）

| 文件:行 | 改前 | 语义 | 处置 |
| --- | --- | --- | --- |
| `board/IssueTreeView.tsx:292` | `text-blue-700 hover:bg-blue-50 dark:…` | 领取按钮（主操作） | `text-accent hover:bg-accent-soft` |
| `board/IssueTreeView.tsx:442` | `bg-green-100 …`（领取徽标 running） | 状态徽标 | `bg-accent-soft text-accent` |
| `board/IssueTreeView.tsx:489` | `bg-blue-600 … text-white` | 提交（主操作） | `bg-accent … text-accent-ink` |
| `board/IssueTreeView.tsx:461/513` | `text-neutral-* hover:bg-neutral-100` | 次级按钮 | `ink-2/ink-3` + `hover:bg-surface-raised` |
| `board/IssueTreeView.tsx:131/138/395/455/504` | `bg-white`/`border-neutral-*`/`dark:*` | 面板底与输入 | `bg-surface-card`/`border-hairline`（`dark:` 变体删除，令牌自带主题） |
| `board/PlanningSortButton.tsx:80` | `text-neutral-500 hover:bg-white hover:text-blue-600` | 排序按钮 | `text-ink-3 hover:bg-surface-card hover:text-accent` |
| `board/Board.tsx:120/121`、`Column.tsx:51`、`IssueCard.tsx:57/69/76`、`LabelFilterBar.tsx:36/47` | `text-neutral-*`/`bg-neutral-*` | 中性文字/底 | `ink-*`/`surface-raised`（`LabelFilterBar` 的 `active:bg-neutral-200` **保留**，被 `interactionFeedback.test.tsx` 钉住） |
| `changelog/ArchivedChangelogPanel.tsx:80` | 选中行 `bg-blue-50 dark:bg-blue-950/30` | 选中 | `bg-accent-soft`（+`text-accent`） |
| `changelog/ChangelogEntryForm.tsx:134/146` | `border-neutral-300`/`focus:border-blue-*`/提示条 `bg-neutral-*` | 输入与提示条 | `border-hairline` + `focus:border-accent` + `surface-raised` |
| `changelog/ChangelogTimeline.tsx:118` | 标题 `hover:text-blue-700` | 标题 hover | `hover:text-accent`（其余中性类同批收敛） |
| `changelog/ChangelogTypeTag.tsx:9-12` | 新增绿 / 修复蓝 / 调整中性 / 历史紫 | **类型标签** | **保留多色相**，理由见下 |
| `workspace/**`（2 文件 13 行）、`knowledge/**`（3 文件 43 行）、`right/**`（2 文件 12 行）、`lib/markdownLinks.tsx`（3 行） | `neutral`/`blue`/`bg-white` | 面板、按钮、链接图标 | 全部收敛到令牌；`IssueTreeView` 之外无 `text-white` 残留 |

合计 **19 文件 / 144 行**，`git diff --stat` 为 **+146 / −146**（纯类名互换，无结构改动）。

## `ChangelogTypeTag` 决策：**保留多色相**（不收敛到 `accent`）

理由（依据优先于偏好）：
1. 仓内已有守卫测试 `src/test/tokenMapping.test.ts:67-73` 明确要求「类型标签 / Badge tone 保留多色相，但只用 Tailwind 内建色阶」，并断言 `tag` **不得**含 `bg-accent-soft`；
2. 该多色相与 `components/ui/Badge.tsx` 的 tone 语义复用（`ChangelogTimeline` 用 `Badge tone={…}`），而 `components/ui/**` 属本卡边界外；
3. 若强行改单色相 + 字形前缀，需同时改 `Badge`、两处守卫测试与所有 `Badge` 调用方 —— 成本高于收益，且与既有决策冲突。

因此本卡只保证：**色值仍为 Tailwind 内建色阶（不用自定义 `--color-type-*`），不新增令牌映射面**，也就不存在「漏映射导致类不生成」的风险。

## 改后 grep（本批目录）

```
$ grep -rEn '(blue|green|purple|indigo|neutral|gray|slate)-(50|...|950)|bg-white' \
    apps/web/src/components/{board,changelog,workspace,knowledge,right} apps/web/src/lib/markdownLinks.tsx
apps/web/src/components/changelog/ChangelogTypeTag.tsx:9:  新增: 'bg-green-100 …'
apps/web/src/components/changelog/ChangelogTypeTag.tsx:10: 修复: 'bg-blue-100 …'
apps/web/src/components/changelog/ChangelogTypeTag.tsx:11: 调整: 'bg-neutral-200 …'
apps/web/src/components/changelog/ChangelogTypeTag.tsx:12: 历史: 'bg-purple-100 …'
```

仅剩上述 4 行，全部是**被守卫测试固定的类型标签多色相**；`markdownLinks.tsx` 为 0。

## 真机（5174，`computed.json` + 截图）

| 位置 | 取值 |
| --- | --- |
| 任务树「创建子任务」按钮 | `background-color: rgb(160, 74, 8)`（= `accent`）、`color: rgb(255,255,255)`（`accent-ink`） |
| 日志类型标签 | `background: oklch(0.962 0.044 156.743)`、`color: oklch(0.448 0.119 151.328)`（= 内建 `green-100`/`green-800`，多色相保留） |
| 知识库「添加」按钮 | `background: rgb(253, 251, 247)`（`surface-card`）、`color: rgb(31, 27, 22)`（`ink`）、`border: rgba(31,27,22,0.1)`（`hairline`） |
| 任务树领取徽标 / 日志选中行 | **未取到**（该工作区当前无 running 会话的领取徽标；日志选中行需先选中条目），见未验证 |

截图：`tree-create-subtask.png`、`log-type-tag.png`、`knowledge-actions.png`、`tree-claim.png`。

## 门禁

- 新增守卫 `src/test/paletteSweep.test.ts`（14 条，读源码断言 10 个文件的遗留类为 0 + 4 处关键令牌）；
- `paletteSweep + tokenMapping + interactionFeedback + changelog/board/knowledge` 子集 → **24 passed**；
- 变异 RED：把 `PlanningSortButton` 的 `hover:text-accent` 改回 `hover:text-blue-600` → 「排序按钮 hover 收敛」用例立刻红，已还原；
- 全量 `pnpm --filter @agentboard/web test` → **112 文件通过 / 2 失败**（`knowledge.test.tsx`、`detail.test.tsx` DispatchDialog，均为既有基线）；
- `pnpm -r build` → **exit 0**。

## 未验证

- 任务树「领取徽标」（`tree-claim-*`）与日志「选中行」两处未取到真机 `getComputedStyle`：前者当前工作区无 running 会话（元素不渲染），后者需先点选日志条目；
- `KnowledgePageDetail.tsx` 的悬浮操作条与知识图（Pixi）内的取色未逐一取真机值（属同一批类名收敛，靠 grep + 守卫测试覆盖）。
