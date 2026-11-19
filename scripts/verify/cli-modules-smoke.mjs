#!/usr/bin/env node
/**
 * CLI 模块加载冒烟（比 `node --check` 更硬）。
 *
 * 为什么需要：`node --check` 只做单文件语法解析，抓不到 **import 期**的失败：
 *   - ESM 解析错误（`"type": "module"` 下的 exports/import 不匹配）
 *   - 循环依赖导致的初始化顺序问题
 *   - 模块顶层副作用抛错（如顶层 `JSON.parse` 坏数据、`process.env` 缺失时 throw）
 *
 * 做法：真的 `await import(fileUrl)`，不是只解析。
 * 2026-11-17 事故中，这个方法定位到「可加载 26 个，失败 1 个」，
 * 比只跑 `node --check packages/cli/dist/index.js` 精确得多（后者只查入口，不查它 import 了什么）。
 *
 * **只 import，不调用任何命令**：不执行 cli 业务逻辑、不写文件、不连服务。
 *
 * 用法：
 *   node scripts/verify/cli-modules-smoke.mjs                  # 默认 packages/cli/dist
 *   node scripts/verify/cli-modules-smoke.mjs some/dist        # 任意包的 dist 根
 *
 * 退出码：0 全部可加载；1 有模块加载失败（跑完**全部**模块再统一退出，非第一个就退出）
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DEFAULT_DIST = 'packages/cli/dist';

/** 递归收集 *.js；`index.js` 排最后，因为它通常聚合其它模块，先加载它必然连带加载全部 */
function collectJs(dir) {
  const out = [];
  const walk = (cur) => {
    for (const name of readdirSync(cur)) {
      const full = join(cur, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && name.endsWith('.js')) out.push(full);
    }
  };
  walk(dir);
  const isIndex = (p) => p.endsWith('index.js');
  return [...out.filter((p) => !isIndex(p)), ...out.filter(isIndex)];
}

const args = process.argv.slice(2);
const distDir = resolve(ROOT, args[0] ?? DEFAULT_DIST);

if (!existsSync(distDir)) {
  console.error(`[cli-modules-smoke] 找不到编译产物：${relative(ROOT, distDir)}（先跑 build）`);
  process.exit(1);
}

const files = collectJs(distDir);
if (files.length === 0) {
  console.error(`[cli-modules-smoke] ${relative(ROOT, distDir)} 下没有 .js`);
  process.exit(1);
}

/** 逐个真 import；收集**全部**失败后再统一退出 */
const failures = [];
let ok = 0;
for (const file of files) {
  try {
    await import(pathToFileURL(file).href);
    ok += 1;
  } catch (error) {
    const firstLine = String(error?.message ?? error).split('\n')[0];
    failures.push({ file: relative(ROOT, file).split('\\').join('/'), detail: firstLine });
  }
}

const commandModules = files.filter((p) => p.includes(`${join('dist', 'commands')}`)).length;

if (failures.length > 0) {
  console.error(`[cli-modules-smoke] ✘ ${failures.length}/${files.length} 个模块加载失败：`);
  for (const f of failures) {
    console.error(`  - ${f.file}`);
    console.error(`    ${f.detail}`);
  }
  process.exit(1);
}

console.log(`[cli-modules-smoke] ✔ CLI 模块加载通过（${ok} 个模块，其中 command 模块 ${commandModules} 个）`);
