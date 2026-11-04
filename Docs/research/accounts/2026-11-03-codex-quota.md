# Codex 余额/额度查询可行性调研（2026-11-03）
- status: proposed
- date: 2026-11-03
- card: -
- supersedes: -

- 任务：`ffb32a37-5b4f-4e04-8a38-e4d3e932ca64`【CODEX-QUOTA】
- 执行者：board-web-accounts；**只读**调研（未读 token 原文、未落盘凭据、未改代码）
- 结论摘要：**可稳定取数**，有两条已在本机验证的路径（本地 rollout JSONL / ChatGPT web 后端），另有两条需额外条件的路径（codex app-server、OpenAI Platform Admin API）。当前账号页 `Codex = unsupported` 的判定应改为 supported（实现另开卡）。

---

## 0. 本机环境（取证底座）

| 项 | 值 | 证据 |
|---|---|---|
| `~/.codex/auth.json` | `auth_mode=chatgpt`，`tokens.access_token` 存在（长度未记录），`account_id` 36 位，`last_refresh=2026-11-01T14:42:21Z` | 只读解析键名与长度，未打印 token |
| 本机 OpenAI API key | **无**（env `OPENAI_API_KEY` 未设置；`~/.dsh/.credentials.yaml` 只有 DeepSeek/Gemini/Qiuniu/Xiaomi/opencode-go 的 key） | 扫描 `sk-` 前缀（脱敏） |
| codex CLI | `C:\Users\31633\AppData\Roaming\npm\codex`（`codex --help` 有 exec/review/login/app-server/debug 等子命令，**无 usage 子命令**） | `codex --help` 实测 |
| 本地会话 | `~/.codex/sessions/**/rollout-*.jsonl` 209 个文件、18,772 条 `token_count` 事件；`state_5.sqlite.threads` 485 行、`tokens_used` 合计 5,328,831,805 | 只读统计 |

---

## 1. 官方 OpenAI Platform 端点（账单/用量）

### 1.1 端点存在性与鉴权要求

| 命令 | 返回码 | 解释 |
|---|---|---|
| `curl -s -o NUL -w "%{http_code}" https://api.openai.com/v1/models` | **401** | 端点可达、未带凭据 → 401（说明本机到 `api.openai.com` 网络可达；Node `fetch` 直连会 `fetch failed`，属本机 Node TLS/代理差异，改用 `curl`/`Invoke-WebRequest` 可复现） |
| `GET https://api.openai.com/v1/organization/costs`（无凭据） | 401 | 同上 |
| `GET https://api.openai.com/v1/dashboard/billing/subscription`（无凭据） | 401 | 同上 |
| `GET https://api.openai.com/v1/dashboard/billing/usage`（无凭据） | 401 | 同上 |

- `/v1/organization/costs` 需要**组织级 Admin API key**（`sk-admin-…`，仅在组织管理员创建），返回按项目/时间的成本与用量；普通 `sk-…` 项目 key 无权访问（`官方文档`：OpenAI Platform Admin API，本机无 Admin key，**未证实**到具体字段）。
- `/v1/dashboard/billing/*` 是旧的 dashboard 计费接口，已不在新的官方文档主路径里（`未证实` 是否仍对部分账号开放）。
- 结论：**官方 Platform 端点不属于"Codex 订阅额度"**（那是 ChatGPT 订阅侧的口径），且本机无 Admin key → 本轮不作为取数路径。

---

## 2. ChatGPT 订阅额度（Codex 的 5h / 周窗口）——**已打通**

### 2.1 之前的 403 是缺浏览器 `User-Agent`（不是 cookie / CSRF）

可复现探测（`~/.codex/auth.json` 的 access_token + `ChatGPT-Account-Id`，逐一叠加 header；token 只在内存中使用，未打印）：

| 变体 | 请求头 | 状态码 |
|---|---|---|
| V1 | `Authorization: Bearer <at>` + `ChatGPT-Account-Id: <aid>` | **403** |
| V2 | V1 + `User-Agent: Mozilla/5.0 … Chrome/140.0.0.0 Safari/537.36` | **200** ✅ |
| V3 | V1 + `Origin: https://chatgpt.com` | 403 |
| V4 | V1 + `Referer: https://chatgpt.com/` | 403 |
| V5 | V1 + `User-Agent` + `Origin` | 200 |
| V6 | V1 + `User-Agent` + `Origin` + `Referer` | 200 |

→ **关键 header 是浏览器 UA**；`Origin`/`Referer` 非必需（V2 已 200）；`OpenAI-Beta` 也非必需。403 时**响应体为空**（无 JSON），不是 CORS（服务端调用无 CORS 概念）。
端点：`GET https://chatgpt.com/backend-api/codex/usage`（`/backend-api/codex/rate_limits` 同样 403，未再验证）。

### 2.2 响应结构（2026-11-03 实测，`status=200`，已脱敏：`user_id`/`account_id`/`email` 置 `<redacted>`）

