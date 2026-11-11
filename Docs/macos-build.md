# macOS 构建与打包前置

适用：在 macOS 上从源码运行 AgentBoard、构建 Tauri v2 桌面壳（`desktop/src-tauri`）与 `.app` / `.dmg`。
Windows 侧口径不变；签名与分发两条路径见根 `README.md` 的「桌面壳打包与分发（macOS）」。

## 1. 依赖清单

| 依赖 | 要求 | 检查命令 | 安装 |
| --- | --- | --- | --- |
| Xcode Command Line Tools | 含 macOS SDK | `xcode-select -p` → `/Library/Developer/CommandLineTools` | `xcode-select --install` |
| Rust 工具链 | rustup + stable cargo | `rustc -V`、`cargo -V` | 见 §2 |
| Rust target | Apple Silicon：`aarch64-apple-darwin`；Intel 或 universal 另加 `x86_64-apple-darwin` | `rustup target list --installed` | `rustup target add aarch64-apple-darwin` |
| Node.js | ≥ 20（`engines.node`） | `node -v` | 官方安装包或 nvm |
| pnpm | 11.18.0（根 `packageManager`） | `pnpm -v` → `11.18.0` | 见 §3 |
| Tauri CLI | 2.x，由 `desktop` 的 devDependencies 提供，不需要全局安装 | `pnpm --dir desktop exec tauri --version` | 根目录 `pnpm install` 后即有 |

2026-11-11 首次 mac 试用实测可用组合：macOS 26.6.2 arm64 / Xcode CLT / rustup 1.99.1（minimal）/ Node 22.14.0 / pnpm 11.18.0 / Tauri CLI 2.12.4。

## 2. 安装顺序

```bash
# 1) Xcode Command Line Tools（弹窗安装，完成后重开终端）
xcode-select --install

# 2) rustup（minimal 足够；安装后 cargo/rustc 在 ~/.cargo/bin）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
source "$HOME/.cargo/env"

# 3) Apple Silicon 目标；要 universal 或 Intel 包时再补 x86_64
rustup target add aarch64-apple-darwin
rustup target add x86_64-apple-darwin   # 可选：--arch universal / x64

# 4) Node.js ≥ 20（已有则跳过，node -v 确认）

# 5) pnpm 11.18.0（corepack 可用时）
corepack enable
corepack prepare pnpm@11.18.0 --activate

# 6) 仓库依赖与构建（与 README 的 `corepack pnpm ...` 等价：有 corepack 时两者都可用）
pnpm install
pnpm -r build
```

## 3. corepack 缺失的坑

独立构建 / 被发行版剥离的 Node 可能**不带 corepack**，此时 `corepack enable` 报 `command not found`，`pnpm -v` 也不存在。不要为此重装 Node，直接用 npm 把 pnpm 装到用户目录：

```bash
npm install --prefix "$HOME/.local" -g pnpm@11.18.0
export PATH="$HOME/.local/bin:$PATH"     # 写入 ~/.zshrc 可长期生效
```

验证（必须能定位到刚装的 pnpm，且版本与根 `packageManager` 一致）：

```bash
which pnpm        # 期望 ~/.local/bin/pnpm
pnpm -v           # 期望 11.18.0
```

`--prefix "$HOME/.local"` 不写系统目录、不需要 sudo；不要混用「全局 npm 装的 pnpm」和 corepack 激活的 pnpm，两个 shim 同时存在时先 `which -a pnpm` 确认优先级。

## 4. 前置自检

```bash
node -v                                      # ≥ 20
pnpm -v                                      # 11.18.0
xcode-select -p
rustc -V && cargo -V
rustup target list --installed               # 含 aarch64-apple-darwin

node scripts/desktop/build-macos.mjs --dry-run --json
```

`--dry-run` 退出码应为 0；报告里 `Xcode Command Line Tools` / `rustc` / `cargo` / `rust target ...` / `node 二进制` 为 `ok`。未设置 `APPLE_SIGNING_IDENTITY` 时「签名身份」为 `missing`、未提供公证凭据时「公证凭据」为 `missing`——这只是说明产物不能外部分发，不影响本机构建与自用（见根 README 的两条分发路径）。

## 5. macOS 与 Windows 的差异

| 项 | Windows | macOS |
| --- | --- | --- |
| 数据/配置目录 | `%APPDATA%\AgentBoard` | `~/.config/AgentBoard` |
| 开机自启 | HKCU Run + `scripts/agentboard.vbs` | `~/Library/LaunchAgents/com.agentboard.server.plist`（`kb autostart`） |
| 桌面壳产物 | `desktop/src-tauri/target/release/`（exe） | `desktop/src-tauri/target/<rust-target>/release/bundle/{macos,dmg}/` |
| 分发 | 未签名 exe / 便携包 | 未签名（本机自用）或 Developer ID + 公证（外部分发） |
