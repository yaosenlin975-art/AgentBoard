# 侧栏「图标简化 ↔ 完整」可切换 · 设计说明

- 卡号：`8b969e52-f54b-4198-b65d-cc0d9dbce2f3`（SIDEBAR-ICT-1）
- 目录：`Docs/prototypes/sidebar-icon-toggle-2026-11-06/`
- 产物：`index.html` + `styles.css` + `app.js`（纯静态，双击 `index.html` 即可；无构建、无外链、无网络请求）
- 范围：**只做设计与原型，不改 production 代码**。本文第 8 节给出落地建议，仅作提案。

---

## 1. 一句话结论

侧栏保留一套 DOM，用 `app-shell[data-mode="expanded|collapsed"]` 切换：展开 176px 显示图标 + 文字 + 行尾角标，收起 56px 变成图标栏（tooltip 补文案、角标缩成右上角数字、active 多一根 2px 竖条）。两种形态都来自同一份入口列表，所以待决策、知识库、聊天这些新增入口不会在某一种形态里漏掉。

## 2. 现状核对（读过的代码，不是猜的）

| 事实 | 位置 | 对原型的影响 |
| --- | --- | --- |
| 侧栏固定 `w-[176px]`，纵向 flex，底部依次是账号、设置、状态行 | [SideBar.tsx](../../../apps/web/src/components/shell/SideBar.tsx#L87) | 原型沿用 176px 与同样的分区顺序 |
| 六入口由 `ENTRIES` 单份数据渲染，`h-9`（36px）、`gap-2`、`px-2`、`aria-current`、`aria-label` 已齐 | [SideBar.tsx](../../../apps/web/src/components/shell/SideBar.tsx#L118-L155) | 折叠态直接复用 36px 行高与图标路径，不新造图标 |
| 聊天未读、待决策数量是两个独立角标，已有 `data-testid` | [SideBar.tsx](../../../apps/web/src/components/shell/SideBar.tsx#L141-L160) | 原型把两个角标都做成可切 0 / 3 / 120 验证 |
| 导航持久化只存 `view`（key `agentboard.nav`），带 `normalize` 与 `merge` 兜底 | [navStore.ts](../../../apps/web/src/state/navStore.ts#L17-L18)、[navStore.ts](../../../apps/web/src/state/navStore.ts#L110-L113) | 形态记忆应并入这个 store，而不是另开一个 key；非法值回落展开 |
| 动效令牌 `--ab-ease: cubic-bezier(0.22, 1, 0.36, 1)` | [index.css](../../../apps/web/src/index.css#L96) | 与卡面要求的 `cubic-bezier(0.2, 0, 0, 1)` 不一致，见 §7 待拍板 |
| 窄屏断点为 920px（`DRAWER_ANCHOR_MIN_VIEWPORT`，抽屉 <920 走 legacy） | [drawerAnchor.ts](../../../apps/web/src/lib/drawerAnchor.ts#L17-L36) | 原型窄屏采用 920px 口径，不另造断点 |
| 参考原型已有「56px 图标栏」：容器 ≤860px 时 `.sb { width: 56px }`，标签 `display:none`，角标 `position:absolute; top:2px; right:3px; 13px`，状态行只留圆点 | [styles.css](../decisions-redesign-2026-11-06/styles.css#L872-L886) | 宽度、角标位置、状态行收敛方式全部沿用；差别是这里要**双向可切 + 有动画**，所以标签改为 `max-width + opacity` 过渡而不是 `display:none` |

## 3. 两种形态规格

| 维度 | 展开（expanded） | 收起（collapsed） |
| --- | --- | --- |
| 宽度 | 176px | 56px |
| 侧栏内边距 | 8px | 8px 10px |
| 条目标签 | 12.5–13.5px 文字，最多 120px 后省略 | 隐藏（`max-width:0; opacity:0`），按钮 36×36 居中 |
| 当前项 | `--ab-accent-soft` 底 + accent 文字 | 同上，另加左侧 2px accent 竖条（`left:-7px`，高 16px） |
| 角标 | 行尾 pill，`margin-left:auto` | 图标右上角 14×14，`top:-4px; right:-5px`，2px card 色描边隔开图标 |
| 工作空间 | 名称 17px + 路径 10.5px + caret | 34×34 圆角方块显示首字「任」，点击仍打开工作空间浮窗 |
| 账号 / 设置 | 32px 高带边框按钮 + 文案 | 36px 图标按钮，无边框，tooltip 补文案 |
| 状态行 | 圆点 + “服务运行中 · 浅色” | 只留 6px 圆点，tooltip 补全状态与主题 |
| 主区 | 挤压后自动回流，`min-width:0` | 同上 |

角标规则：数量 > 0 才渲染；> 99 显示 `99+`；视觉角标之外，按钮 `aria-label` 同步写「待决策，3 条 / 聊天，3 条未读」，读屏不依赖视觉角标。

## 4. 切换按钮：两个位置都做了，等拍板

原型控制条的「切换按钮位置」可以实时互换，两案共用同一套 `aria-expanded` / `aria-controls` / `Ctrl+B` 语义：

| 方案 | 展开态形态 | 收起态形态 | 优点 | 代价 |
| --- | --- | --- | --- | --- |
| **顶部（当前默认，推荐）** | 工作空间头右侧 24×24「«」幽灵按钮，与工作空间形成“面板控制”簇 | 工作空间方块下方 28×22 图标，仍在头部同一区域 | 位置固定、离视线落点近、不占底部操作区 | 56px 宽度里头部要竖排两个方块，略紧 |
| 底部 | 账号按钮上方整行 32px「收起侧栏 · Ctrl+B」 | 账号上方 36×32 图标 | 展开态文案 + 快捷键更易发现；与账号/设置同组 | 位置靠下、离内容起点远；底部已有三个元素，拥挤 |

推荐顶部：它在两种形态下都留在“头部同一 zone”，不会因为折叠而换到屏幕另一端；底部方案的价值主要是首次发现性，可用首启动一次性 tooltip 弥补（本次未实现，见 §9）。

## 5. 状态记忆

- 只存两个字段：`{ mode, pos }`，key `agentboard.sidebar.prototype`（生产建议并入 `agentboard.nav`，见 §8）。
- 刷新、关标签重开、重启浏览器都保持；读回时做白名单校验，非法值回落 `expanded` / `top`，与 navStore 现有 `normalizeNavView` 同风格。
- 首次进入（无存储）按视口决定：≥920px 默认展开，<920px 默认收起；**这个默认不写入存储**，只有用户显式切换才写，避免把小屏的临时默认固化成偏好。
- 控制条右上角实时显示「记忆：展开 · 顶部」，`title` 里带完整 key 与 JSON，便于评审核对。

## 6. 键盘、可访问性与窄屏

- `Ctrl / Cmd + B` 切换：输入框、textarea、select、contenteditable 内不劫持；生产里 `Ctrl+[` 已用于退出聊天，故不复用。
- 两个切换按钮都在 DOM 里，只有当前位置那个可显示；`display:none` 的那个同时从无障碍树移除，不会出现两个同名按钮。
- 收起时如果焦点在侧栏内（且不在切换按钮上），焦点自动转移到仍可见的切换按钮，避免焦点掉回 body。
- tooltip 由 `data-tip` + CSS 伪元素渲染：hover 延迟 120ms，`:focus-within` 立即出现；tooltip 内容包含角标数，如「待决策 · 3」。
- 焦点环统一 `2px accent / offset 2`，36px 图标在 56px 栏内留 10px，环不被裁切。
- 窄屏（<920px）：
  - 收起态 = 56px 图标栏，主区两列，照常可用；
  - 展开态 = 208px 浮层 + 半透明遮罩，主区**不被挤压**；点遮罩、按 Esc、选中任一入口都会收起并把焦点还给切换按钮；
  - 窄屏的浮层展开是瞬时态，不写入记忆；回到宽屏仍按记忆里的形态显示。

## 7. 动效与令牌

- 全部过渡：`160ms cubic-bezier(0.2, 0, 0, 1)`；标签淡出压到 120ms，比宽度动画先结束，避免文字在收缩过程中被拉成细条。
- `prefers-reduced-motion: reduce` 时全部过渡降到 1ms；控制条另有「减弱动效」开关（加 `.force-reduced`，规则与媒体查询一致），因为系统开关在页内无法模拟。
- 只使用既有 `--ab-*` 令牌（`card / raised / hairline / ink / ink-2 / ink-3 / accent / accent-soft / accent-ink / add / del / shadow`），没有新增颜色；深色值直接沿用 `index.css` 的 `.dark` 覆盖。
- ⚠️ **令牌冲突待拍板**：生产 `--ab-ease` 是 `cubic-bezier(0.22, 1, 0.36, 1)`，卡面要求 `0.2, 0, 0, 1`。原型按卡面执行，并单独定义 `--ab-dur: 160ms`。落地时建议新增 `--ab-ease-rail: cubic-bezier(0.2, 0, 0, 1)` 只给侧栏用，不动全局令牌，避免全站动效手感漂移。

## 8. 生产落地建议（本卡不执行）

1. [navStore.ts](../../../apps/web/src/state/navStore.ts)：新增 `sidebarMode: 'expanded' | 'collapsed'` 与 `toggleSidebar()`；`partialize` 增加该字段；`merge` 里做白名单归一。保持 `view` 语义不变。
2. [SideBar.tsx](../../../apps/web/src/components/shell/SideBar.tsx)：`w-[176px]` 改为 CSS 变量 + `data-mode`；标签保留在 DOM（不要再 `display:none`），加 `aria-expanded/aria-controls/aria-label`；把聊天/待决策角标加 `aria-label` 数量。
3. [index.css](../../../apps/web/src/index.css)：新增 56px 栏、tooltip、角标角标位、focus 环、`motion-reduce` 规则；断点沿用 920px。
4. [App.tsx](../../../apps/web/src/App.tsx)：挂 `Ctrl/Cmd+B`，沿用文件内既有「输入框内跳过」的写法。
5. 测试：`normalize`（非法值回落）、toggle 后 `localStorage` 写入、收起时焦点转移、窄屏选中入口后自动收起；组件测试沿用 `data-testid` 口径。

## 9. 待拍板 / 未验证

**需要拍板（原型里都能直接试）**

1. 默认形态：展开（推荐，折叠作为显式选择）还是折叠？
2. 切换按钮位置：顶部（推荐）还是底部？
3. 动效令牌：按卡面用 `0.2, 0, 0, 1`，还是沿用生产 `0.22, 1, 0.36, 1`？
4. 窄屏展开：浮层 + 遮罩（推荐）还是维持挤压？

**未验证 / 已知风险**

- 触屏没有 hover，tooltip 不可达；当前方案是“点图标即导航”，可发现性靠图标语义与 `aria-label`。若需要，可加首次折叠时的短暂 tooltip 或长按提示。
- 键盘 Tab 顺序正常，但未做方向键 roving tabindex（Six 入口用 Tab 足够，是否加方向键未定）。
- 仅在 1280×800 与 430px 预览下截图核对；1440 / 1920 宽屏未逐像素检查。
- `99+` 以上未定上限（如 999+）；当前截断在 99+。
- 系统级 `prefers-reduced-motion` 只用页内 `.force-reduced` 模拟，未在真机系统设置下复测。

## 10. 验收与实测证据

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 展开 176px，标签与角标齐全 | 通过 | 无头浏览器截图；`getBoundingClientRect().width = 176` |
| 点顶部「«」收起为 56px，标签隐藏、角标仍在 | 通过 | 浏览器实测 176 → 56，角标仍显示 3 |
| 点底部方案「收起侧栏」同样生效 | 通过 | 底部方案实测 56px，主区 904px 无遮挡 |
| 收起态 hover 出 tooltip | 通过 | 浏览器 hover「待决策」出现含“待决策”的提示；自检项打勾 |
| `Ctrl/Cmd+B` | 通过 | 折叠 56px 下按 `Control+b` 回到 176px |
| 刷新保持 | 通过 | 折叠后刷新仍 56px，记忆显示「折叠 · 底部」 |
| 角标 120 → `99+` | 通过 | 控制条切 120 后两个角标均显示 99+ |
| 窄屏浮层展开 | 通过 | `?narrow=1&mode=expanded`：208px 浮层 + 遮罩，主区不挤压 |
| 窄屏图标栏 | 通过 | `?narrow=1&mode=collapsed`：56px 栏 + 两列看板 |
| 深色折叠态 | 通过 | 深色下角标描边、图标、文字对比正常 |
| 控制台报错 | 无 | 浏览器 console 无错误 |
| 减弱动效 | 规则与媒体查询同源 | 页内开关可复验，未做真机系统级复测 |

演示深链（可直接打开某个状态）：
`?mode=collapsed&pos=bottom&count=120&narrow=1&dark=1`，参数可任意组合。

## 11. 非目标

- 不改任何 production 代码、不加路由/接口、不动知识库与账号组件。
- 不在本原型里实现工作空间切换浮窗、账号面板、设置面板（点击只给明确 toast，不做死按钮）。
- 不覆盖主区响应式改造本身（只演示侧栏变化后主区回流）。
