# 知识库索引

> 唯一入口。规则：**新增任何文档必须同时在此加一行**；结构见知识页 `b1b42706`（知识库分类体系 §4.4）。
> 自检：`node scripts/check-docs-taxonomy.mjs`（索引覆盖 + 知识页分类；`--emit-section5` 重新生成第 5 节）。

## 1. 四条常用路径

| 我要… | 先读 |
|---|---|
| 改功能 / 加需求 | [设计文档.md](Docs/设计文档.md) → [DESIGNS.md](Docs/DESIGNS.md) → `Docs/designs/<域>/` 最新一篇 |
| 查接口 / 字段 / 错误码 | [api.md](Docs/api.md) → [参考代码索引.md](Docs/参考代码索引.md) |
| 查证据 / 验收记录 | 本文件 §4 → `Docs/evidence/<卡号>-YYYY-MM-DD/` → [PENDING_TESTS.md](Docs/PENDING_TESTS.md) |
| 查为什么 / 根因 / 历史裁决 | 应用内知识页 §5（优先 `solved` / `pinned`）→ `Docs/decisions/` → `Docs/research/` |

## 2. 现行文档（7 篇）

根目录只保留这 7 篇“现行真相源”；其余根目录文档是报告/快照，见 §4。

| 文件 | 一句话结论 | 最近更新 | 关联卡 |
|---|---|---|---|
| [设计文档.md](Docs/设计文档.md) | 需求、方案、接口、UI 布局的起点长文 | 2026-11-02 | — |
| [api.md](Docs/api.md) | REST + WebSocket 完整接口参考（端点、字段、错误码、WS 事件） | 2026-11-04 | — |
| [DESIGNS.md](Docs/DESIGNS.md) | 已落地架构与数据流 | 2026-11-04 | — |
| [CHANGELOG.md](Docs/CHANGELOG.md) | 仓库级变更记录 | 2026-11-02 | — |
| [PENDING_TESTS.md](Docs/PENDING_TESTS.md) | 人工验收清单 | 2026-11-02 | — |
| [实施计划.md](Docs/实施计划.md) | 分阶段实施与排期口径 | 2026-10-31 | — |
| [参考代码索引.md](Docs/参考代码索引.md) | 关键代码位置速查 | 2026-10-31 | — |

## 3. 设计方案（按域）

状态取文件头部 `status` 字段；存量文件未统一重写（分类体系 §4.3 不强制）。

