# STATUS-1 状态模型迁移：操作与回滚
- status: proposed
- date: 2026-11-03
- card: -
- supersedes: -

适用版本：`[STATUS-1]` 及之后（`issue.status` 去掉 CHECK 枚举、新增 `due_date`/`due_time`、新增 `workspace_status`）
落地点：`apps/server/src/db/migrations/issueStatusModel.ts`、`apps/server/src/db/migrations/workspaceStatus.ts`（由 `initSchema` 在服务启动时执行）

## 1. 迁移做了什么

1. **重建 `issue` 表**（SQLite 删不掉列上的 CHECK）：
   - 新表去掉 `status` 的 `CHECK (status IN (...))`，`status` 保留 `TEXT NOT NULL DEFAULT '待规划'`；
   - 新增 `due_date TEXT`、`due_time TEXT`（可空）；
   - 逐列搬运 `id, workspace_id, title, description, priority, labels, status, sort_order, claimed_by, claimed_at, session_id, last_seen_comment_id, parent_issue_id, created_at, updated_at`，`due_*` 置 NULL；
   - `DROP TABLE issue` → `ALTER TABLE issue_new RENAME TO issue`；
   - 重建索引 `issue_parent_order`、触发器 `issue_parent_same_workspace_insert` / `_update` / `issue_parent_no_cycle_update` / `issue_monotonic_time`；
   - **其他表上引用 `issue` 的触发器**（实测为 `issue_dependency_same_workspace` / `issue_dependency_no_cycle`）在事务内先摘除、rename 后用原 SQL 原样装回——否则 `DROP TABLE issue` 会报 `no such table: main.issue`。
2. **新建 `workspace_status`**（每工作区状态字典）+ 索引 `idx_workspace_status_ws_order`。
3. **种入内置五状态**：`待规划/进行中/待验收/已关闭/已废弃`，`sort_order` 0/10/20/30/40，`kind` = `open/started/review/done/deprecated`，`is_builtin=1`；内置行 id 为确定性值 `builtin-<workspaceId>-<kind>`，种子用 `INSERT OR IGNORE`，重复执行不产生重复行。既有工作区在启动时补齐，新工作区在 `createWorkspace` 同一事务内种入。
4. **单事务 + 迁移前备份**：重建与种子在同一事务内；备份用 `VACUUM INTO <db>.pre-status-migration.<epoch_ms>`（一致性快照，事务外执行）。迁移成功后才删除 `issue_git_baseline` 之外的旧状态？——不涉及，本迁移不删数据。

## 2. 迁移前自动备份

- 位置：与数据库同目录，文件名 `<dbname>.pre-status-migration.<epoch_ms>`，例如
  `C:\Users\<user>\AppData\Roaming\AgentBoard\agentboard.db.pre-status-migration.1793690046582`
- 时机：`initSchema` 判定需要迁移时（`issue` 仍有 status CHECK 或缺 `due_date`/`due_time`）立即生成，**早于**任何写操作。
- 幂等：迁移完成后再启动不会重复备份（判据命中即跳过）；同一毫秒重复调用也只保留一份。

## 3. 回滚步骤（不自动回滚）

迁移失败时事务整体回滚，库保持迁移前状态，服务继续以旧结构运行（现场已验证：首次在副本上因 `issue_dependency` 触发器报错，`issue` 表与 status 数据完全未变，`workspace_status` 未创建）。

已经迁移成功、需要退回旧结构时：

```powershell
# 1) 停服务（取确切 PID，不要通配符）
$c = Get-NetTCPConnection -LocalPort 8787 -State Listen; Stop-Process -Id $c.OwningProcess -Force

# 2) 用备份覆盖当前库，并清掉 WAL 边车文件（否则旧 WAL 会覆盖恢复结果）
$dir = Join-Path $env:APPDATA 'AgentBoard'
$bak = Get-ChildItem $dir -Filter 'agentboard.db.pre-status-migration.*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Copy-Item $bak.FullName (Join-Path $dir 'agentboard.db') -Force
Remove-Item (Join-Path $dir 'agentboard.db-wal'), (Join-Path $dir 'agentboard.db-shm') -Force -ErrorAction SilentlyContinue

# 3) 代码回滚到 STATUS-1 之前的提交（旧代码不读 workspace_status，会忽略该表）
git checkout <status-1-之前的提交>

# 4) 重新构建并行起服务
pnpm --filter @agentboard/server build
cmd /c start "" /b node apps\server\dist\index.js
```

回滚后注意：

- `workspace_status` 表若已存在会被旧代码忽略（无害）；如需彻底清理：`DROP TABLE workspace_status;`
- 备份文件不会自动删除，确认无误后手动清理，避免堆积（每次「需要迁移」的启动都会生成一份）。

## 4. 迁移后自检（可直接执行）

```powershell
$db = Join-Path $env:APPDATA 'AgentBoard\agentboard.db'
node -e "const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:true});
console.log('status CHECK 还在吗:', /CHECK\s*\(\s*status\s+IN/i.test(db.prepare(\"SELECT sql FROM sqlite_master WHERE name='issue'\").get().sql));
console.log('due 列:', db.prepare('PRAGMA table_info(issue)').all().map(c=>c.name).filter(n=>n.startsWith('due')));
console.log('内置状态数:', db.prepare('SELECT COUNT(*) n FROM workspace_status WHERE is_builtin=1').get());
console.log('每区状态数:', db.prepare('SELECT workspace_id, COUNT(*) n FROM workspace_status GROUP BY workspace_id').all().length);
" $db
```

验收阈值：`status CHECK 还在吗: false`、`due 列: [ 'due_date', 'due_time' ]`、每工作区 `is_builtin` 行数为 5。

## 5. 存量库副本演练结论（2026-11-03）

- 副本：`%APPDATA%\AgentBoard\agentboard.db`（4 行状态分布 已关闭 142 / 待验收 127 / 待规划 50 / 进行中 6）→ 临时目录 → 临时端口 8791。
- 第一次演练失败：`DROP TABLE issue` 触发 `error in trigger issue_dependency_same_workspace: no such table: main.issue`；事务回滚，副本库结构未变。修复方式即 §1 第 1 条的「引用 issue 的外部触发器先摘后装」。
- 第二次演练通过（启动即完成迁移，耗时约 1–2 秒）：
  - `status CHECK 还在吗: false`，列新增 `due_date`/`due_time`；
  - 状态分布不变（142 / 50 / 127 / 6）；
  - 索引 `issue_parent_order` + 触发器 12 个齐备（含 `issue_parent_*` 三个、`issue_monotonic_time`、`issue_dependency_*` 两个）；
  - `workspace_status`：7 个工作区 × 5 条内置（`kind`/`sort_order`/`is_builtin` 与设计一致）；
  - `kb claim` → 进行中、`kb done` → 待验收 行为不变；
  - 写入 `status=乱写` → 400 且文案列出可用状态；`status=已废弃` → 200；`due_date/due_time` 写入与读取正常；
  - 备份文件 `agentboard.db.pre-status-migration.<ts>` 生成。
- 演练进程按确切 PID 停止，副本目录已删除。

## 6. 已知限制（不在本卡范围）

- `已废弃` 目前只是字典里的一行：父卡关闭校验、后代关闭计数、`kb dep` 解除判定仍按名字 `'已关闭'` 判断，未切到 `kind ∈ {done, deprecated}`。切换到 `kind` 语义由后续状态卡（STATUS-2/3）落地。
- 自定义状态的增删改、看板列与废弃 UI 属于后续卡。
