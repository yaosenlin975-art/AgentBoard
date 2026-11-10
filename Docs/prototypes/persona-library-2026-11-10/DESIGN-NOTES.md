# 设置页「智能体人设」管理 · 设计说明（PERSONA-LIB-1）

- 工作区：任务看板（`e41eb0fb-c367-43cf-a99d-6dc5239a5694`）`D:\WorkSpaces\任务看板`
- 父卡：`a4e9509b-1d93-40ed-94a6-3e64db6fea3e`；本原型卡：`8f8525fc-8d18-4ae1-8e82-8ebfae57a18c`（首版）、`73951796-c0b2-486f-ac52-4e96f502c638`（智能创建迭代）
- 目录：`Docs/prototypes/persona-library-2026-11-10/`
- 产物：`index.html` + `styles.css` + `app.js`（纯静态，双击 `index.html` 即可；无构建、无外链、无网络请求，数据为 mock）
- 范围：**只做设计与原型**，不改 production 代码。第 8 节为落地建议，供 `d78e2e1e-9f83-45bf-920b-b502e6ee3bff`（PERSONA-LIB-2）使用。
- 截图：`index.html?clean=1` 隐藏顶部控制条与右侧说明块。

---

## 1. 一句话结论

在**设置弹窗内单开一节**「智能体人设」：上方一行工具（从专家包导入 / 新建），下方是一张来源可辨的人设表；新建与编辑走右侧抽屉，删除走告知型确认，导入走整包目录对话框。管理页只负责「库里有什么」，**会话使用哪个人设仍留在会话设置里绑定**，两个概念不混在同一个界面。

## 2. 现状核对（读过的代码，不是猜的）

