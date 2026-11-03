# 状态模型扩展 + 截止日期 + 排序 + 看板列宽

状态：待用户批准。覆盖用户 2026-11-03 的第 1、2、3、4、5 条需求。

## 1. 意图

现状 `issue.status` 是 DDL 里写死的四值 CHECK（`待规划/进行中/待验收/已关闭`），既不能表达"不做了"，也不能按工作区扩展。同时卡片没有截止日期，待规划栏无法排序，列数少时看板右侧大片留白。

这次一起解决：**状态从"枚举常量"变成"每个工作区一份的配置表"**，并补上截止日期与排序。

## 2. 已确认决策

| # | 决策 | 取值 |
|---|---|---|
| D1 | 看板列宽 | **自适应撑满 + 超出自滚动**：列数 ≤4 时各列等宽撑满视口；>4 时每列保底 280px 并横向滚动 |
| D2 | 「已废弃」语义 | **与「已关闭」并列的终态，两者都算关闭**；父子卡的「后代已关闭」计数把两者都计入 |
| D3 | 自定义状态删除 | **强制迁移**：删除前必须指定迁移目标状态，同事务把在途卡改过去；不指定不允许删 |
| D4 | 截止日期精度 | **日期 + 可选时间**：`due_date`(YYYY-MM-DD) + `due_time`(HH:mm, 可空)；不填 = 无截止；LLM 不主动询问 |
| D5 | 组合排序权重 | 采纳下节公式（用户要求我 brainstorome 完善） |

## 3. 状态模型

### 3.1 内置状态（5 个，固定）

| name | kind | 说明 |
|---|---|---|
| 待规划 | `open` | 未开始 |
| 进行中 | `started` | 已在做 |
| 待验收 | `review` | 做完等人工确认 |
| 已关闭 | `done` | 正常完成（终态） |
| 已废弃 | `deprecated` | 不做了（终态，与已关闭并列） |

`kind` 决定行为，不靠名字：`done` 与 `deprecated` 都归入"关闭类"，供 `descendants_closed_count`、父卡关闭校验、`kb dep` 的解除判定使用。名字可改（自定义状态下），`kind` 不可改。

### 3.2 自定义状态（每个工作区独立）

新表：
```sql
CREATE TABLE IF NOT EXISTS workspace_status (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('open','started','review','done','deprecated')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, name)
);
```
- 建工作区时种入 5 条内置（`is_builtin=1`，`sort_order` 0/10/20/30/40，留空隙便于插队）。
- **内置状态不可删除、不可改名**；自定义可增删改名。
- 排序：`sort_order` 升序；自定义可插在任意位置，但**内置之间的相对顺序不变**。
- `issue.status` 落库仍是名字字符串；服务层校验必须命中本工作区的 `workspace_status.name`（或内置集合），不再依赖 DDL CHECK。

### 3.3 迁移（SQLite 的 CHECK 删不掉，必须重建表）

1. 新建 `issue_new`：结构与现表一致，**去掉 status 的 CHECK**，新增 `due_date TEXT`、`due_time TEXT`。
2. `INSERT INTO issue_new SELECT ..., NULL, NULL FROM issue`。
3. `DROP issue` → `ALTER TABLE issue_new RENAME TO issue` → 重建既有索引与触发器（`taskHierarchy` 的两个同工作区/防环触发器、`gitBaseline` 等引用按新表重建）。
4. 种子 `workspace_status`：为每个既有工作区插入 5 条内置。
5. 全程单事务；迁移前自动备份 `agentboard.db` 到同目录 `.pre-status-migration.<ts>`。

回滚：迁移失败整事务回滚；已迁移后回滚靠备份文件（文档写清步骤，不自动回滚）。

## 4. 截止日期

