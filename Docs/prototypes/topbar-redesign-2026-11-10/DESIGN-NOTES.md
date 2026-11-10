# 看板顶栏重绘 · 设计说明（TOPBAR-REDESIGN）

- 卡号：父卡 `cb24b3c8-c434-426d-b239-ff1e2308167f`，本原型卡 `c2c9d161-863a-4f54-8a38-d2922f312ea0`
- 目录：`Docs/prototypes/topbar-redesign-2026-11-10/`
- 产物：`index.html` + `styles.css` + `app.js`（纯静态，双击 `index.html` 即可；无构建、无外链、无网络请求）
- 范围：**只做设计与原型**，不改 production 代码。第 6 节为落地建议，供实现卡使用。

---

## 1. 一句话结论

推荐 **方向 A · 极简单行**：46px 单行，左侧面包屑（工作空间 › 视图），中段搜索 + 标签 chips，右端显示密度 / 分组 / 选择；≤920px 折成「信息行 + 标签行」两行。它把旧工具条的全部入口原样保留在条内，只换视觉层级，不改变使用路径，落地风险最低。

方向 B · 分段浮层 作对照方案：40px 单行 + 「筛选」浮层，信息密度更低、窄屏更稳，但把标签筛选从「一眼可见」变成「一次点击」，当前看板的高频筛选场景不划算。

## 2. 现状核对（读过的代码，不是猜的）

截图框选条 = 看板视图顶部工具条，由 `ViewToolbarShell` 外壳 + Board 传入内容组成：