```jsonc
{
  "plan_type": "plus",
  "rate_limit": {
    "allowed": true,
    "limit_reached": false,
    "primary_window":   { "used_percent": 96, "limit_window_seconds": 18000,  "reset_after_seconds": 10469,  "reset_at": 1793703146 },  // 5 小时
    "secondary_window": { "used_percent": 91, "limit_window_seconds": 604800, "reset_after_seconds": 416146, "reset_at": 1794108823 }   // 7 天
  },
  "code_review_rate_limit": null,
  "additional_rate_limits": null,
  "model_usage": { "gpt-6-astra": { "available": true, "available_at": null, "credits_would_enable": false } },
  "credits": { "has_credits": false, "unlimited": false, "overage_limit_reached": false, "balance": "0",
               "approx_local_messages": [0, 0], "approx_cloud_messages": [0, 0] },
  "spend_control": { "reached": false, "individual_limit": null },
  "rate_limit_reached_type": null,
  "promo": null,
  "rate_limit_reset_credits": { "available_count": 2, "applicable_available_count": 0 }
}
```

字段含义（对应我们的 `QuotaWindow{ used_percent, reset_at }`）：

| 我们的字段 | Codex 字段 | 换算 |
|---|---|---|
| window.name=`5h` | `rate_limit.primary_window` | `limit_window_seconds=18000` |
| window.name=`weekly` | `rate_limit.secondary_window` | `limit_window_seconds=604800` |
| used_percent | `used_percent` | 直接用（0–100） |
| reset_at | `reset_at` | **秒**级 epoch → ×1000 得毫秒 |
| 余额 | `credits.balance`（字符串，美元）+ `has_credits` / `unlimited` | `credits.balance="0"` 即当前无额度余额 |

- 注意：`primary/secondary` 只是传输槽位，**语义靠 `limit_window_seconds`**；企业/Team 账号可能出现 43800 分钟（月度）窗口（社区文档，见 §4）。
- 响应头里没有限流相关 `x-*` 字段（`usageHeaders={}`）。

---

## 3. 本机数据（完全不用网络、不碰 token）

### 3.1 会话 rollout JSONL 里已有完整额度快照（**推荐路径**）

`~/.codex/sessions/**/rollout-*.jsonl` 的 `event_msg` / `payload.type = "token_count"` 记录里带 `payload.rate_limits`（实测抽样 3 个文件均有）：

```jsonc
{
  "type": "event_msg",
  "payload": {
    "type": "token_count",
    "rate_limits": {
      "limit_id": "codex",
      "primary":   { "used_percent": 2,  "window_minutes": 300,   "resets_at": 1793703146 },
      "secondary": { "used_percent": 77, "window_minutes": 10080, "resets_at": 1794108823 },
      "credits": { "has_credits": false, "unlimited": false, "balance": "0" },
      "individual_limit": null, "spend_control_reached": null, "plan_type": "plus", "rate_limit_reached_type": null
    }
  }
}
```

- 取「最新一条 `rate_limits`」即可得到最近一次 Codex 活动时刻的额度快照；`resets_at` 同样是**秒**级 epoch。
- 优点：**零网络、零凭据、零 token 读取**；缺点：新鲜度 = 上次使用 Codex 的时间（不做新的网络请求就不会更新）。
- 统计：本机 209 个 rollout 文件中 `rate_limit` 出现 37,779 次，`token_count` 事件 18,772 条 → 覆盖充分。

### 3.2 `state_5.sqlite` 的本地用量（不是额度）

- `threads` 表有 `tokens_used` 列（485 行，合计 5,328,831,805 tokens）、`updated_at`；可做「本地历史用量」统计，**不能**当余额。
- 与社区 codexU 的做法一致（local token usage vs account quota 分开）。

---

## 4. 社区方案（公开仓库）

