/**
 * CHUNK-RECOVER-W：旧页面 + 新 dist（chunk 已不存在）时的可读提示条。
 *
 * 只在 `lib/chunkRecovery.ts` 判定为 stale（已经自动刷新过一次仍失败）时出现，
 * 避免刷新循环；样式只用 unslop 令牌（`surface-card`/`hairline`/`ink-*`/`accent`）。
 */
import { useEffect, useState } from 'react';
import { isStale, subscribeStale } from '../../lib/chunkRecovery';

export function ChunkErrorBanner() {
  const [stale, setStale] = useState(isStale);
  useEffect(() => subscribeStale(() => setStale(isStale())), []);
  if (!stale) return null;
  return (
    <div
      data-testid="chunk-error-banner"
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-[70] flex flex-wrap items-center justify-center gap-2 border-t border-hairline bg-surface-card px-3 py-2 text-xs text-ink shadow-lg"
    >
      <span>页面已过期（新版本已发布），请刷新</span>
      <button
        type="button"
        data-testid="chunk-error-reload"
        onClick={() => window.location.reload()}
        className="rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-accent-ink transition-colors duration-150 hover:bg-accent-soft hover:text-accent motion-reduce:transition-none"
      >
        刷新
      </button>
    </div>
  );
}
