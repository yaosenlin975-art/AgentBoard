#!/usr/bin/env node
/**
 * RULE-CHANGE01 迁移准备：把旧 `Docs/CHANGELOG.md` 导入 AgentBoard 工作区日志（change_type=历史）。
 *
 * 设计约束（见卡 e22cc2de 与 lead 要求）：
 * - 目标工作区必须显式传 `--workspace <id|name>`，不猜默认值；源文件必须位于该工作区目录内。
 * - 默认只做 preview：打印 SHA-256 与「新增 / 已导入 / 不一致 / 无法解析」对账表，不写库。
 * - 只有 `--apply <preview-sha>` 才写库；apply 前重新计算源 SHA 与参数、preview 三方比对，不一致即非 0 退出。
 * - apply 后逐条对账（条数 / 标题 / 日期 / 正文），输出 PASS/FAIL 表；FAIL 不删源文件、不打印「迁移完成」。
 * - 幂等：同一 SHA 重放时服务端返回「新增 0 条」，脚本识别为幂等重放并正常退出（仍做对账）。
 * - 脚本只读源文件，绝不删除或改写 `Docs/CHANGELOG.md`。
 *
 * 退出码：0 通过（preview 完成 / apply 后对账 PASS / 幂等重放）；2 参数或环境错误；
 *         3 源文件缺失、越界或无法读取；4 源 SHA 不一致（源已变化）；5 apply 失败；
 *         6 apply 后对账 FAIL。
 *
 * 用法：
 *   node scripts/migrate-changelog-to-board.mjs --workspace 任务看板
 *   node scripts/migrate-changelog-to-board.mjs --workspace <id> --server http://127.0.0.1:8799
 *   node scripts/migrate-changelog-to-board.mjs --workspace <id> --apply <sha256>
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const EXIT = {
  OK: 0,
  USAGE: 2,
  SOURCE: 3,
  SHA_MISMATCH: 4,
  APPLY_FAILED: 5,
  RECONCILE_FAILED: 6,
};

function fail(code, message, extra = {}) {
  process.stderr.write(`✗ ${message}\n`);
  if (extra.hint) process.stderr.write(`  ${extra.hint}\n`);
  process.exit(code);
}

// ---------- 参数 ----------
function parseArgs(argv) {
  const out = { workspace: null, source: null, apply: null, server: process.env.KB_SERVER ?? null, kb: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) fail(EXIT.USAGE, `${key} 需要一个值`);
      i += 1;
      return v;
    };
    if (key === '--workspace') out.workspace = next();
    else if (key === '--source') out.source = next();
    else if (key === '--apply') out.apply = next();
    else if (key === '--server') out.server = next();
    else if (key === '--kb') out.kb = next();
    else if (key === '--help' || key === '-h') {
      process.stdout.write(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
      process.exit(EXIT.OK);
    } else fail(EXIT.USAGE, `未知参数: ${key}`);
  }
  if (!out.workspace) fail(EXIT.USAGE, '必须显式传 --workspace <id|name>（不猜默认工作区）');
  return out;
}

// ---------- kb 调用（win32 下解析 .cmd 垫片取 node 入口，避免 shell 引号问题） ----------
function resolveKbCommand(explicit) {
  if (explicit) return { cmd: process.execPath, prefix: [explicit] };
  if (process.platform !== 'win32') return { cmd: 'kb', prefix: [] };
  const shimCandidates = [`${process.env.APPDATA}\\npm\\kb.cmd`, `${process.env.LOCALAPPDATA}\\npm\\kb.cmd`];
  for (const shim of shimCandidates) {
    if (!existsSync(shim)) continue;
    const text = readFileSync(shim, 'utf8');
    const match = text.match(/"%dp0%[\\/]([^"]+\.js)"/i);
    if (!match) continue;
    const entry = join(dirname(shim), match[1]);
    if (existsSync(entry)) return { cmd: process.execPath, prefix: [entry] };
  }
  // 兜底：交给 shell 解析（可能因引号丢失中文路径，但保证可用）
  return { cmd: 'kb', prefix: [] };
}

function runKb(kbCmd, args) {
  return new Promise((resolveRun) => {
    const child = spawn(kbCmd.cmd, [...kbCmd.prefix, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => {
      stdout += String(b);
    });
    child.stderr.on('data', (b) => {
      stderr += String(b);
    });
    child.on('error', (e) => resolveRun({ code: -1, stdout, stderr: `${stderr}${e.message}` }));
    child.on('close', (code) => resolveRun({ code: code ?? -1, stdout, stderr }));
  });
}

function parseJson(text, what) {
  const clean = text.replace(/^\uFEFF/, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    fail(EXIT.USAGE, `${what} 返回的不是合法 JSON`, { hint: clean.slice(0, 200) });
    return null;
  }
}

// ---------- 工具 ----------
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const snippet = (body) => {
  const line = String(body ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '');
  const text = (line ?? '').replace(/^[-*]\s*/, '');
  return text.length > 42 ? `${text.slice(0, 42)}…` : text;
};
const pad = (s, n) => {
  const str = String(s);
  return str.length >= n ? `${str.slice(0, n - 1)}…` : str + ' '.repeat(n - str.length);
};
const printTable = (rows, headers) => {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join('  ');
  process.stdout.write(`${line(headers)}\n${widths.map((w) => '─'.repeat(w)).join('  ')}\n`);
  for (const r of rows) process.stdout.write(`${line(r)}\n`);
};

