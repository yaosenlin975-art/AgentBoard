import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const distDir = fileURLToPath(new URL('../dist', import.meta.url));

// dist 为构建产物（gitignore），未构建时跳过；已构建（pnpm --filter @agentboard/cli build）后真实执行
describe.skipIf(!existsSync(join(distDir, 'index.js')))('入口守卫（真实进程）', () => {
  it('经 junction/symlink 链接目录启动 dist/index.js → main 正常执行：--version 输出 0.0.0、退出码 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-entry-guard-'));
    const link = join(dir, 'link');
    try {
      // Windows junction 无需管理员权限（文件目标不可用，仅目录）；POSIX 上 type 参数被忽略，为目录 symlink
      symlinkSync(distDir, link, 'junction');
      const result = spawnSync(process.execPath, [join(link, 'index.js'), '--version'], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('0.0.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
