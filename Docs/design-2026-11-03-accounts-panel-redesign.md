# 账号管理页重设计（2026-11-03）

状态：已与用户确认三项决策；额度区第二、三段（opencode-go / Codex）版式**待用户发图后定**。

## 1. 问题（用户原话：布局过于丑陋冗余）

现状 `AccountsPanel.tsx` 一屏内堆叠：
1. 标题 + 脱敏说明
2. `QuotaCards`（DeepSeek 余额 / opencode-go 三窗口 / Codex unsupported 三张卡，占满一屏）
3. 两个全局按钮（`OneClickCheckin` / `LocalAccountsImport`）
4. 三个平台分区（`AppSection`）：平台名 + 能力矩阵**整句文字**（capture/switch/checkin + reason code + 来源）+ 账号卡列表 + capture/switch 按钮 + 通知（含裸技术码 details）
5. 批次面板（条件渲染）

冗余来源：能力矩阵用整句文字 + 原因码 + 来源三行；额度卡三张平铺；平台之间缺少分隔层级。

## 2. 已确认决策

| # | 决策 | 取值 |
|---|---|---|
| D1 | 信息架构 | **按平台折叠分区**：顶部额度摘要 → 平台分区（可折叠，头部只留 平台名 + 能力图标 + 主操作）→ 展开才看账号卡；默认折叠、第一个平台展开 |
| D2 | 能力矩阵 | **三个图标徽标**（capture / switch / checkin 各一个：✓ / ✗ / ?）+ hover tooltip 显示原因；技术码收进既有 `<details>` 折叠 |
| D3 | 额度区 | DeepSeek **压成一行**；opencode-go 与 Codex 采用用户提供的**窗口行**式版式（见 §3.1），**Codex 不显示 monthly 行**（只有 5-hour 与 weekly） |
| D4 | 视觉基准 | **卡片分区 + 细分割线**：与看板/抽屉卡片同一套中性色与圆角；平台之间用细分割线，不用嵌套卡片 |
| D5 | 全局操作归属 | 顶部保留「一键签到（全部平台）」，平台分区头部追加「仅该平台」次级操作；「读取本机账号」保留顶部（全平台扫描） |

## 3.1 额度窗口行版式（用户 2026-11-03 发图确认）

每个窗口一行，行内三段 + 下方进度条；窗口之间用 1px 细分隔线，整块是一个卡片：

```
5-hour window    [ 6% used ]                     Resets in 3h 34m
▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
Weekly          [ 14% used ]                     Resets in 5d 17h
▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
Monthly         [ 29% used ]                     Resets in 26d 18h
▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
```

规则：
- 左：窗口名（`5-hour window` / `Weekly` / `Monthly`）。
- 中：已用百分比胶囊，文案 `{n}% used`。
- 右：`Resets in {相对时间}`（`Xd Yh` / `Xh Ym`，向下取整到分钟；已过期显示 `Resets soon`）。
- 下：进度条，填充宽度 = `used_percent`（0–100 截断），填充色用主题绿（暗色下保持对比），轨道用中性色。
- 数据源：`QuotaWindow{ used_percent, resetsAt }`（既有实现已返回）。
- **Codex：只显示 5-hour window 与 Weekly，不显示 Monthly**；Codex 当前为 `unsupported`，此时该卡只显示原因文案，不渲染空进度条。
- `limited=true` 时胶囊文案改 `已限额`，填充色转警示色。

## 3. 目标结构（自上而下）
```
账号管理                                    [脱敏说明]
──────────────────────────────────────────────────
额度摘要：DeepSeek 一行（金额 + 可用性）
          opencode-go（版式待定）  Codex（版式待定）
──────────────────────────────────────────────────
[一键签到（全部平台）]  [读取本机账号]
──────────────────────────────────────────────────
▸ WorkBuddy    ✓capture  ✗switch  ✓checkin      [仅此平台签到]
   （展开后）账号卡 × N + capture/switch 按钮 + 通知
──────────────────────────────────────────────────
▸ MiniMax Code ✓  ✓  ✓                          [仅此平台签到]
▸ TRAE CN      ✓  ✗  ?                          [仅此平台签到]
```

## 4. 行为约束

- 折叠状态默认：第一个平台展开，其余折叠；**折叠状态不做持久化**（避免与「用户以为记住了」冲突），后续需要再说。
- 能力图标三态映射：`true → ✓`、`false → ✗`、能力未取到 → `?`；**不得**把 `reason_code` 直接显示在徽标上（只进 tooltip 与 `<details>`）。
- 平台分区头部的「仅此平台签到」复用既有 `POST /api/checkin-runs`（`app_id` 单平台本就是服务端语义，不需要新端点）。
- 脱敏口径不变：不显示 token / `identity_hash` / vault ref / 文件路径。
- `prefers-reduced-motion` 下折叠展开不做高度动画。

## 5. 待定（等用户）

- opencode-go 的余量展示形态（三窗口：5h / 周 / 月）与窗口重置时间的排布。
- Codex 为 `unsupported` 时的展示形态（占位？隐藏？）
- 两者是否需要图示（进度条 / 环）——用户将发参考图。

## 6. 验收（本轮范围：D1/D2/D4/D5 + DeepSeek 一行）

- web test 无新增失败（允许既有基线 `knowledge.test.tsx`）；新增用例证明折叠、徽标三态、tooltip 原因、DeepSeek 一行布局；变异 RED 1 条。
- `web build`、`pnpm -r build` exit 0。
- CDP：三平台分区默认态（首展开其余折叠）、展开/收起、徽标 tooltip 文案、DeepSeek 一行、窄屏（375）不破版。
- 既有能力断言不回归：`accounts-capability-*`、`accounts-notice-*`、`accounts-summary-*` 等 testid 保留或映射到新徽标（映射须在卡评论写明）。