// ---------- 主流程 ----------
const args = parseArgs(process.argv.slice(2));
const kbCmd = resolveKbCommand(args.kb);
const serverArgs = args.server ? ['--server', args.server] : [];

const spacesRun = await runKb(kbCmd, [...serverArgs, 'list-spaces', '--json']);
if (spacesRun.code !== 0) {
  fail(EXIT.USAGE, 'list-spaces 失败，无法解析工作区', { hint: (spacesRun.stderr || spacesRun.stdout).trim().slice(0, 300) });
}
const spaces = parseJson(spacesRun.stdout, 'list-spaces');
const workspace = spaces.find((s) => s.id === args.workspace) ?? spaces.find((s) => s.name === args.workspace);
if (!workspace) {
  fail(EXIT.USAGE, `工作区不存在: ${args.workspace}`, {
    hint: `可选: ${spaces.map((s) => `${s.name}(${s.id.slice(0, 8)}…)`).join(', ')}`,
  });
}

const sourcePath = resolve(args.source ?? join(workspace.path, 'Docs', 'CHANGELOG.md'));
const rel = relative(resolve(workspace.path), sourcePath);
if (rel.startsWith('..') || isAbsolute(rel)) {
  fail(EXIT.SOURCE, `源文件不在目标工作区目录内: ${sourcePath}`, { hint: `工作区根: ${workspace.path}` });
}
if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
  fail(EXIT.SOURCE, `源文件不存在或不是文件: ${sourcePath}`);
}

const sourceBytes = readFileSync(sourcePath);
const localSha = sha256(sourceBytes);

process.stdout.write(`工作区: ${workspace.name} (${workspace.id})\n路径  : ${workspace.path}\n源文件: ${sourcePath}\n源 SHA: ${localSha}\n\n`);

// preview（只读）
const previewRun = await runKb(kbCmd, [
  ...serverArgs,
  'changelog', 'import', 'preview',
  '--workspace', workspace.id,
  '--source', sourcePath,
  '--json',
]);
if (previewRun.code !== 0) {
  fail(EXIT.SOURCE, 'preview 失败（源文件或工作区被拒）', { hint: (previewRun.stderr || previewRun.stdout).trim().slice(0, 400) });
}
const preview = parseJson(previewRun.stdout, 'preview');
if (preview.source_sha256 !== localSha) {
  fail(EXIT.SHA_MISMATCH, '本地计算的 SHA 与服务端 preview 不一致（源文件在读取期间变化？）', {
    hint: `本地 ${localSha} / 服务端 ${preview.source_sha256}`,
  });
}

const buckets = [
  ['新增', preview.added ?? []],
  ['已导入', preview.already_imported ?? []],
  ['不一致', preview.conflicting ?? []],
  ['无法解析', (preview.unparsable ?? []).map((u) => ({ occurred_at: 0, title: u.text ?? '（未知）', body_md: '' }))],
];
process.stdout.write(
  `解析 ${(preview.parsed ?? []).length} 条：新增 ${(preview.added ?? []).length} / 已导入 ${(preview.already_imported ?? []).length} / ` +
    `不一致 ${(preview.conflicting ?? []).length} / 无法解析 ${(preview.unparsable ?? []).length}\n\n`,
);
const rows = [];
for (const [status, list] of buckets) {
  for (const e of list) rows.push([status, e.occurred_at ? isoDate(e.occurred_at) : '-', e.title, snippet(e.body_md)]);
}
printTable(rows, ['状态', '日期', '标题', '正文摘要']);
process.stdout.write('\n');

if (!args.apply) {
  process.stdout.write('仅预览完成，未写库。确认无误后执行：\n');
  process.stdout.write(`  node scripts/migrate-changelog-to-board.mjs --workspace ${workspace.id} --apply ${localSha}\n`);
  if (Number(preview.conflicting?.length ?? 0) > 0 || Number(preview.unparsable?.length ?? 0) > 0) {
    process.stdout.write('\n注意：存在「不一致」或「无法解析」条目，必须先处理，apply 会被服务端拒绝。\n');
    process.exit(EXIT.RECONCILE_FAILED);
  }
  process.exit(EXIT.OK);
}

// ---------- apply ----------
if (args.apply !== localSha) {
  fail(EXIT.SHA_MISMATCH, '--apply 的 SHA 与当前源文件不一致（源文件已变化），请重新 preview', {
    hint: `参数 ${args.apply} / 当前 ${localSha}`,
  });
}
if (Number(preview.conflicting?.length ?? 0) > 0 || Number(preview.unparsable?.length ?? 0) > 0) {
  fail(EXIT.RECONCILE_FAILED, 'preview 存在「不一致」或「无法解析」条目，拒绝 apply（源文件保留）');
}

