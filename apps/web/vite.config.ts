import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const apiTarget = process.env.AGENTBOARD_WEB_API_TARGET ?? 'http://127.0.0.1:8787';
const websocketTarget = apiTarget.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // shared 以源码形式直接消费，避免依赖其 dist 构建产物
      '@agentboard/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  // WEB-BUNDLE（3451075e）：不按组件目录切 chunk（目录级 manualChunks 会把「该目录有静态依赖」
  // 的整块拖回首屏，实测首屏 gzip 反而从 305.53 涨到 416.44 kB）。改由 App.tsx 对
  // knowledge/chat/drawer/right 四个重视图做 React.lazy 动态导入，首屏只保留看板与外壳。
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/ws': { target: websocketTarget, ws: true },
    },
  },
});
