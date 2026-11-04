# 知识库文档阅读与关系星图设计
- status: proposed
- date: 2026-11-02
- card: -
- supersedes: -

- 日期：2026-11-02
- 状态：设计已获用户确认；尚未实施；兼容性和运行效果待验收
- 范围：AgentBoard 现有知识库的 Web 阅读界面、明确页间关系、全局/局部星图；不改数据库业务真源或工作空间隔离语义

## 1. 目标与约束

- 以清爽的文档阅读界面浏览、搜索、打开知识页，并可切换到 Obsidian 风格关系图。
- 图中每个节点对应一张知识页；每条边只对应页面作者明确建立的引用。反向引用通过反查展示，不自动生成反向正文或边。
- 保留 `workspace`（当前项目）与 `common`（公共经验）范围；不做语义推断、embedding、自动关联、团队 ACL 或远程服务。
- 复用现有 `/api/knowledge/*`、SQLite revisions、CAS 和 scope 校验；MCP 与 CLI 不维护第二套数据。

## 2. 源码现状与证据

| 原始材料 | 已核实事实 | 设计影响 |
|---|---|---|
| `apps/web/src/components/knowledge/KnowledgePanel.tsx`、`KnowledgePageDetail.tsx`、`apps/web/src/lib/markdown.tsx` | 现有 Web 是搜索/筛选列表加正文详情；详情有来源、证据、版本历史、归档/恢复/软删除与有效期；Markdown 使用 react-markdown 和代码高亮，无知识页链接语法或编辑器。 | 在现有面板内增加文档/关系图视图；不重建 Markdown 渲染。 |
| `apps/server/src/db/repos/knowledge.ts`、`apps/server/src/db/migrations/knowledge.ts`、`apps/server/src/api/knowledgeRoutes.ts` | `knowledge_page` 保存当前正文；`knowledge_revision` 保存完整快照且由触发器禁止更新/删除。修订、状态变更在 immediate transaction 内校验 `expected_revision` 并追加 revision。现有 REST 有 search/pages/page/revisions/CRUD/actions，无关系或图谱查询。 | 关系随知识 revision 原子提交；图查询新增 REST 读接口。 |
| `packages/shared/src/types.ts`、`apps/mcp/src/tools/knowledge.ts`、`packages/cli/src/commands/knowledge.ts` | shared types 定义页与 revision；CLI/MCP 经 REST 操作知识。MCP page read 使用分段正文/历史，序列化结果上限 40,000 字符，页操作显式传 scope。 | 新字段需在 shared、REST、CLI、MCP 同名；不新增 MCP 图工具。 |
| `Docs/design-2026-11-01-shared-knowledge.md`、`Docs/design-2026-11-01-unified-mcp.md` | 已确定 Workspace + common、单一 REST/SQLite 真源和页面 CAS；当前设计中的知识库与 MCP 已实现，真实客户端接入另有验收边界。 | 沿用现有契约，旧客户端省略新增字段时保持原语义。 |

源码检索使用 `rg` 定向覆盖 UI、knowledge repository/routes/migration、shared types、CLI/MCP 和上述两份设计稿；没有全仓扫描。GitHub 研究读取上游 release、package manifest 和 README。没有安装依赖、运行代码或做浏览器验收；候选兼容性仅按官方包声明核对。

## 3. 图谱库比较与选择

| 候选 | 固定版本 / 许可证 | 匹配、兼容与成本 | 验证状态 |
|---|---|---|---|
| 浏览器原生 SVG/Canvas | 无外部包 | 零依赖、可直接提供可访问 DOM；力布局、节点拖动、缩放/平移和命中处理需自写。 | 未实现；交互和规模未测。 |
| **react-force-graph-2d** | **1.29.2 / MIT**（上游 suite tag `v1.48.3`） | React 组件；Canvas 力导向布局、缩放、平移、拖节点、节点/边交互与本需求匹配。React peer 为 `*`、Node ≥12，和项目 React 19 / Node ≥20 的包声明兼容。运行依赖 `force-graph`、`prop-types`、`react-kapsule`。Canvas 需配套键盘可达的 HTML 节点列表。 | 用户已批准此包与保留包内 LICENSE/NOTICE；尚未安装、构建或浏览器实测。 |
| cytoscape | 3.34.3 / MIT | 通用图模型、布局和交互；核心包无运行依赖，但需写 React 生命周期适配与样式，范围大于当前需求。 | 未安装或运行。 |

