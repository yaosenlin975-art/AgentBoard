# CodeBuddy 本机目标核查

- 日期：2026-11-01
- 任务：ACC-02（92601b5b-a591-4fa2-875b-8ec5c896639e）
- 结论：gate=unverified；已向用户确认 CLI 或 Desktop/IDE 目标形态，尚待答复。不得启用 ACC-06 的桌面登录写入。
- 本轮未读账号、Cookie、vault 或客户端认证文件，未运行客户端、重启或修改配置。

## 已获得证据

| 项目 | 结果 | 口径 |
|---|---|---|
| AgentBoard codebuddy adapter | 现有实现是 CLI，命令名 `codebuddy` | `packages/adapters/src/codebuddy.ts:1-20` 与解析/进程适配接口 |
| 命令解析 | `C:/Users/31633/AppData/Roaming/npm/codebuddy.ps1` | `Get-Command codebuddy`；没有执行登录或读取 CLI profile |
| 常见桌面路径 | 已查的 C 用户 Programs、C Program Files、D Program Files 下未发现对应 CodeBuddy exe | 定向目录与 `Test-Path`；不代表其他自定义目录没有安装 |
| 开始菜单 | 用户与系统开始菜单目录未找到 CodeBuddy 命名快捷方式 | 只枚举匹配文件名，没有启动程序 |
| 卸载元数据 | HKCU/HKLM 与 WOW6432Node 的 Uninstall DisplayName 未匹配 CodeBuddy | 只读注册表；未修改 PATH/注册表 |
| 运行中进程 | 名称匹配查询未返回 CodeBuddy | 只读进程名称/可执行路径；不枚举命令行凭据 |

## Desktop 契约字段

| 字段 | 状态 | 执行条件 |
|---|---|---|
| productName / supportedVersion / processPath / instanceId | unverified | 用户提供实际 Desktop 路径，核验安装元数据；不得以 CLI 路径代替 |
| currentIdentity / stable UID | unverified | 只从已确认产品的受支持身份入口取得，需授权测试场景 |
| snapshot format / version / credential scope | unverified | 未取得目标 Desktop 原始契约，不复用 WorkBuddy 或 CLI 结构 |
| safe close / unsaved-work detection | unverified | 无法证明空闲则用户先保存并手动退出；进程未退出不得写入 |
| restore / independent identity proof | unverified | 两个测试身份独立验证；仅文件写成功不算切换成功 |
| CLI 与 Desktop 的凭据关系 | unverified | 不因同名账号/文件推定共享，需路径与 UID 双证据 |

## 契约测试矩阵（未执行）

- cliIdentityDoesNotSatisfyDesktopIdentity：CLI 命令存在不能使 Desktop provider supported。
- unknownDesktopPathIsUnsupported：版本或安装实例未知时拒绝捕获、恢复与自动关闭。
- desktopIdentityMustBeStableAcrossRestart：测试重启后 UID 不一致，不支持该快照。
- snapshotProductInstanceUidMismatch：任一维度不匹配时不写客户端文件。

当前无 Desktop provider，也没有对应测试文件；不宣称 `codebuddyDesktopProvider.test.ts` 通过。若用户目标实际是 CLI，应先修订账号设计及 ACC-02/06 的目标与契约，不把 Desktop 实现强套到 CLI。

---

## 2026-11-01 接管核查（kb-cli 承接；口径：按 issue 原文以 CodeBuddy Desktop 正式产品为目标）

接管时处理口径已定：以 CodeBuddy Desktop 正式产品为目标穷举本机安装证据；确无 Desktop 安装则 provider 标 unavailable、ACC-06 保持阻塞，不猜路径、不把 CLI/IDE 插件当 Desktop（Codex 遗留的「CLI 还是 Desktop/IDE」提问由该口径与下文解除条件处置）。本轮只读：未读任何文件内容（凭证类文件只记路径/大小/文件名/时间戳）、未触发登录或网络动作（仅任务清单授权的 `codebuddy --version` 本地版本打印）、未杀进程、未修改客户端文件与产品代码。CLI 身份仅作隔离参照。

### 穷举结果表

| # | 检查项 | 命令 | 结果 |
|---|---|---|---|
| 1 | 注册表卸载项（HKLM/HKCU + WOW6432Node，4 棵全部） | PowerShell `Get-ChildItem` + `Get-ItemProperty`，DisplayName 匹配 codebuddy / code buddy / 腾讯云代码助手 / 腾讯 / tencent | 命中 3 条，均为其他腾讯产品：腾讯文档 3.12.11、腾讯会议 3.39.1.427、腾讯桌面整理 4.3.1829.127。**无 CodeBuddy 卸载项** |
| 2 | 开始菜单 lnk（用户目录 76 个 + 系统目录 148 个） | `Get-ChildItem -Recurse -Filter *.lnk` + WScript.Shell 解析 TargetPath | 命中 7 个 lnk，全部为腾讯文档/会议/桌面整理/QQ。**无 CodeBuddy 快捷方式** |
| 3 | 安装路径目录（%LOCALAPPDATA%\Programs、%LOCALAPPDATA%、%APPDATA%、Program Files、Program Files (x86)、D:\、C:\，`-Depth 2`） | `Get-ChildItem -Depth 2 -Directory` 关键词过滤 | %LOCALAPPDATA%\Programs 完整清单仅 7 项（Common/Cursor/Notion/Python/recordly/Tuanjie Cowork/WorkBuddy），**无 CodeBuddy**；其余命中均为数据/缓存/CLI 目录，见下节甄别 |
| 4 | 运行进程 | `Get-Process` 匹配 codebuddy + FileVersionInfo | **无匹配进程** |
| 5 | IDE 插件（VS Code `.vscode\extensions`、JetBrains `%APPDATA%\JetBrains\*\plugins`） | 目录名过滤 | **均无 codebuddy 扩展**。明确：IDE 插件形态不属于 Desktop 契约 |
| 6 | CLI（隔离参照） | `where codebuddy` + `codebuddy --version` | 解析到 4 个位置：npm 全局 `codebuddy`/`codebuddy.cmd`、`D:\tools\bin\codebuddy.cmd`、`D:\tools\bin\codebuddy.exe`；版本 **2.179.1**。仅 CLI 证据 |
| 补 | 商店应用（排除经典卸载键遗漏） | `Get-AppxPackage` 匹配 codebuddy/tencent | **无匹配** |