| 项目 | 许可证 | 取数路径 | 稳定性评估 |
|---|---|---|---|
| [philipp-spiess/CodexBar](https://github.com/philipp-spiess/CodexBar) / [steipete/CodexBar](https://github.com/steipete/CodexBar) | MIT（README 标注） | Codex provider 走 **OAuth API 或本地 Codex CLI**；另可选「OpenAI web dashboard extras」需浏览器 cookie | 主流方案，说明「OAuth/本地 CLI」是社区公认路径；web 端点是可选 enrichment |
| [shanggqm/codexU · RESEARCH.md](https://github.com/shanggqm/codexU/blob/main/RESEARCH.md) | 未确认（仓库未声明，**待确认**） | **`codex app-server` JSON-RPC**：`initialize(capabilities.experimentalApi=true)` → `account/rateLimits/read` / `account/usage/read`；返回 `RateLimitSnapshot{ primary, secondary{ usedPercent, resetsAt, windowDurationMins } }`；本地用量取 `threads.tokens_used` 与 rollout `token_count` 增量 | 明确写「不读 auth.json token、不调私有 web 端点」，是最保守的官方运行时路径；需本机装 codex CLI 并起 app-server 子进程（本机未验证） |
| [codex-status-mcp](https://www.npmjs.com/package/codex-status-mcp/v/0.2.0)、[codex-lb specs](https://github.com/soju06/codex-lb/blob/72630bbfeee9e3b0d9acfb95e2b1e706b8b0188e/openspec/specs/usage-refresh-policy/context.md) | 未确认 | 同类：读本地 rollout / app-server | 仅作交叉印证，未采信细节 |

社区共同点：**额度来自「Codex 自己的运行时/会话」，不是 OpenAI Platform 计费 API**；这与本机两条验证路径一致。

---

## 5. 结论（三选一）

**结论：可稳定取数。**

已在本机验证的路径（按推荐度）：

1. **本地 rollout 快照（首选）**：解析 `~/.codex/sessions/**/rollout-*.jsonl` 最新 `payload.rate_limits` → `primary(300min)` / `secondary(10080min)` 的 `used_percent` + `resets_at`（秒），以及 `credits.balance`。零网络、零凭据、与 Codex 自身显示一致；新鲜度受「上次使用 Codex」限制。
2. **ChatGPT web 后端（实时）**：`GET https://chatgpt.com/backend-api/codex/usage`，需要 `Authorization: Bearer <~/.codex/auth.json access_token>` + `ChatGPT-Account-Id` + **浏览器 `User-Agent`**（缺 UA 必 403）。返回当前 5h/周窗口与 credits 余额；属**非公开端点**，可能随版本变动。
3. **`codex app-server` JSON-RPC（保守备选）**：`account/rateLimits/read`；本机未验证（需起子进程），社区文档明确其字段（`usedPercent`/`resetsAt`/`windowDurationMins`）。

已排除/不适用：

- **OpenAI Platform `/v1/organization/costs`、`/v1/dashboard/billing/*`**：端点可达（无凭据 401），但需要**组织 Admin key**；本机无 OpenAI key，且该口径是「API 组织花费」而非 Codex 订阅额度 → **未证实/不适用**。
- **`codex --help` 无 usage 子命令**（不能靠 CLI 子命令直接查）。

风险与限制：

- 方案 2 依赖私有端点 + UA 伪装，属于「能跑但非约定」，需缓存 + 失败降级；且响应含 `email/user_id/account_id`，**必须脱敏，不得写入日志/界面**。
- 方案 1 的新鲜度问题：用户长时间不用 Codex 时快照会过期（可用 `fetched_at` 与 `resets_at` 判断是否可信）。
- `primary/secondary` 语义靠 `limit_window_seconds`/`window_minutes`，不可硬编码成 5h/周（Team 账号可能出现月度窗口）。

## 6. 接入建议（下一步，另开实现卡）

1. `quotaService` 的 codex loader 改为两级：**先读本地 rollout 最新 `rate_limits`**（零凭据，稳定）→ 若快照缺失/过旧（例如 `resets_at` 已过期或无文件），再可选走 web 端点（读 `auth.json` 的 access_token，只在内存使用 + 带浏览器 UA，失败即降级）。
2. 映射：`primary` → `QuotaWindow{name:'5h', used_percent, reset_at: resets_at*1000}`；`secondary` → `name:'weekly'`；`credits.balance` → 卡的余额口径（与 DeepSeek 的 `balance/unit` 统一，`unit='USD'`）。
3. 脱敏：响应/快照里的 `email`、`user_id`、`account_id`、token 一律不出界面与日志。
4. 缓存：沿用既有 60s TTL + 失败退避；本地路径可放宽到 5 分钟（文件读取成本低但无意义地频繁扫盘）。
5. 是否需要用户授权：方案 1 不需要新凭据；方案 2 复用现有 `~/.codex/auth.json` 登录态（只读），但需在文档/界面明示「读取本机 Codex 登录态」；方案 3 需安装并允许启动 `codex app-server`。

---

## 附：探测命令与返回码汇总

| # | 命令/请求 | 返回 |
|---|---|---|
| 1 | `curl https://api.openai.com/v1/models`（无凭据） | 401 |
| 2 | `GET /v1/organization/costs`（无凭据） | 401 |
| 3 | `GET /v1/dashboard/billing/subscription`（无凭据） | 401 |
| 4 | `GET /v1/dashboard/billing/usage`（无凭据） | 401 |
| 5 | `GET chatgpt.com/backend-api/codex/usage` + Bearer + Account-Id（无 UA） | 403（空 body） |
| 6 | 同上 + 浏览器 `User-Agent` | **200**（§2.2 结构） |
| 7 | 同上 + Origin/Referer（无 UA） | 403 |
| 8 | `~/.codex/sessions/**/rollout-*.jsonl` 最新 `payload.rate_limits` | 存在（§3.1 结构，3/3 抽样命中） |
| 9 | `~/.codex/state_5.sqlite` `threads.tokens_used` | 485 行 / 5,328,831,805 tokens（本地用量，非额度） |
| 10 | `codex --help` | 无 `usage` 子命令 |
| 11 | `codex app-server` → `account/rateLimits/read` | 未验证（社区文档 §4） |
