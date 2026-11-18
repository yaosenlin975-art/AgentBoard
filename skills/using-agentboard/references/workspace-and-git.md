# 工作区与 Git 收尾

## 工作区绑定

- 主路径 `kb list-spaces --current`；JSON 是 `{items,next_offset}`，单条命中。
- 兜底 `kb list-spaces`，把每个 path 与 cwd 解成实体路径后比较：统一分隔符、去尾分隔符、Windows 大小写不敏感。
- cwd 在某个根之下时取最长前缀；同时命中多个不同根或不属于任何工作区即停手。
- 跨区任何写入都要先说明目标工作区、路径与数据影响，并取得当轮授权。

## 占用与依赖

- claim 是排他事务；409 不重试同一卡。
- `release` 只释放自己的占用；强制释放只按用户当轮明确授权执行。
- blocker 到「待验收 / 已关闭」即解除。不得用 `dep rm` 解锁被阻塞卡。
- 被占用卡不能新增 blocker，先结束或释放占用。

## GIT-ON-DONE

- `kb done --scope <path>` 只提交声明的业务路径和 `.agentboard` 快照；逐条重复传 `--scope`。
- `--board-only` 只提交看板快照；`--all` 才纳入全部 dirty 文件。
- 运行中的 `.agentboard/agentboard.db`、WAL/SHM、附件本体、会话正文不进 Git；大库只同步文本快照，不用 LFS。
- 合并后本地库存在即以本地库为准；只有本地库缺失才校验并导入快照。
- 不得手动 `git commit` 兜底；提交信息必须带本卡 UUID。

## done 返回

- 状态必须回读为 `待验收`，占用为空。
- `git_commit.status=not-committed` 且原因在 `NO_BASELINE / COMMIT_FAILED / ZERO_HIT / NO_SCOPE / PARALLEL_UNDECLARED` 时，done 已生效但 CLI 退出 1；按 stderr 补救，不重跑 done。
- `unavailable` 只警告，退出 0。
- `--scope` 零命中通常表示路径没改或参数被拆；按评论中给出的补救命令核对。

## 变更日志门禁

以下任一放行：

- 先 `kb changelog create --issue <本卡 UUID>`，再 done；
- `kb done --close-record --changelog-title ... --type ...`；
- 确认无用户可见变更，传 `--no-changelog`。

缺省时服务端返回 400 `CHANGELOG_ACK_REQUIRED`，done 不执行。

## 设计与 Git

设计页首次落库发生在拆卡前，必须立即提交 `.agentboard/Docs/<slug>.md` 和项目设计稿；提交信息带 page id。`.index.json` 是可重建索引，不提交。
