// 正式页（8787）六项冒烟：真实浏览器 + 计算样式/几何断言，逐项出证据与截图。
const PORT = 9333;
const BASE = 'http://127.0.0.1:8787/';
const OUT = 'D:\\WorkSpaces\\任务看板\\Docs\\verification\\2026-11-04-formal-page-smoke';
import { writeFileSync, mkdirSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  // 优先复用已是本站的 page；否则显式新建一个 tab（避免连到 edge://sync-confirmation-dialog 这类目标卡死）
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const ours = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:8787'));
      if (ours) return ours.webSocketDebuggerUrl;
      const blank = list.find((t) => t.type === 'page' && t.url === 'about:blank');
      if (blank) return blank.webSocketDebuggerUrl;
      if (i === 3) {
        const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('http://127.0.0.1:8787/')}`, { method: 'PUT' })).json();
        if (created.webSocketDebuggerUrl) return created.webSocketDebuggerUrl;
      }
    } catch { /* 等浏览器 */ }
    await sleep(500);
  }
  throw new Error('CDP 不可用');
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
    return r.result.value;
  }
}

const H = { // 页面内复用的 helper：几何 + 计算样式 + WCAG
  helpers: String.raw`
  const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), midY: Math.round(r.y + r.height / 2), right: Math.round(r.right) }; };
  const txt = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
  const hasText = (needle) => [...document.querySelectorAll('body *')].some((el) => el.children.length === 0 && (el.textContent ?? '').trim().includes(needle));
  const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const parse = (c) => { if (!c) return null; ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = 'rgba(0,0,0,0)'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }; };
  const comp = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const lum = ({ r, g, b }) => { const f = (v) => { const n = v / 255; return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const effBg = (el) => { const layers = []; let cur = el; while (cur) { const bg = parse(getComputedStyle(cur).backgroundColor); if (bg && bg.a > 0) { layers.push(bg); if (bg.a >= 0.999) break; } cur = cur.parentElement; } const root = parse(getComputedStyle(document.body).backgroundColor); let base = layers.length > 0 && layers[layers.length - 1].a >= 0.999 ? layers.pop() : (root && root.a >= 0.999 ? root : { r: 255, g: 255, b: 255, a: 1 }); for (let i = layers.length - 1; i >= 0; i -= 1) base = comp(layers[i], base); return base; };
  const contrastOf = (el) => { if (!el) return null; const fg = parse(getComputedStyle(el).color); const bg = effBg(el); if (!fg) return null; const fgc = fg.a >= 0.999 ? fg : comp(fg, bg); return { fg: 'rgb(' + [fgc.r, fgc.g, fgc.b].map(Math.round) + ')', bg: 'rgb(' + [bg.r, bg.g, bg.b].map(Math.round) + ')', ratio: Math.round(ratio(fgc, bg) * 100) / 100 }; };
  `,
};

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const ws = new WebSocket(await wsUrl());
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(3500);
  // 选中工作空间 + 暗色主题（用户报的那套配置）
  await cdp.eval(`(() => { localStorage.setItem('agentboard.theme', 'dark'); localStorage.setItem('agentboard.selected-workspace', JSON.stringify({ state: { workspaceId: 'e41eb0fb-c367-43cf-a99d-6dc5239a5694' }, version: 0 })); })()`);
  await cdp.send('Page.reload');
  await sleep(4000);

  const shot = async (name) => {
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${OUT}\\${name}.png`, Buffer.from(png.data, 'base64'));
  };
  const results = {};

  // ① 顶栏是路径而不是版本号
  results['1_topbar_path'] = await cdp.eval(`(() => { ${H.helpers}
    const path = txt('[data-testid="topbar-workspace-path"]');
    const versionInTopbar = document.querySelector('header [data-testid="app-version"]') !== null;
    const title = txt('[data-testid="topbar-workspace"]');
    return { path, title, versionInTopbar, pass: path !== null && path.includes('WorkSpaces') && versionInTopbar === false };
  })()`);
  await shot('1-topbar');

  // ② 搜索框与标签栏在「日志」右侧、同一行
  results['2_toolbar_row'] = await cdp.eval(`(() => { ${H.helpers}
    const log = rect('[data-testid="view-log"]');
    const search = rect('input[placeholder="搜索标题/描述/标签"]');
    const labelBar = document.querySelector('[data-testid^="label-filter"], [aria-label="标签筛选"]');
    const label = labelBar ? { x: Math.round(labelBar.getBoundingClientRect().x), midY: Math.round(labelBar.getBoundingClientRect().y + labelBar.getBoundingClientRect().height / 2) } : null;
    const sameRow = search && log ? Math.abs(search.midY - log.midY) <= 12 : false;
    const rightOf = search && log ? search.x >= log.right - 4 : false;
    return { log, search, label, sameRow, rightOf, pass: sameRow && rightOf };
  })()`);
  await shot('2-toolbar');

  // ③ 知识库：无「共享知识库」标题块 + 搜索栏一行
  await cdp.eval(`document.querySelector('[data-testid="view-knowledge"]')?.click()`);
  await sleep(2500);
  results['3_knowledge'] = await cdp.eval(`(() => { ${H.helpers}
    const hasBlockTitle = hasText('共享知识库');
    const search = rect('input[placeholder*="搜索"]');
    const scope = rect('[data-testid="knowledge-scope"]');
    const oneRow = search && scope ? Math.abs(search.midY - scope.midY) <= 12 : null;
    return { hasBlockTitle, search, scope, oneRow, pass: hasBlockTitle === false };
  })()`);
  await shot('3-knowledge');

  // ④ 星图首屏居中
  results['4_graph_center'] = await cdp.eval(`(() => { ${H.helpers}
    const graphCanvas = document.querySelector('canvas');
    if (!graphCanvas) return { pass: null, note: '无 canvas（星图未渲染）' };
    const c = graphCanvas.getBoundingClientRect();
    const parent = graphCanvas.parentElement.getBoundingClientRect();
    const dx = Math.abs((c.x + c.width / 2) - (parent.x + parent.width / 2));
    const dy = Math.abs((c.y + c.height / 2) - (parent.y + parent.height / 2));
    return { dx: Math.round(dx), dy: Math.round(dy), parentW: Math.round(parent.width), pass: dx <= parent.width * 0.05 && dy <= parent.height * 0.05 };
  })()`);
  await shot('4-graph');

  // ⑤ 日志视图：无「工作区日志」标题与切换
  await cdp.eval(`document.querySelector('[data-testid="view-log"]')?.click()`);
  await sleep(2500);
  results['5_log'] = await cdp.eval(`(() => { ${H.helpers}
    return { hasTitle: hasText('工作区日志'), hasTabs: hasText('历史日志') || hasText('归档日志'), pass: !hasText('工作区日志') };
  })()`);
  await shot('5-log');

  // ⑥ 暗色「修改模型」弹窗文字可读（对比度 ≥4.5）
  await cdp.eval(`document.querySelector('[data-testid="topbar-chat"]')?.click()`);
  await sleep(1500);
  await cdp.eval(`document.querySelector('[data-testid="session-switcher"]')?.click()`);
  await sleep(1200);
  await cdp.eval(`document.querySelector('[data-testid^="session-option-"]')?.click()`);
  await sleep(1500);
  await cdp.eval(`document.querySelector('[data-testid="edit-model-btn"]')?.click()`);
  await sleep(1500);
  results['6_model_modal'] = await cdp.eval(`(() => { ${H.helpers}
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return { pass: false, note: '弹窗未打开' };
    const title = dialog.querySelector('h2');
    const fields = [...dialog.querySelectorAll('input, select, p, button')].filter((el) => (el.textContent ?? '').trim() !== '' || el.tagName === 'INPUT' || el.tagName === 'SELECT');
    const rows = fields.map((el) => ({ el: el.tagName.toLowerCase() + (el.getAttribute('data-testid') ? '[' + el.getAttribute('data-testid') + ']' : ''), ...contrastOf(el) })).filter((r) => r.ratio !== undefined);
    const worst = rows.sort((a, b) => a.ratio - b.ratio)[0];
    return { dark: document.documentElement.classList.contains('dark'), title: title?.textContent, titleContrast: contrastOf(title), worst, min: worst?.ratio, pass: worst !== undefined && worst.ratio >= 4.5 };
  })()`);
  await shot('6-model-dark');

  console.log(JSON.stringify(results, null, 2));
  writeFileSync(`${OUT}\\results.json`, JSON.stringify(results, null, 2));
  ws.close();
};

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; });