### CodeBuddy 命名目录甄别（第 3 项命中项）

| 路径 | 判定 | 证据 |
|---|---|---|
| `C:\Users\31633\.codebuddy` | **CLI profile**，活跃（mtime 2026-10-27），含 sessions/plugins/skills/tasks 等 | 非 Desktop 证据；仅作 CLI 隔离记录 |
| `C:\Users\31633\.codebuddycn` | CLI/IDE-fork 配置残留（`extensions` + `argv.json`，mtime 2026-04-26 21:44） | 非 Desktop 证据 |
| `C:\Users\31633\AppData\Roaming\CodeBuddy CN` | **Electron userData 数据残留**：blob_storage/GPUCache/Local Storage/Service Worker/machineid/codebuddy-sessions.vscdb 等；全部文件 mtime 2026-04-26 21:44；depth 2 内**无任何 exe**，无版本元数据 | 历史「CodeBuddy CN」Electron/IDE 形态的运行痕迹；正式产品名与版本未确证；当前无安装实例，不构成 Desktop 契约 |
| `C:\Users\31633\AppData\Local\CodeBuddyExtension` | 缓存/数据/日志目录（Cache/Data/Logs，mtime 2026-04-26 21:44–21:45），无 exe | 残留，同上 |
| `D:\tools\codebuddy-bridge`、`D:\tools\codebuddy-cli` | 本机自建工具目录（codebuddy.exe + .cs 源码，mtime 2026-10-20） | CLI/工具实验产物，非 Desktop |
| `D:\tools\codebuddy-official` | npm 包（package.json + node_modules，mtime 2026-10-20） | CLI 安装 |
| `C:\tmp\codebuddy`、`D:\tmp\codebuddy` | tasks 工作目录 | CLI/工具产物 |
| `C:\Users\31633\AppData\Roaming\TDAppDesktop\codebuddy-cli` | 腾讯文档桌面版数据目录下的同名子目录 | 与 CLI/工具相关的杂项，性质未定；非 Desktop 实例证据 |

### 结论

**本机当前无 CodeBuddy Desktop 独立安装实例。** 4 棵卸载注册表、用户+系统开始菜单（224 个 lnk 全量扫描）、%LOCALAPPDATA%\Programs 完整清单、Program Files x64/x86、D:\、C:\ 深度 2、商店应用包、进程列表均无 Desktop 实例证据。2026-04-26 前后存在过的「CodeBuddy CN」Electron 形态仅剩数据残留（无 exe、无卸载元数据、版本未知），残留不构成可核验契约。

**provider 判定：codebuddy_desktop = unavailable。ACC-06 保持阻塞。**

### gate 表

| gate | 结论 | 依据 |
|---|---|---|
| cliIdentityDoesNotSatisfyDesktopIdentity | 成立（静态判定） | CLI 完整存在（命令 2.179.1、活跃 profile `~/.codebuddy`）而 Desktop 无安装实例；CLI 证据对 Desktop provider 输入为零。无 provider 代码，自动化用例不适用 |
| unknownDesktopPathIsUnsupported | 成立 | 唯一类 Desktop 痕迹是无 exe、无版本、无安装实例的数据残留；provider 对该形态必须返回 unsupported，不得从 userData 结构推断契约 |
| desktopIdentityMustBeStableAcrossRestart | unverified | 无 Desktop 实例可重启，无法验证 |

### ACC-06 解除条件（满足其一后复测本卡）

1. 用户安装 CodeBuddy Desktop 正式产品后复测：穷举清单第 1–4 项出现实例（卸载项、开始菜单或 Programs 目录含 exe 及版本元数据），按 ACC-01 同款结构补齐实例/版本/数据目录/身份字段（脱敏）/快照结构/退出启动检测。残留目录（CodeBuddy CN、CodeBuddyExtension、.codebuddycn）与新实例的关系届时需重新甄别，不预判。
2. 用户明确目标形态实为 CLI 或 IDE 插件：先修订设计与 ACC-02/ACC-06 的目标契约，再按新目标重新验证。

### 违规检查确认

未读任何文件内容（machineid、Local State、vscdb 等敏感候选只记路径/大小/时间戳）；仅执行清单授权的 `codebuddy --version` 本地打印；未登录、未联网、未强杀进程、未改客户端文件与产品代码、未清理残留目录。