| 域 | 日期 | 文件 | 状态 | 取代了谁 | 关联卡 |
|---|---|---|---|---|---|
| accounts | 2026-11-01 | [workbuddy-accounts.md](Docs/designs/accounts/2026-11-01-workbuddy-accounts.md) | proposed | — | ACC 多账号/签到 |
| accounts | 2026-11-03 | [accounts-panel-redesign.md](Docs/designs/accounts/2026-11-03-accounts-panel-redesign.md) | superseded | —（被 2026-11-04 统一面板接续） | ACC-PANEL |
| accounts | 2026-11-04 | [accounts-unified-panel.md](Docs/designs/accounts/2026-11-04-accounts-unified-panel.md) | proposed | 2026-11-03-accounts-panel-redesign.md | ACC-PANEL-03 |
| board | 2026-11-01 | [task-hierarchy-images-and-launch.md](Docs/designs/board/2026-11-01-task-hierarchy-images-and-launch.md) | proposed | — | TREE-01/02、IMG-01~04 |
| board | 2026-11-02 | [workspace-changelog.md](Docs/designs/board/2026-11-02-workspace-changelog.md) | proposed | — | SHA 变更日志 |
| board | 2026-11-03 | [issue-dependencies.md](Docs/designs/board/2026-11-03-issue-dependencies.md) | proposed | — | `kb dep` 依赖边 |
| board | 2026-11-03 | [smart-create.md](Docs/designs/board/2026-11-03-smart-create.md) | proposed | — | 智能建卡 |
| board | 2026-11-03 | [status-model-and-due-date.md](Docs/designs/board/2026-11-03-status-model-and-due-date.md) | proposed | — | STATUS-1/2 |
| chat | 2026-11-04 | [nav-sidebar-chat-view.md](Docs/designs/chat/2026-11-04-nav-sidebar-chat-view.md) | proposed | — | 导航/聊天整屏 |
| infra | 2026-11-01 | [unified-mcp.md](Docs/designs/infra/2026-11-01-unified-mcp.md) | proposed | — | MCP-04/05 |
| knowledge | 2026-11-01 | [shared-knowledge.md](Docs/designs/knowledge/2026-11-01-shared-knowledge.md) | proposed | — | 共享知识库 |
| knowledge | 2026-11-02 | [knowledge-reader-and-graph.md](Docs/designs/knowledge/2026-11-02-knowledge-reader-and-graph.md) | proposed | — | 阅读器/星图 |
| knowledge | 2026-11-03 | [knowledge-content-model.md](Docs/designs/knowledge/2026-11-03-knowledge-content-model.md) | proposed | — | 内容模型 |
| knowledge | 2026-11-03 | [knowledge-images-and-history.md](Docs/designs/knowledge/2026-11-03-knowledge-images-and-history.md) | proposed | — | KB-IMG-1~3 |
| ui | 2026-11-03 | [local-voice-input.md](Docs/designs/ui/2026-11-03-local-voice-input.md) | proposed | — | VOICE-5 |
| ui | 2026-11-03 | [unslop-direction.md](Docs/designs/ui/2026-11-03-unslop-direction.md) | proposed | — | UNSLOP |

## 4. 调研 / 决策 / 证据

“结论去向”：是 = 已落进代码；部分 = 部分落地或待验证；否 = 仅调研/待执行；证据类默认是（本卡验收留存）。

