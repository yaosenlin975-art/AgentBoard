# 主题对比度排查与修复（THEME-CONTRAST-AUDIT）

- 卡：`76cb82f2-afdc-445c-bf33-a9d62f5a6559`
- 环境：Windows 11 + Edge 156（headless CDP）+ vite dev `http://127.0.0.1:5174`（`scripts/dev-page.mjs`）+ 看板 8787
- 审查基线：HEAD `453193c`；复测时间 2026-11-04 02:47–03:10

## 1. 用户点名的问题：暗色「修改模型」弹窗黑底黑字

**根因（两段叠加）**

1. `Modal` 用 `createPortal` 挂到 `document.body`，**在 App 根容器之外**——容器上的 `text-ink` 继承不到，弹窗内的文字回到浏览器默认黑（`#000`）；容器自身只有 `bg-white dark:bg-neutral-900` 没有前景色 → 暗色下「深灰底 + 黑字」。
2. 原生控件没设主题：`<select>`/`<option>` 弹层与 date/time picker 由系统绘制，缺 `color-scheme` 时暗色下按 light 画 → 下拉里黑底黑字。

**修法**

| 文件 | 改动 |
| --- | --- |
| `apps/web/src/index.css` | `html, body { background-color: var(--ab-page); color: var(--ab-ink) }`（portal 内容统一有基准色）；`:root { color-scheme: light }` / `.dark { color-scheme: dark }`；`option, optgroup { background-color: var(--ab-card); color: var(--ab-ink) }` |
| `apps/web/src/components/ui/Modal.tsx` | 容器 `bg-white dark:bg-neutral-900` → `bg-surface-card text-ink border border-hairline`（不再依赖继承） |

修后暗色「修改模型」弹窗实测：标题/标签/输入值/取消/保存在 `rgb(239,233,222)` 文字 on `rgb(28,26,24)` 卡面，最小比值 **5.25:1**（截图 `dark-model.png`）。

## 2. 全站清单（按类型）

### 2.1 令牌值本身不达标（改令牌）

| 文件:行 | 类型 | 修前（暗色/亮色实际计算色） | 修法 |
| --- | --- | --- | --- |
| `index.css:80` `--ab-ink-3`（暗） | 令牌对比度不足 | `#8a847a` on raised `rgb(38,36,33)` = **4.17:1**（列计数、「已关闭」列头、「暂无任务」×7 处/屏） | → `#a09a90`，5.54:1 |
| `index.css:62` `--ab-ink-3`（亮） | 同上 | `#7b7266` on raised `rgb(239,233,223)` = **3.92:1** | → `#6b6257`，4.95:1 |
| `index.css:63` `--ab-accent`（亮） | 强调色作前景不足 | `#b45309` on raised 4.16:1 / on accent-soft tint 4.13:1（选中 tab「平铺看板」、列头「待验收」） | → `#a04a08`，5.0:1 / 4.65:1（白字按钮仍 6.4:1） |

### 2.2 legacy 弱化文字桥接（不改他人文件）

`text-neutral-400`（`#a1a1a1`）亮色 card 上 **2.5:1**；`text-neutral-500`（`#737373`）暗色 card 上 **3.19–3.66:1**。命中位置遍布 TopBar 路径/版本号、设置窗版本、账号面板提示与计数、额度卡、状态设置、Modal 关闭按钮、日志时间戳等（40+ 处，其中 `components/changelog/**`、`components/knowledge/**` 属 web-graph 线）。

| 文件:行 | 类型 | 修前 | 修法 |
| --- | --- | --- | --- |
| `index.css`（新增规则） | 单主题/低对比 legacy 类 | `.text-neutral-400` 2.5:1、`.text-neutral-500` 3.19–3.66:1 | 新增兼容层：`.text-neutral-400, .text-neutral-500 { color: var(--ab-ink-3) }`（亮 4.95 / 暗 5.54）。逐文件迁到 `text-ink-3` 后可删 |

### 2.3 组件内写死/单主题类

| 文件:行 | 类型 | 修前 | 修法 |
| --- | --- | --- | --- |
| `components/ui/Modal.tsx:43` | 单主题 bg（无前景色，portal 继承断裂） | `bg-white … dark:bg-neutral-900`，前景默认黑 | `bg-surface-card text-ink border border-hairline` |
| `components/ui/Badge.tsx:6` | 灰 tone 低对比 | `text-neutral-500` on `bg-neutral-200`：亮 3.76 / 暗 3.19 | `bg-surface-raised text-ink-3` |
| `components/topbar/TopBar.tsx:115` | 白字压在饱和红上 | `bg-red-500 text-white`：**3.82:1** | `bg-accent text-accent-ink`（5.0 / 6.4:1，且符合「单一强调色」） |
| `components/settings/AccountCard.tsx:108` | 经 Badge gray tone 触发的低对比 | 「签到能力未知」3.76/3.19 | 由 2.3 的 Badge 修复覆盖 |

### 2.4 原生控件

| 位置 | 类型 | 修前 | 修法 |
| --- | --- | --- | --- |
| `<select>`/`<option>`（ModelField、IssueTreeView、DispatchDialog、NewIssueDialog、WorkspaceStatusSettings 等 12 处） | 系统绘制未跟随主题 | 暗色下拉弹层按 light 画（黑字/白底），选中项与 date picker 同 | `color-scheme: dark`（+ `option` 显式 `--ab-card/--ab-ink`） |

