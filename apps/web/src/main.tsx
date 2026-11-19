import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { ChunkErrorBanner } from './components/ui/ChunkErrorBanner';
import { AppErrorBoundary } from './components/shell/AppErrorBoundary';
import { installChunkErrorRecovery } from './lib/chunkRecovery';
import { installClientErrorHooks } from './lib/errorBuffer';
import { fetchInstanceId, installErrorReporting } from './lib/errorReporting';
import { WEB_VERSION } from './api/version';
import { initTheme } from './theme';
import './index.css';

// CHUNK-RECOVER-W：旧页面引用已不存在的 chunk（dist 重建过）→ 自动刷新一次，再失败只提示不循环
installChunkErrorRecovery();

/**
 * G3：全局错误钩子。只记到环形缓冲（白屏时「复制错误信息」能读到完整上下文）。
 */
installClientErrorHooks();

/**
 * G5：把缓冲接到 `POST /api/client-diagnostics`（G4 的取证端点）。
 * 上报在微任务里做、失败静默、同一指纹只报一次；`ab.diagnostics.disabled=1` 时一个请求都不发。
 */
installErrorReporting({ resolveInstanceId: fetchInstanceId, appVersion: WEB_VERSION });

initTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 15_000,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* G3：包在 QueryClientProvider 外层（provider 抛错也能兜住）、StrictMode 内层 */}
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route path="*" element={<App />} />
          </Routes>
        </BrowserRouter>
        <ChunkErrorBanner />
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
