#!/usr/bin/env node
/**
 * 包内规则自检：校验 app/rules 文件清单与 sha256、五个必需技能、kb CLI 帮助可用性。
 * 用法：check-rules.cmd（或 runtime\node.exe app\verify-rules.mjs）
 * 退出码：0 齐全；1 缺失 / 哈希不符 / 技能不齐 / CLI 帮助失败。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(APP, 'rules-manifest.json');
const REQUIRED_SKILLS = ['using-agentboard', 'writing-task', 'executing-task', 'handoff', 'swing-dev'];

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const problems = [];
let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
} catch (error) {
  console.error(`[rules] 无法读取清单 ${MANIFEST_PATH}: ${error.message}`);
  process.exit(1);
}

for (const entry of manifest.files) {
  const path = join(APP, 'rules', entry.path);
  if (!existsSync(path)) {
    problems.push(`缺失: rules/${entry.path}`);
    continue;
  }
  if (sha256(path) !== entry.sha256) problems.push(`哈希不符: rules/${entry.path}`);
}

for (const skill of REQUIRED_SKILLS) {
  const p = join(APP, 'rules', 'skills', skill, 'SKILL.md');
  if (!existsSync(p)) problems.push(`技能缺失: skills/${skill}/SKILL.md`);
}

const cli = join(APP, 'cli', 'index.js');
const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 20000 });
if (help.status !== 0 || !(help.stdout ?? '').trim()) {
  problems.push(`kb --help 不可用（exit ${help.status}）：${(help.stderr ?? '').trim().slice(0, 200)}`);
}

if (problems.length > 0) {
  console.error(`[rules] 失败：${problems.length} 项`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
const skillCount = new Set(manifest.files.filter((f) => f.path.startsWith('skills/')).map((f) => f.path.split('/')[1])).size;
console.log(`[rules] OK：${manifest.files.length} 个文件，${skillCount} 个技能，AGENTS.md / README.md / Docs/api.md 齐全，kb --help 可用。`);
console.log(`[rules] 规则来源：${manifest.sources.map((s) => `${s.name} <- ${s.path}`).join(' | ')}`);
