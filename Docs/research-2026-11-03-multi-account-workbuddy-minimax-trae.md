# WorkBuddy / MiniMax / TRAE 多账号管理与新增账号方式调研

- 日期：2026-11-03
- 任务：ACC-RESEARCH-01（`1c70c8d0-2114-4b7e-8c8d-c3352aa25ae5`）
- 执行者：board-web-accounts
- 方法：①本机只读实测（2026-11-03，三客户端已安装态；不读 token 原文，字符串值只看键名/长度/sha256 前 8 位）②官方文档抓取（`docs.trae.cn`、`agent.minimax.cn`、`codebuddy.cn`）③对照我们已实现的 `apps/server/src/services/accounts/**`
- 证据标签：`本机实测` / `官方文档` / `未证实`（无社区来源引用；`web_search` 本轮不可用，见 §0.3）

## 0. 材料与方法边界

### 0.1 只读实测清单（全部脱敏）

| 产品 | 本机安装 | 账号数据位置（实测） | 备注 |
|---|---|---|---|
| WorkBuddy Desktop | `D:\Program Files\WorkBuddy\WorkBuddy.exe` 5.9.3.0（另有 C: 4.22.5.0 陈旧残留，已排除） | 主凭据 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`；身份骨架 `~/.workbuddy/storage/skeleton/account-snapshot.json`；数据根 `~/.workbuddy` | 沿用 `Docs/verification/2026-11-01-workbuddy-desktop-contract.md`，今日复核无变化（uid 哈希 `f5d89346`） |
| MiniMax Code | `D:\Program Files\MiniMax Code\MiniMax Code.exe`（235,418,560 B，mtime 2026-11-01）；CLI 于 `~/.minimax-code`（含 `current`/`releases`/`.mcode-active`/`.mcode-update.lock`） | `~/.minimax/auth/prod/cn/mcode-public/{auth.json, auth-state.json, auth.lock, refresh/}`；CLI 配置 `~/.minimax/config.yaml` | 桌面端进程当前未运行；auth 按 `<buildEnv>/<region>/<clientId>` 分层 |
| TRAE CN | `D:\Program Files\Trae CN\Trae CN.exe` 3.4.13（FileVersion 2.3.99396，Beijing Yinli Catapult）；进程当前运行 | 活跃用户数据 `%APPDATA%\Trae CN`（`User/globalStorage/state.vscdb` 1,560,576 B，mtime 今日）；登录态 `~/.trae-cn/trae-jwt-token`（925 B）；旧国际构建数据 `%APPDATA%\Trae`（2026-07 后无活动） | 另有 `~/.trae`、`~/.trae-cn` 两个用户级目录 |

### 0.2 未读取的内容

token / refreshToken / jwt 明文、`$wbEncrypted` 信封值、DPAPI vault、cookie。文中出现的标识一律为 sha256 前 8 位或目录/文件名。

### 0.3 工具限制

`web_search` 本次调用返回上游 401（搜索端点配置问题，需用户侧修复），因此外部资料全部由 `web_fetch` 直取官方站点；未能抓取全文的页面在证据列标「官方站点（正文未抓取）」。**未使用社区来源**。

---

## 1. WorkBuddy Desktop（腾讯）

### 1.1 账号存储形态 —— 单活动槽位 + 客户端自建历史备份（`本机实测`）

- 主凭据单文件：`workbuddy-desktop.info`（9,759 B，schema `v2-wbencrypted`，敏感字段为 `{$wbEncrypted:1, envelope}` 信封）。
- 文件内结构：`auth`（accessToken/refreshToken 信封 + 过期时间）、`account`、`accounts[]`、`allAccounts[]`；**两个数组当前长度均为 1**（本机只登录一个账号）。
- 客户端自建时间戳备份：`workbuddy-desktop.2026-05-02T13-19-10-411Z.info`、`…2026-05-06T10-58-42-821Z.info`、`…2026-08-27T12-49-03-117Z.info` 三份（换账号时生成，历史账号登录态被保留下来）。
- 身份骨架单条：`~/.workbuddy/storage/skeleton/account-snapshot.json`（326 B，`primary.uid` 哈希与主凭据一致 `f5d89346`）。
- 派生键目录 `~/.workbuddy-key-fallback/connector-keys/` 现存两个 uid 派生键前缀（`f5d89346*`、`dae15da8*`）→ 本机曾登录过第二个账号（`本机实测`，该 uid 对应哪个账号未定位）。
- 切换语义：客户端内「退出登录 → 重新登录」，即**换文件内容**而非并行多账号；`accounts[]` 是客户端自己的多账号记录结构，但没有"同时在线"语义（见 1.4）。

### 1.2 新增账号方式 —— 客户端内重新登录（`本机实测` + `官方站点（正文未抓取）`）

- 实测证据链：每次账号变更都伴随 `workbuddy-desktop.<TIMESTAMPZ>.info` 新备份 + `$.account.uid` 变化（2026-05-02 备份为另一 uid `cacb9fd3`）。
- 未发现"添加账号"入口留下的多账号并行痕迹（`accounts[]` 长度恒 1，进程只挂一个登录态）。
- 官方来源：`https://workbuddy.tencent.com/` → 302 到 `https://www.codebuddy.cn/`（腾讯云代码助手 CodeBuddy 官方站点，WorkBuddy 属同产品族）。文档正文为 SPA，抓取只得到标题，**官方是否宣传"多账号"未证实**。

