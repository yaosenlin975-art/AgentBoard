# CLI 图片输入与模型视觉能力复核（IMG-03，2026-11-03）

- 任务：`5399e104-bebf-4a70-a1d9-e8ab16242095`【IMG-03】。前次记录：`Docs/evidence/image-cli-contracts-2026-11-02.md`（codex/opencode/dsh 首轮记录）。本文件**只追加本轮复核**，用于把「视觉 / resume unknown」逐项收敛为 supported / unverified / unsupported。
- 方法：只读探测 CLI 版本与 help、本机模型能力清单、真实合成标记图实测（本地生成，不含任何真实凭据）、本地会话落库结构核查。**未读任何 token/凭据，未启停客户端，未切换账号。**

## 0. 环境（2026-11-03 17:2x）

| CLI | 版本 | 入口 |
|---|---|---|
| codex | `codex-cli 0.166.0` | `C:\Users\31633\AppData\Roaming\npm\codex.ps1` |
| opencode | `opencode v2.2.5`（上次记录 2.2.0，**已升级**） | `…\npm\opencode.ps1` → `@opencode/cli/bin/opencode.exe` |
| codebuddy | `2.179.2` | `…\npm\codebuddy.ps1` |
| dsh | 无法取得版本（见 §4） | `D:\tools\bin\dsh.cmd` |

合成图（本地 System.Drawing 生成，无外部素材）：`IMG03-7788`、`IMG03-2244`，480×240 PNG，约 3.2 KB。

---

## 1. OpenCode v2.2.5

| 维度 | 结论 | 证据 |
|---|---|---|
| 原生附件参数 | **supported** | `opencode run --help`：`--file, -f string  File to attach to the message`；续会话参数 `--session, -s`、`--continue, -c`、`--fork` 均在 |
| 当前模型视觉能力 | **supported（声明层面）** | 本机 `~/.cache/opencode/models.json`：`opencode/glm-5.3-flash-free` → `"attachment": true`；同 provider 129 个模型中 `glm-5.3-flash`、`glm-5.3` 亦为 true，`glm-5.3`（非 flash）为 `false` |
| **首轮真实视觉** | **supported（实测通过）** | `opencode run --model opencode/glm-5.3-flash-free --file marker-a.png "只回答图片中的大写标记文本"` → **stdout 恰为 `IMG03-7788`**，退出码 0（唯一附加输出是 `> build · glm-5.3-flash-free` 提示行） |
| 续会话携带图片（真实调用） | **unverified（被配额阻塞）** | 首次调用成功后，同 provider 再调用一律返回 `Error: Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.`（退出码 1）；换免费视觉模型 `opencode-go/minimax-m3.1-flash-free` → `Error: Model unavailable: opencode-go/minimax-m3.1-flash-free`（退出码 1）。两次都**未进入模型**，属配额/授权阻塞，不是契约失败 |
| 图片落库/回读结构 | **partial（结构存在，未完成映射）** | `~/.local/share/opencode/opencode.db`（52.07 GB，只读）：29 张表，含 `session` / `message` / `part`（`data` JSON）+ 新 v2 表 `session_v2` / `session_message` / `session_part` + 附件表 `blob` / `blob_ref`。今日 `run` 产生的会话不在 `session` 表（最新一条为 2026-10-21），推测走 v2 表；本轮未完成「本次会话 → 图片 part」的映射核验 |

**OpenCode 结论**：CLI 图片参数与模型视觉声明均 supported，**首轮真实识图 supported**；**续会话携带图片 unverified**（原因：免费额度耗尽 + Go 免费视觉模型不可用；恢复条件：额度恢复或有可用授权的视觉模型）。

---

## 2. Codex CLI 0.166.0

| 维度 | 结论 | 证据 |
|---|---|---|
| 原生附件参数 | **supported** | 上次记录（`2026-11-02-image-cli-contracts.md`）：`codex exec --image`、`codex exec resume --image` 均存在并实测识图；本轮 `codex --help` 仍有 `exec` / `resume` 子命令 |
| 首轮视觉 | **supported** | 上次记录：首轮 `--image` 正确识别合成图（exit 0） |
| 续会话携带图片 | **supported** | 上次记录：`exec resume --image` 正确识别第二张图；本轮补充**落库证据**：`~/.codex/sessions/**/rollout-*.jsonl` 中图片以 `"input_image"` 载荷持久化，含 1/2/8/27/34 张图的会话文件（如 `2026-11-02T09-28-47…jsonl` 2 张 = 首轮+续会话一对；`2026-11-02T22-56-35…jsonl` 34 张）。resume 读取同一 rollout，因此续会话的图片在本地是可回读的 |
| 模型视觉能力标识 | **partial** | CLI JSONL 未回传具体模型标识（上次记录），本轮未再调用模型；视觉能力以「上次真实识图通过」为准 |

