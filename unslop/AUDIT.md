# Unslop 审计与进度（AgentBoard 前端）

> 截图在本地 `unslop/{original,after}/`，**不入库**（`.gitignore` 已忽略，约 2MB）；本文件入库。

方向：`Docs/design-2026-11-03-unslop-direction.md`（暖石墨中性 ramp + 单一琥珀强调；值班台世界）。
原图：`unslop/original/*.png`（1440×900，测试页 5174 真实数据）；实施后：`unslop/after/*.png`。

## 审计（按 references/signs.md 分组，每条一行）

### Surfaces and color（13 条）
1. 列头按状态给色相：`lib/workspaceStatuses.ts` `statusAccent()` 返回 green/blue/purple/amber 四色 → 单一琥珀 + 石墨台阶。
2. 页面/面板底色走纯灰 `bg-neutral-50/900`，中性 ramp 无世界感 → 暖石墨 token（`index.css`）。
3. 强调色分散：`bg-blue-600` 18 处、`bg-blue-50/100` 18 处、`bg-amber-*` 13 处、`bg-purple-100` 2 处、`bg-green-100` 3 处 → chrome 只留琥珀。
4. 选中态是蓝色药丸（`ViewSwitcher` ACTIVE=`bg-blue-100 text-blue-800`）→ 琥珀淡底 + 琥珀字。
5. 计数是白底胶囊（`Column` count pill）→ 弱化 tabular 数字。
6. 卡片/列表面走 `bg-neutral-100 dark:bg-neutral-900`，与页面区分靠灰阶而非台阶 → surface/raised token。
7. 边框用 `border-neutral-200/800`（对比偏硬）→ 发丝线 `border-hairline`（8–10%）。
8. 拖拽落点高亮 `bg-neutral-200/70` → `bg-accent-soft`（唯一强调）。
9. 依赖角标用 `text-amber-700`/`text-neutral-400` 直接写死色值 → 改走 accent/ink-3。
10. 账号页额度条整条绿色 + 「正常」绿色文字 + 蓝/紫/粉能力药丸（`AccountsPanel`/`QuotaCards`/`CapabilityBadges`）→ 留到 pass 3/7（本轮未改）。
11. 能力徽标用 `✓ / ✗ / ?` 字符兼色（`CapabilityBadges.tsx` 3 处）→ pass 3（icons）。
12. 搜索框 `border-neutral-300 + bg-neutral-800` 深色模式偏亮 → raised + hairline。
13. 无 hue 渐变 / 渐变文字 / 彩色光晕 / 彩色阴影 / 色块背景（全仓 grep 0 命中，本项目这块本来就干净）。

### Type（5 条）
14. `text-[10px]`/`text-[11px]` 一次性字号 12 处（`ChangelogPanel`、`MentionPopover`、`AccountsPanel` 等）→ pass 5。
15. 大写 + 宽字距标签：`MentionPopover.tsx:29` `uppercase tracking-wid…` → pass 5。
16. 权重用到 `font-semibold`（600）在列头/按钮，尚有 `font-bold` 残留 → pass 5 收敛到 400/500。
17. 数字未统一 `tabular-nums`（评论数、计数、额度百分比）→ 本轮已给列计数加 tabular，其余 pass 5。
18. 小字未见负字距、未见斜体强调（无命中）。

### Icons（4 条）
19. emoji 作图标/状态：`IssueCard`（🔒💬⚡）、`CapabilityBadges`（✓✗?）、`TopBar`、`GraphControls`、`IssueTreeView`、`ChatPanel`、`SessionSwitcher`、`AccountsPanel` 共 8 个文件 → pass 3（内联 SVG）。
20. emoji 计数（`💬 7`）、emoji 徽标（`📌`/`🔒 等 N 项`）→ pass 3。
21. 图标尺寸不统一（`text-xs`/`text-[10px]`/`h-5`）→ pass 3 统一 16px。
22. 会话状态脉冲点与 emoji 混用 → pass 3/9。

### Spacing（7 条）
23. 卡片内边距一次性值 `py-2 pl-3.5 pr-2`（14px 缩进不落 4px 网格）→ 本轮 `p-3 pl-4`。
24. 列头 `px-2.5 pt-2.5`（10px）→ 本轮 `px-3 pb-1 pt-3`。
25. 工具栏 `px-3 py-1`（12/4）与内容区 `p-3`（12）不一致 → 本轮 `px-4 py-2` / `p-4`。
26. 顶栏 `min-h-12`（48）低于 token 的 56–64 → 本轮 `min-h-14`（56）+ `py-2`。
27. 标签筛选条一行塞 20+ 药丸、行高与间距不一致 → pass 5/7。
28. 树行 `p-2 sm:p-2.5` 与看板卡片密度不一致 → pass 3（随看板+树那张卡）。
29. 一次性值 `mt-[13px]` 类未见（无命中），但 `-mt-px`/`py-[11px]` 散落在 3 处 → pass 5。

### Copy（4 条）
30. 状态名与计数并列但无单位说明（`214` 直接跟列名）→ pass 4 补「N 条」或去掉数字。
31. 「等 N 项」「依赖已清」等中文短语可读，但混用 emoji → pass 3/4。
32. 页面头部只有「任务看板 v0.1.0 + 路径」，无上下文（当前工作区/状态摘要）→ pass 4 建议。
33. 无感叹号、无问候语、无夸张宣称（全仓 grep 0 命中）。

