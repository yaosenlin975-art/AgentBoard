'use strict';

/**
 * Playwright 配置：仅跑 Electron 桌面端用例。
 *
 * 关键取舍：
 *  - 不给 Playwright 装浏览器内核（Electron 自带 Chromium）——省 300MB 下载；
 *  - 串行执行（workers: 1）：桌面端用例会抢单实例锁与端口，并行只会互相打；
 *  - trace 只在失败时保留，截图/video 只在失败时留，避免正常跑一次就堆几 GB。
 */
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './specs',
  timeout: 120000,
  expect: { timeout: 15000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: './.artifacts',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
});
