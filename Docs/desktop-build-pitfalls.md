# 桌面端构建环境坑（Windows）

适用：在 Windows 本机执行 `node scripts/desktop/build-all.mjs`（便携包 + NSIS）或任何带 `pnpm -r build` 的构建。
关联卡：D11（重打两份分发产物）、D12（本文档）。

---

## 坑 1：pnpm 非 TTY 构建阻塞【危险级】

### 现象

非 TTY 环境（后台任务、CI、被父进程 `spawn`）执行 `pnpm -r build` / `pnpm run <script>` 时，构建在启动阶段就失败：

```
Scope: all 7 workspace projects
[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY] Aborted removal of modules directory due to no TTY

If you are running pnpm in CI, set the CI environment variable to "true", or set
"confirmModulesPurge" to "false".
[ERROR] Command failed with exit code 1: pnpm install --production
```

根因：pnpm 11 的 deps-status 检查在跑任何 script 之前，会先尝试 `pnpm install --production` 让依赖与 lockfile 同步；它判定需要清空 `node_modules` 重建，而清空操作要求 TTY 确认。

### 无效尝试

以下四种都**不能**解决问题（逐一实测）：

| 写法 | 结果 |
|---|---|
| `$env:npm_config_verify_deps_before_run = 'false'` | 无效，仍报同一错误 |
| `.npmrc` 写 `verify-deps-before-run=false` | 无效 |
| `.npmrc` 写 `confirmModulesPurge=false` | 无效 |
| `corepack pnpm config get verify-deps-before-run` | 返回 `undefined`，说明该键未被识别 |

### 危险操作

```
❌ $env:CI = 'true'
```

**它会"通过"，然后静默删掉全部 devDependencies。**

`CI=true` 让 pnpm 跳过 TTY 确认并真的执行 `install --production`，输出 `Packages: -333`，随后：

```
typescript : 不在     esbuild : 不在     prettier : 不在
eslint     : 不在     vite    : 不在     vitest   : 不在
```

构建随即在 `@agentboard/shared build: tsc -p tsconfig.build.json` 处失败（`tsc` 已不存在）。

**后果比构建失败严重**：这是静默的依赖破坏，不报"我删了你的依赖"，只在后续步骤以奇怪方式崩。仓库里若有人照抄这条"过 CI 的写法"，会把开发环境废掉。

**恢复**（约 85 秒）：

```
corepack pnpm install --frozen-lockfile --config.confirmModulesPurge=false
```

`--config.confirmModulesPurge=false` 必需：环境已处于"需清空重建"状态，不加它仍被 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 拦住。

### 有效解法

**显式传 `--config.verify-deps-before-run=false`**：

```
corepack pnpm --config.verify-deps-before-run=false -r build
corepack pnpm --config.verify-deps-before-run=false build:desktop:all
```

该参数必须给到 pnpm 本身，`npm run` / `pnpm run` 内部转发的写法不生效。

已固化位置：

- `scripts/desktop/build-all.mjs` 的 `runPnpm()`（所有 pnpm 调用都经它）
- `package.json` 的 `build` 脚本：`pnpm --config.verify-deps-before-run=false -r build`

### 复现命令

```
# 复现失败（非 TTY 下）
powershell -NoProfile -Command "corepack pnpm -r build"

# 验证有效解法
powershell -NoProfile -Command "corepack pnpm --config.verify-deps-before-run=false -r build"
```

---

## 坑 2：corepack 三层 Windows spawn 陷阱

### 现象

脚本内用 `spawnSync` 调 `corepack` 或 `pnpm`，逐层碰到三个错误：

| 尝试 | 错误 |
|---|---|
| `spawnSync('corepack', [...], { shell: false })` | `spawnSync corepack ENOENT` |
| 解析成 `C:\Program Files\nodejs\corepack.cmd` 后同样调用 | `.cmd` 不能 `CreateProcess`，静默失败或 ENOENT |
| 改走 `cmd.exe /d /s /c <shim>` | `'C:\Program' is not recognized as an internal or external command` |
| 给 shim 路径加引号 | 引号被二次包裹，报 `'\"C:\Program Files\nodejs\corepack.cmd\"' is not recognized` |

原因链：PATH 里 `corepack` 有两份（无扩展名的 `corepack` 与 `corepack.cmd`），`shell: false` 只按 CreateProcess 语义找 `.exe`；`.cmd` 必须经 `cmd.exe`；而 `cmd /c` 在含空格的路径上按空格截断，`spawnSync` 的数组参数又会给引号再包一层。

### 无效尝试

- `spawnSync('corepack', …)` 与 `spawnSync('corepack.cmd', …)`：都是 ENOENT / 静默失败
- `shell: true`：能跑，但触发 Node DEP0190（参数拼接不转义），且仍受空格截断影响
- 给数组里的 shim 路径加 `"`：被二次包裹，见上表最后一行
- 按 `PATHEXT` 手动解析扩展名：能拿到 `.cmd` 全路径，但仍卡在第 3 层（空格截断）

### 危险操作

无（本坑不破坏环境，只阻塞构建）。

### 有效解法

**用 `node` 直接执行 pnpm 的 JS 入口，完全绕开 shim**：

```
node "C:\Program Files\nodejs\node_modules\corepack\dist\pnpm.js" --config.verify-deps-before-run=false -r build
```

