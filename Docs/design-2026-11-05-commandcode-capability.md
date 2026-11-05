# Command Code 能力调研与落位评估（ACC-CC-1）

日期：2026-11-05
卡：`a57f182c-320e-4cc4-9d2f-69ac930d6487`
性质：调研卡，只读探测 + 文档产出，不含任何实现改动。

## 0. 一句话结论

Command Code 是一个**终端型 AI 编码 agent CLI**（官方发行方 Command Code，npm 包 `command-code`，命令 `cmd` / Windows 原生别名 `cmdc`），凭据落在 `~/.commandcode/auth.json`，没有签到语义；在账号模型上它属于**CLI 来源（`CliAccountAppId`）**，不属于六平台桌面客户端（`ManagedAppId`）。本机当前**未安装**（无二进制、无 `auth.json`、注册表无卸载项），因此「读取本机 / 切换」只能给出**有条件支持 + 待实测**，不能当已验证结论。

---

## 1. 它到底是什么（问题 1）

| 项 | 事实 | 证据 |
| --- | --- | --- |
| 官方名称 | Command Code（显示名有时写作 "Command Code"，包名/命令是 `command-code`） | 官网 <https://commandcode.ai/>；文档 <https://commandcode.ai/docs/quickstart> |
| 形态 | 终端编码 agent（"lives in your terminal"）；另有 **Desktop 图形客户端（beta）** | <https://commandcode.ai/>；<https://commandcode.ai/desktop>；<https://commandcode.ai/docs/desktop> |
| 安装方式（CLI） | `npm i -g command-code@latest`，要求 Node.js 22+；全局命令 `command-code`，短别名 `cmd`（**Windows 原生别名 `cmdc`**，因为 `cmd` 是系统 shell） | <https://commandcode.ai/docs/quickstart>；<https://commandcode.ai/docs/reference/cli> |
| 安装方式（桌面） | 官方 install.ps1 / install.sh 拉 GitHub Release；Windows 候选路径 `%LOCALAPPDATA%\Programs\Command Code\Command Code.exe`、`%LOCALAPPDATA%\Programs\command-code\Command Code.exe`、`%ProgramFiles%\Command Code\Command Code.exe` | <https://github.com/CommandCodeAI/desktop>；install.ps1 原文（同上仓库 `main/install.ps1`） |
| 发行方仓库 | 桌面端公开仓库 `CommandCodeAI/desktop`（仅下载/安装/文档/issue，应用私有）；CLI 源码未公开 | <https://github.com/CommandCodeAI/desktop>（仓库说明 "Application development happens in a private repository"） |
| 与现有六平台关系 | **无关**，不是任何现有平台的别名，也不是 CodeBuddy | 仓库内 `apps/server/src/services/accounts/registry.ts:25-36` 六值；`packages/shared/src/types.ts:46` `ManagedAppId` 六值；`accountCapabilities.ts:33-40` 元信息表均无该值 |

补充事实（对落位有影响）：

- 官方有 **Provider API**（`/provider/v1/chat/completions`、`/provider/v1/messages`、`/provider/v1/models`），同一把 Studio API key 可用：<https://commandcode.ai/docs/studio>、<https://commandcode.ai/blog/introducing-the-command-code-provider-api>。
- 计费是**订阅 + 月度 credits + 滚动 5 小时/周窗口 + 充值额度**：<https://commandcode.ai/docs/resources/pricing-limits>、<https://commandcode.ai/pricing>。
- 有组织（Organization）概念，可在 Studio 内切换组织，但**没有文档化的多账号本地 profile**：<https://commandcode.ai/docs/studio>。

---

## 2. 本机只读实测（Windows，`C:\Users\31633`）

全部为只读探测，未安装、未下载、未读取任何凭据内容。

### 2.1 命令与路径探测

```
== Get-Command ==
MISS commandcode / command-code / commandcode-cli / ccode

== Test-Path（安装目录候选）==
C:\Users\31633\AppData\Local\Programs\CommandCode            -> False
C:\Users\31633\AppData\Local\Programs\Command Code           -> False   (待实测候选，见 install.ps1)
C:\Users\31633\AppData\Local\Programs\command-code           -> False
C:\Program Files\Command Code                                -> False
C:\Users\31633\AppData\Local\CommandCode                     -> False
C:\Users\31633\AppData\Roaming\CommandCode                   -> False

== npm 全局（%APPDATA%\npm）==
cmdc / cmdc.cmd / cmdc.ps1                     -> False
command-code / command-code.cmd / .ps1         -> False
node_modules\command-code                      -> False
npm ls -g --depth=0 的包列表                   -> 无 command-code
pnpm 全局 bin（%LOCALAPPDATA%\pnpm\bin）        -> 空

== 注册表 Uninstall（HKLM x64 / HKLM WOW6432Node / HKCU）==
按 DisplayName 匹配 command[-_ ]?code         -> 0 命中
```