### 1.3 会话与凭据 —— stable UID + token 轮换（`本机实测`）

- 账号标识：`$.account.uid`（UUID，36 位），sha256 前 8 位 `f5d89346`，跨 7/13、8/27、10/27、11/01、11/03 五次观测一致。
- token：`auth.accessToken` / `refreshToken` 均为加密信封；**启动即重写文件**（本次 8,218 B → 9,759 B，mtime 变），因此文件哈希不能作为身份判据。
- 设备绑定：未在本机配置中发现设备指纹字段（`本机实测` 范围内）；官方是否做设备级会话限制 **未证实**。

### 1.4 并发 —— 单实例、单账号（`本机实测`）

- 客户端运行中再次 `Start-Process` 不产生新实例，唤起原窗口（同 PID/HWND）→ 单实例。
- auth 路径固定为每用户路径、不含安装实例段 → 同产品装第二份也共享同一 auth 文件，**不可能并行多账号**。
- 退出行为：`WM_CLOSE` 只隐藏到托盘（`close-to-tray-hint.json` 存在）；真实退出有可只读识别的写盘签名（`workbuddy-desktop.info` 与 `~/.workbuddy/ioa-im-override.json` 同刻写盘，`app/window-state.json` 滞后约 5 s）。

---

## 2. MiniMax Code（桌面 + CLI + Web）

### 2.1 账号存储形态 —— 单活动槽位的结构化 auth 目录（`本机实测`）

```
~/.minimax/auth/prod/cn/mcode-public/
├── auth.json         606 B   keys = schemaVersion, records    （records 当前为空）
├── auth-state.json   269 B   keys = schemaVersion, status, storeKind, clientId,
│                              scopes, audience, buildEnv, region, generation, expiresAtMs
├── auth.lock           0 B   互斥锁（CLI/桌面共用）
└── refresh/                  （当前为空）
```

- 按 `<buildEnv>/<region>/<clientId>` 分层（本机 `prod/cn/mcode-public`），**不支持多账号并列目录**：没有 per-account 子目录、没有账号数组。
- `generation`（计数）+ `expiresAtMs`（过期时刻）→ 说明 token 由客户端刷新轮换；`storeKind`/`status` 表明单槽位状态机。
- 与 CLI 共享同一 auth 根（`~/.minimax/config.yaml` 指向同一产品），桌面端/CLI 是"同一个账号槽位"的不同前端。

### 2.2 新增账号方式 —— 退出登录后重新登录（`本机实测` + `官方文档`）

- 本机未发现"添加账号"结构（无账号数组/索引）；重新登录会覆盖同槽位文件（`auth.lock` + `refresh/` 说明写入受锁保护）。
- 官方文档《欢迎使用 MiniMax Code》把「下载与安装 → 完成登录 → 创建任务」作为线性流程，**未提供多账号/切换账号入口说明**：`https://agent.minimax.cn/docs/code/welcome`（`官方文档`）。
- 官方账户章节只有订阅/积分/API Key/BYOK 四页，没有账号切换页：`https://agent.minimax.cn/docs/code/account/usage`（`官方文档`）。→ 「官方是否支持多账号并存」**未证实**，按单账号处理。

