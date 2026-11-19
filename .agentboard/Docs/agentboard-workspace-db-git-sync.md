---
id: 3607297c-8b64-4fa2-9ce3-a79cb054e7a5
slug: agentboard-workspace-db-git-sync
title: "工作区数据库与 Git 同步"
revision: 2
scope: workspace
workspace_id: c5b8f2a5-5afa-48ec-9217-324f6777078e
status: active
domain: infra
category: design
landed: partial
sources:
  - source_id: "file:apps/server/src/services/workspaceSnapshot.ts"
    source_type: file
    locator: apps/server/src/services/workspaceSnapshot.ts
    captured_at: 1794974400000
    content_hash: 5f95877819bb2072b3c4946d4afbed250dd0af63e5cc85c29f87cc6639cf9ff0
  - source_id: "file:packages/cli/src/commands/createSpace.ts"
    source_type: file
    locator: packages/cli/src/commands/createSpace.ts
    captured_at: 1794974400000
    content_hash: 05bad1960af27d1d3d086ab7ac63aef641cca2e6f149c527ad0afedea8de576f
evidence:
  - source_id: "file:apps/server/src/services/workspaceSnapshot.ts"
    locator: "apps/server/src/services/workspaceSnapshot.ts:47-135"
  - source_id: "file:packages/cli/src/commands/createSpace.ts"
    locator: "packages/cli/src/commands/createSpace.ts:14-53"
content_hash: cfa0e9286e84ba7dc0748272ac1d6359bab6cab13acc9316585707b9928416a1
expires_at: null
created_at: 1794964756337
updated_at: 1794966629501
created_by: kb-cli
updated_by: kb-cli
change_note: ""
---

# 工作区数据库与 Git 同步设计

## 1. 需求

- 每个工作区拥有独立运行库 `<工作区>/.agentboard/agentboard.db`。
- 新建工作区登记成功后默认启用工作区库。
- Git 同步任务看板、任务评论、依赖和变更日志。
- 不同步附件本体和会话正文。
- 合并或拉取后，以本地 `agentboard.db` 为准。

## 2. 非目标

- 不把 SQLite 文件提交到 Git。
- 不采用 Git LFS。
- 不把附件或会话正文纳入默认同步范围。
- 不在后台持续提交 Git。
- 多人快照冲突不做自动合并。

## 3. 约束

- 根 `.gitignore` 排除 `*.db`、`*.db-wal`、`*.db-shm`。
- SQLite 是工作区运行事实源；`.agentboard/snapshot/*.jsonl` 是可读派生快照。
- 知识页已是文件事实源，位于 `<工作区>/.agentboard/Docs/`。
- `kb done --scope` 按声明路径提交；未声明路径不提交。
- 100MB 运行库不得进入 GitHub 历史。

## 4. 方案

采用“工作区运行库 + Git 文本快照 + 本地库优先恢复”。

| 方案 | 取舍 | 结论 |
| --- | --- | --- |
| 运行库进 Git / Git LFS | SQLite 写入产生大对象，历史与合并成本高 | 不采用 |
| 全量改为文件事实源 | 需重建事务、并发占用和查询能力 | 不采用 |
| 工作区 SQLite + JSONL 快照 | 复用现有快照、校验、导入能力 | 采用 |

## 5. 目录与数据结构

| 路径 | 内容 | 是否进 Git |
| --- | --- | --- |
| `.agentboard/agentboard.db` | 工作区运行库 | 否 |
| `.agentboard/agentboard.db-wal` / `-shm` | SQLite 运行文件 | 否 |
| `.agentboard/attachments/` | 附件本体 | 否 |
| `.agentboard/snapshot/manifest.json` | 快照版本、表清单、哈希、行数 | 是 |
| `.agentboard/snapshot/issues.jsonl` | 任务 | 是 |
| `.agentboard/snapshot/issue_comments.jsonl` | 评论 | 是 |
| `.agentboard/snapshot/issue_dependencies.jsonl` | 依赖 | 是 |
| `.agentboard/snapshot/workspace_change_log.jsonl` | 变更日志 | 是 |
| `.agentboard/snapshot/sessions.jsonl` | 会话元数据 | 是 |
| `.agentboard/snapshot/messages.jsonl` | 会话正文 | 否，默认不导出 |
| `.agentboard/snapshot/attachments.jsonl` | 附件清单 | 否，默认不导出 |
| `.agentboard/Docs/*.md` | 工作区知识页 | 是 |