### 2.5 未映射的 `@theme inline` 令牌类

全量扫描 `bg-/text-/border-/ring-/divide-/fill-/stroke-` 的令牌族使用：`surface-page|surface-card|surface-raised|hairline|ink|ink-2|ink-3|accent|accent-ink|accent-soft` **10/10 均已映射，0 处未映射**（`bg-accent-soft` 类问题在本轮前已修）。

### 2.6 允许残留（写明原因）

| 残留 | 数量 | 原因 |
| --- | --- | --- |
| `bg-white` 缺 `dark:bg-*` | 1（`PlanningSortButton.tsx:80` 的 `hover:bg-white`） | 同串有 `dark:hover:bg-neutral-800`，暗色不落白底 |
| `text-white` | 30+ | 全部压在饱和色按钮/徽标上（blue-600/emerald-600/red-600/accent），实测白字对比 ≥4.5 |
| `#hex` / `rgb()` | 12 | `KnowledgePrintView.tsx`（打印专用 #000/#fff/#999，纸张语义）、`cursor.ts`（光标 SVG 取色）、`knowledgeGraph.ts`（画布色板，每色都带 light/dark 对） |
| `text-neutral-600/700` 等 legacy 文字 | 若干 | 实测对比 ≥4.5（亮 7:1 级），未逐条迁移 |

## 3. 计算样式验证（真实浏览器）

方法：CDP `Runtime.evaluate` 遍历可见文本元素，取 `getComputedStyle` 前景色 + 自底向上合成有效背景（canvas 归一 `oklch()` → sRGB），按 WCAG 2.1 算比值；正文阈值 4.5:1，大字 3:1。

| 屏幕 | 暗色 元素数 / 最小比值 | 亮色 元素数 / 最小比值 | 修前（暗/亮最小） |
| --- | --- | --- | --- |
| 看板 board | 1342 / **5.54** | 1342 / **4.95** | 4.17 / 2.5 |
| 知识库 knowledge | 53 / **5.93** | 53 / **4.91** | 4.17 / 2.5 |
| 日志 log | 142 / **4.58** | 142 / **4.77** | 4.17 / 2.23 |
| 设置 settings | 1396 / **5.25** | 1396 / **4.95** | 4.17 / 2.5 |
| 账号 accounts | 1387 / **5.25** | 1404 / **4.95** | 3.19 / 2.5 |
| 修改模型 model | 1359 / **5.25** | 1359 / **4.95** | 3.66 / 2.5 |

代表性取值（修复后）：
- 正文：暗 `rgb(239,233,222)` on `rgb(28,26,24)` = **11.9:1**；亮 `rgb(31,27,22)` on `rgb(253,251,247)` = **14.6:1**
- 弱化文字：暗 `rgb(160,154,144)` on `rgb(38,36,33)` = **5.54:1**；亮 `rgb(107,98,87)` on `rgb(239,233,223)` = **4.95:1**
- 强调文字：亮 `rgb(160,74,8)` on `rgb(239,233,223)` = **5.00:1**
- 最小项：暗色日志条目 `rgb(239,233,222)` on 选中条 `rgb(52,46,26)` = **4.58:1**（amber-soft 叠加后的实测值）

截图（12 张，暗/亮 × 6 屏）：`Docs/evidence/contrast-2026-11-04/{dark,light}-{board,knowledge,log,settings,accounts,model}.png`

## 4. 门禁

- 新增回归测试 `apps/web/src/test/themeContrast.test.ts`（16 条）：解析 `index.css` 两套令牌算 WCAG 比值，断言 ink/ink-2/ink-3 在 page/card/raised 上 ≥4.5、accent 作前景 ≥4.5、accent-ink on accent ≥4.5，并钉住 portal 基准色与弱化文字桥接。
- **变异 RED**：把暗色 `--ab-ink-3` 改回 `#8a847a` → `themeContrast.test.ts` 立刻 1 红（`在 surface-raised 上都 ≥ 4.5:1`），恢复后 16 绿。
- `npx vite build`（apps/web）→ **exit 0**（built in 5.36s）
- `pnpm -r build` → **exit 0**
- `pnpm --filter @agentboard/web test` → **690 passed / 3 failed**：
  - `knowledge.test.tsx`（已知允许项）
  - `dueDate.test.tsx`：时区边界 flake——`new Date(Date.now()-5d).toISOString()` 在本地 03:06 得到 `2026-10-29`，本地今天 `2026-11-04` → 实际「逾期 6 天」而断言写死 5；与本卡颜色改动无关
  - `detail.test.tsx` DispatchDialog 一例（15s 级慢例，另一条线的 `components/chat/**` 区域）
- `unslopTokens.test.ts` 的亮色 accent 断言同步改为 `#a04a08`（令牌变更的正当同步）

## 5. 未验证 / 残留

- **未在真机 macOS/Safari 验证**：`color-scheme` 与原生 `option` 在 WebKit 的表现未测（本轮仅 Edge/Chromium）。
- `components/changelog/**`、`components/knowledge/**`、`components/chat/**` 属他人正在改的区域，仅做只读测量，未改其文件；其中 changelog 面板的选中条（`bg-accent-soft`）随令牌修复自动达标，无独立改动。
- 令牌值的视觉取舍（accent 压深到 `#a04a08`、暗色 ink-3 提亮）未经设计线确认，若方向需回调只需改 `index.css` 三行，回归测试会同步报警。
- 高频动画/滚动性能未测（不属本卡）。
