#!/usr/bin/env node
/**
 * BUILD-FRESHNESS：判定「构建产物是否落后于源码」（只比对 mtime，不触发构建）。
 *
 * 背景（N-06）：`kb knowledge --help` 曾因 `packages/cli/dist` 比 `src` 旧，抛
 * `ReferenceError: addHelpText is not defined`——agent 容易误判为「命令写错」。
 * 背景（L-09）：`pnpm server:ensure` 只探活、不比对构建时间，会继续复用早于 dist 的旧进程，
 * 于是 `kb knowledge resolve` 报「接口不存在」。
 *
 * 本模块只提供纯判定，退出码与提示由调用方决定（`scripts/check-stale.mjs`、`scripts/server-detached.mjs`）。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts']);
/** 不参与比对的目录（产物、依赖、测试用例） */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'test', '__tests__']);

function collectSources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectSources(join(dir, entry.name), out);
    } else if (SOURCE_EXT.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** src 目录下最新的源码文件 { path, mtimeMs }；目录不存在或无源码 → null */
export function newestSource(srcDir) {
  if (!existsSync(srcDir)) return null;
  let newest = null;
  for (const file of collectSources(srcDir)) {
    const { mtimeMs } = statSync(file);
    if (newest === null || mtimeMs > newest.mtimeMs) newest = { path: file, mtimeMs };
  }
  return newest;
}

export function formatDateTime(ms) {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function formatLag(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} 小时` : `${Math.round(hours / 24)} 天`;
}

/**
 * 判定单个包。返回：
 *   { ok: true, distMtime, srcPath, srcMtime }
 *   { ok: false, kind: 'missing-dist' | 'stale', detail, distMtime?, srcPath?, srcMtime? }
 */
export function checkBuildFreshness({ srcDir, distEntry }) {
  const src = newestSource(srcDir);
  const distMtime = existsSync(distEntry) ? statSync(distEntry).mtimeMs : null;
  if (distMtime === null) {
    return { ok: false, kind: 'missing-dist', detail: `产物缺失：${distEntry}`, srcPath: src?.path, srcMtime: src?.mtimeMs };
  }
  if (src === null) return { ok: true, distMtime };
  if (src.mtimeMs > distMtime) {
    const detail = `产物陈旧：源码 ${src.path}（${formatDateTime(src.mtimeMs)}）比产物 ${distEntry}（${formatDateTime(distMtime)}）新约 ${formatLag(src.mtimeMs - distMtime)}`;
    return {
      ok: false,
      kind: 'stale',
      detail,
      srcPath: src.path,
      srcMtime: src.mtimeMs,
      distMtime,
    };
  }
  return { ok: true, distMtime, srcPath: src.path, srcMtime: src.mtimeMs };
}
