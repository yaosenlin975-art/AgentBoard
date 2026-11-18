# .agentboard（AgentBoard 工作区数据）

本目录由 AgentBoard 维护，`snapshot/` 是库的只读派生文本快照：

- 事实源始终是 `agentboard.db`（或其备份），快照只用于进 git、diff 与审阅；
- 快照可直接提交；`manifest.json` 记录每表行数与 sha256；
- 恢复：`kb workspace-db snapshot validate <workspace>` 校验后，
  `kb workspace-db snapshot import <workspace> --replace` 导入（会先自动备份当前库）；
- 附件默认只导出清单行；需要图片本体时用 `kb workspace-db snapshot export <workspace> --include-attachments`，
  导出到 `snapshot/attachments/`，导入时按 sha256 校验并落到本目录 `attachments/`；
- `*.db` / `attachments/` / `localize.json` 已被 `.gitignore` 排除，不要手工提交。