**Codex 结论**：首轮 + 续会话图片 **supported**（真实识图 + JSONL 落库双证据）；模型标识不可得属 CLI 输出限制（不影响识图结论）。

---

## 3. CodeBuddy CLI 2.179.2

| 维度 | 结论 | 证据 |
|---|---|---|
| 原生附件参数 | **supported** | 上次记录：`stream-json` 的 image base64 block（官方文档与本机类型一致），首轮与 `--resume` 均实测识图 |
| 首轮 / 续会话视觉 | **supported** | 上次记录：以 `MiniMax-M3.1-Flash` 首轮与 `--resume` 均正确识别合成图（tools/background tasks 关闭） |
| 图片落库位置 | **unverified** | 本轮只读扫描 `~/.codebuddy`（404 个文件）未发现 `data:image/(png|jpeg|webp);base64,` 块；未定位其会话/附件存储位置（可能在未扫描的 sqlite/leveldb 或压缩块里）。**不回退结论**：识图能力已由上次真实调用证明，落库位置只是未取证 |

**CodeBuddy 结论**：能力 supported；「落库位置」unverified（不影响能力结论，仅缺取证）。

---

## 4. DSH（DeepSeek Harness）CLI

| 维度 | 结论 | 证据 |
|---|---|---|
| CLI 可用性 | **unsupported（环境阻塞）** | `dsh --version` → `Error: Cannot find module 'D:\Program Files\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'`（MODULE_NOT_FOUND，退出码 1）；`D:\tools\bin\dsh.cmd` 只做 `node "<该路径>" %*` |
| 安装形态 | **已改 asar 打包** | `D:\Program Files\DeepSeek Harness\resources` 下只有 `app.asar`、`app.asar.unpacked`、`runtime` 等，**不存在 `app\dsh` 目录** → 旧的 CLI 入口路径失效；纯 Node 无法从 asar 内取模块 |
| 图片参数 / 视觉 / resume | **unsupported** | CLI 无法启动，谈不上参数与模型调用；需要安装方提供可执行入口（或用户以 Electron 主进程方式调用）后再验 |

**DSH 结论**：**unsupported（当前安装形态下 CLI 入口缺失，非模型能力问题）**。恢复条件：DSH 提供可执行的 CLI 入口（非 asar 内路径），或明确官方支持的调用方式。

---

## 5. 汇总矩阵（本轮结论）

| 维度 | codex 0.166.0 | opencode 2.2.5 | codebuddy 2.179.2 | dsh |
|---|---|---|---|---|
| CLI 图片参数 | supported | supported（`--file`） | supported（stream-json image block） | unsupported（入口缺失） |
| 模型视觉能力 | supported（真识图） | supported（`attachment:true` + 真识图） | supported（真识图） | 未知（无法调用） |
| 首轮图片实测 | supported | **supported（本轮实测 `IMG03-7788`）** | supported | unsupported |
| 续会话携带图片 | supported（resume + JSONL 落库） | **unverified（配额阻塞）** | supported（上次实测） | unsupported |
| 图片落库/回读 | supported（rollout `input_image`） | partial（表结构有 `blob`/`part`，未映射本次会话） | unverified（未定位） | 不适用 |

## 6. 本轮新增/变化的证据

1. opencode 从 2.2.0 → **2.2.5**；`opencode run --file` 首轮**真实识图通过**（这是前次 unknown 的直接闭环）。
2. opencode 续会话受**免费额度限制**阻塞：`Free usage limit reached`（配额），`opencode-go/minimax-m3.1-flash-free` → `Model unavailable`（授权/可用性）。
3. codex 会话 JSONL 的 `input_image` 落库统计（1/2/8/27/34 张/文件）→ 续会话图片可回读的结构证据。
4. DSH 失败原因从「wrapper 目标模块缺失」细化为**安装形态已是 asar 打包、`app\dsh` 目录不存在**（路径失效是结构性的，不是临时损坏）。

## 7. 未验证项（明确不可验及其原因）

- **opencode 续会话 + 图片**：需可用额度的视觉模型；当前免费额度耗尽、Go 免费视觉模型不可用 → 无法在不消耗用户付费额度/不动账号的前提下完成。恢复后一条命令即可验（`opencode run --session <ses_…> --file <img>`）。
- **opencode 本次会话的图片 part 映射**：需要确定 v2 表（`session_v2`/`session_message`/`session_part`）与 `blob_ref` 的关联；本轮未继续深挖（主库 52 GB，查询成本高）。
- **codebuddy 图片落库位置**：未在 `~/.codebuddy` 明文找到 base64 块；需按其存储实现取证，属「取证未完成」而非能力缺失。
- **DSH**：安装形态决定 CLI 不可用，需官方/安装方提供入口。
