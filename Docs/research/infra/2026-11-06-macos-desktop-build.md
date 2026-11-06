# macOS 桌面壳构建与签名（DESKTOP-3）

状态：脚本与文档已交付；**未在 macOS 真机验证**（开发机为 Windows）。本页记录构建前置、平台口径与缺失项，供 mac 机器上复核。

关联卡：DESKTOP-3 `f42b6f18-f9e0-468a-a891-ff8cc68cddb8`。设计依据：`Docs/design-2026-11-05-desktop-presentation.md` §8（方案 C/Tauri 已定稿，本页只写平台分支，不改架构）。

## 1. 入口

```bash
node scripts/desktop/build-macos.mjs --dry-run     # 任意平台可跑：前置核查 + 打印计划，不做任何构建
node scripts/desktop/build-macos.mjs               # 仅 macOS：前置 → tauri build → codesign → notarize
pnpm desktop:mac                                   # 同上（等价入口）
```

常用参数：`--arch arm64|x64|universal`（缺省取当前机器架构）、`--no-notarize`、`--json`。
退出码：0 成功；1 前置缺失或步骤失败；2 平台不支持（非 darwin 且未加 `--dry-run`）。

## 2. 平台口径（设计 §8.4）

| 项 | Windows | macOS |
| --- | --- | --- |
| 渲染 | WebView2 Runtime（系统组件） | WKWebView（系统自带，无安装项） |
| 托盘 | Tauri 官方托盘 API | 同一套 API（菜单栏图标），不写平台私有实现 |
| node 二进制 | `runtime\node.exe` | `runtime/darwin-<arch>/node`（或 PATH 上的 `node`） |
| 产物 | `.exe` | `.app` / `.dmg` |

- 渲染与托盘：Tauri v2 在 macOS 上由 wry 落到 WKWebView，托盘走官方 API 的菜单栏分支，**本脚本无需平台开关，也不引入 WebView2/Chromium 依赖**。
- node 二进制按平台分发，脚本按此顺序解析：`AGENTBOARD_NODE_DARWIN` → `runtime/darwin-<arch>/node` → `runtime/darwin/node` → `runtime/node` → PATH 上的 `node`。候选中出现 `.exe` 直接判失败，禁止把 Windows 二进制交叉打进 mac 包。
- Windows 侧路径未变：`scripts/package-portable.mjs` 仍取 `runtime\node.exe`、壳产物仍取 `desktop/src-tauri/target/release/agentboard-desktop.exe`，本卡未改动这些行。

## 3. 构建前置（macOS 机器）

| 项 | 检查命令 | 缺失时 |
| --- | --- | --- |
| macOS + Xcode Command Line Tools | `xcode-select -p` | `xcode-select --install` |
| Rust 工具链 | `rustc -V`、`cargo -V` | 装 rustup 后 `rustup default stable` |
| 目标架构 | `rustup target list --installed` | `rustup target add aarch64-apple-darwin`（Apple Silicon）/ `x86_64-apple-darwin`（Intel）/ 两者都装做 universal |
| 签名证书 | 钥匙串里有 `Developer ID Application` | Apple Developer 账号导出并导入证书 |
| 公证凭据 | `APPLE_ID` + `APPLE_TEAM_ID` + `APPLE_APP_SPECIFIC_PASSWORD`，或 `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` | App Store Connect 生成专用密码或 API Key |

脚本对每项都会打出 `OK` / `MISS`；`MISS` 不阻断 `--dry-run`，真实构建时缺 Xcode CLT、Rust、rust target 会停在构建步骤。

## 4. 构建、签名、公证

1. `pnpm --dir desktop run build -- --target <rust-target> --bundles app,dmg`（脚本内部执行；`desktop` 是独立子工程，不在根 workspace 内）。
2. 产物：`desktop/src-tauri/target/<rust-target>/release/bundle/macos/AgentBoard.app` 与 `bundle/dmg/*.dmg`。
3. 签名：设 `APPLE_SIGNING_IDENTITY` 后脚本执行 `codesign --force --deep --options runtime --sign <id> AgentBoard.app`；存在 `desktop/src-tauri/entitlements.plist` 时一并带上。未设身份 → 产物未签名（脚本打 `SKIP`，不假装已签）。
4. 公证（notarization）：凭据齐备时 `xcrun notarytool submit <dmg> --wait` + `xcrun stapler staple <dmg>`；凭据缺失 → 跳过并标注。外部分发前必须补做，否则 Gatekeeper 拦截。

`tauri.conf.json` 的 `bundle.targets` 仍是 `["nsis"]`（Windows 安装器）；mac 产物由命令行 `--bundles app,dmg` 指定，因此**不必改这个文件**，Windows 行为零改动。

## 5. 缺失项与未验证清单

- **未真机验证**：本轮无 macOS 机器，`.app`/`.dmg` 是否真能产出、WKWebView 是否正常加载 `http://127.0.0.1:8787`、菜单栏托盘图标是否显示、关窗隐藏与优雅停服是否成立，全部未验证。
- **未验证**：`codesign` 与 `notarytool` 分支未实跑（本机无证书与凭据）；`entitlements.plist` 目前不存在，签名走无 entitlements 路径。
- **未验证**：darwin 版 node 二进制尚未入库（`runtime/**` 不在本卡改动范围），mac 首次构建前需自备 `runtime/darwin-<arch>/node`，或依赖目标机 PATH 上的 node。
- **未验证**：`better-sqlite3` 需 darwin 架构原生模块（server 是独立 node 进程，不涉及 WebView ABI；但原生模块要按 mac 架构重装/编译）。
- 校验方式：mac 上依次跑 `--dry-run`（应全 OK 或仅签名/公证 MISS）→ 真实构建 → 双击 `.app` 确认窗口与托盘 → `codesign --verify --deep --strict AgentBoard.app`。

## 6. 本轮实跑记录（Windows）

- `node --check scripts/desktop/build-macos.mjs` → 退出 0。
- `node scripts/desktop/build-macos.mjs --dry-run` → 退出 0，`Tauri 壳工程 OK`、`目标架构 OK`、`运行平台 INFO（win32，仅打印计划）`。
- `node scripts/desktop/build-macos.mjs`（非 darwin 无 `--dry-run`）→ 退出 2，`FAIL 运行平台：非 darwin（win32）`。
- 以上仅证明脚本自身可执行与门禁正确，**不构成 macOS 可用性证据**。