| 事实 | 位置 |
| --- | --- |
| 旧外壳：`flex flex-col gap-2 border-b border-hairline bg-surface-card px-4 py-2`，无内容时返回 null（知识库/日志因此不再出现空白带） | [ViewToolbarShell.tsx](../../../apps/web/src/components/ui/ViewToolbarShell.tsx#L32-L43) |
| 旧内容全部来自 Board：显示密度、分组方式、选择、搜索、标签 chips 五个入口 | [Board.tsx](../../../apps/web/src/components/board/Board.tsx#L364-L429) |
| 树视图额外有「+ 新建任务」 | [Board.tsx](../../../apps/web/src/components/board/Board.tsx#L412-L426) |
| 旧条在 ≤900px 让 chips 换第二行（`max-[900px]:basis-full`），chips 容器不允许 `overflow-x-auto` | [Board.tsx](../../../apps/web/src/components/board/Board.tsx#L409) |
| 侧栏展开 176 / 收起 56，过渡 160ms `cubic-bezier(0.2,0,0,1)` | [index.css](../../../apps/web/src/index.css#L97-L105) |
| 全局缓动 `--ab-ease` 是 `cubic-bezier(0.22,1,0.36,1)`，侧栏专用 `--ab-ease-rail` 才是本次要求的曲线 | [index.css](../../../apps/web/src/index.css#L95-L102) |

结论：**不存在全局 TopBar**（NAV-TOPBAR-01 已移除，侧栏是唯一导航），本次不重新引入全局导航栏；工作区切换/路径/折叠在侧栏头部，账号/设置/主题/同步状态在侧栏底部，均不在框选条内，也不移动。

## 3. 两个方向

原型控制条可实时切换方向、侧栏 176/56、窄屏 900、深色、减弱动效。

### 方向 A · 极简单行（推荐）

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 任务看板 › 看板   [🔍 搜索标题/描述/标签 /]   web 32  功能 18  …  更多 +8   [舒适密度▾][不分组▾][选择] │
└──────────────────────────────────────────────────────────────────────────────┘
```

- 高度：46px；`padding: 0 16px`；`border-bottom: 1px hairline`；底色 `--ab-card`。
- 左：面包屑 11.5px `ink-3` + 12.5px `ink` 的视图名。
- 中：搜索 230px（`--ab-page` 底 + hairline 描边，聚焦 accent 描边 + 2px accent-soft 光圈），右侧 chips 弹性填充。
- 右：密度/分组为 28px 描边 select，「选择」为同高描边按钮；old 的灰底 `bg-surface-raised` 全部收掉，只留发丝线。
- ≤920px：第一行 = 面包屑 + 显示控件 + 搜索（flex 撑满），第二行 = 标签 chips 换行；总高约 76px，**不横滚**，与 LABEL-BAR 的「≤900 换行」口径一致。

### 方向 B · 分段浮层

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 任务看板 › 看板   [🔍 搜索任务]                                    [筛选 ① ▾] [选择] │
└──────────────────────────────────────────────────────────────────────────────┘
                                     ┌─────────────────────────┐
                                     │ 筛选与显示           ✕  │
                                     │ 显示密度 [舒适▾] 分组 [不分组▾] │
                                     │ 标签筛选        清除     │
                                     │ web 功能 server 缺陷 …    │
                                     └─────────────────────────┘
```

- 高度：40px 恒定；浮层绝对定位在条下方，不占布局高度。
- 顶栏只留高频：面包屑、搜索、筛选（带生效数量角标）、选择。
- 浮层：340px，密度/分组并排 + 标签 chips 换行；`Esc` / 点外部 / ✕ 关闭；开合 160ms 位移 4px。
- ≤920px：保持单行；隐藏面包屑里的工作空间段（只留视图名），搜索自适应。

## 4. 取舍对照

| 维度 | 旧工具条 | A · 极简单行（推荐） | B · 分段浮层 |
| --- | --- | --- | --- |
| 占用高度 | 48px；≤900 chips 换行后约 72px | 46px；≤920 两行约 76px | 40px 恒定（浮层不占位） |
| 信息密度 | 全部平铺，但两层 padding + 灰底块，视觉噪声大 | 全部平铺；发丝线 + 无底控件，密度高但不吵 | 顶栏最低密度；筛选内容按需出现 |
| 标签筛选可发现性 | 一眼可见 | 一眼可见 | 需点「筛选」，角标提示生效数 |
| ≤920px | 折两行，第一行仍含搜索与控件 | 折两行，标签整行换行 | 单行不变，最稳 |
| 与侧栏 56px 收起对齐 | 顶栏起于主区左边界，`px-4` 使文本起点在 56+16=72px | 同口径：顶栏不跨侧栏，左内边距 16px 恒等于侧栏 `8+8` 文本起点；侧栏 176↔56 过渡时顶栏内容不位移 | 同口径，窄屏左内边距收到 12px |
| 实现改动 | — | 替换外壳组件 + 重排一层 DOM，入口与 testid 全保留 | 需新增浮层状态/焦点管理，改动面更大 |
| 主要代价 | — | 1440px 下 chips 只露出约 8 个 + 「更多」 | 筛选多一跳；浮层会遮住首列顶部 |

## 5. 旧入口迁移表（每个入口都有归宿）

| 旧入口（testid） | 旧位置 | A 去向 | B 去向 |
| --- | --- | --- | --- |
| 显示密度（`display-density`） | 左组 select | 顶栏右端 select | 筛选浮层 |
| 分组方式（`display-grouping`） | 左组 select | 顶栏右端 select | 筛选浮层 |
| 选择（`board-select-toggle`） | 左组按钮 | 顶栏右端按钮 | 顶栏右端按钮 |
| 搜索（`board-search`） | 中段 input | 顶栏中段搜索 | 顶栏中段搜索 |
| 标签 chips（`board-toolbar-chips`） | 中段 | 顶栏中段，窄屏整行换行 | 筛选浮层 |
| + 新建任务（`tree-create-issue`，仅树视图） | 右端 | 顶栏右端（选择右侧） | 顶栏右端 |

删除的只有视觉壳：`flex-col gap-2` 的两层内边距、`bg-surface-card` 上叠灰底控件的观感；**没有功能入口被删**。侧栏头部/底部入口保持原位。

## 6. 落地建议（给实现卡）

1. 新增 `apps/web/src/components/shell/TopBar.tsx`：一个 `header` 外壳，`h-[46px] px-4 border-b border-hairline bg-surface-card`，内含 `crumb` / `search` / `filters` / `actions` 四个插槽；窄屏用 `flex-wrap` + `max-[920px]:basis-full` 让 chips 换行。
2. `Board.tsx` 把 `<ViewToolbarShell>` 换成 `<TopBar>`，子控件与 testid 原样搬入；树视图「+ 新建任务」放 actions 末尾。
3. 样式优先复用现有令牌类（`border-hairline` / `bg-surface-card` / `bg-surface-page` / `text-ink-*` / `bg-accent-soft`），动效统一 `transition-* duration-150` 并在 `motion-reduce:transition-none`；不要引入新色值。
4. 同步更新 `apps/web/src/test/topbarTabs.test.tsx` 里对旧 class（`px-4 py-2 border-b`）的断言；`toolbarBlank.test.tsx` 若只测旧壳的空态，随外壳删除收敛。
5. 保留 `board-toolbar-chips` 容器不横滚的约束，避免裁掉标签「更多」浮层。

## 7. 演示与截图

- 默认打开带控制条；`?clean=1` 隐藏控制条，`&d=a|b`、`&sb=collapsed`、`&narrow=1`、`&theme=dark`、`&reduce=1` 可直达指定状态。
- 对照截图（1440 / 900，各方向）存于 `.screenshots/topbar-redesign-2026-11-10/`（被 gitignore，不提交）。

## 8. 已知风险

- 窄屏两行方案在 900px 时占 76px，比 B 多 36px；若后续确认「窄屏优先内容区」，应改选 B。
- 顶栏不跨侧栏：若未来侧栏改为浮层抽屉（<920 已有此路径），顶栏左边界仍需跟随抽屉锚点，落地时按 `drawerAnchor` 口径处理。
- 面包屑目前只读；工作区切换仍走侧栏头部，不在顶栏重复入口。
