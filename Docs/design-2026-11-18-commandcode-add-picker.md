# Command Code 添加入口设计

日期：2026-11-18

## 需求分析

- “添加供应商”中增加 Command Code。
- 首次添加不依赖本机 `~/.commandcode/auth.json`。
- 复用现有 CLI 凭据导入能力，支持粘贴 Studio API Key。
- Command Code 继续保持 CLI 来源语义，不加入 `ManagedAppId`。
- 不新增切换与签到入口；两者现有能力仍为不可用。

## 方案选型

GitHub 候选：

| 候选 | 版本 | 许可证 | 匹配情况 | 结论 |
| --- | --- | --- | --- | --- |
| CommandCodeAI/desktop | v0.1.62 | 未声明 | 官方桌面客户端，不是可复用 UI 组件 | 不采用 |
| MAXeaglet/commandcode-proxy | 无 release tag | MIT | OpenAI/Anthropic 反向代理 | 不采用 |
| Mars-Sea/dsh-commandcode-provider | v0.18.1 | MIT | DSH provider 插件 | 不采用 |
| npm `command-code` | 1.90.1 | UNLICENSED | 官方 CLI 包 | 不移植 |

采用现有实现：

- 前端继续使用 React 与当前供应商卡片组件。
- 凭据提交继续使用 `POST /api/cli-accounts/import`。
- 数据继续使用 `cli_account.app_id='commandcode'`。
- 不增加依赖、数据库迁移或服务端协议。

## 接口设计

- `AddAccountPicker` 新增 CLI 来源选择回调，参数为 `'commandcode'`。
- Command Code 卡片显示“添加 API Key”。
- 点击后关闭供应商选择层，并选中左栏 Command Code 来源。
- Command Code 来源复用现有导入表单：
  - 粘贴 Studio API Key；
  - 或粘贴 `COMMAND_CODE_API_KEY=...`；
  - 提交 `POST /api/cli-accounts/import`。

## 数据结构

- 来源 id：`commandcode`
- 来源类型：`CliAccountAppId`
- 账号表：`cli_account`
- 凭据：`secret_vault`，scope 为 `app_id=commandcode`、`purpose=cli_credential`
- 无新增字段、无迁移。

## 关键流程

1. 打开“添加账号”。
2. 点击 Command Code 卡片。
3. 面板切换到 Command Code 来源详情。
4. 展开“添加 API Key”，粘贴凭据并提交。
5. 服务端完成格式校验、加密保存与去重。
6. 前端刷新 `cli-accounts`，新账号出现在 Command Code 来源下。

## 验收标准

- 零 Command Code 账号时，“添加供应商”显示 Command Code 卡片。
- 点击卡片后能进入 Command Code 详情并看到“添加 API Key”。
- 有效 API Key 导入返回成功并立即显示新账号。
- 重复 Key 显示“已存在，已刷新最近发现时间”。
- 无 Key、非法 Key、空输入均由现有服务端返回可解释错误。
- Command Code 仍不显示切换与签到按钮。
- 测试页 `http://127.0.0.1:5174` 完成一次真实导入验证。

## 影响文件

- `apps/web/src/components/settings/AddAccountPicker.tsx`
- `apps/web/src/components/settings/AccountsPanel.tsx`
- `apps/web/src/test/AddAccountPicker.test.tsx`
- `apps/web/src/test/AccountsPanelRedesign.test.tsx`
