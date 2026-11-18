# kb 命令参考

## 参数与退出码

- 全局选项：`--server <url>`、`--json`。全局选项放子命令前。
- `--json` 成功输出原始 JSON；失败输出 `{"error":{"code","message","details"}}`，退出码不变。
- 0 成功；1 参数/用法、404、400、服务不可达；2 冲突（占用、状态、依赖、CAS、幂等、知识文件冲突、前缀多命中）；3 `kb dep` 与待决策族参数错误；4 `dep rm` 边不存在。
- `KB_METRICS=1` 在 stderr 追加 `[kb] cmd=<命令> out=<字节>B lines=<行数>`。

## 工作区

```text
kb list-spaces [--current] [--json]
kb create-space <name> <path>
kb delete-space <workspace> --yes
kb workspace-db <enable|status|cleanup|revert|snapshot> [...]
```

## 任务

```text
kb create-issue <ws> <title> -d <描述> [-p 低|中|高] [-l a,b] [--parent <id>]
  [--status 待规划|待验收] [--allow-empty] [--due YYYY-MM-DD[THH:mm]]
kb list-tasks [--workspace <id|名>] [--status <状态>] [--all-status] [--tree] [--full] [--all]
kb next [--workspace <id|名>] [--limit N]
kb stats [--workspace <id|名>]
kb show <id...> [--mark-read] [--comments n|all] [--description-offset N]
kb update <id> [--title] [--description|--description-stdin] [--priority] [--labels]
  [--due-date] [--due-time|--clear-due] [--parent|--clear-root] [--status]
kb move-issue <id> (--parent <id>|--root|--clear-root)
kb delete-issue <id> --yes
```

`create-issue` 没有 `--description-stdin`；长描述先建卡再 `kb update --description-stdin`。`--scope` 和 `--ids-file` 的参数口径读对应 `--help`。

## 流转

```text
kb claim <id> [--no-knowledge] [--knowledge-query <q>] [--request-id <uuid>]
kb release <id> [--request-id <uuid>]
kb done <id> [--notes|--notes-stdin] [--scope <path>]... [--close] [--close-record]
  [--changelog-title <title>] [--type 新增|修复|调整] [--knowledge-page <id>]
  [--design-not-advanced] [--no-changelog] [--board-only] [--all]
kb fail <id> --reason <text> [--request-id <uuid>]
kb accept <id> --verdict pass|fail --note <text>
kb close <id>
kb reopen <id> [--to <状态>]
```

## 依赖与状态

```text
kb dep ls|add|rm <issue-id> [blocker-id]
kb status ls [workspace]
kb status add [workspace] <name> [--kind open|started|review|done|deprecated|blocked]
kb status rm [workspace] <status> --migrate-to <目标>
```

## 评论、知识与日志

```text
kb comment <id> <text...> [--stdin] [--image <path>]...
kb changelog list|show|create|revise|delete
kb knowledge list|show|search|resolve|link|create|revise|import|action|rename|find-source|export-legacy
```

知识页命令的字段与必填项以 `kb knowledge create --help` 为准；工作区页必须 `--scope workspace --workspace <id>`，公共页用 `--scope common` 且不带 workspace。

## 决策

```text
kb ask <id> --question <q> --option <label|consequence>... [--grace N|--no-wait]
kb decisions [--state grace|open|answered|withdrawn] [--issue <id>] [--stale]
kb decision show <id|prefix>
kb decision withdraw <id> --reason <text>
kb answer <id> (--option <ord|label>|--text <text>) [--revise --expected-revision N]
kb ask-extend <id> --seconds N
kb stop-check <id>
```

## 本地检索

```text
kb grep <pattern> [--path <dir>] [--glob <glob>] [--ignore <glob>] [-i] [-C N]
```

`grep` 退出码独立：0 命中，1 未命中，2 出错。
