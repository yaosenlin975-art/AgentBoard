import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { ChunkErrorBanner } from './components/ui/ChunkErrorBanner';
import { installChunkErrorRecovery } from './lib/chunkRecovery';
import { initTheme } from './theme';
import './index.css';

// CHUNK-RECOVER-W：旧页面引用已不存在的 chunk（dist 重建过）→ 自动刷新一次，再失败只提示不循环
installChunkErrorRecovery();

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
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="*" element={<App />} />
        </Routes>
      </BrowserRouter>
      <ChunkErrorBanner />
    </QueryClientProvider>
  </StrictMode>,
);
