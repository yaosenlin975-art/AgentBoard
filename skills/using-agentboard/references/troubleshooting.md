# 故障与平台

## CLI 缺失

`kb` 返回 127：在 AgentBoard 仓库执行 `cd packages/cli; npm link`，再 `kb --version` 复验。没有仓库时报告未安装，不猜安装来源。

## 服务未启动

报「看板服务未启动」：仓库根执行 `pnpm --config.verify-deps-before-run=false server:ensure`。脚本探活成功即复用旧进程，不自动换构建。需要换构建时由用户确认重启。

服务日志在 `.logs/server.log`。同 DB 由 `server.lock` 单例保护；不要手工删除活锁。

## 409 / 退出码 2

先看 stderr：

- 已被占用：换卡，不重试；
- 状态不可领取：先按状态处理，已关闭卡用 reopen；
- 依赖未完成：等 blocker 到待验收/已关闭；
- 决策锁：走 `ask-user` / `get decision`；
- STALE_FENCE：重新 show + claim，拿新 fence。

## PowerShell

- 参数含引号、`&`、`|`、反斜杠时用单引号，内部单引号写两次。
- 多行正文走 `Get-Content -Raw file | kb ... --stdin`。
- 设置 `$OutputEncoding = New-Object System.Text.UTF8Encoding($false)`。
- 下游早退导致 EPIPE 时 CLI 静默结束且退出 0；需要业务结果就落盘或改用 `--json`。

## 编码

仓库文本必须 UTF-8 无 BOM。PowerShell 5.1 的 `Set-Content -Encoding UTF8` 和 `>` 可能写 BOM；用编辑器、`utf8NoBOM` 或 `UTF8Encoding($false)`。检查：`node scripts/check-bom.mjs`。
