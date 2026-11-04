# 真机验收：聊天粘贴截图 → agent 收到图片字节（CHAT-IMG-DELIVERY-C）

日期：2026-11-04 · 卡：`e087d35c-8afc-40cb-b73c-3cf93dadf570` · 父卡 `6a140b0f`
被测代码：CHAT-IMG-DELIVERY-A（`5ea3ee70`，服务端契约）+ B（`c6b070ee`，web 发送带 `attachment_ids`）

## 0. 结论先写

**A+B 的代码路径是通的（上传 → 绑定 → 传参），但端到端「图片字节到达 agent」在当前环境仍然不可能**，两个独立原因：

| # | 现象 | 根因（文件:行） |
|---|---|---|
| 1 | 任何带 `attachment_ids` 的消息都 400 `IMAGE_DELIVERY_UNVERIFIED` | `packages/adapters/src/codex.ts:123`、`dsh.ts:110`、`opencode.ts:111` 硬编码 `supportsImageInput() { return false; }`；唯一实现图片通道的 codebuddy 又要求 **`cliVersion === '2.179.2'`（`codebuddy.ts:14`）且 `model === 'minimax-m3.1-flash'`（`codebuddy.ts:17-19`）**，本机 codebuddy 是 **2.170.0** → 判定恒假 |
| 2 | 8787 正式实例把带图消息当纯文本接收（HTTP 200，无错误提示） | 运行中的进程 pid 59716 是 **15:33 启动的旧构建**，早于 A；它的 DB **没有 `session_attachment` 表**，路由也不认识 `attachment_ids` → 附件 id 被静默丢弃 |

## 1. 正例（真实截图，193,909 字节 PNG）

用 CDP 抓真实看板截图（1024×700，**193,909 字节**，非 1×1），上传到工作区并带 `attachment_ids` 发送：

```
上传：POST /api/workspaces/<ws>/attachments → 201
      { id: c9b9b5c1-2f98-4dff-9b9c-12f394033b4c, mime_type: image/png, size_bytes: 193909, status: staged }
磁盘：attachments/613fa97f-0eb6-476b-97e8-e9dc44126da1 = 193,909 bytes，magic 89504e470d0a1a0a（PNG）
发送：POST /api/sessions/<sid>/messages { text, attachment_ids:[c9b9b5c1…] } → 400
      {"error":{"code":"VALIDATION_ERROR","message":"IMAGE_DELIVERY_UNVERIFIED:当前 CLI/model 组合没有通过图片输入验证"}}
落库：session_attachment 表存在，但该会话 0 行（未绑定，附件保持 staged，可重发）
```

codebuddy 会话即使显式指定 `model: minimax-m3.1-flash` 仍然 400（版本 2.170.0 ≠ 固化 2.179.2）。

## 2. 反例（纯文本，不带附件 id）

```
POST /api/sessions/<sid>/messages { text: "（反例）纯文本" } → 200 {"queued":true}
session_attachment：rowsBefore=0 → rowsAfter=0（rowsAdded=0）
```

符合预期：普通文本不产生绑定行。

## 3. 测试页 UI 真机（5174 → 8787 旧实例）

真实截图 **243,861 字节（1416×808）** 经真实 `Ctrl+V` 粘贴 → 草稿变为
`![图片](/api/workspaces/<ws>/attachments/cc8e2113-031e-442d-abe2-a96af89b2bde)` → 发送：

```
POST /api/sessions/836a45c9…/messages → 200（无错误提示）
用户气泡 <img>：naturalWidth=1416 / naturalHeight=1812? → 实测 naturalWidth=1416, naturalHeight=808
```

即：**用户自己看得见图，但服务端把这条消息当纯文本收下**（旧 DB 无 `session_attachment` 表、`attachment` 表 147 行里该附件仍 `staged`）。这正是「图片从未以图片字节投递给 agent」的线上表现。

## 4. 需要做的修复（不在本卡范围，A/B 仍在待验收）

