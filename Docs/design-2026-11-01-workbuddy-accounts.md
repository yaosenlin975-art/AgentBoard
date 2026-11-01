# WorkBuddy / CodeBuddy 多账号签到与本机登录切换设计

- 日期：2026-11-01
- 状态：设计稿。用户已确认多账号批量签到、本机 WorkBuddy 与 CodeBuddy 登录账号切换，并排除 workbuddy2api；AgentBoard 内部接口、凭据路径与提供方能力均为提案或待验证。
- 范围：只设计 AgentBoard 本机功能。本轮不改产品代码、不运行签到或登录、不操作进程、不安装依赖、不做 Git 写入。

## 1. 需求分析

### 已确认需求

| 项 | 内容 |
|---|---|
| 账号操作 | 多个账号可批量签到。 |
| 本机客户端 | 分别切换 WorkBuddy 与 CodeBuddy 各自的登录账号。 |
| 排除项 | 不接入 workbuddy2api、代理账号池、账号轮换网关。 |

### 设计提案

- 在 AgentBoard 增加账号页面，分别管理 WorkBuddy Desktop 与 CodeBuddy Desktop。
- 用户先在对应官方客户端登录，再显式保存当前账号快照；切换必须指定目标账号。
- 签到凭据与本机客户端登录快照分开保存、分别授权。不能因为能读取桌面登录态就推断可以安全地对离线账号直接签到。
- 批量签到由用户手动启动，按单一产品/提供方范围串行处理启用账号，逐账号返回结果。
- 首版不自动签到、不自动切换账号、不执行国际版活跃聊天；未验证签到状态或服务日时明确显示缺口。
- WorkBuddy 与 CodeBuddy 使用独立 app adapter、安装实例和身份标识；AgentBoard 的 codebuddy CLI adapter 继续只表示 CLI 执行器，不与 CodeBuddy Desktop 共享账号状态。

### 成功标准

1. 用户能查看每个产品的本机当前账号和已保存账号快照。
2. 明确切换目标后，只有目标客户端当前身份核验成功才报告切换成功。
3. 切换失败时恢复原快照并核验原身份；恢复失败时冻结后续切换并显示恢复状态。
4. 批量签到逐账号串行执行；已确认完成的账号不重复请求；结果区分成功、已完成、失败和结果未知。
5. 凭据不出现在 SQLite 明文、REST 响应、浏览器状态、日志、错误文本或 Git 跟踪文件中。
6. WorkBuddy Desktop、CodeBuddy Desktop 与 CodeBuddy CLI 的进程、存储、身份和锁范围可分别验证。

### 专家补充动作、材料与验收

| 补充动作 | 原始材料 | 方法 / 产物 | 验收依据 |
|---|---|---|---|
| 分开识别客户端身份、安装实例、桌面登录快照和签到凭据 | AgentBoard 源码；两个客户端当前官方版本与本机文件契约 | 定义按产品与安装实例隔离的 adapter 契约 | 每个 adapter 仅读写其所属客户端；另一个产品及 CLI 状态不变 |
| 把签到做成可复核的操作状态机 | 固定版本的签到源码、接口响应和专用测试账号记录 | 串行批次、单账号结果和超时未知状态 | 同一服务日重复操作不重复领取；发送后超时不会盲目重发 |
| 保护本机活动会话和切换回滚 | AgentBoard session 状态；客户端进程与账号身份读取结果 | 对照进程身份、停止、备份、写入、重启、核验、恢复流程 | 运行中任务阻止切换；故障恢复后读取到原账号 |
| 核验服务日与每个客户端存储边界 | 官方客户端版本、现场观察、服务状态响应 | 在用户专用测试账号上验证签到状态与日期边界 | 每个产品和版本有可复现的成功、已完成、失败及结果未知样例 |

上表中的官方端点、安装目录、文件格式、活动进程、服务日与真实切换结果目前没有完成现场验证。

