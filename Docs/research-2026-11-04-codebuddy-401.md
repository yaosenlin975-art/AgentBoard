# codebuddy CLI 401 根因调研与恢复方案

日期：2026-11-04 · 卡：`12d721cf-2853-4ee8-b67b-1e482ea7b07c` · 仅调研，未改实现

## 1. 现象

- 2026-11-01 记录：本机 `codebuddy` CLI 直连返回 **401**，当时判断「需 `/login` 交互登录」，凭据未取得（ACC-02/03/07）。
- 未抓响应体，配额因素（402/429）未排除。
- AgentBoard `/api/clis` 报告 codebuddy `2.170.0`。

## 2. 今日探测记录（2026-11-04 11:16–11:24，共 3 次真实调用）

| # | 命令（相同调用只做一次，控额度） | 结果 |
|---|---|---|
| 1 | `codebuddy --version` | **2.179.2**（exit 0） |
| 2 | `codebuddy -p "ping" --output-format json` | **exit 0**，返回 JSON；`is_error=false`，含 `total_tokens`，**无 401** |
| 3 | `codebuddy -p "ping" --model minimax-m3.1-flash --output-format json`（adapter 固化模型） | **exit 0**，回包 `"model":"minimax-m3.1-flash"`、`"requestModelName":"MiniMax-M3.1-Flash"`、`is_error=false`，**无 401** |
| 4 | AgentBoard 路径：`POST /api/sessions {cli:'codebuddy'}` → `POST …/messages` → 读消息 | **200 / 200**；消息流含 `thinking` 与 `Bash`/`Read`/`Glob` 事件，**无 401/403/quota 关键词** |

补充事实（不含任何 token 内容）：

- `C:\Users\31633\.codebuddy\user-state.json` 的 mtime = **2026-11-04 11:09:36**（就在本次探测前 ~10 分钟被刷新），键为 `numStartups,memoryUsageCount,promptQueueUseCount,sessionsSinceLastTip,tipShowHistory,lastTipShown` —— 可见其中**不存凭据**。
- `settings.json` 键：`enabledPlugins,trustedDirectories,model,codebuddy`；`model = minimax-m3.1-flash`；**无 `env` 覆盖**（无自定义 endpoint / token 环境变量）。
- **两个 codebuddy 安装并存**：
  - `D:\tools\bin\codebuddy.cmd` → `D:\tools\codebuddy-official\node_modules\.bin\codebuddy.cmd` = **2.170.0**（旧）
  - `C:\Users\31633\AppData\Roaming\npm\codebuddy.cmd` = **2.179.2**（新，PATH 里排在前面）
- `where codebuddy`：npm 的 `.cmd` 在前，`D:\tools\bin\codebuddy.cmd`/`.exe` 在后。

## 3. 三候选判定

| 候选 | 结论 | 依据 |
|---|---|---|
| **token 过期 / 未登录** | **成立（最可能，且已自愈）** | 11-01 的 401 之后完成了登录流程；`user-state.json` 于今日 11:09 刷新；今日直连与经 AgentBoard 的调用全部成功、无 401 |
| 区域端点（region endpoint） | **未证实（当前不支持）** | `settings.json` 无 env/endpoint 覆盖；同机调用成功，无需换端点 |
| 版本过低（2.170.0 vs 固化 2.179.2） | **未证实，但「双版本并存」是真实隐患** | 旧副本存在且是 `/api/clis` 曾报的 2.170.0；今日成功调用走的是 npm 的 2.179.2。为避免消耗额度，**未在 2.170.0 上复测 401** |
| 配额不足 | **未证实** | 三次调用均正常计费返回，没有 402/429；此前也没留 401 响应体 |

**结论**：401 的最合理解释是**登录态在 11-01 已失效，之后已通过交互登录/自动刷新恢复**；「版本过低」不是当前 401 的原因，但双版本并存会让**服务端探测到旧版本**（`/api/clis` 曾报 2.170.0，即旧进程缓存 + 旧副本），从而把 adapter 的图片能力/版本判定带偏。

## 4. 恢复方案与代价

| 方案 | 做法 | 代价 / 风险 |
|---|---|---|
| **A. 统一 codebuddy 版本（推荐）** | 让 `where codebuddy` 只解析到一个新版本：把 `D:\tools\bin\codebuddy.cmd` 改为委托 npm 的 2.179.2（或删掉旧副本、把它改名 `.bak-<ts>`），然后重启服务刷新 `/api/clis` 启动缓存 | 一处 shim 改动 + 一次服务重启（共享实例，需 lead 安排时机）；无额度消耗 |
| **B. 再遇 401 时的恢复** | 交互执行一次 `codebuddy /login`（浏览器授权），完成后重跑第 2 条命令验证 | 需人工一次性操作；CLI 无 headless 登录通道（未证实是否有 `--device-code` 类参数） |
| **C. 凭据注入（若要做自动化）** | 摸清登录态落盘位置与格式（当前只确认 `user-state.json` 不含凭据，`settings.json` 有 `codebuddy` 键），再评估 adapter 注入 env/profile | 未证实格式；**不建议**在摸清前动手；且用户口径是「模型由用户主动下载/登录」 |
| **D. 版本固化对齐** | adapter 侧 `VERIFIED_IMAGE_CLI_VERSION='2.179.2'` 与本机新版本一致，无需修改 | — |

## 5. 未验证

- 2.170.0 是否真的 401（为省额度未复测）；
- 401 的原始响应体（历史记录未保存，今日已无法复现）；
- 配额维度：是否曾因余额触发过 401 而非 402/429（无证据）；
- 登录态落盘的具体文件与格式（`user-state.json` 已排除，`settings.json.codebuddy` 未解析）；
- 是否有 headless 登录/设备码通道。

## 6. 附：本次顺手发现（另卡处理，不在本卡范围）

经 AgentBoard 通道发给 codebuddy 的中文 prompt 在 CLI 侧显示为 `???`（mojibake），说明 **Windows 控制台编码/argv 传递**可能没走 UTF-8。这会污染中文需求，建议单独开卡核实（`spawnLineChild` 的 encoding 选项 + `chcp 65001` 影响）。