### 2.3 会话与凭据（`本机实测`）

- 标识：`auth-state.json` 的 `clientId` + `audience` + `region`；`auth.json` 的 `records` 为空时表示当前无活动登录态（本机当前状态）。
- token：`records[]` 内保存（本机为空，**未读取任何 token 值**）；`expiresAtMs` 给出过期时刻 → 轮换由客户端负责。
- 设备绑定：本机未见设备指纹文件；官方未见说明 → **未证实**。

### 2.4 并发（`本机实测`）

- `auth.lock`（0 B）→ 同类操作互斥；桌面端进程当前未运行，未观察到多实例行为。
- 同机 CLI 与桌面端共用 auth 槽位 → 同一时刻只应有一个活动登录态。

### 2.5 补充发现（对我们有直接影响）

- 本机实际安装目录名是 **MiniMax Code**（`D:\Program Files\MiniMax Code\MiniMax Code.exe`），而我们的 provider 默认路径是 `~/AppData/Local/Programs/MiniMax/MiniMax.exe`（`apps/server/src/services/accounts/minimaxDesktopProvider.ts:65`）→ 能力矩阵把 minimax 判成 `CLIENT_NOT_INSTALLED`（`apps/server/src/services/accounts/registry.ts:21`），属**路径假设导致的误判**，不是客户端缺失。

---

## 3. TRAE（CN 构建）

### 3.1 账号存储形态 —— Electron globalStorage + 租户级 auth 条目（`本机实测`）

- 活跃用户数据在 `%APPDATA%\Trae CN`（`User/globalStorage/state.vscdb`，387 个键，1,560,576 B）；`%APPDATA%\Trae` 是旧构建/国际版残留（2026-07 后无写入）。
- 登录态文件：`~/.trae-cn/trae-jwt-token`（925 B，今日 10:05 更新）→ **单文件单槽位**。
- `storage.json` 顶层出现按端点/租户区分的 auth 条目（键名，不含值）：`iCubeAuthInfo://icube.cloudide`、`iCubeAuthInfo://usertag`、`iCubeAuthInfo://icube-dc:578796082186762`、`iCubeAuthInfo://icube-dc:aha-0b9a133bb704f765bb800e8b395af606`；与 `~/.trae-cn/578796082186762/` 目录同名 → 租户/端点的数据分目录。
- 多账号痕迹：`state.vscdb` 的用户级键出现**两个不同数字用户 id**（`2214882779084540`、`4320450682843164`），说明本机历史上用过两个账号；但登录态仍是单一 jwt 文件 → 当前只有一个活动账号。
- 我们的 registry 判定 `LOGIN_STATE_NOT_FILE_BASED`（`registry.ts:22`）与实测一致：登录态分散在 SQLite + JSON + jwt 文件，**不是单文件可替换**。

### 3.2 新增账号方式 —— 退出登录/切换账号后重登（`官方文档` + `本机实测`）

- 官方文档未提供"添加多个账号"能力；账号相关入口只有头像菜单（升级权益 / 订阅管理 / 用量管理）：`https://docs.trae.cn/ide_subscription-management?lang=zh`（`官方文档`）。
- 通用设置项里没有账号/多账号设置：`https://docs.trae.cn/ide_general-settings?lang=zh`（`官方文档`）。
- 本机实测：账号切换会改 `trae-jwt-token` 与租户级 auth 条目，旧账号的用户级键仍留在 `state.vscdb`（不清理）。

### 3.3 会话与凭据 —— 设备数量限制 + 单活动登录（`官方文档`）

- 同一 TRAE 账号最多同时登录 **10 台设备**；计入设备的有 TRAE、TraeWork 桌面版、TRAE 移动端，网页版不计；同一台电脑同时登录 TRAE 与 TraeWork 桌面版只算 1 台；达到上限需在其它设备登出，且登出该设备会连带登出该机上的多个客户端：`https://docs.trae.cn/ide_device-limit?lang=zh`（`官方文档`）。
- token 由客户端维护（jwt 文件随使用更新），我们未读取其内容（`本机实测`）。
- 设备绑定：**官方明确有设备数上限**（账号级设备会话），与 WorkBuddy/MiniMax 的"未证实"不同（`官方文档`）。