结论：**CLI 与桌面端均未安装**。

### 2.2 唯一命中的目录：`C:\Users\31633\.commandcode`

```
d-----  skills
-a----  532  mcp.json
-a----  458  mcp.json.rea.backup
skills\handoff\SKILL.md + 11 个 .bak-* + test-prompts.json
auth.json -> False
settings.json -> False
projects\ -> False
```

判定**不能**据此认为「Command Code 装过或登录过」：

- `~/.commandcode` 是公开文档规定的配置根（`~/.commandcode/skills/`、`~/.commandcode/settings.json`、`mcp.json`）：<https://commandcode.ai/docs/skills>、<https://commandcode.ai/docs/resources/security>。
- 本机该目录里 `mcp.json` 只有一个 server 名 `rea`，并有 `mcp.json.rea.backup`；全局 npm 装有 `rea-agents`，其 `dist/application/SupportedClients.js:176` 定义 `commandCodeDirectory = join(home, ".commandcode")`、`:341-346` 把 Command Code 视为 `mcp.json` 型客户端，`rea` 注册时会写这个文件。即：**目录是别的工具（REA）注册 MCP 时创建的**，不代表本机有 Command Code。
- `skills/handoff/*` 是 AgentBoard `handoff` 技能的副本（含 `bak-darwin-*` 备份），属技能同步产物。
- 真正能证明「已安装」的信号是 `auth.json`、`settings.json`、`projects/` 或二进制；一个都没有。

---

## 3. 凭据形态与本地落点（问题 2）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 形态 | **Studio 生成的 API key（用户自持）**，或 `cmd login` 的浏览器 OAuth；两者最终都落本地 | <https://commandcode.ai/docs/quickstart>（"API key stored in ~/.commandcode/auth.json"）；<https://commandcode.ai/docs/studio>（API keys 页面） |
| 落点（官方口径） | `~/.commandcode/auth.json`；对话历史 `~/.commandcode/projects/`；taste `~/.commandcode/taste/`（项目内 `.commandcode/taste/`） | <https://commandcode.ai/docs/resources/security> 的 "Your data" 表 |
| Windows 实际路径 | `C:\Users\<u>\.commandcode\auth.json`（home 相对，官方路径写法跨平台一致；**本机实测不存在**） | 同上 + 2.1/2.2 实测 |
| macOS 实际路径 | `~/.commandcode/auth.json`（同一 home 相对口径；**未在 macOS 实测**，属推断，见 §8） | <https://commandcode.ai/docs/resources/security> |
| 是否加密 | **未确认**。官方只说"local only / never sent to third party"，未声明 DPAPI / Keychain / safeStorage；第三方研究称文件 `mode 0600`（POSIX 权限，Windows 无等价保护） | <https://commandcode.ai/docs/resources/security>；二手：<https://raw.githubusercontent.com/lczpln/command-go-pool/HEAD/docs/research.md> |
| 环境变量旁路 | `COMMAND_CODE_API_KEY` 可完全跳过 `cmd login`（CI/无浏览器场景） | <https://commandcode.ai/docs/quickstart>；<https://commandcode.ai/docs/headless#authentication> |
| 登出 | `cmd logout` 删除已存认证；`cmd status` / `cmd status --json` 输出认证状态；`cmd whoami` 输出当前用户 | <https://commandcode.ai/docs/reference/cli> |

`auth.json` 内部字段（`accessToken` / `refreshToken` / `user` / `expiresAt` 等）**未找到官方字段说明**；不读本机真实凭据（本机也没有），因此 schema 属未知项。

---

## 4. 能力矩阵（问题 3）

判定口径沿用仓库现约定：`supported` = 有可落地的读写+校验路径；`unsupported` = 产品根本没有该语义；`unknown` = 语义存在但当前无证据闭环（并给出原因码建议）。

