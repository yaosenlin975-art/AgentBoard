// D15/D16 顶栏平台自适应验收
//
// 验收对象：**从 NSIS 安装包里解出的** apps/web/dist（不是仓库里的 dist，也不是 8787 上跑的那份）。
// 原因：仓库 apps/web/dist 是 pnpm build 的副作用产物，未走 publish:web；
//       8787 现网服务托管的就是它 —— 拿它当证据会验到错误的 bundle。
//
// 做法：起一个本地静态服务器托管包内 dist，用真实 Chromium 加载，
//       在页面脚本执行前注入 window.__AB_PLATFORM_OVERRIDE__（与 D16 的 initialization_script 同语义），
//       然后读真实布局盒（getBoundingClientRect）判断顺序/对齐/尺寸/间距。
//
// 用法：node tests/desktop/d15-titlebar-platform.mjs <pkgWebDistDir> [--json]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const pkgDist = process.argv[2];
if (!pkgDist) {
  console.error('用法：node d15-titlebar-platform.mjs <pkgWebDistDir> [--json]');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function startServer(root) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        let rel = urlPath === '/' ? '/index.html' : urlPath;
        const full = normalize(join(root, rel));
        // 目录越界防护
        if (!full.toLowerCase().startsWith(normalize(root).toLowerCase())) {
          res.writeHead(403).end('forbidden');
          return;
        }
        let target = full;
        try {
          const st = await stat(target);
          if (st.isDirectory()) target = join(target, 'index.html');
        } catch {
          // SPA 回退
          target = join(root, 'index.html');
        }
        const body = await readFile(target);
        res.writeHead(200, { 'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream' });
        res.end(body);
      } catch (error) {
        res.writeHead(500).end(String(error));
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// 注入桩：让页面认为自己跑在 Tauri 里，并按指定平台渲染顶栏。
//
// WindowTitleBar 的挂载条件是 `window.__TAURI_INTERNALS__ !== undefined`（浏览器里返回 null，不占布局）。
// 所以光注入平台值不够，必须同时补一个最小 Tauri 桩，否则组件根本不渲染 ——
// 这也是第一版脚本 W0/M0 全 FAIL 的原因（不是产品缺陷）。
//
// 桩只需覆盖组件实际用到的东西：invoke('plugin:window|is_maximized'|...) 与 metadata.currentWindow.label。
function tauriStub(platform) {
  window.__AB_PLATFORM_OVERRIDE__ = platform;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' } },
    // 只回应 is_maximized，其余返回 undefined（组件内部 catch 兜底）
    invoke: (cmd) =>
      cmd === 'plugin:window|is_maximized' ? Promise.resolve(false) : Promise.resolve(undefined),
  };
}
const results = [];
function check(id, title, ok, evidence) {
  results.push({ id, title, ok, evidence });
  console.log(`::${id}::${ok ? 'PASS' : 'FAIL'}::${evidence}`);
}

// 读顶栏结构：返回三键的名字、左侧坐标、宽高、容器信息
async function readTitleBar(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-testid="window-titlebar"]');
    if (!bar) return { found: false };
    const barRect = bar.getBoundingClientRect();
    const buttons = [...bar.querySelectorAll('button')].map((b) => {
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      return {
        label: b.getAttribute('aria-label') || b.textContent?.trim() || '',
        title: b.getAttribute('title') || '',
        left: Math.round(r.left),
        top: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
        borderRadius: cs.borderRadius,
        backgroundColor: cs.backgroundColor,
      };
    });
    // 找圆点容器（mac）：带 group/dots 类的元素
    const dotsWrap = bar.querySelector('.group\\/dots');
    let dots = null;
    if (dotsWrap) {
      const dr = dotsWrap.getBoundingClientRect();
      const cs = getComputedStyle(dotsWrap);
      dots = {
        left: Math.round(dr.left),
        top: Math.round(dr.top),
        width: Math.round(dr.width),
        height: Math.round(dr.height),
        gap: cs.gap,
        paddingLeft: cs.paddingLeft,
      };
    }
    return {
      found: true,
      barLeft: Math.round(barRect.left),
      barTop: Math.round(barRect.top),
      barWidth: Math.round(barRect.width),
      barHeight: Math.round(barRect.height),
      buttons,
      dots,
    };
  });
}

const server = await startServer(pkgDist);
const port = server.address().port;
const base = `http://127.0.0.1:${port}/`;

const { chromium } = await import(
  new URL('../e2e/node_modules/playwright/index.mjs', import.meta.url).href
);
const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });

try {
  // ---------- 场景 1：Windows ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(tauriStub, 'windows');
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(1200);
    const info = await readTitleBar(page);

    if (!info.found) {
      check('W0', 'Windows：找到 window-titlebar', false, '未找到 [data-testid=window-titlebar]');
    } else {
      check('W0', 'Windows：找到 window-titlebar', true, `bar=${info.barWidth}x${info.barHeight} @(${info.barLeft},${info.barTop})`);
      const labels = info.buttons.map((b) => b.label);
      const expect = ['最小化窗口', '最大化窗口', '关闭窗口'];
      // 最大化后 aria-label 会变「还原窗口」，两者都算合法
      const normalized = labels.map((l) => (l === '还原窗口' ? '最大化窗口' : l));
      check(
        'W1',
        'Windows：三键顺序 最小化/最大化/关闭',
        JSON.stringify(normalized) === JSON.stringify(expect),
        `实际=${JSON.stringify(labels)}`,
      );
      // 右侧对齐：关闭键的右边缘贴近顶栏右边缘
      const close = info.buttons.find((b) => b.label === '关闭窗口' || b.label === '关闭');
      if (close) {
        const gapRight = info.barLeft + info.barWidth - (close.left + close.width);
        check('W2', 'Windows：三键靠右对齐（关闭右边缘距栏右 ≤2px）', Math.abs(gapRight) <= 2, `右侧余量=${gapRight}px`);
      } else {
        check('W2', 'Windows：三键靠右对齐', false, '未找到关闭键');
      }
      // 三键应水平等高且相邻（无左侧圆点容器）
      check('W3', 'Windows：无 mac 圆点容器', info.dots === null, `dots=${JSON.stringify(info.dots)}`);
      // 三个按钮都在顶栏上半部（同一行）
      const tops = [...new Set(info.buttons.map((b) => b.top))];
      check('W4', 'Windows：三键同一水平行', tops.length === 1, `top 值=${JSON.stringify(tops)}`);
      await page.screenshot({ path: join(process.cwd(), '.logs', 'p16-win-titlebar.png') }).catch(() => {});
    }
    await ctx.close();
  }

  // ---------- 场景 2：macOS ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(tauriStub, 'macos');
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(1200);
    const info = await readTitleBar(page);

    if (!info.found) {
      check('M0', 'macOS：找到 window-titlebar', false, '未找到');
    } else {
      check('M0', 'macOS：找到 window-titlebar', true, `bar=${info.barWidth}x${info.barHeight}`);
      const labels = info.buttons.map((b) => b.label);
      const normalized = labels.map((l) => (l === '还原窗口' ? '最大化窗口' : l));
      const expectMac = ['关闭窗口', '最小化窗口', '最大化窗口'];
      check(
        'M1',
        'macOS：三键顺序 关闭/最小化/最大化',
        JSON.stringify(normalized) === JSON.stringify(expectMac),
        `实际=${JSON.stringify(labels)}`,
      );
      // 左侧对齐：第一个键（关闭）左边缘贴近栏左
      if (info.dots) {
        const gapLeft = info.dots.left - info.barLeft;
        check('M2', 'macOS：圆点组靠左（距栏左 ≤20px）', gapLeft >= 0 && gapLeft <= 20, `左侧余量=${gapLeft}px`);
        check('M3', 'macOS：圆点组间距 8px', info.dots.gap === '8px', `gap=${info.dots.gap}`);
      } else {
        check('M2', 'macOS：圆点组存在且靠左', false, '未找到 .group/dots 容器');
        check('M3', 'macOS：圆点组间距 8px', false, '未找到容器');
      }
      // 圆点尺寸 12×12
      const sizes = [...new Set(info.buttons.map((b) => `${b.width}x${b.height}`))];
      check('M4', 'macOS：三圆点均为 12×12', sizes.length === 1 && sizes[0] === '12x12', `实际尺寸=${JSON.stringify(sizes)}`);
      // 圆点应为圆形
      const radii = [...new Set(info.buttons.map((b) => b.borderRadius))];
      // 圆点应为圆形。注意 Tailwind v4 的 `rounded-full` 是 `calc(infinity * 1px)`，
      // 浏览器算出来是 3.35544e+07px 这种极大值（不是 50%、也不是 9999px）——
      // 按「半径 ≥ 边长一半」判定为圆，比匹配字面值稳。
      const radiusOk = info.buttons.every((b) => {
        const raw = parseFloat(String(b.borderRadius).replace('px', ''));
        return Number.isFinite(raw) && raw >= Math.min(b.width, b.height) / 2;
      });
      check('M5', 'macOS：圆点为圆形（半径 ≥ 半径长）', radiusOk, `radius=${JSON.stringify(radii)}`);
      await page.screenshot({ path: join(process.cwd(), '.logs', 'p16-mac-titlebar.png') }).catch(() => {});
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}

const fail = results.filter((r) => !r.ok).length;
console.log('');
console.log(`合计 ${results.length} 项：通过 ${results.length - fail}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
