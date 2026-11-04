// KBIMP-2B 真机取证（轮询版）：塞 sample-dup.json → 确认导入 → 等结果区出现 → 读汇总与失败条目。
const PORT = 9333;
const OUT = 'D:\\WorkSpaces\\任务看板\\Docs\\verification\\2026-11-04-kbimp2b-results';
const FILE = 'D:\\WorkSpaces\\任务看板\\Docs\\verification\\samples\\sample-dup.json';
// 每次运行用带时间戳的标题，保证「第一条新建成功、第二条同 slug 失败」可复现
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
const dupTitle = 'KBIMP-2B 同 slug 演练 ' + stamp;
writeFileSync(FILE, JSON.stringify([{ title: dupTitle, body_md: '第一条正文' }, { title: dupTitle, body_md: '第二条正文' }], null, 1), 'utf8');
import { writeFileSync, mkdirSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page') ?? list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id;
  pending.set(i, { resolve, reject });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
  return r.result.value;
};
const until = async (expression, timeoutMs = 15000, stepMs = 200) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ev(expression)) return true;
    await sleep(stepMs);
  }
  return false;
};

mkdirSync(OUT, { recursive: true });
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://127.0.0.1:5174/' });
await sleep(3500);
await ev(`localStorage.setItem('agentboard.theme','light'); localStorage.setItem('agentboard.selected-workspace', JSON.stringify({ state: { workspaceId: 'e41eb0fb-c367-43cf-a99d-6dc5239a5694' }, version: 0 }))`);
await send('Page.reload');
await sleep(3500);

await ev(`document.querySelector('[data-testid="sidebar-entry-knowledge"]')?.click()`);
const viewOk = await until(`!!document.querySelector('[data-testid="knowledge-import-open"]')`, 12000);
if (!viewOk) {
  const ids = await ev(`[...document.querySelectorAll('[data-testid]')].map(e => e.getAttribute('data-testid')).filter(t => /knowledge/.test(t)).slice(0, 20).join(',')`);
  console.log(JSON.stringify({ error: '知识库视图未出现「添加」按钮', ids }));
  writeFileSync(`${OUT}\\result.json`, JSON.stringify({ error: 'no import button', ids }, null, 1));
  ws.close();
  process.exit(0);
}
await ev(`document.querySelector('[data-testid="knowledge-import-open"]')?.click()`);
await sleep(800);

const handle = await send('Runtime.evaluate', { expression: `document.querySelector('[data-testid="kb-import-file"]')` });
if (!handle.result?.objectId) {
  console.log(JSON.stringify({ error: '对话框里找不到 file input' }));
  writeFileSync(`${OUT}\\result.json`, JSON.stringify({ error: 'no file input' }, null, 1));
  ws.close();
  process.exit(0);
}
await send('DOM.setFileInputFiles', { objectId: handle.result.objectId, files: [FILE] });

const parsedOk = await until(`!!document.querySelector('[data-testid="kb-import-items"]')`, 12000);
const previewMeta = await ev(`(document.querySelector('[data-testid="kb-import-meta"]')?.textContent ?? '').trim()`);
const submitDisabled = await ev(`document.querySelector('[data-testid="kb-import-submit"]')?.disabled ?? null`);
await ev(`document.querySelector('[data-testid="kb-import-submit"]')?.click()`);

const resultsOk = await until(`!!document.querySelector('[data-testid="kb-import-results"]')`, 15000);
await ev(`document.querySelector('[data-testid="kb-import-result-row-draft-1"] summary')?.click()`);
await sleep(400);

const dom = await ev(`(() => {
  const el = (s) => document.querySelector(s);
  const txt = (s) => { const n = el(s); return n && n.textContent ? n.textContent.replace(/\\s+/g, ' ').trim() : ''; };
  const attr = (s, name) => { const n = el(s); return n ? n.getAttribute(name) : null; };
  const results = el('[data-testid="kb-import-results"]');
  return {
    resultsPresent: Boolean(results),
    dataOk: results ? results.getAttribute('data-ok') : null,
    dataFailed: results ? results.getAttribute('data-failed') : null,
    summary: txt('[data-testid="kb-import-summary"]'),
    row0Status: attr('[data-testid="kb-import-result-row-draft-0"]', 'data-status'),
    row1Status: attr('[data-testid="kb-import-result-row-draft-1"]', 'data-status'),
    detail1: txt('[data-testid="kb-import-result-detail-draft-1"]'),
    message1: txt('[data-testid="kb-import-result-message-draft-1"]'),
    suggestions1: txt('[data-testid="kb-import-result-suggestions-draft-1"]'),
  };
})()`);

const info = { ...dom, parsedOk, resultsOk, previewMeta, submitDisabledBefore: submitDisabled, fileName: 'sample-dup.json' };
const png = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(`${OUT}\\kb-import-partial-failure.png`, Buffer.from(png.data, 'base64'));
writeFileSync(`${OUT}\\result.json`, JSON.stringify(info, null, 1));
console.log(JSON.stringify(info, null, 1));
ws.close();
