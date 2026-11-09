---
id: 3eeca147-8df0-4cac-aee7-520df1afd1b5
slug: dsh-plugin-install-gates
title: DSH 第三方插件安装与版本门禁处置（ponytail 5.6.2 实录）
scope: workspace
revision: 1
status: active
updated_at: 2026-11-09T09:38:54.062Z
---

# DSH（DeepSeek Harness）第三方插件安装与版本门禁处置

适用范围：给本机 dsh（Electron + CLI，运行时 0.2.2-rc.1，配置目录 `C:\Users\31633\.dsh`）安装 npm 形态的 cordis 插件。

## 插件形态与注册位置

- 插件是 npm 包，包内 `cordis.patch.yml` 向宿主配置 insert 自己的行；`package.json` 的 `dsh.bundle` / `dsh.profile` 提供元信息。
- 真正生效需要两处登记：`profiles/<profile>/package.json` 的 `dependencies` 与 `dsh.profile.bundles`；模块从 `profiles/<profile>/node_modules` 解析（`nodeLinker: hoisted`）。
- 官方安装命令：`dsh plugin --profile <profile> add <pkg>@<ver>`（内部转发 pnpm），成功后自动写两处登记。

## 版本门禁：engines.dsh 超出上界

- 现象：`dsh: installation rejected: Plugin <pkg>@<ver> is incompatible with dsh <ver>: requirements {"engines.dsh":">=0.2.0-rc.1 <=0.2.1"}. Exact-version exemption: not active.`
- 处置：给「精确包 + 精确 dsh 版本」豁免，不改运行时、不改插件源码：
  `dsh plugin --profile <profile> allow-version <pkg>@<ver> --dsh-version <本机 dsh 版本> --accept-risk`
- 豁免落盘在 `profiles/<profile>/compatibility.json`（形如 `{"<pkg>@<ver>":["0.2.2-rc.1"]}`），逐 profile 生效。
- 判定是否可豁免的依据：插件只用到 cordis 稳定 API、peer 由宿主提供且无破坏性变更时，风险可控；有 native 依赖或 peer 大版本跳跃时不要豁免，应换版本。

## profile 归属：desktop 只能由 Electron 启动

- `dsh --profile desktop --dump-config` / `--dump-default-config` 会报 `profile "desktop" is managed exclusively by the Electron application`。
- 结论：桌面 profile 的配置合成只能靠应用本身（重启后生效）；CLI 验证要在别的 profile（如 `web`，或临时建的 profile）上做，验证完删除临时 profile。

## pnpm 被既有坏依赖阻断（重要坑）

- 现象：安装任意新插件时 pnpm 报 `[ERR_PNPM_FETCH_404] GET https://codeload.github.com/<owner>/<repo>/tar.gz/<commit>: Not Found`，点名的是**另一个**已失效的 git 直依。
- 原因：pnpm 在 `add` 时会重解析 profile 里所有直接依赖；`github:` 形态且仓库/commit 已消失的依赖必然 404。`--prefer-offline` / `--offline` 无效（store 里没有该 tarball）。
- 最小改动绕行（不动无关扩展）：
  1. 从 registry 取官方 tarball（`https://registry.npmmirror.com/<pkg>/-/<name>-<ver>.tgz`），用 registry 的 `dist.integrity`（sha512）核对；
  2. 解压到 `profiles/<profile>/node_modules/<scope>/<name>`（npm tarball 内是 `package/` 目录，移动后改名）；
  3. 手工登记 `package.json` 的 `dependencies` 与 `dsh.profile.bundles`。
- 遗留风险：`pnpm-lock.yaml` / `node_modules/.modules.yaml` 不会包含该包，后续 pnpm 操作可能把它当多余包处理；彻底解决要先修掉坏依赖的 spec（属于单独的卡）。

## 验证套路

- 干净 profile 走官方路径装一遍，再 `dsh --profile <临时profile> --dump-config`，命中 `- id: ponytail / name: '@wenaixi/dsh-ponytail'` 即证明补丁合成与包可加载。
- 手工落地的包要与官方安装产物逐文件 SHA256 比对（本次 58 个文件全等）。
- 桌面 profile 真正加载需用户重启 Electron 应用；CLI 无法替代。