快照继续使用 `agentboard.workspace-snapshot/1`、`schema_version=1`、固定主键顺序、ISO 时间字符串、逐文件 sha256 与行数。

## 6. 接口

### 新建工作区

`POST /api/workspaces` 成功登记后由 CLI 调用现有 `autoEnableWorkspaceDb`：

1. 建工作区库并写入 `meta.workspace_id`。
2. 设置 `db_mode=localized`。
3. 导出默认快照。
4. 自动启用失败时保留工作区登记，降级为中心库模式并提示补做。

### 收尾

`kb done` 增加工作区快照同步步骤：

1. 完成知识页与变更日志收尾记录。
2. 从当前工作区库导出默认快照；不导出附件与会话正文。
3. 将 `.agentboard/snapshot` 纳入本次提交路径。
4. 保留调用方 `--scope` 声明的代码和知识页路径。
5. 快照导出或校验失败时不声称已提交；按现有 `git_commit` 结果报告。

`--board-only` 不再跳过工作区快照；它只表示没有业务代码改动。

### 手动工具

保留：

- `kb workspace-db snapshot export`
- `kb workspace-db snapshot validate`
- `kb workspace-db snapshot import`

默认导出范围收敛为看板同步所需表。附件与会话正文仍仅通过显式参数导出。

## 7. 关键流程

### 首次创建

```text
create-space
  -> 中心库登记工作区
  -> 创建 .agentboard/agentboard.db
  -> 写入 meta.workspace_id
  -> db_mode=localized
  -> 导出 snapshot
```

### 任务变更

```text
任务/评论/依赖/变更日志写入本地库
  -> kb done 收尾
  -> 导出 snapshot
  -> git add 声明路径 + .agentboard/snapshot
  -> git commit
```

### 拉取与恢复

```text
git pull
  -> 本地库已存在：以本地库为准
  -> 比较快照与本地库：只提示落后，不自动覆盖
  -> 本地库缺失：validate snapshot 后 import
```

### 冲突

- Git 合并冲突留在 `.agentboard/snapshot` 文本文件。
- 不以快照自动覆盖本地库。
- 冲突处理完成后重新导出快照。

## 8. 错误与状态

| 条件 | 行为 |
| --- | --- |
| 新建工作区自动启用失败 | 登记保留，返回中心库模式与补做命令 |
| 快照导出失败 | `done` 不声称快照已提交，返回失败原因 |
| 快照校验失败 | 拒绝导入 |
| 本地库存在且快照落后 | 使用本地库，展示落后提示 |
| 本地库缺失且快照有效 | 允许导入 |
| 快照与 `workspace_id` 不一致 | 拒绝导入 |
| Git 非仓库 / 未安装 / 不可用 | 沿用现有 `git_commit` 原因码 |

## 9. 验收

- 新建工作区后磁盘存在 `.agentboard/agentboard.db`，状态为 `localized`。
- 快照包含任务、评论、依赖、变更日志、状态与会话元数据。
- 快照不包含附件本体、会话正文和 SQLite 文件。
- 完成一张含评论与依赖的卡后，快照变化随 `kb done` 提交。
- 纯看板任务也会提交快照。
- 快照超过 100MB 时，运行库不进入 Git 历史。
- 本地库存在时，快照落后不会覆盖本地库。
- 新克隆仓库可校验并导入快照恢复看板。