实测可用，不受路径空格影响，也不触发 DEP0190。

已固化位置：`scripts/desktop/build-all.mjs` 的 `resolvePnpmEntry()` + `runPnpm()`。解析顺序：

1. `<dirname(process.execPath)>/node_modules/corepack/dist/pnpm.js`（Node 自带 corepack 的标准位置）
2. `%LOCALAPPDATA%/node/corepack/v1/pnpm/<version>/dist/pnpm.mjs`（`corepack enable` 后的缓存，取最高版本）
3. 都没命中才回退 `corepack pnpm …`（保留可用性，但会撞上面的坑）

### 复现命令

```
# 复现 ENOENT
node -e "require('child_process').spawnSync('corepack', ['--version'], { shell: false })"

# 验证有效解法
node -e "require('child_process').spawnSync(process.execPath, ['C:/Program Files/nodejs/node_modules/corepack/dist/pnpm.js', '--version'], { shell: false, stdio: 'inherit' })"
```

---

## 坑 3：产物归档约定

### 现象

`package-portable.mjs` 用**构建那一刻**的 HEAD 给 zip 命名（`AgentBoard-win-x64-<HEAD>.zip`）。每次重打都会在仓库根留下一个新 zip，旧的不自动清理。仓库根堆积多个 zip 时：

- 容易拿错产物发出去
- `build-all.mjs --verify-only` 可能校验到旧包

### 约定

| 位置 | 内容 |
|---|---|
| 仓库根 | **同一时刻只留一个** `AgentBoard-win-x64-*.zip`（当前有效产物） |
| `.logs/archive/` | 旧产物移入此处；`.logs/` 已在 `.gitignore`，不进历史 |
| `dist-package/` | 便携包解压树（127MB 级），已 gitignore，可随时再生 |
| `desktop/src-tauri/bundle-stage/` | NSIS 打包前的运行时暂存树，已 gitignore |

归档命令：

```
New-Item -ItemType Directory -Force .logs\archive
Move-Item AgentBoard-win-x64-<旧HEAD>.zip .logs\archive\
```

### 无效尝试

直接删除旧 zip —— 失去回滚与对比能力。archive 保留成本接近零（gitignore，不占仓库体积指标）。

### 危险操作

无。

### 有效解法

1. 旧包移到 `.logs/archive/`，仓库根只留当前有效产物
2. `build-all.mjs --verify-only` 的多 zip 处理：取 mtime 最新的那个并打印提示，不静默挑任意一个
3. 双判据防止校验到旧包（见下）

### 复现命令

```
# 查看仓库根有几个 zip
Get-ChildItem AgentBoard-win-x64-*.zip | Select-Object Name, LastWriteTime, Length

# 校验（应 exit 0，且不打印「多个 zip」提示）
node scripts/desktop/build-all.mjs --verify-only
```

---

## 附：`--verify-only` 的 zip 判据口径

判据演进过一次，两处都容易写错：

### 判据 1：zip 名 HEAD 用「祖先」而非「相等」

`package-portable.mjs` 用构建那一刻的 HEAD 命名 zip。若要求「zip 名 == 当前 HEAD」，则**每次「构建 → 提交 → 复验」都必然失败**——提交让 HEAD 前进，产物永远落后于它自己的提交。

正确写法：

```
git merge-base --is-ancestor <zipHead> HEAD
# exit 0 → 是祖先，通过
# exit 1 → 非祖先，失败（拒绝其它分支/未合并提交打的包）
# exit 128 → 无效对象名，失败
```

### 判据 2：必须叠加 mtime

**单靠祖先判定会放过残留旧包**：实测 `git merge-base --is-ancestor b83a269 HEAD` 返回 0，旧包同样是祖先。

因此追加：`zip mtime ≥ 其内部 bundle mtime`。旧包 mtime 早于新 bundle，被拦住。

两条判据缺一不可：祖先判据挡「别的分支」，mtime 判据挡「本分支的历史包」。

### 反例验证

| 用例 | 预期 | 实测 |
|---|---|---|
| 造 `<非祖先HEAD>.zip` 并设最新 mtime | 失败 | exit 1 |
| zip 名合法但 mtime 改到早于 bundle | 失败 | exit 1 |
| 正例：zip 名是当前 HEAD 的祖先 | 通过 | exit 0 |
| 回归：提交产生新 HEAD 后再复验 | 通过 | exit 0 |

---

## 附：安装包内嵌 exe 的新旧判定

**不要用 sha256 比对**安装包内嵌的 `agentboard-desktop.exe` 与 `target/release/` 下的同名文件。

Tauri 打包时会对 exe 写 bundle 类型标记（构建日志：`Patching … with bundle type information: nsis`），导致两者字节不同：

```
PE 时间戳   相同（如 16:11:22）
大小        相同（12,361,728 B）
sha256      不同
差异字节    仅 3 个，位于 0x8a5b9a
3 字节解码  `_NSIS`（内嵌） vs `_UNK`（release）
```

判定方法：**PE 时间戳 + 大小字节数**。两者相同即同一次编译。

静态解包比对（7-Zip，无需安装）：

```
& 'C:\Program Files\7-Zip\7z.exe' x <安装包> -o<输出目录> -y 'agentboard-desktop.exe'
```

PE 时间戳读取：`PE+8` 处为 COFF `TimeDateStamp`（Unix 秒）。
