// AUDIT-SETTINGS 取证：设置抽屉内 Tab 顺序（前 15 个 data-testid）、分区/生效标注、主题入口唯一性。
import { writeFileSync, mkdirSync } from 'node:fs';
const PORT = 9333;
const OUT = 'D:\\WorkSpaces\\任务看板\\Docs\\verification\\2026-11-04-audit-settings';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page') ?? list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
const tab = async () => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await sleep(60); };
mkdirSync(OUT, { recursive: true });
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://127.0.0.1:5174/' });
await sleep(3500);
await ev(`localStorage.setItem('agentboard.theme','light'); localStorage.setItem('agentboard.selected-workspace', JSON.stringify({ state: { workspaceId: 'e41eb0fb-c367-43cf-a99d-6dc5239a5694' }, version: 0 }))`);
await send('Page.reload');
await sleep(4000);

const themeEntries = await ev(`(() => {
  const bottom = document.querySelector('[data-testid="topbar-theme"]');
  return { sidebarTheme: bottom ? { tag: bottom.tagName, readonly: bottom.getAttribute('data-readonly'), label: bottom.getAttribute('aria-label') } : null,
    clickableToggleCount: document.querySelectorAll('[aria-label="切换主题"]').length };
})()`);

await ev(`document.querySelector('[data-testid="topbar-settings"]')?.click()`);
await sleep(1500);
const sections = await ev(`(() => {
  const el = (s) => document.querySelector(s);
  const txt = (s) => (el(s)?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  return { saveBadge: txt('[data-testid="settings-badge-save"]'), effectPort: txt('[data-testid="settings-effect-port"]'),
    effectMaxTurns: txt('[data-testid="settings-effect-max-turns"]'), effectTheme: txt('[data-testid="settings-effect-theme"]'),
    saveHint: txt('[data-testid="settings-save-hint"]'),
    sections: [...document.querySelectorAll('[data-testid^="settings-section-"], [data-testid="settings-statuses"], [data-testid="settings-storage"]')].map((n) => n.getAttribute('data-testid')),
    storageMigrateVisible: !!document.querySelector('[data-testid="settings-storage-submit"], [data-testid="settings-storage-pick"]') };
})()`);

await ev(`document.querySelector('[data-testid="settings-port"]')?.focus()`);
const order = [];
for (let i = 0; i < 15; i += 1) {
  const info = await ev(`(() => { const el = document.activeElement; return el ? { id: el.getAttribute('data-testid') ?? el.tagName, label: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 14) } : null; })()`);
  order.push(info?.id ?? null);
  await tab();
}
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(`${OUT}\\settings-tab-order.png`, Buffer.from(shot.data, 'base64'));
const result = { themeEntries, sections, tabOrderFromPort: order };
writeFileSync(`${OUT}\\result.json`, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
ws.close();
