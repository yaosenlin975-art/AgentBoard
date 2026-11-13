# 桌面端构建环境坑（Windows）

适用：在 Windows 本机执行 `node scripts/desktop/build-all.mjs`（便携包 + NSIS）或任何带 `pnpm -r build` 的构建。
关联卡：D11（重打两份分发产物）、D12（本文档）、D13（容器内层校验）。

**首要原则：所有「容器套内容」的产物都必须验内层。** 外层时间戳只代表容器生成时刻，
zip 里的 exe、NSIS 里的 exe、asar 里的 node_modules 都属此类。见坑 4。

---

## 坑 4：容器套内容——外层时间戳永远是新的

### 现象

便携包 zip 外层 mtime 是**打包时刻**，看起来永远是新的。但里面可能装着上一轮编译的旧壳：

```
zip 外层 mtime     16:09:59   ← 打包时刻，新
zip 内层壳 PE      14:52:49   ← 实际编译时刻，旧
源码 release 壳 PE 16:11:22
```

内层壳缺失的界面文案（D7 的「正在停止服务」/「已在运行」、D10 的「逃出了资源根」）在 `strings` 检索中全部为 False。

### 判据原则

**所有「容器套内容」的产物都必须验内层，外层时间戳只代表容器生成时刻。**

| 产物 | 容器 | 必须验的内层 |
|---|---|---|
| 便携包 zip | zip 外层 mtime | `app/desktop/agentboard-desktop.exe` 的 PE |
| 便携包 zip | zip 外层 mtime | `app/apps/server/dist/index.js` 的 bundle 内容 |
| NSIS 安装包 | setup.exe mtime | 内嵌 `agentboard-desktop.exe` 的 PE |
| NSIS 安装包 | setup.exe mtime | `bundle-stage/apps/server/dist` 整树 |
| 任意 asar / tar | 归档文件 mtime | 归档内的 `node_modules` 与二进制 |

### 无效尝试

- 只比「产物 mtime vs 源码 mtime」：zip 外层 mtime 是打包时刻，必然通过，**漏掉内层**
- 只判 `existsSync(壳)` 就复用：旧壳文件一直存在，永远通过
- 比 sha256：打包会改写 exe 字节（见下文 `_NSIS` / `_UNK`），同一次编译也判不等

### 危险操作

无（本坑不破坏环境，只让缺陷静默通过）。

### 有效解法

1. **构建顺序**：`pnpm -r build` → **构建壳（`--no-bundle`）** → 打便携包 → 打 NSIS
   - 壳必须在打便携包**之前**编好；否则打便携包时 `target/release/` 还是上一轮的
2. **壳产物新鲜度门禁**（`package-portable.mjs` 的 `ensureDesktopExe`）：
   - 判据用 **PE 编译时刻 vs 壳源码最新 mtime**，不用文件 mtime
   - 不新鲜：非 `--skip-build` 重建；`--skip-build` 则 **fail 并说明**
3. **包内壳一致性校验**（`build-all.mjs` 的 `assertPackagedShellMatches`）：
   - 包内壳 PE 必须等于源码 release 壳 PE
   - 便携包与 NSIS 两侧都查
   - `--verify-only` 下同样查，不能只在构建期查

### 复现命令

```
# 看 zip 内层壳的编译时刻（7-Zip 直接列）
& 'C:\Program Files\7-Zip\7z.exe' l <zip> | Select-String 'agentboard-desktop'

# 解出并读 PE
& 'C:\Program Files\7-Zip\7z.exe' e <zip> -o<目录> 'AgentBoard\app\desktop\agentboard-desktop.exe' -y
# 再用 PE 读取法比对（见文末「安装包内嵌 exe 的新旧判定」）

# 校验（会同时查壳新鲜度与包内壳一致性）
node scripts/desktop/build-all.mjs --verify-only
```

---

## 坑 5：同一构建链路可能多次编译同一目标，PE 只可在同目标内比

### 现象

四段式构建里，壳被编译了**两次**：

```
▶ 构建桌面壳：tauri build --no-bundle     → Compiling agentboard-desktop（18.5s）
▶ 打 NSIS：  tauri build --bundles nsis   → Compiling agentboard-desktop（18.2s）
```

两次产物：

```
包内壳（便携包）  PE 08:55:13  12,344,320 B
源码 release 壳   PE 08:55:47  12,344,320 B   ← 同一份源码，仅重链接
```

**字节大小完全相同，PE 相差 34 秒。**

### 判据原则

**同一构建链路可能多次编译同一目标，PE 时间戳只在同一目标内可比。**

跨目标比对 PE，正确判据是「**PE ≥ 该目标的源码最新 mtime**」，不是「两个目标的 PE 相等」。

| 比较对象 | 错误判据 | 正确判据 |
|---|---|---|
| 包内壳 vs 源码 release 壳 | PE 相等 → **必失败** | 各自 PE ≥ 壳源码 mtime |
| NSIS 内嵌壳 vs 源码 release 壳 | PE 相等 → **必失败** | 内嵌壳 PE ≥ 壳源码 mtime |
| 同一个 exe 的两次读取 | — | PE 相等（同目标内可比）|

### 无效尝试

- 比 sha256：Tauri 打包会写 bundle 类型标记（`_NSIS` / `_UNK`），同一次编译的两个副本 sha256 也不同
- 比 PE 相等：如上，双编译导致必不相等
- 比字节大小：两次编译大小确实相同，但**大小相同不代表内容相同**，无法区分新旧源码

### 危险操作

无（本坑只导致校验误报，不破坏环境）。误报的代价是把好的产物判成坏的，逼人反复重打。

### 有效解法

```
包内壳 PE  >= 壳源码最新 mtime   ✔ 能抓「上一轮旧壳被打进新包」
                                ✔ 不受双编译影响
```

实现位置：`scripts/desktop/build-all.mjs` 的 `assertPackagedShellMatches()` 与
`assertNsisEmbedsShell()`。

### 复现命令

```
# 观察两次编译（日志里应有两条 Compiling agentboard-desktop）
node scripts/desktop/build-all.mjs 2>&1 | Select-String 'Compiling agentboard-desktop'

# 看两次 PE 差多少
node scripts/desktop/report-artifacts.mjs
```

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