| 类型 | 域 | 日期 | 文件 | 结论去向 | 关联卡 |
|---|---|---|---|---|---|
| 调研 | accounts | 2026-11-03 | [codex-quota.md](Docs/research/accounts/2026-11-03-codex-quota.md) | 是 | CODEX-QUOTA |
| 调研 | accounts | 2026-11-03 | [multi-account-workbuddy-minimax-trae.md](Docs/research/accounts/2026-11-03-multi-account-workbuddy-minimax-trae.md) | 是 | ACC-RESEARCH-01 |
| 调研 | accounts | 2026-11-04 | [codebuddy-401.md](Docs/research/accounts/2026-11-04-codebuddy-401.md) | 否（恢复步骤待执行） | ACC-02 |
| 调研 | infra | 2026-11-03 | [macos-docker-readiness.md](Docs/research/infra/2026-11-03-macos-docker-readiness.md) | 部分 | DOCKER |
| 调研 | ui | 2026-11-03 | [local-asr.md](Docs/research/ui/2026-11-03-local-asr.md) | 否（待实现） | VOICE |
| 决策 | infra | 2026-11-03 | [docker.md](Docs/decisions/2026-11-03-docker.md) | 是 | DOCKER-2/3 |
| 决策 | board | 2026-11-03 | [status-model.md](Docs/decisions/2026-11-03-status-model.md) | 是 | STATUS-1 |
| 决策 | accounts | 2026-11-04 | [device-identity.md](Docs/decisions/2026-11-04-device-identity.md) | 是 | ACC-KB-B6 |
| 决策 | board | 2026-11-04 | [labeling.md](Docs/decisions/2026-11-04-labeling.md) | 部分（治理条款待裁决） | 标签治理 |
| 证据 | accounts | 2026-11-04 | [acc-ui-05-2026-11-04.md](Docs/evidence/acc-ui-05-2026-11-04.md) | 是 | ACC-UI-05 |
| 证据 | board | 2026-11-02 | [board-ui-progress-2026-11-02.md](Docs/evidence/board-ui-progress-2026-11-02.md) | 是 | BOARD-UI |
| 证据 | accounts | 2026-11-04 | [cb-utf8-2026-11-04.md](Docs/evidence/cb-utf8-2026-11-04.md) | 是 | CB-UTF8 |
| 证据 | infra | 2026-11-04 | [cb-version-a2-2026-11-04.md](Docs/evidence/cb-version-a2-2026-11-04.md) | 是 | CB-VERSION-A2 |
| 证据 | chat | 2026-11-04 | [chat-img-delivery-2026-11-04.md](Docs/evidence/chat-img-delivery-2026-11-04.md) | 是 | CHAT-IMG |
| 证据 | accounts | 2026-11-01 | [checkin-provider-contracts-2026-11-01.md](Docs/evidence/checkin-provider-contracts-2026-11-01.md) | 是 | ACC 签到 |
| 证据 | accounts | 2026-11-01 | [codebuddy-desktop-contract-2026-11-01.md](Docs/evidence/codebuddy-desktop-contract-2026-11-01.md) | 是 | ACC-01 |
| 证据 | infra | 2026-11-04 | [db-home-e2e-2026-11-04.md](Docs/evidence/db-home-e2e-2026-11-04.md) | 是 | DB-HOME |
| 证据 | chat | 2026-11-04 | [draft-session-reuse-2026-11-04.md](Docs/evidence/draft-session-reuse-2026-11-04.md) | 是 | DRAFT-SESSION |
| 证据 | infra | 2026-11-04 | [dsh-shim-fix-2026-11-04.md](Docs/evidence/dsh-shim-fix-2026-11-04.md) | 是 | DSH-SHIM |
| 证据 | chat | 2026-11-02 | [image-cli-contracts-2026-11-02.md](Docs/evidence/image-cli-contracts-2026-11-02.md) | 是 | IMG-CLI |
| 证据 | chat | 2026-11-03 | [image-cli-recheck-2026-11-03.md](Docs/evidence/image-cli-recheck-2026-11-03.md) | 是 | IMG-CLI |
| 证据 | knowledge | 2026-11-04 | [kb-import-e2e-2026-11-04.md](Docs/evidence/kb-import-e2e-2026-11-04.md) | 是 | KBIMP-3 |
| 证据 | accounts | 2026-11-03 | [minimax-trae-switch-demo-2026-11-03.md](Docs/evidence/minimax-trae-switch-demo-2026-11-03.md) | 是 | ACC-SWITCH |
| 证据 | ui | 2026-11-04 | [palette-board-log-2026-11-04.md](Docs/evidence/palette-board-log-2026-11-04.md) | 是 | PALETTE |
| 证据 | board | 2026-11-04 | [smart-create-codebuddy-2026-11-04.md](Docs/evidence/smart-create-codebuddy-2026-11-04.md) | 是 | SMART-CREATE |
| 证据 | ui | 2026-11-04 | [theme-contrast-audit-2026-11-04.md](Docs/evidence/theme-contrast-audit-2026-11-04.md) | 是 | CONTRAST |
| 证据 | accounts | 2026-11-01 | [workbuddy-desktop-contract-2026-11-01.md](Docs/evidence/workbuddy-desktop-contract-2026-11-01.md) | 是 | ACC-01 |
| 证据 | accounts | 2026-11-03 | [workbuddy-tray-exit-and-switch-demo-2026-11-03.md](Docs/evidence/workbuddy-tray-exit-and-switch-demo-2026-11-03.md) | 是 | ACC-SWITCH |
| 证据 | ui | 2026-11-04 | [fix3-drawer-threshold-2026-11-04/boundary.md](Docs/evidence/fix3-drawer-threshold-2026-11-04/boundary.md) | 是 | FIX3 |
| 证据 | ui | 2026-11-04 | [formal-page-smoke-2026-11-04/README.md](Docs/evidence/formal-page-smoke-2026-11-04/README.md) | 是 | SMOKE |
| 证据 | knowledge | 2026-11-04 | [kb-cli-import-sample.md](Docs/evidence/kb-cli-import-sample.md) | 是 | KB-CLI-IMPORT |