const applyRun = await runKb(kbCmd, [
  ...serverArgs,
  'changelog', 'import', 'apply',
  '--workspace', workspace.id,
  '--source', sourcePath,
  '--sha', args.apply,
]);
const applyText = `${applyRun.stdout}${applyRun.stderr}`;
if (applyRun.code !== 0) {
  fail(EXIT.APPLY_FAILED, 'apply 失败（服务端拒绝或网络错误）', { hint: applyText.trim().slice(0, 400) });
}
const applied = applyText.match(/新增\s*(\d+)\s*条/);
const receipt = applyText.match(/回执\s*([0-9a-f-]{36})/);
const addedCount = applied ? Number(applied[1]) : Number.NaN;
process.stdout.write(`apply 输出: ${applyText.trim().split(/\r?\n/)[0]}\n`);
if (Number.isNaN(addedCount)) {
  fail(EXIT.APPLY_FAILED, 'apply 输出无法解析「新增 N 条」，按失败处理', { hint: applyText.trim().slice(0, 400) });
}
if (addedCount === 0) process.stdout.write('幂等重放：该 SHA 此前已导入（新增 0 条），继续对账。\n');
if (receipt) process.stdout.write(`导入回执: ${receipt[1]}\n`);

// ---------- 对账（服务端回读，逐条比对） ----------
const entries = preview.parsed ?? [];
const stored = [];
for (let offset = 0; ; ) {
  const listRun = await runKb(kbCmd, [
    ...serverArgs,
    'changelog', 'list',
    '--workspace', workspace.id,
    '--type', '历史',
    '--limit', '50',
    '--offset', String(offset),
    '--json',
  ]);
  if (listRun.code !== 0) {
    fail(EXIT.RECONCILE_FAILED, '对账读取工作区历史条目失败', { hint: (listRun.stderr || listRun.stdout).trim().slice(0, 300) });
  }
  const page = parseJson(listRun.stdout, 'changelog list');
  stored.push(...(page.items ?? []));
  if (page.next_offset === null || page.next_offset === undefined) break;
  offset = page.next_offset;
}
const byKey = new Map(stored.map((s) => [s.legacy_source_key, s]));

const reconcileRows = [];
let failures = 0;
for (const e of entries) {
  const hit = byKey.get(e.source_key);
  const problems = [];
  if (!hit) problems.push('缺失');
  else {
    if (hit.title !== e.title) problems.push('标题不一致');
    if (Number(hit.occurred_at) !== Number(e.occurred_at)) problems.push('日期不一致');
    if (String(hit.body_md).replace(/\s+$/, '') !== String(e.body_md).replace(/\s+$/, '')) problems.push('正文不一致');
  }
  if (problems.length > 0) failures += 1;
  reconcileRows.push([problems.length === 0 ? 'PASS' : 'FAIL', isoDate(e.occurred_at), e.title, problems.join('+') || '—']);
}
const extra = stored.filter((s) => !entries.some((e) => e.source_key === s.legacy_source_key));
process.stdout.write('\n=== 逐条对账（源条目 → 服务端历史条目） ===\n');
printTable(reconcileRows, ['结果', '日期', '标题', '问题']);

// verify-retire（只读复核：回执 + 对账结论）
const retireRun = await runKb(kbCmd, [
  ...serverArgs,
  'changelog', 'verify-retire',
  '--workspace', workspace.id,
  '--source', sourcePath,
]);
const retireText = `${retireRun.stdout}${retireRun.stderr}`.trim();
const canRetire = /可退役:\s*是/.test(retireText);
process.stdout.write(`\n=== 退役前置复核（verify-retire，只读） ===\n${retireText.split(/\r?\n/).slice(0, 5).join('\n')}\n`);

if (failures > 0 || extra.length > 0 || !canRetire) {
  process.stdout.write(
    `\nFAIL：对账不通过（失败 ${failures} 条，多出 ${extra.length} 条，verify-retire=${canRetire ? '可退役' : '不可退役'}）。\n` +
      '迁移未完成：源文件保持原样，未删除任何内容。\n',
  );
  if (extra.length > 0) {
    process.stdout.write(`多出的历史条目（非本源条目，需人工确认）：${extra.length} 条\n`);
    for (const s of extra.slice(0, 5)) process.stdout.write(`  - ${s.id} ${s.title}\n`);
  }
  process.exit(EXIT.RECONCILE_FAILED);
}

process.stdout.write(
  `\nPASS：${entries.length} 条全部对账一致（标题/日期/正文），无多余历史条目，verify-retire=可退役。\n` +
    '源文件未删除——退役（删除 Docs/CHANGELOG.md）由用户按流程确认后执行。\n' +
    `回滚参考：本次导入行可用 legacy_source_key 定位（共 ${entries.length} 个 key，服务端字段 legacy_source_key）；` +
    `删除单条用 kb changelog delete <id> --workspace ${workspace.id} --expected-revision <rev>；` +
    `回执记录 ${receipt ? receipt[1] : '(见 apply 输出)'} 保存在服务端导入回执表，回滚后需一并清理以免 verify-retire 误判。\n`,
);
process.exit(EXIT.OK);
