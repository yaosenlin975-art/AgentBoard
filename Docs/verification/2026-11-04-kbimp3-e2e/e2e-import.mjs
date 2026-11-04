// KBIMP-3：用 CDP 给 <input type=file> 塞真实文件，逐个走 UI 导入并记录结果。
// 用法：node e2e-import.mjs   （需 5174 dev server + CDP 9333 + Edge headless）
const PORT = 9333;
const BASE = 'http://127.0.0.1:5174/';
const OUT = 'D:\\WorkSpaces\\任务看板\\Docs\\verification\\2026-11-04-kbimp3-e2e';
const SAMPLES = 'D:\\WorkSpaces\\任务看板\\Docs\\verification\\samples';
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

mkdirSync(OUT, { recursive: true });
await send('Page.enable');
await send('DOM.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: BASE });
await sleep(3500);
await ev(`localStorage.setItem('agentboard.theme','light'); localStorage.setItem('agentboard.selected-workspace', JSON.stringify({ state: { workspaceId: 'e41eb0fb-c367-43cf-a99d-6dc5239a5694' }, version: 0 }))`);
await send('Page.reload');
await sleep(3500);
await ev(`document.querySelector('[data-testid="view-knowledge"]')?.click()`);
await sleep(2500);

const shot = async (name) => {
  const png = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}\\${name}.png`, Buffer.from(png.data, 'base64'));
};

/** 打开导入对话框并把文件塞进 input（真实 File，走浏览器原生路径） */
const setFile = async (filePath) => {
  await ev(`document.querySelector('[data-testid="knowledge-import-open"]')?.click()`);
  await sleep(700);
  const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '[data-testid="kb-import-file"]' });
  await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [filePath] });
  await sleep(1200);
};

const readDialog = () => ev(`(() => {
  const q = (s) => document.querySelector(s);
  const txt = (s) => (q(s)?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  return {
    meta: txt('[data-testid="kb-import-meta"]'),
    title: q('[data-testid="kb-import-title"]')?.value ?? null,
    items: [...document.querySelectorAll('[data-testid^="kb-import-item-"]')].map((el) => ({ id: el.getAttribute('data-testid'), text: (el.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 60), cancelled: el.getAttribute('data-cancelled') })),
    failure: txt('[data-testid="kb-import-failure"]') || null,
    error: txt('[data-testid="kb-import-error"]') || null,
    warnings: txt('[data-testid="kb-import-warnings"]') || null,
    submitDisabled: q('[data-testid="kb-import-submit"]')?.disabled ?? null,
    result: txt('[data-testid="knowledge-import-result"]') || null,
  };
})()`);

const runImport = async (label, fileName, { expectBlocked = false } = {}) => {
  await setFile(`${SAMPLES}\\${fileName}`);
  const preview = await readDialog();
  if (expectBlocked) {
    await shot(`${label}-blocked`);
    console.log(`${label}=` + JSON.stringify({ preview, imported: false }));
    await ev(`document.querySelector('[data-testid="kb-import-reset"]')?.click()`);
    await ev(`document.querySelector('[aria-label="关闭"]')?.click()`);
    await sleep(600);
    return { label, preview, imported: false };
  }
  await ev(`document.querySelector('[data-testid="kb-import-submit"]')?.click()`);
  await sleep(2500);
  const after = await readDialog();
  await shot(label);
  await ev(`document.querySelector('[aria-label="关闭"]')?.click()`);
  await sleep(600);
  console.log(`${label}=` + JSON.stringify({ preview, result: after.result ?? after.error ?? after.failure }));
  return { label, preview, after };
};

const results = [];
results.push(await runImport('md', 'sample.md'));
results.push(await runImport('txt', 'sample.txt'));
results.push(await runImport('json-single', 'sample.json'));
results.push(await runImport('json-array', 'sample-array.json'));
results.push(await runImport('conflict', 'sample.md'));
results.push(await runImport('oversize-blocked', 'sample-500kb.md', { expectBlocked: false }));
writeFileSync(`${OUT}\\result.json`, JSON.stringify(results, null, 2));
ws.close();