## 2. 当前 AgentBoard 与现有证据

AgentBoard 是 Windows 优先的本机 Web 服务，已有 Node / TypeScript、Express、SQLite、React 设置入口。现有数据以工作空间、任务、CLI 会话和消息为主；schema 中的核心 DDL 是 pinned contract，账号数据须通过新的幂等增量迁移增加表，不得修改既有工作空间、任务或会话表定义。[AgentBoard 设计](./设计文档.md#L1-L25) · [实施计划 pinned DDL](./实施计划.md#L24-L111) · [schema](../apps/server/src/db/schema.ts#L1-L43)

AgentBoard 的 CLI id 包含 codebuddy，但该 id 只代表无头 CLI 执行器。它不能说明 CodeBuddy Desktop 的认证文件、进程、登录状态或凭据与 CLI 相同。[CLI 与 adapter 契约](./设计文档.md#L65-L120) · [adapter registry](../packages/adapters/src/index.ts)

当前 AgentBoard 服务仅监听 127.0.0.1；本机单用户可沿用现有服务边界。新增凭据操作仍需同源检查和 CSRF 防护，API 只返回脱敏元数据。[服务入口](../apps/server/src/index.ts#L108-L119)

### WorkBuddy 本机实现的静态参考

本机另一个项目 WorkBuddy Switch 1.9.0（package.json 声明 MIT）包含 WorkBuddy 当前账号读取、加密账号快照、单进程操作锁、切换时停止客户端、校验账号身份、写入目标状态和失败恢复代码。[D:/WorkSpaces/LLM 看板/desktop/store.mjs#L166-L300] [D:/WorkSpaces/LLM 看板/desktop/store.mjs#L396-L465] [D:/WorkSpaces/LLM 看板/desktop/controller.mjs#L130-L255]

其 WorkBuddy 切换流程在本轮只按静态源码核对。已有实施计划仍把真实本机解密、登录状态和独立身份核验列为未验收；不能把源码存在当作真实切换验收通过。[D:/WorkSpaces/LLM 看板/Docs/2026-10-30-workbuddy-auth-compat-plan.md]

现有代码并未给出 CodeBuddy Desktop 的独立客户端 adapter 证据。WorkBuddy 与 CodeBuddy 的桌面账号切换均须有独立路径识别与身份验证；CodeBuddy 桌面端契约未确认前，不实现该 provider。

## 3. 方案选型

| 方案 | 版本 / 许可证 | 匹配与兼容性 | 移植成本、验证状态与结论 |
|---|---|---|---|
| **AgentBoard 原生模块（推荐）** | 复用现有 Node ≥20、Express、better-sqlite3 12.11.1、React；不新增运行服务 | 可把账号元数据、操作记录、设置 UI 与现有本地服务整合；DPAPI 需要 Windows 实现接口 | 需要各产品独立的客户端 adapter 和签到 adapter。改动范围中等；AgentBoard 目标客户端目前未实测。首选整体形态。 |
| **autumnsentiment/workbuddy-helper** | README 标示最新发布 v1.0.8，MIT。已读源码固定到 main HEAD commit 11808853e53ae195a329182f5655baa1783de64c；未证明该 HEAD 与 v1.0.8 release 完全相同。[release README](https://github.com/autumnsentiment/workbuddy-helper/blob/11808853e53ae195a329182f5655baa1783de64c/README.md#L251-L275) · [LICENSE](https://github.com/autumnsentiment/workbuddy-helper/blob/11808853e53ae195a329182f5655baa1783de64c/LICENSE) | Go 服务具备多个服务账号、浏览器授权、国内版每日签到、单账号结果和 Windows DPAPI。它保存自己的服务端账号凭据，不切换本机 WorkBuddy / CodeBuddy Desktop 登录态。[login source](https://github.com/autumnsentiment/workbuddy-helper/blob/11808853e53ae195a329182f5655baa1783de64c/internal/client/client.go#L798-L948) · [batch source](https://github.com/autumnsentiment/workbuddy-helper/blob/11808853e53ae195a329182f5655baa1783de64c/internal/service/service.go#L1060-L1102) | 单独运行会引入另一套 Go 服务、账号库和 UI；将符合范围的代码移到 Node/TypeScript 需要重写模型、登录、存储与业务接口。未运行、未集成；作为签到机制参考，不作为本机登录切换方案或运行依赖。 |
| **D:/WorkSpaces/LLM 看板/WorkBuddy Switch 1.9.0** | 项目 package.json 声明 MIT；Node ≥22.16 / Electron 44.9.3。[package.json](../../LLM%20看板/package.json#L1-L29) | 有 WorkBuddy 本机账号快照和切换实现；本轮没有证据证明该模块适用于 CodeBuddy Desktop。AgentBoard Node 栈相近，但数据模型、Electron 主进程和账号 provider 不可直接复用。 | 内部源码静态核对；真实切换仍未验收。可复用其流程经验；如需复制现有文件，实施前确认保留 LICENSE / NOTICE。 |
| **ithtelab/workbuddy-manager** | 固定 commit 15568af76e0852ff2ba5b5650d96d7a9bd3a745d，MIT | 管理 workbuddy2api 代理账号池，与本机客户端登录切换不匹配。[固定版本](https://github.com/ithtelab/workbuddy-manager/tree/15568af76e0852ff2ba5b5650d96d7a9bd3a745d) | 本稿不采用其账号池或重载流程，不移植代码。只保留为范围排除证据。 |
| **DPAPI 包候选** | @primno/dpapi 2.0.1，MIT。[README](https://github.com/primno/dpapi/blob/main/README.md) | 候选用于 Windows 当前用户 DPAPI；其 README 声明 Node ≥14、Windows x64 / ARM64。符合 Node 版本下限，但 native addon 打包与 AgentBoard 运行时兼容性未验证。 | 可避免自写原生绑定，但会增加 native addon 依赖及打包验证。尚未安装；采用前需在 AgentBoard 目标打包方式中验证。 |

**推荐路线：**在 AgentBoard 原有单机服务内实现账号模块；使用本地 WorkBuddy Switch 仅作为 WorkBuddy 流程参考，以 workbuddy-helper 固定源码作为签到协议参考；分别新增 WorkBuddy Desktop、CodeBuddy Desktop 与签到 provider。CodeBuddy provider 在确认其官方客户端、安装实例、认证路径和身份检查前标记为阻塞。workbuddy2api 不进入方案。没有第三方代码或许可证文件被复制。

若实施决定复制任何第三方仓库源码，先确认保留其 LICENSE、NOTICE 和相关文件；本轮只读调研，不触及代码许可文件。

## 4. 系统边界与模块

新增 Account 模块，放在 AgentBoard server 与现有 React 设置入口中：

- Account Registry：账号安全元数据、客户端安装配置与 provider 能力。
- Local Client Provider：为 WorkBuddy Desktop、CodeBuddy Desktop 分别实现当前身份读取、快照读取/写入、进程状态、退出/启动和身份验证。
- Check-in Provider：按产品和服务版本独立处理凭据、状态查询、签到请求与响应分类。
- Secret Vault：在 Windows 当前用户 DPAPI 下保存客户端快照和签到凭据；metadata 数据库只存 opaque reference。
- Operation Runner：账号级和客户端实例级锁，保存操作阶段、超时状态和恢复指引。

切换和签到是不同操作：签到使用经验证的每账号签到凭据，不通过反复切换桌面账号来轮询签到。某客户端无法为非当前账号提供安全、独立的签到凭据时，该客户端账号显示“签到能力未验证”，不可由系统自动切换过去签到。

## 5. 数据结构提案

下表新增于现有 SQLite，使用新的幂等迁移函数。时间戳统一毫秒 Unix 时间。任何表不存放明文令牌、Cookie、密码或客户端凭证原文。

### managed_account

| 字段 | 用途 |
|---|---|
| id | AgentBoard 账号 UUID |
| app_id | workbuddy_desktop / codebuddy_desktop |
| client_instance_id | 对应安装实例；由 provider 建立稳定 id |
| service_region | 由登录响应或 provider 验证的区域，不以显示名称推断 |
| identity_hash | 外部 UID 的不可逆摘要，用于去重与切换后身份比较 |
| display_name | 用户自定义名称 |
| client_snapshot_ref | 当前客户端登录快照的 DPAPI 加密文件引用 |
| checkin_credential_ref | 通过该账号的官方浏览器授权取得并验证后的独立签到凭据引用；不得从 Desktop snapshot 提取 |
| client_snapshot_version | 客户端快照格式版本 |
| checkin_capability | unknown / supported / unsupported |
| enabled | 是否纳入用户启动的批量签到 |
| last_checkin_day / last_checkin_status / last_checkin_at | 最近本地记录；不能冒充服务器当天状态 |
| created_at / updated_at | 毫秒时间戳 |

唯一索引为 app_id、client_instance_id、identity_hash。当前账号显示应从客户端读取并验证，不单靠数据库中的 active 标记。

### account_operation

| 字段 | 用途 |
|---|---|
| id | 操作 id |
| batch_id | 批量签到关联 id；单账号切换时为空 |
| account_id | 操作账号；切换时为目标账号 |
| app_id / client_instance_id | 锁域与进程范围 |
| operation | capture / switch / checkin / restore |
| state | queued / running / succeeded / already_done / failed / unknown / recovery_required |
| stage | preflight / stop / snapshot / validate_target / write / start / verify / rollback |
| safe_error_code | 可展示的固定错误码，不包含凭证或原始异常 |
| started_at / finished_at | 毫秒时间戳 |

索引按 (batch_id, started_at) 与 (app_id, client_instance_id, state) 建立。关联签到凭据时，必须明确匹配产品、区域和稳定 UID；仅三者全部一致才关联到本机账号。不同产品不因 UID 字符串相同而互通。删除账号默认只删除 AgentBoard 的 metadata 和 DPAPI 文件；不删除客户端当前登录文件、不清理 WorkBuddy / CodeBuddy 客户端数据目录。

## 6. 本机客户端登录账号管理

### 新增账号

1. 用户选择 WorkBuddy Desktop 或 CodeBuddy Desktop，并在该客户端的官方界面完成登录。
2. 用户在 AgentBoard 点击“保存当前账号”。
3. 对应 provider 读取客户端当前稳定身份，捕获可还原快照，验证产品、安装实例和身份。
4. Secret Vault 使用当前 Windows 用户 DPAPI 加密快照；数据库保存 identity_hash、别名和加密引用。
5. 保存成功后再次读取当前身份；身份变化或客户端格式不支持时放弃保存并清理临时快照。

本流程是提案。WorkBuddy 当前本机路径/格式是否可完整捕获与还原仍未获真实验收；CodeBuddy Desktop 路径、版本、身份字段和快照契约未核实。若令牌被客户端设备绑定或无法通过受支持方式还原，该客户端切换能力保持 unavailable；不绕过未知加密包装。

### 单账号“授权签到”

每个账号另提供“授权签到”流程提案：AgentBoard 打开该提供方的官方浏览器授权页，用户完成授权后由 provider 轮询结果。成功后验证签到凭据返回的产品、区域和稳定 UID，与用户明确选择关联的本机快照身份完全相同；验证通过才将凭据加密到 DPAPI vault、设置 checkin_credential_ref 并标记 checkin_capability=supported。身份不匹配时返回安全错误，不保存、不关联。不同产品或区域不默认互通，也不从客户端快照盲提取签到 token。

目前没有已验证的 AgentBoard 签到 provider。provider 未验证时，UI 不展示“授权签到”可用按钮；API 占位接口返回 PROVIDER_UNVERIFIED，不创建授权会话或保存凭据。

### 账号切换状态机

同一 client_instance_id 使用独占切换锁；不能与同一客户端的批量操作、账号捕获、另一切换并发执行。

1. preflight：确认 app id、安装路径、目标快照版本与 DPAPI 解密结果一致。
2. 活动任务保护：只有确认目标 Desktop 客户端空闲且没有未保存内容才允许关闭。AgentBoard 中 CodeBuddy CLI 运行会话也阻止 CodeBuddy Desktop 切换；这不代表二者认证状态相同。无法可靠探测 Desktop 活动状态或未保存内容时，要求用户先保存并手动退出。
3. 停止目标客户端。只请求正常退出；未经用户明确授权不强制结束进程。客户端未完全退出时中止操作，绝不写入账号数据。
4. 备份当前客户端快照并验证可恢复；读取当前身份作为回滚预期。
5. 验证目标快照的 app id、client_instance_id 和 identity_hash 与请求目标一致。
6. 原子写入目标快照并重新启动目标客户端。
7. 通过只读身份探测确认实际登录身份匹配目标 account_id；成功后记录操作完成。
8. 任何写入后失败，停止目标客户端、还原备份、重新启动并验证旧身份。恢复失败时置 recovery_required，保留恢复文件，冻结该客户端实例的后续写入并显示恢复路径。

切换只改变用户明确选择的本机应用实例。不会自动改变 CodeBuddy CLI 配置、工作空间环境变量、其他 WorkBuddy 安装或 2api 账号池。

## 7. 多账号批量签到

### 运行协议提案

1. UI 按 app/provider 展示独立账号列表；用户选择一个产品的启用账号并点击“全部签到”。
2. 服务端创建 batch_id 和每个账号的 operation 记录，按确定列表顺序逐个执行，不并发。
3. 每个账号取得 account_id 锁；凭据未验证、已失效或能力为 unsupported 时返回该账号失败，不阻止其他独立账号继续。
4. 若有已验证的官方签到状态查询，先查询该服务日状态；明确已完成则标记 already_done，不发签到请求。
5. 若无可信状态查询，只有本地同一服务日有已确认成功记录时跳过；若同一服务日已有结果未知，保持 unknown、不自动重发。其他账号发送一次签到请求并解析明确成功或“已签到”结果。服务日边界尚未确认前，UI 标注该状态来自本地时区记录。
6. 请求超时或连接中断后，结果置 unknown。仅在已验证的状态查询能证明未完成时允许再次提交；否则不自动重试，待用户查看状态后显式处理。
7. 每个账号记录成功、already_done、failed 或 unknown；失败和限流不伪装为成功。批次结束时用户可查看逐账号结果和安全错误码。

每产品的批量签到使用 batch 锁，单账号操作与 batch 共用账号锁。切换锁按 client_instance_id 独立；只有 provider 明确需要桌面客户端当前身份时才与该客户端锁互斥。首版建议签到只依赖独立 checkin_credential_ref，不能依赖切换过程。

### 服务日与幂等边界

workbuddy-helper 当前 HEAD 的代码用 Asia/Shanghai 计算本地日，已有本地成功/已完成记录时跳过；另将签到请求发到 daily-checkin 路径，并按特定业务码/消息识别已签到。[日期及本地跳过](https://github.com/autumnsentiment/workbuddy-helper/blob/11808853e53ae195a329182f5655baa1783de64c/internal/service/service.go#L830-L900) · [请求端点](https://github.com/autumnsentiment/workbuddy-helper/blob/11808853e53ae195a329182f5655baa1783de64c/internal/client/client.go#L1036-L1050)

这些源码证明 helper 的本地实现逻辑，不证明平台官方服务日就是北京时间，也不证明该接口对所有 WorkBuddy / CodeBuddy 客户端版本稳定。各 provider 的端点、状态查询、服务日与业务码需在实施前用测试账号验证。国际版活跃会话不计为“签到”，不自动纳入本设计。

## 8. API 与界面提案

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | /api/managed-accounts?app= | 返回账号别名、产品、安装实例摘要、当前身份匹配状态、签到能力与最近签到结果；不返回 secret ref 原值 |
| POST | /api/managed-accounts/:app/capture-current | 保存对应桌面客户端当前已登录账号快照 |
| POST | /api/managed-accounts/:id/switch | 创建切换 operation，立即返回 operation id |
| POST | /api/checkin-authorizations/start | body 为 account_id；创建该账号的官方浏览器签到授权会话。未验证 provider 时返回 PROVIDER_UNVERIFIED |
| POST | /api/checkin-authorizations/:id/poll | 轮询授权结果；只在产品、区域和稳定 UID 全部匹配后保存签到凭据 |
| POST | /api/checkin-runs | body 为 app_id 与 account_ids；启动按序批量签到 |
| GET | /api/account-operations/:id | 查询切换或批量操作状态、阶段、逐账号安全结果 |
| DELETE | /api/managed-accounts/:id | 删除 AgentBoard 管理的账号快照与 metadata |

UI 在“设置 → 账号”中提供 WorkBuddy Desktop、CodeBuddy Desktop 两个独立区域。每个区域显示当前账号、保存账号卡片、当前身份匹配状态、显式“保存当前账号”“切换”“选中账号签到”“全部签到”。仅已验证 provider 为账号完成独立官方授权后，才显示“授权签到”；产品、区域或 UID 与所选 Desktop snapshot 不一致时不可关联。批量运行时显示当前账号、成功/已签到/失败/结果未知数及逐账号日志摘要。用户可取消尚未发起网络请求的排队账号；已发送请求不提供假取消。

所有写 API 要求本机同源来源检查和 CSRF token。错误只返回 operation id、固定阶段码和安全错误码；不返回 token、refresh token、原始路径、客户端响应体或栈信息。

## 9. 凭据保护与权限边界

- AgentBoard 本机服务继续绑定回环地址；首版按当前 Windows 用户单用户假设运行。
- 快照及签到凭据保存到 AgentBoard 私有数据目录并由 Windows 当前用户 DPAPI 加密；数据库只存 opaque ref 与非敏感 metadata。
- UI/REST 仅返回脱敏身份摘要；不得显示、日志记录、导出或复制凭据。
- DPAPI 当前用户保护不能自动迁移到另一个 Windows 用户或机器。账号导出、云同步与跨设备迁移不在首版范围。
- CodeBuddy CLI 登录文件、CodeBuddy Desktop 登录文件、WorkBuddy Desktop 登录文件分开处理；任何共享关系须由实际路径和身份测试证明。
- 登录、签到和切换均不自动绕过官方认证、验证码或客户端安全包装。登录由用户在官方界面完成。

## 10. 验收标准与验证缺口

### 自动化验收

1. 增量 schema 可重复执行，旧 pinned DDL 不变。
2. API、SQLite metadata、日志和前端中无 token、Cookie、凭证原文。
3. 同一客户端实例并发切换只有一个进入；不同 app_id 的安装实例不互相覆盖。
4. 切换目标身份不匹配时回滚；模拟恢复失败后状态为 recovery_required，且后续操作被拒绝。
5. 批量签到顺序可断言；某账号失败不会丢失其他结果；同一服务日已完成账号不重复请求。
6. 网络请求发送后模拟超时，结果为 unknown，不自动重试；只有显式状态查询确认未完成才能重试。
7. WorkBuddy Desktop、CodeBuddy Desktop 和 CodeBuddy CLI 使用不同 fixture、路径和身份；没有跨产品误切换。
8. Desktop 空闲状态或未保存内容无法确认时切换被阻止；客户端未完全退出时不写凭据，流程不强杀进程。
9. 签到授权只在 provider 返回的产品、区域、UID 与所选 Desktop snapshot 全部匹配后设置 checkin_credential_ref；provider 未验证时授权接口不创建会话。
10. 账号删除只清理 AgentBoard 私有 DPAPI 快照，不删除被管理客户端的数据。

### 人工验收

- WorkBuddy Desktop：使用两个获授权测试账号，验证捕获、正向切换、反向切换、目标身份核验、活动进程阻止、错误回滚和重启恢复。
- CodeBuddy Desktop：在确认产品名称、版本、安装路径和认证文件契约后，执行与 WorkBuddy 相同的独立验证。
- 签到：用多个获授权测试账号运行一次批次；核实顺序、已签到跳过、单账号失败隔离、业务限流、服务日边界和超时后不盲重试。
- 重启 AgentBoard 和客户端后核验凭据 DPAPI 可用性、账号身份、未完成操作恢复状态和日志脱敏。

以上验收均未运行。当前无真实客户端、账号、进程、接口或服务日验证结果。

## 11. 待实现前确认与阻塞

1. CodeBuddy Desktop 正式产品名、版本、可执行程序、账号存储位置/格式、当前身份读取方式、退出/启动语义和回滚可行性。
2. WorkBuddy 各目标版本的账号快照可否保存和还原；受保护凭据是否设备绑定；不支持时应明确禁用切换。
3. WorkBuddy / CodeBuddy 的各自签到资格、端点、请求体、响应分类、状态查询及限流规则；国际版是否有用户明确要支持的非签到活动。
4. 服务端服务日与系统本地时区是否一致；确认前不得把本地日期显示为官方签到日。
5. 签到是否允许跨 WorkBuddy 与 CodeBuddy 混合为一个批次；本稿按单 app/provider 一个批次。
6. AgentBoard 首版仅支持 Windows 本机客户端；若需 macOS/Linux，需另行确认对应 OS 的安全存储与进程契约。
7. 是否允许跨项目读取本机当前客户端账号快照；本稿限定当前 AgentBoard 本机用户，不提供团队或互联网账号库。
8. 实施若要复制 workbuddy-helper 等第三方源码，须先确认 LICENSE / NOTICE 文件保留要求；本轮没有复制。

## 12. 原始材料与调研方法

- AgentBoard：Docs/设计文档.md、Docs/实施计划.md、apps/server/src/db/schema.ts、apps/server/src/config.ts、apps/server/src/index.ts、packages/adapters/src/index.ts、apps/web/src/components/topbar/SettingsDialog.tsx。
- 本机 WorkBuddy Switch 项目：D:/WorkSpaces/LLM 看板/package.json、desktop/store.mjs、desktop/controller.mjs、desktop/login.mjs、desktop/workbuddy-auth-crypto.mjs、Docs/2026-10-30-workbuddy-auth-compat-plan.md。仅读源码与计划，未读账号库、vault 或真实凭据文件，未执行脚本或客户端。
- 签到候选固定源码：autumnsentiment/workbuddy-helper main HEAD commit 11808853e53ae195a329182f5655baa1783de64c；阅读 README、LICENSE、internal/client/client.go、internal/service/service.go、internal/model/model.go、internal/store。未证明该 HEAD 等同 v1.0.8 release；未安装、运行、签到或访问账号服务。
- 不匹配参考：ithtelab/workbuddy-manager commit 15568af76e0852ff2ba5b5650d96d7a9bd3a745d；只确认其目标是 workbuddy2api 账号池，未作为设计流程或依赖。
- 本轮方法：现有文档核对、本地相关源码定向只读、GitHub 固定版本原始源码读取；未读取 vault 或账号数据，未运行程序、客户端或网络 API。
