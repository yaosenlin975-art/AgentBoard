# 桌面壳自动更新（Tauri updater）选型与发布口径

卡：`7c29eba6-3614-485f-a58f-da70357cd055`（MAC-TRIAL-E5）。当前状态：**已选定方案并留好开关，插件未接线、更新通道未启用**。启用前不得在卡面宣称「可自动更新」。

## 1. 选型：Tauri updater v2（不选 Sparkle）

| 维度 | Tauri updater v2（选定） | Sparkle |
| --- | --- | --- |
| 与现有壳的关系 | 同一套 Tauri 2.12 依赖，`Cargo.toml` 加一个官方插件即可 | 需引入 Sparkle framework / XPC 组件与独立的 appcast.xml |
| 跨平台 | 同一份实现覆盖 macOS + Windows（Windows 用 NSIS 更新包） | 仅 macOS，Windows 要另做一套 |
| 签名模型 | 用**更新包签名密钥**（`TAURI_SIGNING_PRIVATE_KEY`）校验升级包；系统层签名/公证另行要求 | EdDSA 签名 + appcast |
| 代价 | 需要自建静态更新端点（`latest.json`），并且发布包必须签名 | 需要理解 Sparkle 的 appcast 与 XPC，长期维护两套通道 |

结论：选 Tauri updater v2。核心理由是**同一壳、同一打包链**，不额外引入 macOS 专有框架与第二套发布物；代价是自建 `latest.json` 端点，这个代价在单机自用 + 偶尔分发的场景下可以接受。

## 2. 配置项（现在只落了开关）

`desktop/src-tauri/tauri.conf.json`：

```json
"bundle": { "createUpdaterArtifacts": false }
```

- `createUpdaterArtifacts: false` 是当前的**总开关**：关闭时不产出 `.sig`，也不会因为缺签名私钥导致构建失败。
- 启用时改为 `true`；同时必须新增下面三项，缺一不可：
  1. `desktop/src-tauri/Cargo.toml` 增加 `tauri-plugin-updater = "2"`，并在 `main.rs` 注册 `.plugin(tauri_plugin_updater::Builder::new().build())`（Windows/macOS 同一份）。
  2. `tauri.conf.json` 增加：

     ```json
     "plugins": {
       "updater": {
         "endpoints": ["https://<你的静态站点>/agentboard/latest.json"],
         "pubkey": "<tauri signer generate 输出的公钥>"
       }
     }
     ```

  3. `desktop/src-tauri/capabilities/default.json` 的 `permissions` 增加 `"updater:default"`（前端若要在页面里触发检查）。

> 注意：`endpoints` 为空数组或 `pubkey` 为空串时**不要**注册插件——Tauri updater 在初始化阶段就会报错，壳会起不来。所以本卡只落 `createUpdaterArtifacts: false`，插件留到真正配置好端点与公钥之后再接线。

## 3. 密钥与签名

```bash
# 只做一次：生成升级包签名密钥（私钥务必离线保管，不要进仓库）
pnpm --dir desktop exec tauri signer generate -w ~/.tauri/agentboard.key
# 输出公钥 → 填到 plugins.updater.pubkey
# 私钥口令 → 发布时用环境变量传入：
#   TAURI_SIGNING_PRIVATE_KEY=<私钥路径或内容>
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<口令>
```

发布 macOS 包时还需要系统层签名与公证（见 `Docs/macos-build.md` 的两条路径）；两者是**独立**的两层校验：

- 系统层：`codesign` + `notarytool` + `stapler`，决定 Gatekeeper 是否放行；
- 更新层：`TAURI_SIGNING_PRIVATE_KEY` 产出的 `.sig`，决定 updater 是否接受升级包。

任一层缺失都会被拒：未公证的包被 Gatekeeper 拦；签名不匹配的包被 updater 拒绝并给出可读错误。

## 4. 发布新版本步骤（启用后）

1. 改版本号：`desktop/src-tauri/tauri.conf.json` 的 `version` 与 `desktop/src-tauri/Cargo.toml` 的 `version` 同步。
2. 构建（mac 示例）：
   ```bash
   export TAURI_SIGNING_PRIVATE_KEY=~/.tauri/agentboard.key
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=***
   pnpm --dir desktop exec tauri build --bundles app,dmg --target aarch64-apple-darwin
   ```
   产物：`desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/*.app`、`bundle/dmg/*.dmg` 及其 `.sig`。
3. 把 `.app` 打成 `AgentBoard.app.tar.gz`（updater 的 macOS 更新包就是 tar.gz）并保留 `.tar.gz.sig`。
4. 上传更新包与 `.sig` 到静态站点，生成 `latest.json`：

   ```json
   {
     "version": "0.2.0",
     "notes": "更新说明",
     "pub_date": "2026-11-12T00:00:00Z",
     "platforms": {
       "darwin-aarch64": {
         "signature": "<AgentBoard.app.tar.gz.sig 的内容>",
         "url": "https://<站点>/agentboard/AgentBoard_aarch64.app.tar.gz"
       },
       "windows-x86_64": {
         "signature": "<nsis 安装包 .sig 的内容>",
         "url": "https://<站点>/agentboard/AgentBoard_0.2.0_x64-setup.exe"
       }
     }
   }
   ```

5. 旧版本启动后调用 `app.updater()?.check()`：命中新版本 → 下载 → 校验签名 → 安装 → 重启生效。签名不匹配时返回错误，UI 侧要展示可读提示，不能静默失败。

## 5. 当前未做 / 待 mac 复验

- 插件未注册、`latest.json` 端点未搭建、签名密钥未生成（需要真实发布通道，属外部条件）。
- 验收标准第 2 条（旧版本触发一次完整更新流程）与第 3 条（未签名/校验失败被拒的实测）**只能在 mac 真机 + 真实发布通道上验证**，本机（Windows）无法覆盖。
- 本卡交付的是：选型结论、开关（`createUpdaterArtifacts: false`）、发布步骤与签名口径；卡保持待验收，不关闭。