选用 `react-force-graph-2d@1.29.2`。引入时保留该包内 LICENSE/NOTICE，不复制示例源码、不新增顶层许可证文件。未验证项由实施验收覆盖。

上游资料：[react-force-graph-2d manifest](https://github.com/vasturiano/react-force-graph/blob/v1.48.3/src/packages/react-force-graph-2d/package.json)、[react-force-graph README](https://github.com/vasturiano/react-force-graph/blob/v1.48.3/README.md)、[Cytoscape 3.34.3 manifest](https://github.com/cytoscape/cytoscape.js/blob/v3.34.3/package.json)、[Cytoscape 3.34.3 release](https://github.com/cytoscape/cytoscape.js/releases/tag/v3.34.3)。

## 4. 关系真源方案

| 方案 | 优点 | 成本与风险 |
|---|---|---|
| Markdown 内 `[[page-id]]` 或知识页 URL | 文中可直接点击，符合部分 Obsidian 写法。 | 需要后端和 renderer 以相同规则解析 Markdown，排除 code fence、inline code、转义和普通外链；否则图和正文关系不一致。当前 renderer 未启用 wiki-link。 |
| **revision 字段 `related_page_ids` + UI 选择器（推荐）** | 明确结构化输入、稳定 ID；关系随不可变 revision 快照审计，不解析 Markdown。反向引用可从 revision 快照反查。 | 正文不嵌入引用标记；UI 和 CLI/MCP 写入增加一个字段。 |

推荐把 `related_page_ids: string[]` 作为每个知识页版本的明确引用集合。Web 在正文附近提供“引用知识页”选择器，使用现有页面搜索/列表选目标；正文 Markdown 不增加特殊语法。关系字段本身是可修订内容：只新增/移除引用也可单独保存，不要求同时伪造 title/body/sources/evidence 改动；该操作校验 `expected_revision` 并产生一个新 revision。版本历史显示该版本的引用页。一个方向 `A -> B` 只存 A 引用 B；B 的“反向引用”由查询找到 A，不创建 B -> A。

关系保存在 `knowledge_revision.related_page_ids_json`。新增页未传时存 `[]`；修订未传该字段时沿用当前集合；显式传入时与正文、来源、证据在同一个 `expected_revision` CAS 事务中保存。server revise schema 和 repository patch 白名单必须把 `related_page_ids` 列为独立有效字段；`reviseKnowledgePage()` 的“至少一个字段”校验接受只含 `related_page_ids` 的 patch。CLI/MCP 同步接受可选关系数组，MCP refine 同样把该字段视为有效修订；所有通道复用既有 CAS 和冲突语义。归档、恢复、软删除版本沿用当前集合。新 migration 对旧 revision 加默认 `[]`，不回写或改写不可变历史。当前页关系从最新 revision 读取；初版不增加第二份关系真源。反向查询使用 SQLite JSON1 `json_each`，实施前先探测实际 `better-sqlite3` 构建；未通过时停止相关实现并报告父代理，再采用已比较的 revision-keyed 派生关系索引策略，不静默猜测替代实现。

## 5. 作用域与生命周期

- `workspace` 页面 W 可引用 W 内页面及 `common` 页面；`common` 页面仅可引用 `common` 页面。服务器校验每个目标，不信任 UI/MCP 传入的范围。
- `scope=both` 只展开调用 Workspace 与 common。未知、越界 page ID 对外返回同类 `KNOWLEDGE_NOT_FOUND`，不提供跨 Workspace 探测差异。
- 图和反向引用查询都先按 scope 限定节点，再连边；边的两个端点必须属于本次结果范围。
- 页面标题变化不改 ID，边保持且节点显示新标题。slug 当前不可修订，本次不新增 slug 重命名；未来改名仍以 ID 解析。
- 归档页保留引用快照，默认图隐藏；可开“包含归档”查看。软删除页及其当前图边隐藏，历史引用仍保留；现有恢复只恢复 archived，不扩展 deleted 恢复。过期页默认隐藏，可开“包含过期”。UI 可在已打开页面的引用列表中标注归档、过期或删除状态。

## 6. Web 界面与 API

### 文档阅读

- 保留知识范围、搜索、状态、过期筛选和来源/证据/版本信息。
- 桌面使用左侧知识导航、中央正文、右侧可折叠的引用页/反向引用；默认进入正文阅读。
- 提供“文档 / 星图”切换。搜索结果选中页后同步选中图节点；点击节点后读取并显示该页正文。正文引用列表点击同样更新当前页和图节点。
- 窄屏使用单面板切换；图视图提供 HTML 节点列表，键盘可逐项打开知识页，不把 Canvas 当作唯一入口。

### 图查询

新增 `GET /api/knowledge/graph`：

- 参数：`scope=common|workspace|both`；项目范围需要 `workspace_id`；可选 `center_page_id`（局部图）、`selected_page_id`（global 图选中页）、`include_archived`、`include_expired`、`limit`（2–1000）。
- 默认 `limit=500`，最大 1000 节点；边上限 5000。超出时先在已通过 scope/status/expiry 过滤的允许节点中保留合法的 `center_page_id` 与当前 `selected_page_id`，再按稳定 ID 顺序填充；未通过作用域过滤的 ID 永不因“保留选中”而进入结果。只返回 source 和 target 均位于本次 `nodes` 中的边，并返回 `total_nodes`、`total_edges`、`returned_nodes`、`returned_edges`、`truncated`、`omitted_nodes`、`omitted_edges`。界面明确标注“显示数/总数”和图不完整，继续提供完整搜索/分页列表；不得静默裁切。
- 全局图返回当前 scope 内节点和关系；局部图返回所选节点及一跳入边/出边邻居。中心页不在有效 scope 时返回 `KNOWLEDGE_NOT_FOUND`。若当前正文页因超限仍不在 global 图返回列表，前端用同一 scope 和状态筛选重新请求以该页为中心的一跳局部图，再完成定位与打开联动；局部请求也必须服务端验证 scope。
- 响应节点字段：`id,scope,workspace_id,slug,title,status,revision,expires_at`；边字段：`source_id,target_id,source_revision`。边有方向箭头；图层只绘制该响应中的节点与边。

## 7. REST、CLI、MCP 与兼容性

- REST create/revise 增加可选 `related_page_ids`，读页与 revision 响应增加该字段；只改关系即可通过现有 PUT 完成修订，并使用同一 actor、idempotency key 和 `expected_revision`。create/revise schema、repository patch whitelist 和“至少一个修订字段”检查统一识别此字段。图查询只新增 GET 路由。
- CLI create/revise 增加可选 `--related <JSON数组>`；未提供时按 REST 的新增/修订语义处理。`knowledge show --json` 直接显示字段。
- MCP create/revise schema 增加可选 `related_page_ids`；`agentboard_read_knowledge` 以有界窗口返回引用 ID、总数和续读 offset，并继续服从 40,000 字符结果上限。v1 不增加 graph tool；如后续 agent 需要拓扑查询，再复用同一 REST graph 响应。
- 旧客户端创建时省略字段得到空数组；修订时省略字段保留现有关系。新增响应字段保持向后兼容；scope、请求体 strict validation 和 MCP 输出上限仍由服务端执行。

## 8. 实施验收依据

- 实际 `better-sqlite3` 构建可调用 SQLite JSON1 `json_each`；若不支持，停止实现并报告父代理，再使用 revision-keyed 派生索引方案。迁移后旧知识页与全部旧 revisions 的关系数组为 `[]`；新增字段可重复初始化；历史 snapshot 仍不可更新或删除。
- create/revise 的关系和正文由同一 CAS 提交；只改 `related_page_ids` 可成功创建新 revision，无需改动正文或来源；过期 revision 返回现有 `KNOWLEDGE_REVISION_CONFLICT`，关系与正文都不变；归档/恢复/软删除版本保留对应关系快照。
- 建立 Workspace A、Workspace B、common 样例：A→A/common 可保存；A→B 与 common→workspace 被拒；A 的 `both` 图/反向引用不返回 B 的节点或边。
- A→B 只产生一条有向边；B 的反向引用显示 A，但 B 仍无指向 A 的关系。重复 ID、未知 ID、越界 ID 有确定校验结果。
- 改标题后边仍连接相同 page ID；归档/过期筛选和软删除节点/边按本设计隐藏；恢复 archived 后原边返回。
- 浏览器验收桌面与窄屏：文档阅读、搜索选中与节点定位、节点点击打开正文、局部/全局切换、拖动/缩放、键盘节点列表、超限提示、来源/历史区可用；记录真实浏览器结果，构建/单测不能替代此项。
- 安装验收核对 `react-force-graph-2d@1.29.2`、React 19 构建、依赖锁定及包内 LICENSE/NOTICE；此项当前未运行。

## 9. 状态

设计已获用户确认；尚未实施。兼容性和运行效果待验收。

## 10. 未验证项

- `react-force-graph-2d` 在当前 Vite/React 19 浏览器运行环境的构建、拖动/缩放手感与 500/1000 节点表现尚未实测。
- 当前 `better-sqlite3` 构建的 SQLite JSON1 `json_each` 支持尚未实测；若实施前置探测失败，先报告父代理，再采用 revision-keyed 派生关系索引策略。
- 新增图视图的键盘、窄屏和实际页面体验尚未验收。

## 11. 渲染层路线变更（KB-GRAPH-P1，2026-11-03）

技术路线：弃用 canvas 2D 自绘与 sigma 方案，改按 `D:\WorkSpaces\REA\Docs\Obsidian-星图渲染逆向.md` A 章用 PIXI 7.2.4 分包（`@pixi/core|graphics|sprite|text|display|events|app`，无伞包）1:1 重建。

- 文件：`apps/web/src/components/knowledge/pixiGraph.ts`（渲染骨架，动态 import 入口）、`apps/web/src/lib/graphVisualFormulas.ts`（10 个视觉公式 + `tintFromCssColor`）、`apps/web/src/index.css`（`.graph-view.color-*` 11 个语义色，值走 `--kb-graph-*` CSS 变量，亮/暗两套）、`apps/web/src/components/knowledge/KnowledgeGraph.tsx`（容器 div + 懒加载挂载 + 无 WebGL 降级列表）。
- 分层：React 负责取数、边过滤、聚焦/搜索过滤、`layoutGraph` 布局、可测钩子；渲染层负责相机（scale/targetScale/pan）、节点/连线/箭头/水印、A5 每帧九步、停帧。
- 实测（headless Edge + CDP，真实 PIXI WebGL）：rendererType=1、resolution=1；weight 8 → size 9、circleScale 0.09、fontSize 16.25；weight 1 → size 8、0.08、16；scale 1 → textAlpha 1、lineWidth 1；scale 0.5 → textAlpha 0、lineWidth 2、nodeScale 1.4142、箭头 scale 4；双向边 A↔B 只画 1 条（createdEdges 9 / edgeCount 10 / hiddenDuplicateEdges 1）；`hanger.children = 节点数×2 + 实画边数×2 = 40`；一次 `changed()` 61 帧后停；11 语义色取 CSS 变量，改变量或切 `.dark` 后 tint 跟着变（`#5c5c5c`→`#b3b3b3`）。
- 体积：`dist/assets` 935.7 KB → 1274.9 KB，主 chunk 556.1 KB → 582.2 KB，PIXI 惰性 chunk 348.5 KB（gzip 105.8 KB）。
- 未做（后续子卡）：节点拖拽固定、右键菜单、局部图、时间轴动画。