1. **放开图片能力判定**（`packages/adapters/src/*.ts`）：要么把 `codebuddy.ts:14` 的 `VERIFIED_IMAGE_CLI_VERSION` 更新到实测可用版本（当前 2.170.0 需实测 `stream-json --input-format stream-json` 图片块），要么明确 codex/opencode/dsh 的图片通道后再返回 true；**不要**为了让流程跑通就把 false 改 true（会静默退化成「发出去但没有图」）。
2. **重启 8787 正式实例**，让 A 的 schema 迁移（`session_attachment`）在当前库上执行；否则线上永远走旧路由。
3. 修完后重跑本卡：期望正例 `200 {queued:true}` + `session_attachment` 1 行（`delivery_state=delivered`、`delivered_at` 非空）+ adapter 侧 base64 载荷。

## 5. 未验证

- **adapter 侧 base64 载荷未能取证**：因为正例在路由层就被 400 拦住，`runTurn` 从未被调用。
- 真实 agent（codebuddy 2.179.2）收到图片后的理解效果。
- 8787 重启后的端到端（需要重启共享实例，交由 lead 决定时机）。

## 6. 复现命令

```
# 隔离实例（当前构建 + 独立库，端口 18791）
$env:AGENTBOARD_PORT='18791'; $env:AGENTBOARD_DB='D:\tools\tmp\chatimg-c\agentboard.db'
$env:AGENTBOARD_ATTACHMENTS='D:\tools\tmp\chatimg-c\attachments'
node scripts/server-detached.mjs

# 取证脚本（在 D:\tools\tmp）
node verify-chat-img-delivery.mjs      # 上传 + 正例/反例 + 行数
node verify-delivery-exact.mjs         # HTTP + DB 行 + 磁盘字节
node verify-ui-real-screenshot.mjs     # 测试页真实截图粘贴 → 发送
node probe-live-vs-fresh.mjs           # 8787 旧库 vs 当前构建库对比
```

## CHAT-IMG-ADAPTER：适配器图片能力逐项核实（2026-11-04）

| 适配器 | 结论 | 依据命令 | 实测输出 |
| --- | --- | --- | --- |
| codex | **支持**（`supportsImageInput` 由 `codex exec --help` 探测决定，不写死） | `codex exec --help` / `codex exec "Reply with just OK" --json --skip-git-repo-check -i tiny.png` | help 含 `-i, --image <FILE>...`；真机运行接受 `-i`（`thread.started`/`turn.started` 正常，随后因账号用量上限 429 结束，与图片无关） |
| opencode | **支持**（由 `opencode run --help` 探测决定） | `opencode run --help` / `opencode run "Reply with just OK" --format json --file tiny.png` | help 含 `--file, -f string`；真机运行接受 `--file`（建会话并 step_start，随后 `provider.free-limit` 429 结束，与图片无关） |
| codebuddy | **支持但需 2.179.2 + model=minimax-m3.1-flash**（本机现为 2.179.2，实测通过门槛） | `codebuddy --version` | `2.179.2`；2.170.0 会被拒（路由 400 且文案要求升级） |
| dsh | **不支持**（保持 false） | 本机入口为 asar 形态（shim 指向 `.../app.asar/dsh/lib/bin.js`，文件不存在） | 拿不到稳定 `--help`，无法实测图片入参 → 按不支持处理并在代码注释写明阻塞原因 |

**payload 级证据**（`packages/adapters/test/imageCapability.test.ts`，9 例）：用 303 字节真实 PNG 跑 `runTurn`，断言 argv 里出现 `-i <pngPath>`（codex）/ `--file <pngPath>`（opencode），并核对磁盘文件 sha256 与 fixture 一致；`--help` 缺 flag 时 `supportsImageInput` 必须为 false，且带附件调用抛 `IMAGE_DELIVERY_UNVERIFIED`。

**未验证**：真实模型侧「看到图并描述内容」——本机 codex 账号用量上限、opencode 免费额度耗尽，均在请求图片之后才 429，图片入参本身已被 CLI 接受。
