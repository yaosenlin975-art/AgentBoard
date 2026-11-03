#!/usr/bin/env node
/**
 * 正式页重建（TEST-PAGE 配套）：把 apps/web 源码重新构建成 `apps/web/dist`，8787 正式页才会更新。
 *
 * 何时用：**只在卡关闭 / 批量收口时执行**（用户要求「任务关闭后才在正式页展示」）。
 * 日常改界面不要重建 dist，用测试页 `pnpm dev:test-page`（固定 5174）验证即可。
 *
 * 用法：node scripts/rebuild-web-dist.mjs   或   pnpm publish:web
 * 说明：只跑 web 包构建（tsc --noEmit && vite build），不碰 server/其他包；失败时退出码非 0 并打印尾部日志。
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const started = Date.now();

console.log('[publish:web] 开始重建正式页产物（apps/web/dist）…');
const result = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['--filter', '@agentboard/web', 'build'],
  { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' },
);

if (result.status !== 0) {
  console.error(`[publish:web] 构建失败（exit ${result.status}），正式页保持旧产物；请先修类型/构建错误。`);
  process.exit(result.status ?? 1);
}
console.log(`[publish:web] 完成，用时 ${Date.now() - started}ms。8787 正式页刷新后即为新产物（静态目录无需重启服务）。`);
