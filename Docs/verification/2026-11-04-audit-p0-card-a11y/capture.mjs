// AUDIT-P0：看板卡片键盘可达与焦点环的真机取证（CDP 9333 + 5174）。
// 取：①Tab 顺序前 N 个可聚焦元素的 data-testid ②焦点环 computed(outline-*) ③焦点是否落在可见卡片
// ④Enter / Space 打开详情（面板状态）⑤Space 抓取→方向键→Space 放下的键盘拖拽路径。
import { writeFileSync, mkdirSync } from 'node:fs';

const PORT = 9333;
const OUT = 'D:\\WorkSpaces\\任务看板\\Docs\\verification\\2026-11-04-audit-p0-card-a11y';
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};
const key = async (k, code, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, text: k === 'Enter' ? '\r' : ' ' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
};
mkdirSync(OUT, { recursive: true });
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://127.0.0.1:5174/' });
await sleep(3500);
await ev(`localStorage.setItem('agentboard.theme','light'); localStorage.setItem('agentboard.selected-workspace', JSON.stringify({ state: { workspaceId: 'e41eb0fb-c367-43cf-a99d-6dc5239a5694' }, version: 0 }))`);
await send('Page.reload');
await sleep(4000);
await ev(`document.querySelector('[data-testid="sidebar-entry-board"]')?.click()`);
await sleep(2500);

const describeActive = `(() => { const el = document.activeElement; if (!el) return null; const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return { testid: el.getAttribute('data-testid'), role: el.getAttribute('role'), tag: el.tagName,
    outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, outlineStyle: cs.outlineStyle,
    boxShadow: cs.boxShadow, visible: rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.opacity !== '0',
    ariaHidden: el.closest('[aria-hidden="true"]') !== null }; })()`;

// ① Tab 顺序（前 12 个可聚焦元素）
const order = [];
for (let i = 0; i < 12; i += 1) {
  await key('Tab', 'Tab', 9);
  await sleep(120);
  const active = await ev(describeActive);
  order.push(active ? (active.testid ?? `${active.tag}:${(await ev('document.activeElement.textContent || ""')).slice(0, 12)}`) : null);
}

// ②③ 聚焦到第一张卡片，读焦点环与可见性
const focusCard = await ev(`(() => { const card = document.querySelector('[data-testid^="issue-card-"]'); if (!card) return null; card.focus(); const cs = getComputedStyle(card); const rect = card.getBoundingClientRect(); return { testid: card.getAttribute('data-testid'), role: card.getAttribute('role'), tabIndex: card.tabIndex, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, outlineStyle: cs.outlineStyle, visible: rect.width > 0 && rect.height > 0, ariaHiddenAncestor: card.closest('[aria-hidden="true"]') !== null }; })()`);
const shotLight = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(`${OUT}\\focus-ring-light.png`, Buffer.from(shotLight.data, 'base64'));

// ④ Enter 打开详情
const before = await ev(`document.querySelector('[data-testid="detail-panel"], [aria-label^="任务详情"], [data-testid^="issue-detail"]') ? 'open' : 'closed'`);
await key('Enter', 'Enter', 13);
await sleep(900);
const afterEnter = await ev(`document.querySelector('[data-testid="detail-panel"], [aria-label^="任务详情"], [data-testid^="issue-detail"], [data-testid="right-panel"]') ? 'open' : 'closed'`);

// ESC 关闭后测 Space 与键盘拖拽
await key('Escape', 'Escape', 27);
await sleep(600);
const spaceOpen = await (async () => {
  await ev(`document.querySelector('[data-testid^="issue-card-"]')?.focus()`);
  await key(' ', 'Space', 32);
  await sleep(700);
  return ev(`document.querySelector('[data-testid="detail-panel"], [aria-label^="任务详情"], [data-testid^="issue-detail"], [data-testid="right-panel"]') ? 'open' : 'closed'`);
})();
await key('Escape', 'Escape', 27);
await sleep(400);

// ⑤ 键盘拖拽路径：focus 卡片内 activator → Space 抓取 → ArrowRight → Space 放下
const dragPath = await (async () => {
  await ev(`(() => { const card = document.querySelector('[data-testid^="issue-card-"]'); const act = card?.querySelector('[role="button"]'); act?.focus(); return !!act; })()`);
  await key(' ', 'Space', 32);
  await sleep(400);
  const grabbed = await ev(`document.body.getAttribute('data-dnd') ?? document.querySelector('[data-dnd-grabbed], .dnd-grabbed') ? 'yes' : (document.querySelector('[aria-describedby]') ? 'maybe' : 'unknown')`);
  await key('ArrowRight', 'ArrowRight', 39);
  await sleep(300);
  await key(' ', 'Space', 32);
  await sleep(400);
  return grabbed;
})();

// 暗色焦点环
await ev(`localStorage.setItem('agentboard.theme','dark')`);
await send('Page.reload');
await sleep(3500);
await ev(`document.querySelector('[data-testid="sidebar-entry-board"]')?.click()`);
await sleep(2000);
const darkRing = await ev(`(() => { const card = document.querySelector('[data-testid^="issue-card-"]'); if (!card) return null; card.focus(); const cs = getComputedStyle(card); return { outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor }; })()`);
const shotDark = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(`${OUT}\\focus-ring-dark.png`, Buffer.from(shotDark.data, 'base64'));

// prefers-reduced-motion
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
const reducedRing = await ev(`(() => { const card = document.querySelector('[data-testid^="issue-card-"]'); if (!card) return null; card.focus(); const cs = getComputedStyle(card); return { outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, transition: cs.transitionDuration }; })()`);
const shotReduced = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(`${OUT}\\focus-ring-reduced-motion.png`, Buffer.from(shotReduced.data, 'base64'));

const result = { tabOrder: order, focusCard, detail: { before, afterEnter, spaceOpen }, dragPath, darkRing, reducedRing };
writeFileSync(`${OUT}\\result.json`, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
ws.close();
