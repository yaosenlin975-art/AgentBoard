# CLI 图片输入契约核验

日期：2026-11-02

## 结果矩阵

| CLI | 版本与输入方式 | 首轮 / 续会话 | 当前模型结果 | 结论 |
| --- | --- | --- | --- | --- |
| Codex CLI | 0.166.0；`codex exec --image <file>`；`codex exec resume <id> --image <file>` | 两轮均附不同的合成 PNG | 首轮回答 `4 orange squares; red triangle on the left; blue circle on the right.`；续会话回答 `6 purple squares; green triangle on the right; yellow circle on the left.`。CLI JSONL 未返回模型标识 | 本次默认会话模型视觉通过；具体模型名未知 |
| OpenCode CLI | v2.2.0；`opencode run --file <file>`；`--session <id>` 用于继续或创建会话 | 首轮进程收到 session id 并输出 5 个 `step_start`，约 110 秒未输出 assistant 内容；未执行续会话 | 未得到模型回答 | 未验证；仅有本机参数，不将官方文档视为实测 |
| CodeBuddy Code | 2.179.2；`--input-format stream-json` 接收 JSONL user message，image block 使用 base64；新会话 `--session-id`，续会话 `--resume <id>` | 两次独立 CLI 进程复用同一合成测试会话，各自附图 | MiniMax-M3.1-Flash；首轮回答 `4; red triangle; blue circle.`；续会话回答 `6; green triangle on the right; yellow circle on the left.`。两次 result 均为 success，CLI 报告 cost 0 | 本次模型视觉与首轮/续会话图片输入通过 |
| DSH | 0.2.1-rc.5 Windows 可执行文件版本；adapter 契约为 `dsh --profile headless` 并带会话参数 | `dsh.cmd --version` 与 `--help` 因目标模块缺失报 `MODULE_NOT_FOUND`；不能进入图片首轮或续会话 | 未调用模型 | CLI 入口阻塞；视觉能力未知 |

## 合成图片

测试文件位于 ignored fixture：`.superpowers/sdd/agentboard-board-2026-11-01/fixtures/img03-workspace/workspace-files/`。

- `first-turn.png`：4 个橙色方块、左侧红色三角形、右侧蓝色圆形；1103 字节；SHA-256 `7eb36648cde1f4141016e45b48a5aef9d0e39ac1433f1aaa4bc9a3e25cd0cbce`。
- `resume-turn.png`：6 个紫色方块、右侧绿色三角形、左侧黄色圆形；1103 字节；SHA-256 `249efb49c54e70d05fb1cf6aa41e1550d21f14673d79fec452fe378962ade35b`。

只用这两张无敏感信息的合成图。CodeBuddy 关闭所有内置工具并禁用后台任务；Codex 使用 read-only sandbox；OpenCode 使用 plan agent 并只在隔离目录运行。没有读取凭据、登录、切换账号或操作桌面客户端。为验证续会话，Codex 与 CodeBuddy 各在本机 CLI 历史创建了一个仅含合成图和识别问题的测试会话；未修改用户配置。模型输入与输出日志保存在 ignored `.superpowers/sdd/agentboard-board-2026-11-01/img03-*.jsonl`；日志只含合成测试对话和运行事件。

## 接口证据

- Codex 本机 `exec --help` 与 `exec resume --help` 均提供 `--image`，分别标为初始 prompt 和续会话 prompt 的图片输入。
- OpenCode 本机 `run --help` 提供 `--file` 和 `--session`；实际首轮未得到模型输出，续会话未知。
- CodeBuddy 官方 [Headless Mode](https://www.codebuddy.ai/docs/cli/headless) 定义 stream-json image block `{type:"image", source:{type:"base64", media_type, data}}`，以及多行会话与 `--resume`。本机 2.179.2 类型和运行时解析与该 JSONL 形状一致，视觉结果已实测。
- DSH 使用先前核验的安装入口；其 wrapper 目标缺失，本轮不修复共享安装。

## 未验证边界

- Codex 的实际模型标签没有出现在本次 JSONL 结果中；通过结果只代表该当前会话模型。
- OpenCode 未返回文本，不能断言参数已把图像送达模型或模型具备视觉能力。
- DSH 没有可运行的 CLI 入口，未验证首次、续会话或模型视觉能力。
- 结果只适用于上述 CLI 与当前模型；不代表同产品其他模型或 Desktop/IDE 客户端。
