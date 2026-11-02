/**
 * IMG-04 浏览器级验收驱动（headless Edge + CDP，真实点击派发弹窗）。
 *
 * 前置：node apps/server/test/fixtures/img04FixtureServer.mjs 已启动（写出 <root>/fixture.json）；
 *       web 端 dev server 指向该 fixture：
 *       AGENTBOARD_WEB_API_TARGET=http://127.0.0.1:18789 pnpm --filter @agentboard/web exec vite --port 5177
 * 运行：node apps/server/test/fixtures/img04BrowserUi.mjs
 * 环境变量：IMGFIX_ROOT、IMGFIX_WEB（默认 http://127.0.0.1:5177/）、EDGE_PORT（默认 9301）、EDGE_PATH
 *
 * 覆盖（只用测试替身适配器，不 spawn 真实 CLI、不发起模型推理）：
 *  A 7 张候选 → 默认只选 5 张且显示批次上限 → 派发后余数提示「另有 N 张未附」、只投递本批 → 显式选第二批 → 全部交付
 *  B 强制失败 → 候选变「结果未知」、未勾选确认时确认按钮禁用且不发请求 → 勾选后重试成功 → 只投递一次
 *  C console 无运行时错误
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeMarkerPng } from './png.mjs';

const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.IMGFIX_ROOT ?? join(here, '..', '.fixture-img04'));
const info = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'));
const WEB = process.env.IMGFIX_WEB ?? 'http://127.0.0.1:5177/';
const PORT = Number(process.env.EDGE_PORT ?? 9301);
const EDGE = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const calls = () => (existsSync(info.callsPath) ? readFileSync(info.callsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsonReq = async (method, path, body) => {
  const res = await fetch(info.base_url + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json();
  if (res.status >= 400) throw new Error(`${method} ${path} ${res.status} ${JSON.stringify(data)}`);
  return data;
};

const workspaces = await jsonReq('GET', '/api/workspaces');
const workspace = workspaces.find((w) => w.path === info.workspaceDir) ?? workspaces[0];
if (!workspace) throw new Error('fixture 里没有工作区（先跑 img04FixtureChecks.mjs）');

const seed = async (title, prefix, count) => {
  const issue = await jsonReq('POST', '/api/issues', { workspace_id: workspace.id, title, description: `${count} 张图片` });
  for (let i = 1; i <= count; i += 1) {
    const up = await fetch(`${info.base_url}/api/workspaces/${workspace.id}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-file-name': `${prefix}-${i}.png` },
      body: makeMarkerPng(i),
    });
    const staged = await up.json();
    if (up.status >= 400) throw new Error(`upload ${up.status} ${JSON.stringify(staged)}`);
    await jsonReq('POST', `/api/issues/${issue.id}/comments`, { content: `${prefix} 第 ${i} 张`, workspace_id: workspace.id, attachment_ids: [staged.id] });
  }
  return issue.id;
};
const pendingOf = async (issueId) => (await (await fetch(`${info.base_url}/api/issues/${issueId}/pending-attachments?limit=50&offset=0`)).json()).items.map((i) => i.delivery_state);

const batchIssue = await seed('IMG04-UI 批次上限', 'batch', 7);
const unknownIssue = await seed('IMG04-UI 未知重试', 'retry', 3);
const callsAtStart = calls().length;

const profile = mkdtempSync(join(tmpdir(), 'ab-edge-img04-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });

const pageTarget = async () => {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // 等 CDP
    }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
};

const target = await pageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r, j) => {
  ws.on('open', r);
  ws.on('error', j);
});
let seq = 0;
const pend = new Map();
const sessionPosts = [];
const consoleErrors = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pend.has(msg.id)) {
    const { resolve: res, reject } = pend.get(msg.id);
    pend.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(msg.params.exceptionDetails.text);
  if (msg.method === 'Network.requestWillBeSent' && msg.params.request.url.endsWith('/api/sessions')) {
    sessionPosts.push(JSON.parse(msg.params.request.postData ?? '{}'));
  }
});
const send = (method, params = {}) =>
  new Promise((res, reject) => {
    const id = ++seq;
    pend.set(id, { resolve: res, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails));
  return r.result.value;
};

await send('Runtime.enable');
await send('Network.enable');
await send('Page.enable');
await send('Page.navigate', { url: WEB });
await sleep(2500);
await evaluate(`window.__t = {
  click(s) { const el = document.querySelector(s); if (!el) return false; el.click(); return true; },
  wait(cond, ms = 15000) { const t0 = Date.now(); return new Promise((resolve, reject) => { const tick = () => { let ok = false; try { ok = cond(); } catch { ok = false; } if (ok) return resolve(true); if (Date.now() - t0 > ms) return reject(new Error('等待超时')); setTimeout(tick, 80); }; tick(); }); }
}; true`);

const checks = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ name, actual, expected, ok });
  console.log(JSON.stringify({ type: 'check', name, actual, expected, ok }));
};
const openIssue = async (issueId) => {
  await evaluate(`__t.wait(() => !!document.querySelector('[data-testid="workspace-card-${workspace.id}"]'))`);
  await evaluate(`__t.click('[data-testid="workspace-card-${workspace.id}"]')`);
  await sleep(600);
  await evaluate(`__t.wait(() => !!document.querySelector('[data-testid="issue-card-${issueId}"]'))`);
  await evaluate(`__t.click('[data-testid="issue-card-${issueId}"]')`);
  await sleep(900);
};
const openDispatch = async () => {
  if (!(await evaluate(`__t.click('[data-testid="dispatch-btn"]')`))) return false;
  await evaluate(`__t.wait(() => !!document.querySelector('[data-testid="dispatch-confirm"]'))`);
  await sleep(1200);
  return true;
};
const configure = async () => {
  await evaluate(`(() => { const sel = document.querySelector('[data-testid="cli-select"]'); const opt = [...sel.options].find(o => o.value === 'codebuddy'); if (!opt) return null; sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return opt.value; })()`);
  await sleep(700);
  if (await evaluate(`!!document.querySelector('[data-testid="model-select"]')`)) {
    await evaluate(`(() => { const sel = document.querySelector('[data-testid="model-select"]'); const opt = [...sel.options].find(o => String(o.value).includes('minimax')); if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); } return sel.value; })()`);
    return;
  }
  await evaluate(`document.querySelector('[data-testid="model-mode-toggle"]')?.click()`);
  await sleep(250);
  await evaluate(`(() => { const el = document.querySelector('[data-testid="model-manual-input"]'); if (!el) return null; const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(el, 'minimax-m3.1-flash'); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; })()`);
};
const snap = async (prefix) => ({
  candidates: await evaluate(`document.querySelectorAll('[aria-label^="选择图片 ${prefix}-"]').length`),
  checked: await evaluate(`[...document.querySelectorAll('[aria-label^="选择图片 ${prefix}-"]')].filter(el => el.checked).length`),
  legend: await evaluate(`document.querySelector('[aria-label="历史图片派发批次"] legend')?.textContent ?? null`),
  batchNotice: await evaluate(`document.querySelector('[data-testid="attachment-batch-notice"]')?.textContent ?? null`),
  unknownConfirmVisible: await evaluate(`!!document.querySelector('[aria-label="确认重试未知投递图片"]')`),
  confirmDisabled: await evaluate(`document.querySelector('[data-testid="dispatch-confirm"]')?.disabled ?? null`),
  states: await evaluate(`[...document.querySelectorAll('[aria-label^="选择图片 ${prefix}-"]')].map(l => l.parentElement.textContent.split('user:')[0].trim())`),
});

// ===== A. 7 张分批 =====
await openIssue(batchIssue);
check('A.dialog_open', await openDispatch(), true);
await configure();
const beforeA = await snap('batch');
check('A.candidates', beforeA.candidates, 7);
check('A.default_selected', beforeA.checked, 5);
check('A.legend_shows_batch', beforeA.legend?.startsWith('历史图片（已选 5 张'), true);

await evaluate(`__t.click('[data-testid="dispatch-confirm"]')`);
await sleep(3500);
const afterFirstA = await snap('batch');
check('A.remaining_candidates', afterFirstA.candidates, 2);
check('A.batch_notice', afterFirstA.batchNotice?.includes('另有 2 张未附'), true);
check('A.pending_after_first', await pendingOf(batchIssue), ['pending', 'pending']);
check('A.first_call_images', calls().slice(callsAtStart).at(-1)?.attachment_count, 5);

const secondReady = await evaluate(`(async () => { const t0 = Date.now(); while (Date.now() - t0 < 12000) { if (document.querySelectorAll('[aria-label^="选择图片 batch-"]').length === 2) return true; await new Promise(r => setTimeout(r, 100)); } return false; })()`);
check('A.second_batch_listed', secondReady, true);
check('A.second_selected', await evaluate(`(() => { const boxes = [...document.querySelectorAll('[aria-label^="选择图片 batch-"]')]; for (const b of boxes) if (!b.checked) b.click(); return boxes.filter(b => b.checked).length; })()`), 2);
await evaluate(`__t.click('[data-testid="dispatch-confirm"]')`);
await sleep(3500);
check('A.pending_after_second', await pendingOf(batchIssue), []);
check('A.call_image_counts', calls().slice(callsAtStart).map((c) => c.attachment_count), [5, 2]);
check('A.second_uses_reuse', sessionPosts.at(-1)?.reuse_session, 'last');

// ===== B. 未知投递与显式确认 =====
await evaluate(`__t.click('[aria-label="关闭"]') || (() => { const b = [...document.querySelectorAll('[role="dialog"] button')].find(x => x.textContent.trim() === '取消'); if (b) b.click(); return true; })()`);
await sleep(1200);
await openIssue(unknownIssue);
check('B.dialog_open', await openDispatch(), true);
await configure();
writeFileSync(join(root, 'fail-next'), 'force-fail', 'utf8');
const callsBeforeFail = calls().length;
await evaluate(`__t.click('[data-testid="dispatch-confirm"]')`);
await sleep(3500);
check('B.pending_unknown', await pendingOf(unknownIssue), ['unknown', 'unknown', 'unknown']);
check('B.single_attempt_no_auto_retry', calls().length - callsBeforeFail, 1);

check('B.reopen_available', await evaluate(`__t.wait(() => !!document.querySelector('[data-testid="dispatch-btn"]'), 15000).then(() => true).catch(() => false)`), true);
await openDispatch();
await configure();
const reopenB = await snap('retry');
check('B.unknown_listed', reopenB.states.every((s) => s.includes('结果未知')), true);
check('B.confirm_checkbox_visible', reopenB.unknownConfirmVisible, true);
check('B.confirm_disabled_without_tick', reopenB.confirmDisabled, true);
const postsBefore = sessionPosts.length;
const callsBefore = calls().length;
await evaluate(`__t.click('[data-testid="dispatch-confirm"]')`);
await sleep(1500);
check('B.no_request_without_confirm', { posts: sessionPosts.length - postsBefore, calls: calls().length - callsBefore }, { posts: 0, calls: 0 });
check('B.confirm_tick', await evaluate(`(() => { const el = document.querySelector('[aria-label="确认重试未知投递图片"]'); if (!el) return null; if (!el.checked) el.click(); return el.checked; })()`), true);
await sleep(400);
const callsBeforeRetry = calls().length;
await evaluate(`__t.click('[data-testid="dispatch-confirm"]')`);
await sleep(3500);
check('B.retry_single_call', calls().length - callsBeforeRetry, 1);
check('B.retry_images', calls().at(-1)?.attachment_count, 3);
check('B.pending_after_retry', await pendingOf(unknownIssue), []);
check('B.retry_sent_with_flag', sessionPosts.at(-1)?.retry_unknown_images, true);
check('C.console_errors', consoleErrors, []);

const failed = checks.filter((c) => c.ok === false);
console.log(JSON.stringify({ type: 'summary', total_checks: checks.length, failed_checks: failed.length }));
ws.close();
edge.kill();
if (failed.length > 0) process.exitCode = 1;