### 3.4 并发（`官方文档` + `本机实测`）

- 同机单账号：一个 `trae-jwt-token` 槽位，客户端同时只挂一个账号。
- 多设备：官方允许同账号最多 10 台设备并行（`官方文档`），但**同一台机器的同一客户端不能同时挂两个账号**（`本机实测`）。

---

## 4. 横向对比表

| 维度 | WorkBuddy Desktop | MiniMax Code | TRAE CN |
|---|---|---|---|
| 存储形态 | 单文件主凭据 `.info`（v2 信封）+ 单身份骨架；客户端另存时间戳历史备份；文件内有 `accounts[]`/`allAccounts[]`（当前 1 条） | 分层 auth 目录 `auth/<env>/<region>/<clientId>/`：`auth.json`(records) + `auth-state.json`(状态机) + `auth.lock` + `refresh/`；无多账号并列结构 | `state.vscdb`(SQLite 全局状态) + `storage.json`(租户级 auth 条目) + `~/.trae-cn/trae-jwt-token`(单 jwt) |
| 是否支持客户端内多账号并存 | 结构上留了数组，但实测单活动账号、无并行 | 单槽位，无并存结构 | 单 jwt 槽位；历史用户键残留，但只一个活动账号 |
| 新增账号方式 | 退出登录→重新登录（换文件内容，客户端生成新备份） | 退出登录→重新登录（覆盖同槽位） | 头像菜单退出登录→重新登录 |
| 账号标识 | `$.account.uid`（sha256_8 `f5d89346`），跨重启稳定 | `clientId`+`audience`+`region`（`auth-state.json`） | 数字用户 id（`state.vscdb` 用户级键）+ 租户 id（`icube-dc:…`） |
| token 轮换 | 启动即重写文件（哈希必变） | `generation` 计数 + `expiresAtMs` | jwt 文件随使用更新 |
| 设备绑定 | 本机未见设备字段；官方未证实 | 本机未见；官方未证实 | **官方明确：同账号最多 10 台设备** |
| 并发/互斥 | 单实例（再次启动唤起原窗口）；auth 路径无实例段 → 同机只能一个活动账号 | `auth.lock` + 单槽位；桌面端与 CLI 共用槽位 | 单 jwt 槽位；多设备可并行登录同账号 |
| 官方来源 | `https://www.codebuddy.cn/`（`workbuddy.tencent.com` 302 到此；正文未抓取） | `https://agent.minimax.cn/docs/code/welcome`、`https://agent.minimax.cn/docs/code/account/usage` | `https://docs.trae.cn/ide_device-limit?lang=zh`、`https://docs.trae.cn/ide_subscription-management?lang=zh` |
| 主要风险 | 文件级替换会与客户端会话/设备风控不一致；升级改 schema 即失效；启动 token 轮换导致"我们存的 token"过期 | 默认 exe 路径假设错误（本机是 MiniMax Code）；records 为空时无有效登录态可切换 | 登录态非单文件，做文件快照替换不可行（已正确标 unverified）；设备上限可能被占满 |

---

## 5. 对照我们已实现的部分（差距与风险）

现状（`apps/server/src/services/accounts/**`）：

- `workbuddyDesktopProvider.ts`：捕获/切换 = 快照 `.info` + `account-snapshot.json` → vault；身份用 `uid` sha256；切换流程 = 停客户端 → 写快照 → 启动 → 验证身份；`canCloseSafely()` 恒返回不安全（busy/unsaved 不可判定）；禁止 `taskkill /F`。
- `minimaxDesktopProvider.ts`：文件级切换（改写 `~/.minimax/auth/.../auth.json`），默认 exe 路径 `~/AppData/Local/Programs/MiniMax/MiniMax.exe`。
- trae：无桌面 provider，registry 标 `LOGIN_STATE_NOT_FILE_BASED`；仅签到 provider 读 `~/.trae-cn/trae-jwt-token`。
- 能力矩阵按维度给 `capture/switch/checkin_reason_code`（ACC-09/13/14 已交付）。

差距：