| 维度 | 判定 | 依据 | 备注 / 原因码建议 |
| --- | --- | --- | --- |
| **读取本机（capture）** | **有条件支持（本机未实测 → 记为 unknown）** | `auth.json` 位于固定 home 路径、身份可经 `cmd status --json` / `cmd whoami` 读回（官方 CLI 参考）；`packages/shared/src/types.ts:66` 的 CLI 来源已有同构先例（`deepseek`/`opencode_go` 均读本地文件） | 先决条件：本机有 `auth.json`。原因码建议 `AUTH_FILE_MISSING`（无文件）/ `AUTH_SCHEMA_UNSUPPORTED`（字段不符）/ `CLI_NOT_INSTALLED`（无二进制） |
| **手动导入凭据** | **支持（待实测写入）** | `cmd login` 支持"粘贴 API key"；CI 用 `COMMAND_CODE_API_KEY`（<https://commandcode.ai/docs/quickstart>） | 若走"写 `auth.json`"而非调 `cmd login`，需先拿到 schema；只读导入（解析现成 `auth.json`）风险最低 |
| **签到（checkin）** | **不支持** | 官方 CLI 子命令清单与文档中没有签到/每日奖励；计费只有月度 credits + 5h/周滚动窗口 + 充值（<https://commandcode.ai/docs/reference/cli>、<https://commandcode.ai/docs/resources/pricing-limits>） | 原因码建议 `CHECKIN_NOT_APPLICABLE`（该来源无签到语义，与 `codex` 同类处理） |
| **切换账号（switch）** | **有条件支持（本机未实测 → 记为 unknown）** | 单文件凭据 + `cmd status --json` 可读回校验；`cmd logout` 可清空。无多 profile 机制，切换=换 `auth.json` 内容 | 风险：OAuth 令牌可能含 refresh token / 设备态，写入后需 `cmd status --json` 校验；失败回滚靠文件快照 + 回滚校验（沿用 `cliSwitch.ts:172-204`、`:306-318` 的既有红线）。原因码建议 `AUTH_WRITE_UNVERIFIED`、`AUTH_VERIFY_FAILED` |
| **额度 / 余额接口** | **部分支持（接口未文档化 → unknown）** | Studio 有实时 Usage 页与 credits/billing（<https://commandcode.ai/docs/studio>）；CLI 内 `/usage` 为交互式；公开 Provider API 只列 chat/messages/models，无余额端点（<https://commandcode.ai/blog/introducing-the-command-code-provider-api>） | 二手研究称存在 `GET /alpha/whoami`、`GET /alpha/billing/credits`、`GET /alpha/billing/subscriptions`（未官方文档化，属 CLI 私有 API，随时可能变）：<https://raw.githubusercontent.com/lczpln/command-go-pool/HEAD/docs/research.md>。原因码建议 `QUOTA_API_UNDOCUMENTED` |

> 说明：`checkin=不支持` 是**硬结论**（产品无此功能）；`capture/switch` 是**能力像支持但本机无法实测**，不得写成 supported 交付。

---

## 5. 与现有平台对照（问题 4）

### 5.1 现有六平台（`ManagedAppId`，桌面客户端线）

来源：`apps/server/src/services/accounts/registry.ts:25-36`（静态能力表）、`accountCapabilities.ts:52-61`（UI 栏位）、公共知识 `knowledge:9733aae8-111d-4589-a2ec-b118b070d2bc`、`knowledge:3c21b76c-ffb4-49c4-b496-fc7b8224a119`。

| app_id | capture | switch | checkin | 上线状态 |
| --- | --- | --- | --- | --- |
| `workbuddy_desktop` | ✔ | ✔ | ✔ | 在用 |
| `codebuddy_desktop` | ✘ | ✘ | ✘ | 已下线（UI 过滤，`accountCapabilities.ts:61`） |
| `minimax` | ✔（按客户端探测） | ✘（进程控制未装配） | ✔ | 在用 |
| `trae` | ✔（有 `storage.json` 才开） | ✘ | ✔ | 在用 |
| `qoder_cn` | ✘ | ✘ | ✘ | 仅登记 id（`PROVIDER_NOT_IMPLEMENTED`） |
| `zcode` | ✘ | ✘ | ✘ | 仅登记 id（`PROVIDER_NOT_IMPLEMENTED`） |

### 5.2 CLI 三来源（`CliAccountAppId`，额度/凭据线）

来源：`packages/shared/src/types.ts:66`、`cliAccounts.ts:27-84`、`cliSwitch.ts:37-46`。

