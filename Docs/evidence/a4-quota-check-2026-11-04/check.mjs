// ACC-KB-A4 视觉/断言核对：额度行在收敛到 packages/shared 后渲染是否与之前一致。
// 用法：node Docs/evidence/a4-quota-check-2026-11-04/check.mjs（需 5174 dev + CDP 9333）
const PORT = 9333;
const BASE = 'http://127.0.0.1:5174/';
const OUT = 'D:\\WorkSpaces\\任务看板\\Docs\\verification\\2026-11-04-a4-quota-check';
import { writeFileSync, mkdirSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:5174'))
  ?? list.find((t) => t.type === 'page' && t.url === 'about:blank')
  ?? list.find((t) => t.type === 'page');
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
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
  return r.result.value;
};

mkdirSync(OUT, { recursive: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: BASE });
await sleep(3500);
await ev(`localStorage.setItem('agentboard.selected-workspace', JSON.stringify({ state: { workspaceId: 'e41eb0fb-c367-43cf-a99d-6dc5239a5694' }, version: 0 }))`);
await send('Page.reload');
await sleep(3500);
await ev(`document.querySelector('[aria-label="账号管理"]')?.click()`);
await sleep(4000);

const result = await ev(`(() => {
  const rows = [...document.querySelectorAll('[data-testid^="quota-row-"]')].map((el) => ({
    testid: el.getAttribute('data-testid'),
    source: el.getAttribute('data-source'),
    text: (el.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 120),
  }));
  const labels = [...document.querySelectorAll('[data-testid^="quota-row-"] span')]
    .map((el) => (el.textContent ?? '').trim())
    .filter((t) => t !== '');
  return { count: rows.length, rows, labels: [...new Set(labels)].slice(0, 8) };
})()`);

const png = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(`${OUT}\\accounts-quota-rows.png`, Buffer.from(png.data, 'base64'));
console.log(JSON.stringify(result, null, 2));
writeFileSync(`${OUT}\\result.json`, JSON.stringify(result, null, 2));
ws.close();
