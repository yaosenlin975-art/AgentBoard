# CB-VERSION 方案 A2 实施与验证（codebuddy 双版本并存）

- 卡：`8df7e26a-788e-4010-b9fe-7bfc174d7937`【CB-VERSION】
- 时间：2026-11-04 11:31–11:45（Asia/Shanghai）

## 背景（只读调研结论，前一步已回报）

`where codebuddy` 给出四条候选，PATH 里 npm 目录在 `D:\tools\bin` **之前**；但 AgentBoard 实际 spawn 的**不是** PATH 首项，而是 `adapters/spawn.ts` 的 `resolveWindowsSpawnForm()` **优先取 `.exe`** 的结果 —— 即 `D:\tools\bin\codebuddy.exe`（7 680 B 的 NodeExe launcher，`--version` = 2.170.0）。
因此「改 `D:\tools\bin\codebuddy.cmd` 委托 2.179.2」这条路无效；唯一真正生效的做法是让 `.exe` 不再被 where 命中。

## 实施（A2：改名移走，最小可逆）

| 步骤 | 动作 | 结果 |
| --- | --- | --- |
| 1 | 备份（复制，不动原件） | `D:\tools\bin\codebuddy.exe.bak-20261104-113154`，7 680 B，`sha256` 前 8 位 `4f075f7e`（全量 `4f075f7e566c441b3f81d7d6bff23f499c32acb887ea26f6e6848de1d02e6ae4`） |
| 2 | 原件改名 | `D:\tools\bin\codebuddy.exe` → `codebuddy.exe.disabled`（同目录，同字节） |

## 验证

**1) where 序列（改后）**

```
C:\Users\31633\AppData\Roaming\npm\codebuddy
C:\Users\31633\AppData\Roaming\npm\codebuddy.cmd
D:\tools\bin\codebuddy.cmd
```

（原第 4 条 `D:\tools\bin\codebuddy.exe` 消失；`.disabled` 不参与 where 匹配。）

**2) `/api/clis` 版本（`POST /api/system/restart` 刷新缓存后）**

- 改前：`{"id":"codebuddy", … "version":"2.170.0" …}`
- 改后：`{"id":"codebuddy","displayName":"CodeBuddy","installed":true,"version":"2.179.2","supportsModelSelection":true}`

**3) 真实调用**

`codebuddy -p 'ping'` → **exit 0**，耗时 6.7s；返回体是额度提示：
`429 额度已用尽，请访问 …/profile/usage (01a1a49dae…/01a1a49d-…)`。
即：进程能正常拉起、能打到服务端点并回传结构化错误 —— 启动链路 OK；**生成成功路径因账号额度用尽未验证**。

**4) 版本三处对照**

| 位置 | 版本 |
| --- | --- |
| `where` 解析后 `codebuddy --version` | **2.179.2** |
| `C:\Users\31633\AppData\Roaming\npm\codebuddy.cmd --version` | 2.179.2 |
| `D:\tools\bin\codebuddy.exe.disabled`（原 launcher） | 2.170.0（已停用） |

## 已知副作用（A2 的代价）

任何**通过 PATH 名 `codebuddy` 解析**的调用方，现在都会拿到 npm 的 2.179.2 而不是 2.170.0。已只读排查引用面：

| 检查项 | 结果 |
| --- | --- |
| 注册表 `HKCU\…\Run` / `App Paths` | 无 codebuddy 项 |
| `D:\tools\multica\run-daemon.cmd:14` | 用的是 `D:\tools\codebuddy-cli\codebuddy.exe`（**另一份，存在且未动**）→ 不受影响 |
| `%APPDATA%\npm\node_modules\@tencent-ai\codebuddy-code\builtin\remote-host\cbc-discovery-windows.ps1:149` | 按**文件名**发现 `codebuddy.exe/.cmd`，不写死路径 → 仍能发现 npm 版本 |
| 仓库内引用 `tools\bin\codebuddy.exe` | 仅两处历史验证文档（`Docs/verification/2026-11-01-checkin-provider-contracts.md:47`、`2026-11-01-codebuddy-desktop-contract.md:54`）→ 非运行路径 |
| OpenViking 记忆 / DSH 会话缓存 | 描述性文本，无运行耦合 |

## 回滚（一条命令量级）

```powershell
Move-Item 'D:\tools\bin\codebuddy.exe.disabled' 'D:\tools\bin\codebuddy.exe' -Force
# 可选：删掉备份副本
Remove-Item 'D:\tools\bin\codebuddy.exe.bak-20261104-113154'
# 然后刷新 CLI 缓存（版本会回到 2.170.0）
curl.exe -s -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:8787/api/system/restart
```

## 未验证

- **生成成功路径**：账号 429 额度用尽，`-p` 只跑到「拉起到回传 429」；等额度恢复后需再跑一次真实生成确认 2.179.2 行为（尤其 `--resume`、图片入参 `-i`）。
- 其它调用方（IDE 插件等 GUI 侧）是否自带路径，未逐一排查。