| app_id | 本机发现（capture） | 手动导入 | switch | checkin |
| --- | --- | --- | --- | --- |
| `deepseek` | ✔（env / `~/.deepseek/config.toml` / `~/.dsh/.credentials.yaml`，按 key 去重） | ✔ | ✔ | 不适用 |
| `opencode_go` | ✔（`~/.local/share/opencode/auth.json` 单槽，最多 1） | ✔ | ✔ | 不适用 |
| `codex` | ✘（无可枚举凭据） | 仅额度 | ✘（OAuth 写回未验证） | 不适用 |

### 5.3 横向结论

| 判断 | Command Code 的归属 |
| --- | --- |
| 是桌面客户端吗？ | 有 Desktop（beta），但**当前无公开的配置/登录落点文档**，且 agent runtime 内建、与 CLI 同源；不能按 WorkBuddy/MiniMax 那套「杀进程 → 改登录文件 → 冷启动校验」建模 |
| 是 CLI 来源吗？ | **是**。单文件 `auth.json`、home 相对路径、命令可查身份、无签到、额度靠订阅 credits —— 与 `deepseek` / `opencode_go` 同构 |
| 需要新表吗？ | **不需要**。`cli_account` 表按 `(app_id, identity_hash)` 幂等登记（`cliAccounts.ts:117-128`），新增 `app_id` 值即可 |
| 需要新 app_id 吗？ | **需要 1 个**：`CliAccountAppId` 加 `'commandcode'`；**不要**加进 `ManagedAppId` |

---

## 6. 落位建议（问题 5）

**结论：可以接入，但只做「CLI 来源」三件事 —— 读取本机凭据登记、手动导入、切换（先 dry-run）**；不做签到，额度是否接入取决于私有接口实测。

### 6.1 枚举与模型

- `packages/shared/src/types.ts:66`：`CliAccountAppId` 增 `'commandcode'`。
- 不改 `ManagedAppId`（`types.ts:46`）、不改 `account_operation.app_id` 的约束（桌面线语义）。
- 复用 `cli_account` 表；身份 = `sha256(app_id + NUL + key)`（`cliAccounts.ts:48-50`），同一 key 多处出现只算 1 个账号。

### 6.2 需要动的点（仅列位置，不在本卡实现）

| 能力 | 落点 | 工作量 |
| --- | --- | --- |
| 本机发现 | `cliAccounts.ts` 增 `readCommandCodeAuth(homeDir)` → 解析 `~/.commandcode/auth.json`，产出 candidate；`discoverCliCredentials` 加一行 | 小（需先拿到 schema） |
| 手动导入 | 复用现有 `importCliCredential`（vault purpose `cli_credential`） | 小 |
| 切换 | `cliSwitch.ts` 增 `CliTargetFile` 映射（`~/.commandcode/auth.json`），能力表加 `{ app_id: 'commandcode', switch: true/false, reason_code }`；先 dry-run + 读回校验，失败回滚 | 中（关键在写回后 `cmd status --json` 可验证） |
| 额度 | 若接 `/alpha/billing/credits`：新增 quota 来源 + 空态（复用 ACC-B6 四种形态，`QuotaDetail` 的 `credit` 形态可直接兜住） | 中（依赖未文档化接口，需实测） |
| 文案 | `accountCapabilities.ts` 的 `REASON_LABEL` 增 `AUTH_FILE_MISSING` / `AUTH_SCHEMA_UNSUPPORTED` / `CHECKIN_NOT_APPLICABLE` / `AUTH_WRITE_UNVERIFIED` | 小 |

### 6.3 UI 落点

落**「CLI 来源 / 额度来源」区**（与 `deepseek` / `opencode_go` / `codex` 同栏，`QuotaCards.tsx` 的 `quota-row-*` 体系），**不要**塞进 `APP_ORDER`（`accountCapabilities.ts:52` 三栏只放桌面三平台）。

---

## 7. 已知 / 未知分界（问题 5 的验收要求）

| 已确认（有证据） | 未确认（需什么条件才能确认） |
| --- | --- |
| 产品身份、包名/命令、Windows 别名 `cmdc`、Node 22+（官网文档） | 本机是否安装：需用户自行安装后复跑 `Get-Command cmdc` |
| `auth.json` 路径、`mcp.json`/`skills`/`settings.json` 配置根（官网文档 + 本机目录结构） | `auth.json` 字段 schema 与是否加密：需装/登录后**只看字段名与文件属性**（不读令牌值） |
| 登录方式（浏览器 OAuth / 粘贴 API key）、登出、`status --json` / `whoami` | 写回 `auth.json` 是否等价于有效登录态：需一次「A 号 → B 号 → `cmd status --json` 校验」实测 |
| 无签到语义；计费=订阅 credits + 5h/周窗口（官网） | 余额接口是否可调用：需真实 key 实测 `/alpha/billing/credits`，或等官方文档化 |
| 桌面端存在且为 beta、Windows 安装候选路径（公开 install.ps1） | 桌面端与 CLI 是否共用同一 `auth.json`：需安装桌面端后比对路径（官方未写） |
| macOS 路径推断为 `~/.commandcode/auth.json`（home 相对） | macOS 实测（本机为 Windows，无法验证） |