| # | 差距 | 影响 | 证据 |
|---|---|---|---|
| G1 | 我们把"多账号"实现为**登录态文件快照替换**，产品原生是"客户端内账号槽位 + 服务端会话" | 快照替换实质是伪造客户端登录态：可能与设备会话/风控冲突；产品升级改 schema 后快照失效 | 三产品均单槽位；TRAE 官方设备数限制 |
| G2 | WorkBuddy 客户端已保留历史账号备份（时间戳 `.info` + `connector-keys`），我们却仍从进程内存扫 token | 多账号列表可更稳地来自"客户端自建备份"，减少进程内存扫描（当前 `credentialImport.ts` 路径） | §1.1 三份时间戳备份 + 两个 uid 派生键 |
| G3 | minimax provider 默认 exe 路径与本机实际安装名不符（`MiniMax Code`） | 能力矩阵误判 `CLIENT_NOT_INSTALLED`，切换被误标不可用 | `minimaxDesktopProvider.ts:65`、`registry.ts:21` |
| G4 | TRAE 只有签到通道，没有"只读识别当前账号"能力 | 界面上 TRAE 账号只能靠导入 token 后的 identity_hint 推断 | `~/.trae-cn/trae-jwt-token` + `state.vscdb` 用户键 |
| G5 | 我们把"切换"当原子操作（停→写→启→验），产品侧没有"切换 API" | 切换失败面大（客户端更新、后台常驻托盘、未保存内容）；`canCloseSafely` 恒不安全是正确但受限 | WorkBuddy `WM_CLOSE` 只隐藏托盘；托盘退出需人工 |
| G6 | 并发模型未在产品文档中固化 | 若未来支持"同产品多实例"，`client_instance_id` 与 auth 固定路径假设会冲突 | auth 路径无实例段（WorkBuddy/MiniMax） |

---

## 6. 对我们的建议（可落地动作）

| 建议 | 类型 | 归属 |
|---|---|---|
| 把「账号存储形态 = 单活动槽位 + 客户端保留历史备份」写进设计文档与 UI 说明：**同一产品同一时刻只有一个活动账号，我们不支持并行在线** | 改文档 | `Docs/design-2026-11-01-workbuddy-accounts.md` 增补一节（由账号域后续卡执行） |
| WorkBuddy 增加「从客户端时间戳备份只读枚举历史账号」的导入通道（替代/补充进程内存扫描），并把 `connector-keys` 的 uid 派生前缀作为账号存在性提示 | 改代码 | 新卡（账号域，需只读 + vault 复用） |
| `minimaxDesktopProvider` 支持候选 exe 路径（`D:\Program Files\MiniMax Code\MiniMax Code.exe` 等）并把「安装目录名≠产品名」写成显式 reason_code，避免误报 `CLIENT_NOT_INSTALLED` | 改代码 | 新卡（ACC-13 续） |
| TRAE 保持"不做文件级切换"，补「只读识别当前账号（用户 id/租户）」到界面，明确提示需用户手动切换 | 改代码 + 改文档 | 新卡（账号域） |
| UI 增加风险提示：切换会重启客户端、可能触发产品设备会话/风控、且需要用户确认无未保存内容 | 改代码（前端文案） | 与账号域 UI 卡合并 |
| 不做：多实例并行、token 长期缓存替代客户端登录、按文件哈希判身份 | 保持现状 | — |

---

## 7. 未证实 / 未验证清单

- WorkBuddy 官方是否宣传/支持多账号：官方站点正文未抓取到（SPA），**未证实**。
- MiniMax Code 官方是否支持多账号并存/账号切换入口：文档无相关页，**未证实**。
- 三产品的服务端设备会话策略（除 TRAE 官方 10 台上限外）：**未证实**。
- WorkBuddy `connector-keys` 中 `dae15da8` 前缀对应哪个历史账号：**未定位**（需用户演示第二账号时对照）。
- TRAE `state.vscdb` 中两个数字用户 id 与具体账号/时间的对应关系：**未定位**（用户级键残留，未解密任何值）。
- MiniMax 桌面端与 CLI 是否会同时持有不同登录态：桌面端当前未运行，**未实测**。
- 本调研未读取任何 token/信封/vault 内容；未运行签到/登录；未启停客户端；未改客户端文件。
