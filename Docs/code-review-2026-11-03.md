# 代码审查报告：UNSLOP 工作树（workspace 模式）

- 审查工具：open-code-review `delegate` 模式（OCR v1.13.4 只做文件筛选与规则解析，判断由本 agent 完成）
- 审查时间：2026-11-03 20:55 ~ 21:05（Asia/Shanghai）
- 审查基线：`git rev-parse HEAD` = `5ae2a1f2be4302d52a7293d8e95c9b7363350f0e`；`git status --porcelain` = **34 项**（20:55:48）
- **基线漂移（如实记录）**：审查期间并行 unslop 线仍在写盘——`apps/web/src/components/chat/MessageList.tsx` 在 21:00 后新变为 modified（不在 preview 的 17 个文件内，**未纳入本次审查**）；`apps/web/dist` 在 20:59:54 被外部重建过一次。收尾时 `git status` 计数 38（含本报告的修复）。

## 覆盖统计

| 指标 | 值 |
| --- | --- |
| total_files（OCR preview） | 46 |
| reviewable_files | 17 |
| reviewed_files | **17** |
| skipped_files | 0 |
| coverage_rate | **100%** |
| 额外覆盖（OCR 默认排除，按 lead 要求补审） | 7 个测试文件（6 modified + 1 added，`exclude_reason=default_path`） |

规则来源：`delegate rule` 两组——group 1（`**/*.{ts,js,tsx,jsx,mjs,cjs}`，16 个 TS/TSX）与 group 2（`default`，`index.css`）。

## 结论表

| path | start_line | end_line | category | severity | 一句话问题与建议 |
| --- | --- | --- | --- | --- | --- |
| apps/web/src/index.css | 16 | 27 | bug | **critical** | `--ab-accent-soft` 在 `:root`/`.dark` 有定义却没映射成 `--color-accent-soft`，Tailwind v4 因此**不生成** `bg-accent-soft` 工具类（已修：补映射；证据见下） |
| apps/web/src/components/settings/QuotaCards.tsx | 232 | 232 | bug | **high** | 「已限额」chip 用了不存在的 `text-accent50/50`（疑似编辑事故）+ 残留 `dark:text-amber-300`，文字色静默丢失（已修） |
| apps/web/src/components/chat/SessionList.tsx | 1 | 219 | maintainability | **high** | 与 `chat/SessionSwitcher.tsx` 逐字节重复（仅 BOM 差 1 行）、导出同名 `SessionSwitcher`、**无任何 import 引用**，且内容停在 unslop 前的旧配色——后来者 import 它会静默拿到旧样式（已删） |
| apps/web/src/test/AccountsPanelRedesign.test.tsx | 89 | 101 | test | **high** | 三处 `toHaveTextContent('✓'/'✗')` 被替换成**紧邻上一行的同一断言**（`data-state`），断言等于删掉；另 117 行 `?` 同样被替换（已修：断言图标 + aria-label） |
| apps/web/src/test/CapabilityReasonCodes.test.tsx | 95 | 98 | test | **high** | 同上：`✓` 断言被复制成重复的 `data-state` 断言（已修） |
| apps/web/src/components/board/Board.tsx | 202 | 202 | other | medium | 搜索框 `outline-none` + 仅 `focus:border-accent`，键盘焦点只剩 1px 边框变色（WCAG 2.4.7 风险）；建议 `focus-visible:outline-2 outline-accent` |
| apps/web/src/components/board/Column.tsx | 51 | 51 | style | medium | 残留 `dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-blue-400`，暗色下把已废弃的蓝色 hover 又带回来，与「chrome 只有一个强调色」冲突，且覆盖了同元素的 token 类 |
| apps/web/src/components/topbar/TopBar.tsx | 60 | 60 | style | medium | 工作空间触发器仍留 `hover:bg-neutral-100 dark:hover:bg-neutral-800` 与 `focus-visible:outline-blue-500`（token 化未做完；同类残留另见 97/110/129/138 行） |
| apps/web/src/components/settings/RestartServerPanel.tsx | 186 | 186 | style | medium | `recovered`（成功）从绿色改成 `text-ink`，成功与超时现在只靠文案区分；else 分支仍是旧 neutral |
| apps/web/src/components/settings/QuotaCards.tsx | 229 | 236 | style | medium | 同一行内混用两套色板：窗口标题 `text-neutral-800 dark:text-neutral-200`、重置时间 `text-neutral-500`，与刚 token 化的 chip/进度条不一致 |
| apps/web/src/test/board.test.tsx | 289 | 289 | test | medium | 评论数断言从 `'💬 2'` 放宽为 `'2'`（356/368 同），emoji→SVG 后**图标是否渲染**再无断言；建议补 `querySelector('svg') !== null` |
| apps/web/src/test/unslopTokens.test.ts | 16 | 19 | test | medium | 直接断言 `index.css` 里的十六进制字面量（任何有意调色都会红），却**没有**断言 `@theme inline` 的令牌映射——本次 critical 正是从这里漏过；建议改为断言 `--color-*` 键集合 |
| apps/web/src/components/board/IssueCard.tsx | 84 | 84 | maintainability | low | 去掉 `animate-pulse` 后留下 `className=""`（死属性）；且卡片内运行中圆点用 accent、`SessionSwitcher` 里仍用 green，同类语义两种颜色 |
| apps/web/src/components/ui/Icon.tsx | 10 | 25 | maintainability | low | `base()` 把 `...rest` 展开在 `aria-hidden`/`className` **之后**，调用方可用 props 覆盖 a11y 与尺寸默认值；建议把 `...rest` 提前、固定项后置 |
| apps/web/src/lib/workspaceStatuses.ts | 45 | 55 | style | low | `open`（待规划）与 `deprecated`（已废弃）现在同为 `text-ink-2`，两列列头同色；若为有意取舍，建议在注释里写明可读性依据 |
| apps/web/src/test/changelog.test.tsx | 143 | 146 | test | low | 正文断言从「h2 标题 + listitem」放宽为「文本出现」；已核对 `changelogView.test.tsx:227-228` 仍在断言真实结构，故不算覆盖丢失，仅记录 |

