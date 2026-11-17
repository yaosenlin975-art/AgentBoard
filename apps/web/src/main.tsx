import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { ChunkErrorBanner } from './components/ui/ChunkErrorBanner';
import { AppErrorBoundary } from './components/shell/AppErrorBoundary';
import { installChunkErrorRecovery } from './lib/chunkRecovery';
import { installClientErrorHooks } from './lib/errorBuffer';
import { initTheme } from './theme';
import './index.css';

// CHUNK-RECOVER-W：旧页面引用已不存在的 chunk（dist 重建过）→ 自动刷新一次，再失败只提示不循环
installChunkErrorRecovery();

/**
 * G3：全局错误钩子。本卡只记到环形缓冲（白屏时「复制错误信息」能读到完整上下文），
 * 网络上报是 G4/G5 的事——这里刻意不联网，避免异常路径里再抛一次。
 */
installClientErrorHooks();

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
