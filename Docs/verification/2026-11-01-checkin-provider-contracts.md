# 多产品签到契约核查

- 日期：2026-11-01
- 任务：ACC-03（ca042e61-d2f5-4529-b525-df65c883b872）
- 结论：两个产品的真实授权/签到 gate=unverified；不得启用 ACC-07 的真实授权或签到 provider。
- 原始材料：[workbuddy-helper 固定提交](https://github.com/autumnsentiment/workbuddy-helper/tree/11808853e53ae195a329182f5655baa1783de64c)，不等同于已证明的 v1.0.8 release。
- 仅读取公开源码；未复制代码、读取账号、发起授权或签到请求。

## 逐产品矩阵

| 契约 | WorkBuddy 国内版 | CodeBuddy 国内版 |
|---|---|---|
| 产品/区域身份 | unverified；需授权响应证明 app/region/UID | unverified；用户目标 CLI 或 IDE 尚待确认 |
| 浏览器授权 | 候选：helper `LoginSession.Start` 请求 auth state，校验返回授权 URL 后浏览器授权；目标版本未实测 | 不能以同一 helper 通用 Account 参数证明 CodeBuddy CLI/IDE 对应的 OAuth platform |
| callback/poll | helper 有登录 session 协议；目标提供方的绑定与过期规则未实测 | unverified；不得复用 WorkBuddy session/state |
| stable UID | 需从受验证授权结果取得并与产品/区域匹配 | unverified；不同客户端相同 UID 不自动关联凭据 |
| 签到请求 | 静态候选：POST `/v2/billing/meter/daily-checkin`，JSON `{}`，按账号配置 origin/base/auth header | helper 通用请求存在不等于此产品/版本已验证 |
| 权威签到状态查询 | 已查 Checkin 函数主要使用本地 LastCheckinDate；未获得可作为官方完成状态的查询证据 | unverified |
| 服务日 | helper 使用 Asia/Shanghai 本地日期；未证明平台官方服务日 | unverified |
| 成功/已签到分类 | helper 以业务码 14001/10001 及消息片段判断；未用平台原始响应验证码的唯一含义 | unverified；不跨产品照抄判断 |
| 限流/失效/超时 | 需分别验证；请求发送后无明确响应只能 unknown | unverified |
| 独立签到凭据 | 未授权，不从桌面快照提取 | 未授权，不从 CLI/Desktop 任一未知配置提取 |

源码定位：[登录](https://github.com/autumnsentiment/workbuddy-helper/blob/11808853e53ae195a329182f5655baa1783de64c/internal/client/client.go#L798-L850)、[签到请求](https://github.com/autumnsentiment/workbuddy-helper/blob/11808853e53ae195a329182f5655baa1783de64c/internal/client/client.go#L1036-L1060)、[本地日期/去重/结果判断](https://github.com/autumnsentiment/workbuddy-helper/blob/11808853e53ae195a329182f5655baa1783de64c/internal/service/service.go#L830-L900)、[串行批次](https://github.com/autumnsentiment/workbuddy-helper/blob/11808853e53ae195a329182f5655baa1783de64c/internal/service/service.go#L1060-L1102)。helper 的 auth-dead 刷新后重试不能替代本项目“结果未知不重发”要求；本项目不能仅按宽泛的 already 消息片段判定成功。

## 执行门禁

- authorizationRejectsProductRegionUidMismatch：三元组任一维未证实，不保存或关联签到凭据。
- unknownCheckinOutcomeIsNotRetried：已发出请求但结果未知，保持 unknown；无可靠状态证明不得再次提交。
- unknownServiceDayDoesNotClaimOfficialDay：本地日期不能显示为官方服务日，不能作为全天去重的唯一依据。
- 国际版“活跃聊天”不属于本项目签到范围，不为获得奖励触发额外模型请求。

以上用例为尚待产品契约验证的门禁，未执行真实接口测试。没有批准的测试账号与独立签到授权；本轮不模拟“接口已验证”的成功结果。

## 解除阻塞材料

- 明确 CodeBuddy 目标为 CLI 或 IDE、各产品区域与目标版本。
- 用户批准的测试账号官方浏览器授权场景；令牌仅进入私有加密存储，不进入报告。
- 原始响应的安全分类、服务端日期与可靠状态查询证据。
- 每个产品分别完成一次明确成功/已签到及失败/限流/超时结果分类；真实签到须单独明确授权，不重复领奖。

# 2026-11-01 授权验证（kb-cli 续做）

- 授权口径：测试账号=本机当前登录态；WorkBuddy 授权流观测 1 次、CodeBuddy 只读形态核查；真实签到仅当只读状态查询明确「今日未签到」时每产品最多 1 次。本轮状态查询均无可执行凭据，未发任何签到请求。
- 实际网络请求共 3 次（均匿名、无凭据）：`POST /v2/plugin/auth/state` ×2（第一次取信封与 pending 分类，第二次补采 authUrl 形状——首次输出管道漏存 URL 结构，如实计入）+ `GET /v2/plugin/auth/token` ×1。无授权完成、无签到、无重试。
- 掩敏规则：uid/token/state/URL 值只记 sha256 前 8 位或长度；不记原始响应体。
- 本机环境：WorkBuddy Desktop 5.9.3（`D:\Program Files\WorkBuddy\WorkBuddy.exe`，5 进程运行中）；CodeBuddy CLI 2.170.0（npm `@tencent-ai/codebuddy-code`，`D:\tools\bin\codebuddy.exe`）；无 127.0.0.1 CDP 调试端口（9222/9223/9229/9333/5858 均无响应）。

## WorkBuddy 国内版 CheckinProviderSpec

| 字段 | 判定 | 证据 | 复现 |
|---|---|---|---|
| app_id/产品身份 | supported（本机客户端）；授权响应侧 unverified | 本机在装在跑的 WorkBuddy Desktop 5.9.3；auth 文件名 `workbuddy-desktop.info`（`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth`）；asar 前门域名含 `www.workbuddy.cn`。AgentBoard app_id 提案 `workbuddy_desktop` | 列 auth 根目录文件名；`grep -aob "www.workbuddy.cn" app.asar`（偏移 5976314 附近为 failover 表） |
| region | unverified | 无服务端区域响应；旁证：auth `domain` 由 `www.codebuddy.cn`（2026-05/08 快照）迁移为 `www.workbuddy.cn`（当前），scope `openid profile offline_access email`，loginChannels `["openplatform"]` | 读各 `.info` 快照的 `auth.domain`（值可明文，非凭据） |
| authorization_url/protocol | supported（2026-11-01 14:08 UTC 实测） | `POST https://copilot.tencent.com/v2/plugin/auth/state?platform=CLI`，body `{}`，Origin `www.codebuddy.cn` → 200 `{code:0,msg:"OK",data:{state,authUrl}}`；state 36 字符（sha256:3e627626）；authUrl 89 字符（sha256:d7657d99）=`https://copilot.tencent.com/login?platform=CLI&state=<36c>`。浏览器内登录/授权=用户手工步骤 → unverified，未等待 | 同参数 curl/node fetch 一次；掩码记录 code/state 长度/authUrl 形状 |
| callback/poll | pending 分类 supported（实测）；token 交付 unverified | `GET /v2/plugin/auth/token?state=<36c>` → 200 `{code:11217,msg:"login ing...",requestId}`（pending 实证，与 helper 一致）。token 响应字段 accessToken/refreshToken/expiresIn/domain 仅 helper 静态。桌面路由表：`login.state.create` POST `/v2/*/auth/state` replayClass=forbidden、commitPoint=request-body、deadline 8s、attempts≤2；`login.token.poll` GET `/v2/*/auth/token` replayClass=safe、deadline 3s（asar 偏移 3675434） | poll 一次记录 envelope；asar `grep -aob "login.state.create" app.asar` |
| stable UID 来源 | supported（本地）；授权响应侧 unverified | `account.uid`（UUID）于 `workbuddy-desktop.info`；同一 uid（sha256:f5d89346）跨 2026-05-06/08-27/11-01 三快照稳定，且跨域名迁移保持；桌面 `status()` 以 `accountProvider().uid` 判定 authenticated。授权响应是否返回同一 uid 未验证 | 对比 4 个 `.info` 快照 uid 哈希（勿记原值） |
| 状态查询（已签/未签/服务日） | unverified（端点 attested，未执行） | 桌面 5.9.3 asar：`POST {billingPrefix=/v2}/billing/meter/checkin-activity-status` body `{}` → data 含 `active,today_checked_in,streak_days,daily_credit,today_credit,is_streak_day,next_streak_day,streak_bonus_days,streak_bonus_credit,checkin_dates[],total_credits,start_time,end_time,theme_name,season,activity_name`；另有简式 `POST /billing/meter/checkin-status`。无可用签到凭据（桌面 token 为 `$wbEncrypted` 设备加密信封，按设计不从快照提取）→ 未执行 | asar 偏移 3029454（checkinStatus）、3008779（getCheckinStatus）；取得独立凭据后 POST 一次记录 data 键集 |
| 服务日边界 | unknown（不得标 official-day） | 无服务端日界证据。helper 用 `Asia/Shanghai` 固定 +8 本地日做全天去重（helper 实现非平台契约）；桌面响应含 `checkin_dates[]/start_time/end_time` 服务端字段但未观测 | 无；待状态查询样例后评估 |
| 签到请求 endpoint/body | supported（静态双源一致）；header 全集 unverified | 桌面与 helper 一致：`POST /v2/billing/meter/daily-checkin` body `{}`，成功 `code==0`。CN billing origin：helper=`https://www.codebuddy.cn`；桌面前门 failover=`www.workbuddy.cn`/`copilot.tencent.com`（备 `wb.tencentbuddy.com`）。headers：helper 侧 Bearer+`X-User-Id/X-Enterprise-Id/X-Tenant-Id/X-Domain/X-Product:SaaS/x-codebuddy-request:1`；桌面侧另加 `X-Device-Token`（Turing 设备令牌，asar `getCheckinRequestHeaders`） | asar 偏移 3009042、3037050；helper client.go L1036-1060 |
| 结果分类器 | pending=11217 supported（实测）；成功/已签/限流 unverified（双源码表冲突） | 桌面 5.9.3 `mapCheckinStatus`：0=Claimed、1001=AlreadyClaimed、1002=NotEligible、1003=EventEnded、其余 UnknownBizError；helper：14001/10001 或消息含「已签到/already/今日已」判 already，KindAuthDead→needs_login、KindCredit→credits_exhausted、KindRate→rate_limited。两套码表不一致→平台原始码表未验证，不得互抄 | asar 偏移 3023742；helper service.go（isAlreadyMessage/markError） |
| 幂等/重试证据 | unverified | 签到请求无幂等令牌证据；桌面仅对 auth 路由定义重放分类（state create 提交后 forbidden）；helper 的 auth-dead 刷新后重试属 helper 行为，违反本项目「结果未知不重发」，不采纳 | 无 |
| 独立签到凭据 | 未取得 | 授权流程止步于 pending（用户手工步骤未做、未等待）；桌面 token 设备加密不可提取（符合设计：不从 Desktop 快照提取） | 用户手工步骤见 gate 解除条件 |

## CodeBuddy CheckinProviderSpec（本机唯一形态=CLI 2.170.0）

| 字段 | 判定 | 证据 | 复现 |
|---|---|---|---|
| app_id/产品形态 | CLI supported；IDE/Desktop unverified（未安装） | CLI 2.170.0 双入口（npm shim + `D:\tools\bin\codebuddy.exe`）；无 CodeBuddy Desktop/IDE 安装证据；目标形态仍未官方确认 | `codebuddy --version`；`where codebuddy` |
| region | unverified | CLI local_storage entry 含 `"internal"` 标记（10 字节文件）；无服务端区域响应 | 读 `~/.codebuddy/local_storage/entry_3bab4ce6*.info` |
| 当前登录态（非签到凭据） | supported | `~/.codebuddy/settings.json` `env.CODEBUDDY_AUTH_TOKEN`（custom-token/env 模式；auth source 优先级 env→apiKeyHelper→OAuth）；API base `https://copilot.tencent.com`（entry_933d5543 + 当日日志大量 `/v2/chat/completions`）→ 该 token 当日有效 | 读 settings.json 键名（值掩码）；`grep -rhoi "copilot.tencent.com/v2/[a-z/-]*" ~/.codebuddy/logs/2026-11-01` |
| authorization_url/protocol | 静态形状 supported；动态 unverified（未发起） | CLI bundle：`POST /v2{prefixPath}/auth/state?platform={platform}`（prefixPath/platform 由 `authentication.attributes` 配置驱动，值未取得）→ `data.data.authUrl`（经 `alignAuthUrlToApiOrigin` 对齐）；`GET /v2{prefixPath}/auth/token?state=` 轮询。本机登录为 env token 非 OAuth，CodeBuddy 专属 platform 值无 attestation → 不按未证实形状发请求 | bundle 偏移 18125330/18120743（`dist/codebuddy.js`）；用户需在 CLI 官方入口完成一次浏览器登录后观测 |
| callback/poll | unverified | 同协议家族（超时 5s、轮询等待循环），未实测 | 同上 |
| stable UID | supported（本地）；跨产品绑定 forbidden | CLI local_storage `entry_d43e9696*.info` 账号数组含 `userId`（与 WorkBuddy Desktop `account.uid` 同值，sha256:f5d89346）→ 同一底层账号两产品同 uid，uid 字符串相等不构成凭据关联依据 | 对比两存储 uid 哈希 |
| 状态查询 | unsupported（CLI 无签到面） | CLI 2.170.0 bundle 无任何 billing/checkin 端点（"checkin" 命中均为 utf8/关键字表误命中）；WorkBuddy 桌面的 checkin-activity-status 属其产品契约，禁止套用 | bundle grep `daily-checkin`/`checkin-status`（0 真命中） |
| 签到请求/分类器/重试/服务日 | unverified | 无 CodeBuddy 侧签到端点 attestation；helper CN billing（www.codebuddy.cn）是 helper 的 CN 账号路径，对 CodeBuddy 产品未验证 | 无 |

## 跨产品身份证据（三元组门禁的直接依据）

- 同一 uid（sha256:f5d89346）同时出现于 WorkBuddy Desktop auth（domain=www.workbuddy.cn）与 CodeBuddy CLI 存储（base=copilot.tencent.com，env token）。仅 uid 相等、产品与域名/凭据形态均不同 → 任何凭据关联必须拒绝。
- WorkBuddy Desktop 2026-05→08 快照 auth.domain=www.codebuddy.cn、当前=www.workbuddy.cn：产品域名迁移期，domain 字段不可单独当 region。

## 契约用例断言与数据形状

1. `authorizationRejectsProductRegionUidMismatch`：输入 `{app_id, region, uid_hash, credential:{uid_hash, domain, platform}}`，任一维不等 → 拒绝写 `checkin_credential_ref`。观测数据形状：`{workbuddy_desktop, region:unknown, uid_hash:f5d89346, domain:www.workbuddy.cn}` vs `{codebuddy_cli, region:internal?, uid_hash:f5d89346, base:copilot.tencent.com, credential_kind:env-custom-token}` → uid 相等仍必须拒绝。执行侧未实现（ACC-07 范围），门禁维持。
2. `unknownCheckinOutcomeIsNotRetried`：发出后超时/中断 → `state=unknown`、`attempts==1`、不自动重发；仅已验证状态查询证明未完成才允许再发。本轮签到 attempts=0（未发），断言未被违反；平台侧旁证：桌面路由表将 auth/state 提交点后标记 forbidden 重放。
3. `unknownServiceDayDoesNotClaimOfficialDay`：无服务端日期边界证据 → `service_day=unknown`，UI 不得显示 official-day；本地时区日不得作全天去重唯一依据。本轮两产品服务日均 unknown（helper 的 Asia/Shanghai 仅 helper 实现；本机北京时间不采信）。

## ACC-07 gate 结论

- **两产品均 BLOCKED，不启用真实授权/签到入口。**
- WorkBuddy：已过=授权会话协议实测（state/authUrl/pending 11217）、UID 本地稳定证据；未过=授权未完成 → 无独立签到凭据 → 状态查询未执行 → 产品/区域/UID 三元组无授权响应侧匹配证据。解除条件：用户在浏览器打开 authUrl（`https://copilot.tencent.com/login?platform=CLI&state=...`）手工完成授权 → poll 取 token → `GET /v2/plugin/login/account` 比对 uid==f5d89346 且 domain/platform 符合 WorkBuddy → 用该独立凭据执行一次 checkin-activity-status，记录 today_checked_in/checkin_dates 样例 → 补一次明确结果分类（成功或已签）。
- CodeBuddy：已过=CLI 形态/版本/当前凭据形态/base；未过=无 CodeBuddy 浏览器授权观测（prefixPath/platform 值未知）、无签到端点 attestation、无独立签到凭据。解除条件：官方确认目标形态（CLI/IDE）→ 在该形态官方入口完成一次浏览器授权并记录 platform/prefixPath/authUrl → 确认其官方签到资格与端点 → 状态查询与分类样例。

## 违规自检

- 未存任何凭据/token/cookie/原始响应体（仅 sha256 前 8 位、字段名、长度）。
- 签到请求 0 次；无超时；无重试。授权流止于 pending，未等待用户手工步骤。
- 未改客户端/浏览器数据与系统配置；未读浏览器 cookie 库。
- 服务日无 official-day 声明；本机时间未用于判定服务日。
