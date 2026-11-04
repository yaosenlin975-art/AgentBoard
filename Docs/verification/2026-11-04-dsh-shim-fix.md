# DSH CLI 修复记录（shim 指向废弃路径）

日期：2026-11-04 · 卡：`40c8ea0c-54e6-48b5-b401-2cb8f12255c7`

## 结论

`dsh` 恢复可用：`dsh --version` → **`0.2.1-rc.5`**（exit 0）。修法是把用户目录下的 shim 改为**委托官方 runtime shim**，不再写死 asar 内部路径。

## 旧 shim（失效）

`D:\tools\bin\dsh.cmd`：

```bat
@echo off
node "D:\Program Files\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js" %*
```

`resources\app\dsh\…` 已不存在（Harness 改为 `resources\app.asar` 打包形态）→ 报错：

```
Error: Cannot find module 'D:\Program Files\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
```

## 新 shim（可用）

`D:\tools\bin\dsh.cmd`：

```bat
@echo off
rem DSH CLI shim. Harness moved its CLI: resources\app\dsh\... no longer exists (asar layout).
rem This delegates to the official runtime shim so Harness upgrades keep working.
rem Old shim backed up next to this file as dsh.cmd.bak-<timestamp>.
call "D:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" %*
exit /b %errorlevel%
```

## 官方入口在哪

`D:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`：

```bat
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
```

即：**Electron 以 node 模式跑 asar 内的 `@deepseek-ai/dsh-desktop-host/lib/cli.js`** —— 这是 Harness 自己维护的入口，随版本升级自动生效，所以 shim 委托它比写死 asar 路径更稳。

`resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\` 里只有 `dsh-session-log-export`、`libreoffice-kit*`，**没有 dsh CLI 本体** —— 旧 shim 指向的包名在 unpacked 里也不存在。

## 备份

- `D:\tools\bin\dsh.cmd.bak-20261104-111459`（115 字节，原内容如上一节「旧 shim」）

## 验证

| 命令 | 结果 |
|---|---|
| `where dsh` | `D:\tools\bin\dsh.cmd` |
| `dsh --version` | `0.2.1-rc.5`（exit 0） |
| `cmd /d /s /c "dsh.cmd --version"`（模拟 adapter 探测） | `0.2.1-rc.5`（exit 0） |
| 旧 shim 对照 | `Cannot find module …`（exit 1） |
| `POST /api/sessions {cli:'dsh'}` | **200**，会话创建成功（id `c2f6eccb…`，随后删除 204） |

## 已知遗留（不在本卡范围）

`GET /api/clis` 仍返回 `dsh: installed=false, version=null` —— 因为该接口读**进程启动时的内存缓存**（`services/cliDetect.ts:5`，只在 `index.ts:132` 启动时 `refreshClis`，无刷新端点、无 TTL）。当前 8787 进程（pid 50772）启动早于本次 shim 修复，所以缓存是旧的；**重启服务后即会显示可用**。会话创建走的是实时 `adapter.detect()`，已实测 200，不受该缓存影响。

## 未验证

- DSH 真实对话轮次（会话创建成功，但未跑 prompt；`dsh` 需已完成 profile 配置）；
- Harness 下次升级后 runtime shim 路径是否保持（当前按「官方入口」设计，理论免疫）。