证据目录里的截图 / `result.json` / `*.mjs` 是附件，不逐件入索引；目录本身已由上表最后两行或卡号命名登记。

**报告与快照（根目录，非现行真相源）**

| 日期 | 文件 | 用途 |
|---|---|---|
| 2026-11-03 | [acceptance-triage-2026-11-03.md](Docs/acceptance-triage-2026-11-03.md) | 待验收卡复审分类 |
| 2026-11-03 | [code-review-2026-11-03.md](Docs/code-review-2026-11-03.md) | UNSLOP 工作树代码审查 |
| 2026-11-03 | [skill-trial-report-2026-11-03.md](Docs/skill-trial-report-2026-11-03.md) | 四份技能文档实测缺陷 |
| 2026-11-03 | [archive-2026-11-03-agentboard-skill.md](Docs/archive-2026-11-03-agentboard-skill.md) | 旧 `skills/agentboard` 删除前快照 |
| 2026-11-04 | [知识卡：产品体检 2026-11-04](knowledge:bdb81648-5bec-4746-839e-b8c325daf499) | 产品体检跨模块一致性原则与未闭环项（原 md 与截图目录已清退，全文在该页 rev1 历史） |
| 2026-11-04 | [guide-2026-11-04-cli-knowledge-tasks.md](Docs/guide-2026-11-04-cli-knowledge-tasks.md) | 当前工作区 CLI / 知识 / 任务操作指引 |
| 2026-11-04 | [kb-cli-newcomer-report.md](Docs/kb-cli-newcomer-report.md) | `kb` CLI 新人可用性实测 |
| 2026-11-13 | [desktop-build-pitfalls.md](Docs/desktop-build-pitfalls.md) | Windows 桌面端构建三坑与产物校验口径（D12） |
| 长期 | [agentboard测试问题记录.md](Docs/agentboard测试问题记录.md) | 测试问题流水 |

**其它目录**

| 位置 | 内容 |
|---|---|
| `Docs/drafts/` | 闲时任务草稿 3 篇（[续做三条线](Docs/drafts/2026-11-01-续做三条线.md)、[完成全部待规划](Docs/drafts/2026-11-02-完成工作区全部待规划任务.md)、[动态决策](Docs/drafts/2026-11-02-推进待规划任务-动态决策.md)） |
| `Docs/prototypes/` | 账号页原型（[DESIGN-NOTES.md](Docs/prototypes/accounts-redesign-2026-11-04/DESIGN-NOTES.md) + 3 个 HTML） |
| `Docs/external/` | 外部资料冻结区（[README.md](Docs/external/README.md) 说明来源与取得日期） |

## 5. 应用内知识页（按域）

由 `node scripts/check-docs-taxonomy.mjs --emit-section5` 从 `kb knowledge list/show --json` 生成，**不手抄**；剔除 deleted 页。

