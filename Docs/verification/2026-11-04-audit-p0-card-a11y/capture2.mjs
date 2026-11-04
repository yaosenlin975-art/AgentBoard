// AUDIT-P0 补充取证：键盘 Tab 到卡片（真实 focus-visible）、Space 的归属、Esc 取消抓取。
import { writeFileSync } from 'node:fs';
const PORT = 9333;
const OUT = 'D:\\WorkSpaces\\任务看板\\Docs\\verification\\2026-11-04-audit-p0-card-a11y';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page') ?? list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
const key = async (k, code, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, text: k === 'Enter' ? '\r' : k === ' ' ? ' ' : undefined });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
};
await send('Page.enable');
await send('Emulation.setEmulatedMedia', { features: [] });
await ev(`localStorage.setItem('agentboard.theme','light')`);
await send('Page.navigate', { url: 'http://127.0.0.1:5174/' });
await sleep(3500);
await ev(`localStorage.setItem('agentboard.selected-workspace', JSON.stringify({ state: { workspaceId: 'e41eb0fb-c367-43cf-a99d-6dc5239a5694' }, version: 0 }))`);
await send('Page.reload');
await sleep(4000);
await ev(`document.querySelector('[data-testid="sidebar-entry-board"]')?.click()`);
await sleep(2500);

const seq = [];
let cardFocus = null;
for (let i = 0; i < 140; i += 1) {
  await key('Tab', 'Tab', 9);
  await sleep(45);
  const info = await ev(`(() => { const el = document.activeElement; if (!el) return null; const cs = getComputedStyle(el); return { testid: el.getAttribute('data-testid'), role: el.getAttribute('role'), outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, outlineStyle: cs.outlineStyle }; })()`);
  seq.push(info?.testid ?? null);
  if (info?.testid && info.testid.startsWith('issue-card-')) { cardFocus = info; break; }
}
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(`${OUT}\\focus-ring-keyboard-tab.png`, Buffer.from(shot.data, 'base64'));

const detailState = `(() => document.querySelector('[data-testid="detail-panel"], [data-testid="right-panel"]') ? 'open' : 'closed')()`;
const beforeSpace = await ev(detailState);
await key(' ', 'Space', 32);          // 未占用卡片：Space 归 dnd-kit 抓取
await sleep(600);
const afterSpace = await ev(detailState);
const dragged = await ev(`(() => { const c = document.querySelector('[aria-roledescription]'); return { roledescription: c?.getAttribute('aria-roledescription') ?? null, pressed: document.querySelector('[aria-pressed="true"]') !== null }; })()`);
await key('Escape', 'Escape', 27);     // Esc 取消抓取
await sleep(400);
const afterEsc = await ev(detailState);

const result = { tabSequenceUntilCard: seq, cardFocus, spaceOwnership: { beforeSpace, afterSpace, dragged, afterEsc } };
writeFileSync(`${OUT}\\result2.json`, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
ws.close();