- 字段：`issue.due_date TEXT NULL`（`YYYY-MM-DD`）、`issue.due_time TEXT NULL`（`HH:mm`，24h）。二者独立：有日期无时间 = 当天任意时刻截止（排序按当天 00:00 视为最宽松，展示只显示日期）。
- API：`Issue` 增加 `due_date`、`due_time`（可选，缺省 null）；`POST/PATCH /api/issues` 接受；`?due_before=YYYY-MM-DD` 预留筛选（本批不实现筛选 UI）。
- CLI：`kb create-issue ... --due 2026-11-10` 或 `--due 2026-11-10T14:30`；`kb update-issue`（若存在）同样支持；不传 = 无截止。
- UI：卡片与详情显示「截止 11-10」/「截止 11-10 14:30」；**逾期**（含当天时间已过）用警示色 + `逾期 N 天`。
- 技能口径（`using-agentboard`）：**不主动询问截止日期**；用户说了才填；用户没说就留空，不得推断。

## 5. 排序（待规划栏顶部）

五种排序，同一时刻只有一种生效（本地存储，不落库）：
1. `A-Z` / 2. `Z-A`：按标题（不分大小写，中文按 `localeCompare('zh')`）。
3. `截止日期`：近→远；无截止排最后。
4. `优先级`：高→中→低；同优先级按创建时间升序。
5. `组合`（默认）：
```
优先级分： 高 = 30，中 = 20，低 = 10
紧迫度分： 已逾期 = +50；≤3 天 = +30；≤7 天 = +15；>7 天 = +5；无截止 = 0
score = 优先级分 + 紧迫度分
排序： score 降序 → 同分按 created_at 升序（老的在前）
```
**设计理由**：逾期（+50）能压过"高优先级但无截止"（30），因为逾期是已经发生的问题；同分用创建时间升序防止老卡被无限推后（饿死）。`排序` 只作用于「待规划」列，其余列保持既有顺序（用户只要求待规划）。

## 6. 看板列宽（第 1 条）

```
.board-columns { display: grid;
  grid-template-columns: repeat(var(--col-count), minmax(280px, 1fr));
  overflow-x: auto; }
```
- 列数 ≤4：`1fr` 撑满视口，右侧不再留白。
- 列数 >4：每列 ≥280px，总宽超出后容器横向滚动。
- 移除现在的固定宽度与左对齐留白；拖拽落点计算沿用 `pointerWithin`（DND-SEARCH-BUG 已修）。

## 7. 拆卡（供 writing-task）

1. **迁移与状态表**：表重建 + `workspace_status` + 种子 + 服务层校验替换 CHECK + 备份/回滚文档。
2. **自定义状态 CRUD**：REST 三端点（list/create/delete，删除带 `migrate_to`）+ CLI + MCP + 「内置不可删」守卫。
3. **已废弃状态**：五列 UI、颜色、`kind` 判定接入 `descendants_closed_count` 与父卡关闭校验、`kb dep` 解除判定用 `kind in (done,deprecated)`。
4. **截止日期**：DB 两列 + API + CLI `--due` + MCP + UI 显示/编辑 + 技能口径（不主动问）。
5. **待规划排序**：五种排序 + 权重公式 + 本地存储 + 单测（含权重表逐值断言）。
6. **看板列宽**：grid 自适应 + 超出自滚动 + CDP 三档证据。

## 8. 非目标

- 不做跨工作区共享状态、不做状态工作流（stage/交接）。
- 不做截止日期提醒/通知。
- 不做其余三列的排序 UI。

## 9. 验收（父级）

- 迁移在既有库副本上演练通过（含索引与触发器重建、5 条内置种子、`descendants_closed_count` 口径不变）。
- 新增自定义状态 → 看板立即多一列；删除时未指定迁移目标被拒；指定后卡全部迁移且新列消失。
- 「已废弃」卡计入父卡的已关闭计数，父卡可关闭。
- `kb create-issue --due` 落库正确；不传为 null；技能文档写明不主动询问。
- 五种排序切换生效，`组合` 排序逐值断言（给权重表）。
- 1440/1024/375 三档下列宽自适应与横向滚动正确。
- 全量 test 无新增失败；`pnpm -r build` exit 0。