<!-- SECTION5:START -->
| 域 | page id | category | 生命周期 | landed | 是否 common | 标题 |
|---|---|---|---|---|---|---|
| accounts | `1646fa18-6b37-4323-807c-0c466ccdccf5` | design | active | landed | workspace | 账号行危险操作的两步流口径与验证套路 |
| accounts | `ca7d1e4a-797a-411b-b691-a3225cdf12d6` | design | active | landed | workspace | 账号删除端点的外键口径与凭据文件删除顺序 |
| accounts | `c2111322-7bfc-4318-91d0-572ab7f3920e` | design | active | landed | workspace | 账号页六行总览（ACC-PANEL-03）：testid 契约与签到芯片口径 |
| accounts | `a1cf93ba-95a4-4f92-8482-f0c788250f3e` | design | archived | partial | workspace | B4S-4 切换骨架 S0–S5 收敛为一份共用流程 |
| accounts | `12cea879-6dd0-4399-a881-07bb0e0b0821` | design | archived | partial | workspace | B4S-3 S3/S5 校验与回滚接入 A3 restore |
| accounts | `77cf046c-4e90-4f93-8028-6cebc4042608` | design | archived | partial | workspace | ACC-KB-B2S 协议级添加账号服务端（五平台授权流） |
| accounts | `500160b2-b086-41ef-b514-cd3f004f626c` | design | archived | partial | workspace | B4W 切换前置条件与失败原因界面（账号卡口径） |
| accounts | `8bac607e-300a-47c8-83fd-eaa6f67bbf22` | pinned | active | — | common | 五平台账号运维总览（Trae CN / Qoder CN / WorkBuddy / MiniMax Code / ZCode） |
| accounts | `cc06032d-59de-480a-a5af-6e627ed12ff2` | pinned | active | — | common | 五平台无感换号机制与必须成套搬的设备字段 |
| accounts | `89c72721-f580-4427-b721-675408b29300` | pinned | active | — | common | 五平台添加账号的协议与自动化程度 |
| accounts | `9733aae8-111d-4589-a2ec-b118b070d2bc` | pinned | active | — | common | 五平台凭据落点与「加密」实质 |
| accounts | `3c21b76c-ffb4-49c4-b496-fc7b8224a119` | pinned | active | — | common | 五平台积分余额接口矩阵（含实测读数） |
| accounts | `228e1b70-d010-4ca9-8d04-f32de5ffebc2` | pinned | active | — | common | ZCode 深挖：凭据信封 · 双区互斥 · 一账号一目录多开 |
| board | `f88b3445-f253-42c3-8424-670be243195b` | design | active | landed | workspace | AgentBoard 测试与门禁 |
| board | `fe4518bd-8746-41d0-8451-bc5606668e0f` | design | active | landed | workspace | 设计方案：任务依赖（DESIGNS §7） |
| board | `3d1415c4-5bbc-4766-9877-f8270df5a93d` | open | active | — | workspace | AgentBoard 坑与注意点 |
| board | `61a13159-462b-4aa4-b812-1c0e0d890dc9` | pinned | archived | — | workspace | 项目现状交接 2026-11-04（暂停） |
| board | `b4a67766-35b0-4906-9f47-1986097e7062` | solved | archived | — | workspace | 任务看板 项目状态（2026-11-03） |
| chat | `1d29e637-b060-4760-8b30-7c6d9590e98d` | design | active | landed | workspace | codebuddy 双安装检测坑与聊天图片投递真机验证模式（CHAT-IMG-DELIVERY 实录） |
| chat | `fabd830f-5fb7-4d46-a3ab-a3840557be98` | solved | archived | — | workspace | handoff-077ece77 IMG-04（图片派发/唤醒/会话集成） |
| chat | `5d173c8a-3041-44de-9f95-727a54b7f58e` | solved | archived | — | workspace | handoff-2044dcb4 CHAT-RENDER01（泡泡/正文渲染） |
| infra | `13047a85-8c9e-4e95-8030-df722f737a7c` | design | active | landed | workspace | AgentBoard 服务端与数据层 |
| infra | `9548444c-3356-4af6-9221-7581dd2b2063` | design | active | proposed | workspace | 工作区自治数据库（.agentboard 分布式存储）设计 |
| infra | `3ea2c944-c184-4c0f-a5fb-507f84c77a45` | solved | active | — | common | DSH 隐藏与筛选已归档会话 |
| knowledge | `e55715b6-3ff8-482d-8097-6f0518f5cb67` | design | active | landed | workspace | 知识卡引用落地面：resolve 唯一入口 + link 全域产出（KB-PAGE-2b） |
| knowledge | `047f82d5-4ef6-45eb-8a98-0c52993b364b` | design | active | landed | workspace | 知识页分类回填的实操口径（domain / legacy 收口） |
| knowledge | `d089473d-11d6-4ad3-8347-81c80c344406` | design | active | proposed | workspace | AgentBoard 工作区知识与任务指引设计 |
| knowledge | `51066e4d-8dbd-42cf-a642-de8cf72b3289` | design | active | landed | workspace | Docs 引用校验门禁（check-docs-refs） |
| knowledge | `d84d7fd9-9b43-4541-8e81-d4572f504b0a` | design | active | proposed | workspace | 知识卡片关联（Knowledge Card Links）设计 |
| knowledge | `b1b42706-01fc-4439-ad8d-e81da2d2ed38` | design | active | proposed | workspace | 知识库分类体系（盘点 · 方案 · 落地方案） |
| knowledge | `d37befc0-bdac-41b3-b0e2-b87d39f77678` | solved | archived | — | workspace | CLI knowledge selftest page |
| knowledge | `5d245a4a-7349-4f4f-9456-ecbb8db9a341` | solved | active | — | common | KB-CLI-IMPORT 真机样例 |
| knowledge | `28c37f99-c897-4d72-ab6b-e65ef1990a1d` | solved | active | — | common | KBIMP-3 Markdown 样例 |
| knowledge | `c9b04560-a478-48fa-8c33-b7a203fff919` | solved | archived | — | workspace | 知识页时间展示验证（KB-PAGE-TIME） |
| ui | `a98c1c3d-ae60-400a-87a4-05076a3e236e` | design | active | landed | workspace | AgentBoard 前端与交互 |
| ui | `c4ac531b-010d-469e-955e-f6761f7486bc` | design | active | landed | workspace | 设计方案：星图 PIXI 重建（DESIGNS §8） |
| ui | `1740a9b9-b42b-4968-8191-f1b5f878db15` | design | active | landed | workspace | apps/web 新增绘制形态：不改既有卡片 DOM 与 web 基线噪声清单 |
| ui | `75effb5e-7a67-4edf-aad3-89d6589d73f3` | design | active | landed | workspace | web 测试页 DOM 验证路径、抽屉头部控件几何与 apps/web 既有失败基线 |
| ui | `8c72df9b-6d06-46a3-bf33-afe130b2f608` | solved | archived | — | workspace | handoff-72daf739 UI-FILTER01（标签 toggle 筛选） |
<!-- SECTION5:END -->

