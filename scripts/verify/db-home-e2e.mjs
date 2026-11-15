#!/usr/bin/env node
/**
 * P2 知识文件事实源端到端验收（P2-05）：
 * 起隔离实例 → 建工作区（自动下沉）→ kb knowledge create 落盘 Docs/<slug>.md →
 * 回读一致 → 外部编辑 409 KNOWLEDGE_FILE_CONFLICT → rename 全库重写 → 星图建边 → 软删撤文件。
 *
 * 可复现：`node scripts/verify/db-home-e2e.mjs`（默认端口 18830；不改 8787 上正在跑的服务）
 *
 * 隔离口径（沿用 DB-4 先例，见 Docs/evidence/db-home-e2e-2026-11-04.md）：
 * - 独立 `APPDATA`（临时目录）+ 独立端口，不设 `AGENTBOARD_DB`；
 * - 子进程必须继承完整环境（最小 env 会让启动期契约路径解析抛错 → 端口从未监听）；
 * - 循环回请求不走代理：给子进程与自身都显式设置 `NO_PROXY=127.0.0.1,localhost`；
 * - 跑前清掉临时 APPDATA 里的 `server.lock`（陈旧锁会导致启动被拒）。
 *
 * 退出码：0 全绿 / 1 有失败项。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const WORK = join(process.env.TEMP ?? process.env.TMP ?? '.', `kbfile-e2e-${STAMP}`);
const APPDATA = join(WORK, 'appdata');
const PORT = Number(process.env.KBFILE_E2E_PORT ?? 18830);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text === '' ? null : JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function version() {
  try {
    const res = await fetch(`${BASE}/api/version`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function waitVersion(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await version();
    if (v !== null) return v;
    await sleep(300);
  }
  return null;
}

const killPort = () => {
  spawnSync('powershell', ['-NoProfile', '-Command', `Get-NetTCPConnection -State Listen -LocalPort ${PORT} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`], { encoding: 'utf8' });
};

// ── 准备：隔离目录 + 清陈旧锁 ───────────────────────────────
rmSync(WORK, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
mkdirSync(join(APPDATA, 'AgentBoard'), { recursive: true });
mkdirSync(join(WORK, 'space'), { recursive: true });
const staleLock = join(APPDATA, 'AgentBoard', 'server.lock');
if (existsSync(staleLock)) rmSync(staleLock, { force: true });

console.log(`工作目录：${WORK}\n端口：${PORT}\n`);

// ── 启动（完整 env 继承；loopback 不走代理）──────────────────────
const childEnv = { ...process.env, APPDATA, AGENTBOARD_PORT: String(PORT), NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' };
delete childEnv.AGENTBOARD_DB;
process.env.NO_PROXY = '127.0.0.1,localhost,::1';
process.env.no_proxy = '127.0.0.1,localhost,::1';

killPort();
const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
  cwd: ROOT, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let childOut = '';
child.stdout.on('data', (d) => { childOut += String(d); });
child.stderr.on('data', (d) => { childOut += String(d); });
child.unref();

let exitCode = null;
child.once('exit', (code) => { exitCode = code; });

try {
  const v1 = await waitVersion();
  if (v1 === null) {
    check('服务启动并可达', false, `exitCode=${exitCode}；子进程输出：${childOut.split('\n').filter((l) => l.trim() !== '').slice(0, 3).join(' | ')}`);
    throw new Error('服务未起来');
  }
  check('服务启动并可达', true, `pid=${v1.pid} instance=${v1.instance_id}`);

  // ── 工作区（新建区自动下沉 localized）────────────────────────
  const ws = await api('POST', '/api/workspaces', { name: 'kbfile-e2e', path: join(WORK, 'space') });
  check('建工作区', ws.status === 200 || ws.status === 201, `status=${ws.status} ${JSON.stringify(ws.body?.error ?? {}).slice(0, 200)}`);
  const workspaceId = ws.body.id;
  const wsDocs = join(join(WORK, 'space'), '.agentboard', 'Docs');
  const detail = (r) => JSON.stringify(r.body?.error ?? {}).slice(0, 240);

  // ── create → Docs/<slug>.md 落盘（front matter + content_hash）────
  const bodyMd = '# e2e 源页\n\n这是知识文件事实源 e2e 的正文。\n\n参见 [[kbfile-target]]。\n';
  // content_hash 用真实 sha256 形态（十六进制混合字母）；全零/纯数字串会被 YAML 解析成 number，round-trip 即坏
  const fakeHash = Array.from({ length: 64 }, (_, i) => '0123456789abcdef'[(i * 7 + 3) % 16]).join('');
  const sources = [{ source_id: 'agent:e2e', source_type: 'agent', locator: 'agent:e2e', captured_at: Date.now(), content_hash: fakeHash, snapshot: 'db-home-e2e 冒烟' }];
  const evidence = [{ source_id: 'agent:e2e', locator: 'agent:e2e', snapshot: 'create via REST' }];
  const created = await api('POST', '/api/knowledge/pages', {
    scope: 'workspace', workspace_id: workspaceId,
    slug: 'kbfile-source', title: 'e2e 源页', body_md: bodyMd, domain: 'knowledge',
    sources, evidence, actor: 'e2e', change_note: 'db-home-e2e',
  });
  check('create 知识页 200', created.status === 200 || created.status === 201, `status=${created.status} ${detail(created)}`);
  const pageId = created.body?.id;
  const createdFile = join(wsDocs, 'kbfile-source.md');
  check('Docs/<slug>.md 真实落盘', existsSync(createdFile), createdFile);
  const fileText = existsSync(createdFile) ? readFileSync(createdFile, 'utf8') : '';
  const fmMatch = /^---\n([\s\S]*?)\n---\n/.exec(fileText);
  check('front matter 含 id/revision/content_hash',
    fmMatch !== null && /id: /.test(fmMatch[1]) && /revision: 1/.test(fmMatch[1]) && /content_hash: /.test(fmMatch[1]),
    fmMatch === null ? '无 front matter' : fmMatch[1].split('\n').slice(0, 6).join(' / '));

  // ── show 回读一致 ──────────────────────────────────────────
  const shown = await api('GET', `/api/knowledge/pages/${pageId}?scope=workspace&workspace_id=${workspaceId}`);
  check('show 回读 title/revision 一致', shown.status === 200 && shown.body?.title === 'e2e 源页' && shown.body?.revision === 1,
    `status=${shown.status} pageId=${pageId} ${detail(shown)}`);

  // ── 外部编辑 → 409 KNOWLEDGE_FILE_CONFLICT ─────────────────
  writeFileSync(createdFile, `${fileText}外部追加的一行\n`, 'utf8');
  const revise = await api('PUT', `/api/knowledge/pages/${pageId}`, {
    scope: 'workspace', workspace_id: workspaceId, expected_revision: 1,
    body_md: `${bodyMd}经 API 的修订\n`, actor: 'e2e',
  });
  check('外部编辑后 CAS 写 → 409 KNOWLEDGE_FILE_CONFLICT', revise.status === 409 && revise.body?.error?.code === 'KNOWLEDGE_FILE_CONFLICT',
    `status=${revise.status} code=${revise.body?.error?.code}`);
  // 模拟人裁决后恢复原文（内容逐字节还原），后续 rename 等写操作才能继续
  writeFileSync(createdFile, fileText, 'utf8');

  // ── 目标页 + wikilink 建边（星图）────────────────────────────
  const target = await api('POST', '/api/knowledge/pages', {
    scope: 'workspace', workspace_id: workspaceId,
    slug: 'kbfile-target', title: 'e2e 目标页', domain: 'knowledge',
    body_md: '# e2e 目标页\n\n被 [[kbfile-source]] 引用。\n',
    sources, evidence, actor: 'e2e',
  });
  check('目标页落盘', (target.status === 200 || target.status === 201) && existsSync(join(wsDocs, 'kbfile-target.md')), `status=${target.status} ${detail(target)}`);
  const graph = await api('GET', `/api/knowledge/graph?scope=workspace&workspace_id=${workspaceId}`);
  const edges = graph.body?.edges ?? [];
  const linkEdge = edges.find((e) => e.kind === 'link' && (e.source === pageId || e.target === pageId || e.source === target.body?.id || e.target === target.body?.id));
  check('星图建边：[[wikilink]] → link 边', graph.status === 200 && linkEdge !== undefined,
    `status=${graph.status} edges=${edges.length}`);

  // ── rename：换文件名 + 全库重写 [[old]]→[[new]] ──────────────
  const renamed = await api('POST', `/api/knowledge/pages/${pageId}/rename`, {
    scope: 'workspace', workspace_id: workspaceId, expected_revision: 1, new_slug: 'kbfile-source-v2', actor: 'e2e',
  });
  check('rename 成功且 id 不变', renamed.status === 200 && renamed.body?.id === pageId && renamed.body?.slug === 'kbfile-source-v2',
    `status=${renamed.status}`);
  const oldGone = !existsSync(createdFile);
  const newFile = join(wsDocs, 'kbfile-source-v2.md');
  const rewritten = existsSync(newFile) ? readFileSync(newFile, 'utf8') : '';
  const targetAfter = existsSync(join(wsDocs, 'kbfile-target.md')) ? readFileSync(join(wsDocs, 'kbfile-target.md'), 'utf8') : '';
  check('旧文件名消失、新文件名出现', oldGone && existsSync(newFile), `${oldGone}/${existsSync(newFile)}`);
  check('目标页正文 [[kbfile-source]] 重写为 [[kbfile-source-v2]]',
    targetAfter.includes('[[kbfile-source-v2]]') && !targetAfter.includes('[[kbfile-source]]'),
    '目标页正文引用已跟随');
  check('rename 后 front matter revision +1', /revision: 2/.test(rewritten), 'rev=2');

  // ── 软删撤文件 ─────────────────────────────────────────────
  const del = await api('POST', `/api/knowledge/pages/${target.body?.id}/actions`, {
    scope: 'workspace', workspace_id: workspaceId, action: 'delete', expected_revision: 1, actor: 'e2e',
  });
  const targetFileGone = !existsSync(join(wsDocs, 'kbfile-target.md'));
  check('action=delete 撤文件', del.status === 200 && targetFileGone, `status=${del.status} fileGone=${targetFileGone}`);
  const deletedGet = await api('GET', `/api/knowledge/pages/${target.body?.id}?scope=workspace&workspace_id=${workspaceId}`);
  check('软删页不可寻址', deletedGet.status === 404 || deletedGet.status === 410, `status=${deletedGet.status}`);
} catch (error) {
  if (results.every((r) => r.ok)) check('脚本未抛错', false, error instanceof Error ? error.message : String(error));
} finally {
  const failed = results.filter((r) => !r.ok).length;
  const ok = failed === 0;
  console.log(`\n合计 ${results.length} 项，失败 ${failed} 项`);
  try { writeFileSync(join(WORK, 'result.json'), `${JSON.stringify({ port: PORT, work: WORK, results }, null, 2)}\n`, 'utf8'); } catch { /* 忽略 */ }
  console.log(`结果文件：${join(WORK, 'result.json')}`);
  killPort();
  if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* 忽略 */ } }
  process.exit(ok ? 0 : 1);
}
