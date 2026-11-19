# 收尾清单

## done 前

1. 重拉 `kb show`，确认仍由本 worker 占用。
2. 重跑任务要求和项目要求的验证。
3. 检查接口、事件、ticker、CLI 或迁移是否已真实接线；未接线时确认另一张卡通过 `blocks` 边接手。
4. 检查关联 design 页：仍 proposed 时 revise，或显式声明不推进。
5. 判定知识页：有可复用结论则创建/修订；否则在 notes 写明原因。
6. 选择变更日志出口：`--close-record`、先写归属本卡的日志，或 `--no-changelog`。
7. 逐条列出 `--scope`，只含本卡实际改动。

## 推荐命令

```powershell
Get-Content -Raw notes.md |
  kb done <id> --close-record --changelog-title '<标题>' --type 新增|修复|调整 `
    --knowledge-page <page-id> --notes-stdin --scope <path>
```

## done 后

- 回读 `status=待验收`、`claimed_by=null`。
- 检查 `git_commit.status`：
  - `committed` / `nothing` / `skipped`：完成；
  - `not-committed`：done 已生效，按 stderr 补救，不重跑 done；
  - `unavailable`：警告，退出 0。
- 若命令退出 1 且原因属于 `NO_BASELINE / COMMIT_FAILED / ZERO_HIT / NO_SCOPE / PARALLEL_UNDECLARED`，只做补救与复核。

## 失败

`kb fail <id> --reason '<阻塞或失败的具体事实>'`，回读状态为 `待规划`。

不要在未验证、未提交或接线不明时 done。

## 报告

必须包含：

- 工作区 id + 绝对路径；
- 实际改动文件清单；
- 是否跨区及授权依据；
- 每条验证命令和结果；
- 知识页 id 或未沉淀原因；
- 变更日志 id；
- 提交 hash / 提交状态；
- 未验证项与剩余风险。
