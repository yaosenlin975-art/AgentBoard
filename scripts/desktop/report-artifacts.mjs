#!/usr/bin/env node
/**
 * D11/D13 验收取证：三份产物的 mtime / PE / 体积对照表 + 容器内层校验。
 *
 * 为什么要这个脚本：D11 当时手工比「产物 mtime vs 源码 mtime」，zip 外层 mtime 是
 * 打包时刻（永远新），漏掉了内层旧壳。D13 起改为验内层 PE，本脚本把取证步骤固化，
 * 避免再次用错判据。口径见 `Docs/desktop-build-pitfalls.md` 坑 4。
 *
 * 用法：node scripts/desktop/report-artifacts.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP_EXE = join(ROOT, 'desktop', 'src-tauri', 'target', 'release', 'agentboard-desktop.exe');
const PKG_SHELL = join(ROOT, 'dist-package', 'AgentBoard', 'app', 'desktop', 'agentboard-desktop.exe');
const NSIS_DIR = join(ROOT, 'desktop', 'src-tauri', 'target', 'release', 'bundle', 'nsis');

function pe(file) {
  if (!existsSync(file)) return null;
  const buffer = readFileSync(file);
  if (buffer.length < 0x40 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) return null;
  const offset = buffer.readInt32LE(0x3c);
  if (offset <= 0 || offset + 12 > buffer.length) return null;
  const seconds = buffer.readUInt32LE(offset + 8);
  if (seconds === 0) return null;
  return {
    iso: new Date(seconds * 1000).toISOString(),
    local: new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false }),
    size: buffer.length,
  };
}

function newestMtime(dir, filter = () => true) {
  if (!existsSync(dir)) return null;
  let newest = 0;
  let file = '';
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && filter(entry.name)) {
        const mtimeMs = statSync(full).mtimeMs;
        if (mtimeMs > newest) {
          newest = mtimeMs;
          file = full;
        }
      }
    }
  };
  walk(dir);
  return newest === 0 ? null : { mtimeMs: Math.round(newest), file: relative(ROOT, file) };
}

const rows = [];

const srcServer = newestMtime(join(ROOT, 'apps', 'server', 'src'), (n) => n.endsWith('.ts'));
const srcRust = newestMtime(join(ROOT, 'desktop', 'src-tauri', 'src'));
const dist = newestMtime(join(ROOT, 'apps', 'server', 'dist'));

console.log('── 源码基准 ──');
for (const [label, info] of [
  ['server src 最新', srcServer],
  ['rust src 最新', srcRust],
  ['server dist 最新', dist],
]) {
  console.log(
    `  ${label.padEnd(18)} ${info === null ? '（无）' : `${new Date(info.mtimeMs).toLocaleString('zh-CN', { hour12: false })}  ${info.file}`}`,
  );
}

console.log('\n── 壳 PE（判定壳产物新鲜度与两端一致性的唯一判据）──');
const refPe = pe(DESKTOP_EXE);
const pkgPe = pe(PKG_SHELL);
for (const [label, info] of [
  ['源码 release 壳', refPe],
  ['便携包内层壳', pkgPe],
]) {
  console.log(`  ${label.padEnd(18)} ${info === null ? '（不存在）' : `PE ${info.local}  ${info.size} B`}`);
}
if (refPe !== null && pkgPe !== null) {
  console.log(`  → 包内壳与源码壳同一次编译: ${refPe.iso === pkgPe.iso ? '✔ 是' : '✘ 否（旧壳被打进包）'}`);
}

console.log('\n── 产物文件 ──');
const zips = existsSync(ROOT)
  ? readdirSync(ROOT)
      .filter((n) => /^AgentBoard-win-x64-.+\.zip$/.test(n))
      .map((n) => join(ROOT, n))
  : [];
for (const zip of zips) {
  rows.push(['便携包 zip', zip, statSync(zip)]);
}
if (existsSync(NSIS_DIR)) {
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/-setup\.exe$/i.test(entry.name)) rows.push(['NSIS 安装包', full, statSync(full)]);
    }
  };
  walk(NSIS_DIR);
}
if (existsSync(DESKTOP_EXE)) rows.push(['release 壳 exe', DESKTOP_EXE, statSync(DESKTOP_EXE)]);

for (const [label, file, stats] of rows) {
  console.log(
    `  ${label.padEnd(18)} ${new Date(stats.mtimeMs).toLocaleString('zh-CN', { hour12: false })}  ${(stats.size / 1024 / 1024).toFixed(2)} MB  ${relative(ROOT, file)}`,
  );
}

console.log('\n── 时序校验（产物晚于源码只是必要条件，内层 PE 才是充分条件）──');
const newestSrc = Math.max(srcServer?.mtimeMs ?? 0, srcRust?.mtimeMs ?? 0);
for (const [label, , stats] of rows) {
  console.log(`  ${label.padEnd(18)} 晚于最新源码: ${stats.mtimeMs > newestSrc ? '✔' : '✘'}`);
}
if (refPe !== null && newestSrc > 0) {
  const peMs = new Date(refPe.iso).getTime();
  console.log(`  ${'壳 PE'.padEnd(18)} 晚于壳源码: ${peMs >= newestSrc ? '✔' : '✘（源码改了壳没重编）'}`);
}
