# AgentBoard 项目规则（索引）

本文件只做索引：细则以列出的权威文档为准，冲突时按下列优先级。

## 硬规矩：先建卡再动手（RULE-1）

任何实现性改动（包括口头提出的一两行 UI 修补）必须先在看板建卡并 claim，再改代码；派工前先确认目标卡已存在，同一内容已有卡就认领/追加、不重复新建；提交信息必须带卡号。禁止以「改动很小」豁免。细则见 `skills/using-agentboard/SKILL.md` 的「无卡不动手（RULE-1）」。

1. `skills/using-agentboard/SKILL.md` —— 看板工作流唯一权威：工作区边界（强制）、kb 命令口径、故障分支、收尾提交。
2. `skills/writing-task/SKILL.md` —— 拆卡 / 建卡流程。
3. `skills/executing-task/SKILL.md` —— 执行已派卡流程。
4. `skills/handoff/SKILL.md` —— 交接流程。
5. `skills/swing-dev/SKILL.md` —— 机动巡检流程。
6. `README.md` —— 运行、端口、默认数据位置、构建与打包。
7. `Docs/api.md` —— HTTP API 与 CLI 契约（含退出码）。

## 对外打包约束

便携包必须携带本文件、`README.md`、`Docs/api.md` 与上述 5 个技能，落在包内 `app/rules/`；打包固定入口 `pnpm package:portable`（`scripts/package-portable.mjs`）。包内 `app/rules-manifest.json` 记录文件清单与 sha256，解压后用 `check-rules.cmd` 自检。