误报丢弃（未计入）：`index.css` 的 `dark:` 变量块被 OCR 规则提示「重复定义」——那是亮/暗两套令牌，属正确写法；`Icon.tsx` 的 `dangerouslySetInnerHTML` 检查项——全文件无该 API（`grep` 0 命中）。

## 分级汇总

- **critical 1**：`bg-accent-soft` 工具类未生成（3 处使用：Column 拖拽悬停、ViewSwitcher 选中 tab、QuotaCards 已限额底）
- **high 4**：QuotaCards 失效类名、SessionList 重复文件、两处测试断言被「复制成重复断言」
- **medium 7**：焦点可见性、三处色板残留、成功态语义色、测试两处放宽、令牌测试未覆盖映射
- **low 4**：空 className、Icon props 覆盖顺序、状态同色、changelog 断言放宽（已核对有兜底）

## 已修（high/critical，均只改 `apps/web/**`）

1. `index.css`：`@theme inline` 补 `--color-accent-soft: var(--ab-accent-soft);`（含一行注释说明为什么必须映射）
2. `QuotaCards.tsx:232`：`bg-accent-soft text-accent`（并去掉 `dark:text-amber-300`），非限额分支改 `bg-surface-raised text-ink-2`
3. 删除 `apps/web/src/components/chat/SessionList.tsx`（重复文件，内容与 `SessionSwitcher.tsx` 等价，`sha256=9d0e6c78…`）
4. `AccountsPanelRedesign.test.tsx`：三处被替换的断言恢复为「`svg` 存在 + `aria-label` 含可用/不可用/能力未知」
5. `CapabilityReasonCodes.test.tsx`：同上恢复为 `svg` + `aria-label` 断言

## 验证

- `pnpm --filter @agentboard/web test` → **exit 1**：`Test Files 1 failed | 74 passed (75)`，`Tests 1 failed | 643 passed (644)`；唯一失败为 `src/test/knowledge.test.tsx > dispatch knowledge query is editable…`（既有已知失败，允许项），修复前后计数一致
- `npx vite build`（apps/web）→ **exit 0**，`built in 5.23s`
- 修复有效性硬证据：修复前构建产物里 `.bg-accent-soft` 命中 **0** 次（`--ab-accent-soft` 变量存在但无工具类）；修复后 `dist/assets/index-D8OFRN9g.css` 中 `.bg-accent-soft{` 命中 **1** 次，`.text-accent{` 1 次
- 测试未被放宽的反向确认：修复后的三态断言在把 `CapabilityBadges` 的 `<IconCheck/>` 临时换成文本时会红（本次未跑该变异，属未验证项，见下）

## 未验证

- `MessageList.tsx`（21:00 后新出现的改动）不在 OCR 基线内，未审。
- 变异验证（mutation）未做：本次为审查任务，未对修复项逐条跑「去掉修复会红」。
- medium/low 项按要求**未修改**，只给建议。
- 真机视觉验收未做（本次无浏览器截图）；`accent` 滥用度按屏统计未做量化（仅逐文件人读）。