## 6. 归档规则 + 最近归档

| 对象 | 触发 | 动作 |
|---|---|---|
| 设计方案快照 | 同域出现更新版本 | 旧版 `git mv` 到 `archive/YYYY-MM/`，新版头部写 `supersedes` |
| 验证证据 | 卡关闭满 30 天 | 整个卡目录移入 `archive/YYYY-MM/` |
| 调研 | 结论已写入现行文档或代码 | 移入 `archive/YYYY-MM/`，索引标注结论去向 |
| 外部资料 | 不归档 | `external/` 冻结只读，附来源与取得日期 |
| 草稿 | 卡完成后 7 天 | 移入 `archive/YYYY-MM/` 或删除（草稿允许删） |
| 日志/备份/夹具 | 立即 | 移出知识库（`.logs/`、随测试代码、删 `.bak`） |

原则：知识文件只归档不删除；删除仅限日志、备份、草稿、测试夹具。

最近归档 / 已消失：

- `Docs/archive/preview-mig5.txt` —— DOC-0 清场时归档的预览临时文件。
- `Obsidian-星图渲染逆向.md` —— 2026-11-04 删除（7 处引用按 DOC-3 基线豁免，未复活）。
- `Docs/verification/` —— 旧证据目录，正文已迁 `Docs/evidence/`；残留 3 个 json/ts 资产待随卡归档，不计入 §4。