| 事实 | 位置 |
| --- | --- |
| 后端 CRUD 已存在：`GET/POST /api/personas`、`PATCH/DELETE /api/personas/:id`；`source='builtin'` 改删直接 409 | [personaRoutes.ts](../../../apps/server/src/api/routes/personaRoutes.ts#L55-L84) |
| persona 落**中心库**，是全局资源，不随工作区库下沉 | [personaRoutes.ts](../../../apps/server/src/api/routes/personaRoutes.ts#L3-L7) |
| 字段与上限：`name ≤100`、`description ≤2000`、`body_md` 必填且 ≤ `PERSONA_BODY_MAX_CHARS` | [schemas.ts](../../../apps/server/src/api/schemas.ts#L396-L400) |
| 来源三态 `builtin / user / import`；导入项带 `package_path` | [persona.ts](../../../apps/server/src/db/repos/persona.ts#L5-L14) |
| `session.persona_id` **无外键**；行被删时起轮侧按缺失静默跳过，不起轮报错 | [personaInjection.ts](../../../apps/server/src/db/migrations/personaInjection.ts#L12-L17) |
| 写会话时若 persona 不存在会被拒（悬空引用只在起轮侧容忍） | [sessionRoutes.ts](../../../apps/server/src/api/routes/sessionRoutes.ts#L389-L392) |
| 专家包导入是**按包事务**写入，同目录 / 同名重复导入 409 | [expertPackageRoutes.ts](../../../apps/server/src/api/routes/expertPackageRoutes.ts#L76-L100) |
| 现有消费方只有会话设置与新建会话弹窗，均以 `['personas']` 拉 `GET /api/personas` | [SessionSettingsDialog.tsx](../../../apps/web/src/components/chat/SessionSettingsDialog.tsx#L277-L292)、[NewSessionDialog.tsx](../../../apps/web/src/components/chat/NewSessionDialog.tsx) |
| 设置弹窗已有分组口径：`border-t border-hairline pt-3` + `text-xs uppercase tracking-wide text-ink-3` 标题 | [SettingsDialog.tsx](../../../apps/web/src/components/topbar/SettingsDialog.tsx#L206-L223) |
| 按钮 / 输入框统一走 `buttonStyles.ts`（主 / 次 / 危险三级，`--ab-*` 令牌） | [buttonStyles.ts](../../../apps/web/src/components/ui/buttonStyles.ts) |

结论：**这不是新增能力，是补入口**。后端接口、导入流程、会话侧读取都已存在；本需求的价值是把散落的 `personas` 变成可管理的全局库。

## 3. 信息架构与页面结构

```
设置（Modal）
├─ 服务与并发（既有，仅作排版对照）
├─ …（既有分组）
└─ 智能体人设（本次新增）              ← 全局库 · 即时生效
   ├─ 标题行：智能体人设          [从专家包导入] [＋ 新建人设]
   ├─ 说明：这里管库；会话用哪个人设在会话设置里选
   ├─ 人设表：名称 + 来源徽标 + 描述(2 行截断) + 来源路径/创建时间 + [编辑][删除]
   └─ 空态：新建 / 从专家包导入 两条主行动
```

为什么是「一节」而不是独立页面 / 侧栏入口：人设是低频全局配置，与「工作区状态 / 语音 / 存储 / MCP」同级；单独加导航会抬高主界面噪声，还会让「库管理」与「会话绑定」看起来像同一件事。

## 4. 交互流程

1. **列表**：`created_at` 倒序（与后端一致）。来源徽标三色区分：内置（raised）、导入（accent-soft）、自建（card 描边）。
2. **新建**：右侧抽屉，字段 name / description / body_md；空名称、空正文就地报错；保存后列表顶部插入并 toast。
3. **编辑**：同一抽屉回填；`builtin` 打开为只读态（输入框禁用、隐藏保存、按钮改为「关闭」），并说明「服务端 409，界面提前拦截」。
4. **删除**：居中确认框，正文写清后果（见第 5 节）；删除后行消失并 toast；无撤销。
5. **导入**：对话框输入包目录 + 只读展示归属工作区；整包导入；成功 toast 列出「导入 N 个人设 + 团队模板」，重复导入按 409 原文展示。
6. **空态**：虚线框 + 两条主行动 + 一句「不设人设的会话照常可用」。

## 5. 关键取舍

| 取舍 | 选择 | 理由 |
| --- | --- | --- |
| 入口位置 | 设置页单开一节 | 低频全局配置；不加侧栏、不做独立路由，避免两层概念抢同一个入口 |
| 编辑器形态 | 右侧抽屉 | 保留列表上下文；比「弹窗套弹窗」层级浅；正文用等宽大文本域，Markdown 结构可读 |
| builtin | 禁用编辑/删除 + 只读说明 | 服务端本来 409；提前禁用比让用户点了才失败更好，且说明「新建一份再改」的替代路径 |
| import | 可改可删，单独徽标 + 包目录 | 与 builtin 区分：导入是用户资产，包只是来源；后台也没有对它做写保护 |
| 删除已被人设引用的项 | **告知，不阻断** | 三个硬事实决定：`session.persona_id` 无外键；会话分散在各工作区库；没有引用计数接口。前端算不出引用数，强行阻断需要新端点（超出本卡） |
| 删除文案 | 写「会话显示未知人设 / 下一轮不再注入 / 会话仍可启动」 | 与起轮侧的实际行为一致，避免用户以为删了会把人设留在会话里 |
| 导入粒度 | 整包，不做包内多选 | 后端按包事务写入；拆包单选需要新接口与半包回滚语义 |
| 导入重复 | 409 原文直出 | 服务端文案已说明「同名包 / 同目录」与团队 id，前端不再包装 |
| 列表能力 | 不做搜索 / 分页 / 排序切换 / 批量 | 人设量级小；先保证增删改顺滑，功能膨胀留给真实需求 |
| 与会话设置的关系 | 管理页不提供「绑定到会话」 | 绑定是会话级配置，放回会话设置；管理页只维护库，范围清楚 |

## 6. 视觉口径

- 全部使用 `--ab-*` 令牌（值照抄 [index.css](../../../apps/web/src/index.css#L78-L136) 的 `:root` 与 `.dark`），无第二套色板。
- 分组标题 `12px / 600 / uppercase / tracking .04em / ink-3`；分组分隔 `border-top: 1px hairline + 14px`；控件高度 32px、圆角 4px；卡片圆角 6px、弹窗 8px（对齐 `RADIUS-HALF`）。
- 语义色只用于含义：删除按钮用 `--ab-del`，错误提示用 `--ab-del`，来源徽标用 accent-soft 标「导入」。
- 控制条与右侧说明块均标注「非产品 UI」，截图时 `?clean=1` 隐藏。

## 7. 刻意没做的

- **引用计数 / 有引用禁止删除**：需要新增「按 persona 统计会话与团队成员」的端点；会话数据在各工作区库，成本不低。若评审要求，另开卡，不在实现卡里扩。
- **从专家包「增量刷新」**：重复导入目前是 409；是否要做「更新已导入人设」需要先定合并语义。
- **复制内置人设为自建**：界面上用文案引导「新建一份」，没做一键复制（可作为后续小改进）。
- **批量删除 / 导出**：量级不支撑。

## 8. 落地建议（PERSONA-LIB-2）

1. 新增 `apps/web/src/components/settings/PersonaSection.tsx`，在 [SettingsDialog.tsx](../../../apps/web/src/components/topbar/SettingsDialog.tsx) 的既有 section 之后插入一节（沿用 `border-t border-hairline pt-3`）。
2. 数据：`useQuery({ queryKey: ['personas'], queryFn: () => api.get('/api/personas') })`；写操作后 `invalidateQueries(['personas'])`，会话设置下拉与新建会话弹窗会自动同步。
3. 写操作：`POST /api/personas`、`PATCH /api/personas/:id`、`DELETE /api/personas/:id`、`POST /api/expert-packages/import { workspace_id, path }`。
4. 错误展示：直接展示服务端中文 message（builtin 409 / 导入 409 / 校验 400），不吞错、不改写。
5. 测试点：列表渲染三来源、新建后 invalidate、builtin 按钮禁用、删除确认文案、导入成功与 409。
6. 不改 `apps/server`（无新端点），不改侧栏导航，不改会话绑定语义。

## 9. 验证方式

- 打开 `Docs/prototypes/persona-library-2026-11-10/index.html`，走完：列表 → 新建 → 编辑 → 删除确认 → 导入（成功 / 409）→ 空态 → 深色。
- 控制台无报错；`?clean=1` 截图干净。
- 样式检查：`rg -n "ab-" Docs/prototypes/persona-library-2026-11-10/styles.css` 可见令牌定义；除控制条外不出现硬编码主色十六进制。

## 10. 智能创建（PERSONA-LIB-1b 迭代）

**位置**：只在「新建人设」抽屉出现；编辑既有 persona（含内置只读）不渲染这一块，原编辑流程一字未改。

**状态机**（纯前端 mock，不调真实模型）：

| 状态 | 界面 | 可做的操作 |
| --- | --- | --- |
| `idle` | 一句话输入 + 3 个示例 chips + [生成草稿] + 手动填写字段 | 输入、套用示例、生成、直接手填保存 |
| `generating` | 输入区收起，显示 spinner + 秒表 + 进度条；名称/描述/正文字段与保存按钮禁用 | [取消生成] → 回 `idle`，表单内容保留 |
| `draft` | 草稿 banner + 四段结构化字段（角色 / 语气 / 边界与禁忌 / 擅长领域），名称与描述自动回填（仅当原本为空） | 改字段、[重新生成]、[放弃草稿]、[改为 Markdown 编辑] |
| `error` | 原输入区保留，错误文案 + 按钮变为 [重试生成] | 重试、改描述、直接手填后保存 |

**关键取舍**：

| 取舍 | 选择 | 理由 |
| --- | --- | --- |
| 是否替代手动新建 | 不替代，作为抽屉顶部的可选加速块 | 手动正文入口始终可达（`idle` / `error` 直接可见，`draft` 经「改为 Markdown 编辑」可达），不会因为生成失败卡死流程 |
| 草稿结构 | 四段固定小节，保存时拼成 `## 角色 / ## 语气 / ## 边界与禁忌 / ## 擅长领域` 的 `body_md` | 与后端 `body_md` 单字段契约一致，不新增字段；结构化输入降低「不知道正文怎么写」的门槛 |
| 生成中 | 锁住整张表单 + 可取消 | 对齐任务卡智能创建的「生成中 → 取消」；避免生成结果覆盖用户刚改的内容 |
| 失败 | 不自动回退，原地显示错误 + 重试 | 回退会丢掉已输入的一句话需求；原地重试成本最低 |
| 放弃草稿 | 清空四段与自动回填的名称/描述，回到 `idle` | 只清「生成带来的内容」，用户自己填的名称/描述不动（用 `draftAuto` 标记） |
| 演示失败 | 控制条「下次生成失败」一次性开关（非产品 UI） | 三态必须能在静态原型里演示，不依赖后端；真实实现由 `POST /api/issues/draft` 一类接口的 502/504 决定 |
| 重新生成 | 复用原一句话需求再跑一次 | 不要求用户重打需求；成功后整组字段替换 |

**与真实实现的关系**：落地到 `PersonaSection.tsx` 时，`buildDraft()` 换成服务端草稿接口，其余状态机、禁用、重试、放弃逻辑可原样复用；`composeBody()` 仍是前端拼 `body_md`，不新增后端字段。