### Components（6 条）
34. 计数/状态用发光药丸（`Badge` 组件 neutral/green/blue/purple/red 五色）→ pass 3/7 收敛。
35. 卡片不是「纸卡」而是一个白盒子 + 左色条 → 本轮改为 12px 圆角 + 发丝线 + 3px 状态轨。
36. `Badge` 的 `tone` 会给出第二/第三强调 → pass 3。
37. 星图控件面板已有自己的变量体系（`--kb-graph-menu-*`），pass 7 统一到令牌。
38. 设置/账号弹窗的按钮层级（蓝主 + 灰次 + 红危险）与 chrome 分隔线密度 → pass 3/7。
39. 无 chart / 无 sparkline / 无 `PRO` 徽标（无命中）。

### Visuals（3 条）
40. 星图是全站唯一允许丰富颜色的 moment，当前配色已由 `graphVisualFormulas` 驱动 → 保持（pass 8 微调）。
41. 看板卡片是产品「实物」（纸卡）→ 本轮已强化（发丝线 + 状态轨 + 暖底）；pass 8 再加一点实体感。
42. 无装饰性光斑/球体/发光网格（无命中）。

### Motion（6 条）
43. `animate-pulse` 7 处：`IssueCard` 会话运行中（实时，保留）、`SessionSwitcher`×2（非实时状态）、`SessionList`、`KnowledgePanel` 骨架（加载态，保留）→ pass 9 清非实时。
44. `animate-bounce` 3 处：`MessageList` 输入中三点（实时，保留但换更克制的 keyframes）→ pass 9。
45. `transition-all` 未见；但 `transition`（未具名）在 `AccountsPanel`/`WorkspaceCard` 等 5 处 → pass 9 必须具名。
46. `hover:scale` 未见命中 → pass 9 复核。
47. 动效时长散落（200/150/300ms 混用）→ pass 9 统一到 160/220/320 + 单一缓动 `cubic-bezier(0.22,1,0.36,1)`。
48. 面板进出场已有 `panelMotion`（160ms + cubic-bezier(0.2,0,0,1)）→ pass 9 与全局缓动对齐。

### Template look（2 条）
49. 暖石墨 + 琥珀方向已落地（非纯灰 #161616），但账号/日志页仍是纯灰 → pass 3/7 铺到全站。
50. 卡片与列的信息层级偏「模板卡片列表」，签名的状态轨已在卡片上出现，尚未进任务树 → pass 3。

**合计 50 条**：Surfaces/color 13、Type 5、Icons 4、Spacing 7、Copy 4、Components 6、Visuals 3、Motion 6、Template 2。

## 最严重的 5 条
1. #1 状态色按 kind 上色相（紫/蓝/绿/琥珀），chrome 里有 4 个色相：第一眼就是 AI 生成。
2. #3 强调色分散（蓝 18 处 + 琥珀 13 处 + 紫 2 + 绿 3），没有「唯一强调」可言。
3. #19 emoji 当图标（8 个文件），锁/评论/闪电/徽标混排。
4. #23–#26 间距不成网格（14/10/12/48 混用），卡片与列头密度不一致，列表读不成块。
5. #10 账号页多色能力药丸 + 绿色进度条 + 蓝紫按钮，一屏 5 个色相。

## 本轮（pass 1 spacing + pass 2 color）已改
- `apps/web/src/index.css`：新增 `@theme inline` 令牌（surface-page / surface-card / surface-raised / hairline / ink / ink-2 / ink-3 / accent / accent-ink）+ 亮暗两套取值（暖石墨 + 琥珀）。
- `App.tsx`：外壳 `bg-surface-page text-ink`。
- `components/topbar/TopBar.tsx`：header 改为 `min-h-14 + px-4 py-2 + bg-surface-card + border-hairline`。
- `components/ui/ViewToolbarShell.tsx`：工具条外壳 `gap-2 + px-4 py-2 + bg-surface-card + border-hairline`。
- `components/ui/ViewSwitcher.tsx`：选中态 `bg-accent-soft text-accent`，常态 `text-ink-2 hover:bg-surface-raised`，按钮 `rounded-md px-3 py-1.5`。
- `components/board/Board.tsx`：列容器 `p-4`；搜索框 `h-8 rounded-lg border-hairline bg-surface-raised text-ink focus:border-accent`。
- `components/board/Column.tsx`：列 `rounded-xl border-hairline bg-surface-raised`；列头 `px-3 pb-1 pt-3`；计数改 `tabular-nums text-ink-3`；拖拽落点 `bg-accent-soft`；空态 `text-ink-3`。
- `components/board/IssueCard.tsx`：卡片 `rounded-xl border-hairline bg-surface-card`；左缘 3px 状态轨（低 ink-3 / 中 ink-2 / 高 accent）；内容 `p-3 pl-4`、`space-y-2`；标题 `text-ink`。
- `lib/workspaceStatuses.ts`：`statusAccent()` 由四色相改为「待验收＝accent，其余 ink 台阶」。
- 新增 `apps/web/src/test/unslopTokens.test.ts`（4 例，钉住令牌与状态色；变异可红）。

## 下一道建议
**pass 3 icons**（emoji → 内联 SVG）优先：它同时消除审计里最刺眼的一条（#19）与依赖角标/评论数的视觉噪音；色板已经安静，接下来最影响「像不像设计过」的是图标与文案（#3 icons + #4 copy 可与 pass 3 合并推进）。
