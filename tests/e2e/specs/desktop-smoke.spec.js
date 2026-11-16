'use strict';

/**
 * 最小可跑通的桌面端冒烟用例（C5 验收脚手架第一层）。
 *
 * 覆盖：dev 模式启动 → 窗口加载成功 → 标题/关键元素存在 → 正常退出。
 * 不覆盖：安装包、单实例、残留进程、端口占用（在 tests/e2e/scripts/ 下用独立脚本验）。
 *
 * 运行（在 tests/e2e 目录）：
 *   npx playwright test specs/desktop-smoke.spec.js --reporter=list
 */
const { test, expect } = require('@playwright/test');
const { launchDev, makeIsolatedEnv, firstWindowReady, readMainLog, readServerLog } = require('../lib/desktop');

test.describe('桌面端冒烟（dev 模式）', () => {
  let env;

  test.beforeEach(async () => {
    env = await makeIsolatedEnv();
  });

  test.afterEach(async () => {
    env?.dispose();
    env = null;
  });

  test('启动窗口、加载看板、关键元素齐全、正常退出', async () => {
    const app = await launchDev({ env: env.env, args: env.userDataArgs });
    try {
      const { window, consoleLines } = await firstWindowReady(app);

      // 1) 主进程侧：恰好一个窗口、可见、走 dev（未打包）分支、URL 指向本实例端口
      const mainState = await app.evaluate(async ({ app: electronApp, BrowserWindow }) => {
        const wins = BrowserWindow.getAllWindows();
        return {
          isPackaged: electronApp.isPackaged,
          userData: electronApp.getPath('userData'),
          windowCount: wins.length,
          visible: wins[0]?.isVisible() ?? false,
          url: wins[0]?.webContents.getURL() ?? null,
        };
      });
      expect(mainState.isPackaged).toBe(false);
      expect(mainState.windowCount).toBe(1);
      expect(mainState.visible).toBe(true);
      expect(mainState.url).toBe(`http://127.0.0.1:${env.port}/`);
      // 隔离生效：userData 就是临时目录，不是 %APPDATA%\AgentBoard
      expect(mainState.userData.toLowerCase()).toBe(env.userDataDir.toLowerCase());

      // 2) 渲染进程侧：标题 + 三区骨架 + 顶栏控件（选择器取自 apps/web/src）
      await expect(window).toHaveTitle('AgentBoard');
      await expect(window.getByRole('heading', { name: '工作空间' })).toBeVisible();
      await expect(window.getByRole('list', { name: '工作空间列表' })).toBeVisible();
      await expect(window.getByLabel('CLI 状态')).toBeVisible();
      await expect(window.getByRole('button', { name: '设置' })).toBeVisible();
      await expect(window.getByText('已连接', { exact: true })).toBeVisible();

      // 3) 全新库：空态文案 + 新建 issue 按钮禁用（未选工作空间）
      await expect(window.getByText('还没有工作空间')).toBeVisible();
      await expect(window.getByRole('button', { name: '新建 issue' })).toBeDisabled();

      // 4) 渲染进程无未捕获异常
      const errors = consoleLines.filter((line) => line.startsWith('[pageerror]'));
      expect(errors, `渲染进程异常：\n${errors.join('\n')}`).toEqual([]);

      // 5) 日志证据：主进程启动行、窗口创建行、服务子进程就绪行
      const main = readMainLog(env);
      expect(main).toContain('==== 启动 mode=dev');
      expect(main).toContain('窗口已创建');
      expect(readServerLog(env)).toContain(`AgentBoard listening on http://127.0.0.1:${env.port}`);
    } finally {
      await app.close();
    }

    // 6) 退出后窗口归零：close() 已等主进程结束
    expect(app.windows().length).toBe(0);
  });

  test('重复启动两次都能正常起停（稳定性基线，不含单实例锁）', async () => {
    for (let round = 1; round <= 2; round += 1) {
      const fresh = await makeIsolatedEnv();
      try {
        const app = await launchDev({ env: fresh.env, args: fresh.userDataArgs });
        try {
          const { window } = await firstWindowReady(app);
          await expect(window).toHaveTitle('AgentBoard');
          await expect(window.getByText('已连接', { exact: true })).toBeVisible();
        } finally {
          await app.close();
        }
        expect(app.windows().length).toBe(0);
      } finally {
        fresh.dispose();
      }
    }
  });
});