---

## 8. 后续卡拆分建议（由主代理决定，本卡不建实现卡）

1. **ACC-CC-2｜Command Code 落地实测取证**（前置 CC-1）：在一台装了 CLI 的机器上，只读确认 `auth.json` 字段名、文件权限/是否 DPAPI，跑 `cmd status --json`、`cmd whoami`，实测 `/alpha/billing/credits` 是否 200；产出取证文档。
2. **ACC-CC-3｜CLI 来源接入：枚举 + 本机发现 + 手动导入**（依赖 CC-2 的 schema）：`CliAccountAppId` 加值、`cliAccounts.ts` 发现分支、vault 导入、单测。
3. **ACC-CC-4｜CLI 来源切换（dry-run → apply + 读回校验）**（依赖 CC-2/CC-3）：`cliSwitch.ts` 映射与回滚，验收含「旧号切回」「文件缺失」「校验失败回滚」。
4. **ACC-CC-5｜额度展示（可选，先评估再开）**：仅当 CC-2 证明私有余额接口稳定才开；否则只做「订阅型来源无余额接口」的空态说明。

风险清单：私有 `/alpha/*` 接口无契约（随时改）；OAuth 设备态可能导致跨机/跨用户切换失败；桌面端 beta 可能另存账号，届时需重新判定是否升级为 `ManagedAppId`。

---

## 9. 证据索引

仓库文件：

- `apps/server/src/services/accounts/registry.ts:25-36`（六平台能力表）
- `packages/shared/src/types.ts:46`（`ManagedAppId`）、`:66`（`CliAccountAppId`）
- `apps/web/src/components/settings/accountCapabilities.ts:15`、`:33-40`、`:52-61`（UI 栏位与平台元信息）
- `apps/server/src/services/accounts/cliAccounts.ts:27-84`（CLI 发现/身份哈希）
- `apps/server/src/services/accounts/cliSwitch.ts:37-49`（能力表）、`:172-204`（快照/回滚）、`:306-318`（切换失败回滚）
- `C:\Users\31633\AppData\Roaming\npm\node_modules\rea-agents\dist\application\SupportedClients.js:176`、`:341-346`（`.commandcode` 目录由 REA 注册 MCP 写入的证据）

知识页（公共空间）：

- `knowledge:8bac607e-300a-47c8-83fd-eaa6f67bbf22` 五平台账号运维总览
- `knowledge:9733aae8-111d-4589-a2ec-b118b070d2bc` 五平台凭据落点与「加密」实质
- `knowledge:3c21b76c-ffb4-49c4-b496-fc7b8224a119` 五平台积分余额接口矩阵
- `knowledge:89c72721-f580-4427-b721-675408b29300` 五平台添加账号的协议与自动化程度

外部（官方优先）：

- <https://commandcode.ai/>（产品首页）
- <https://commandcode.ai/docs/quickstart>（安装、`cmd login`、`~/.commandcode/auth.json`、Windows `cmdc`）
- <https://commandcode.ai/docs/resources/security>（数据落点表、API key storage）
- <https://commandcode.ai/docs/reference/cli>（子命令：`status --json` / `whoami` / `login` / `logout`）
- <https://commandcode.ai/docs/studio>（Studio Usage、API keys、Organizations）
- <https://commandcode.ai/docs/resources/pricing-limits>（credits / 5h / 周窗口）
- <https://commandcode.ai/docs/skills>（`~/.commandcode/skills/` 与 `.agents/skills/`）
- <https://commandcode.ai/docs/desktop>、<https://commandcode.ai/desktop>（Desktop beta 存在）
- <https://github.com/CommandCodeAI/desktop>（install.ps1 / 安装候选路径）
- <https://raw.githubusercontent.com/lczpln/command-go-pool/HEAD/docs/research.md>（二手：`/alpha/billing/credits` 等私有接口；**非官方，仅作待验证线索**）
