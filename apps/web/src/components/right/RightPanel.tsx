/**
 * 右侧面板单实例容器（§7.4/§7.5）：
 * - view===null 不渲染；收起（rightOpen=false）渲染窄条，展开按钮恢复原视图；
 * - 展开时顶部条（视图标题 + 收起按钮），左缘拖拽调宽（320–720px，localStorage 持久）；
 * - view==='detail' 渲染 DetailPanel（T13），view==='chat' 渲染聊天视图（T14 占位）。
 * 视图组件各持 react-query 缓存，收起/展开与往返切换不丢数据。
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { usePanelStore } from '../../state/panelStore';
import { DetailPanel } from '../detail/DetailPanel';
import { ChatPanelPlaceholder } from './ChatPanelPlaceholder';

const WIDTH_KEY = 'agentboard.right-panel-width';
const MIN_WIDTH = 320;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 420;

function clampWidth(w: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));
}

function loadWidth(): number {
  const raw = localStorage.getItem(WIDTH_KEY);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? clampWidth(n) : DEFAULT_WIDTH;
}

export function RightPanel() {
  const view = usePanelStore((s) => s.view);
  const rightOpen = usePanelStore((s) => s.rightOpen);
  const issueId = usePanelStore((s) => s.issueId);
  const openDetail = usePanelStore((s) => s.openDetail);
  const openChat = usePanelStore((s) => s.openChat);
  const closeRight = usePanelStore((s) => s.closeRight);

  const [width, setWidth] = useState(loadWidth);
  const widthRef = useRef(width);
  widthRef.current = width;

  if (view === null) return null;

  const restore = (): void => {
    if (view === 'detail' && issueId !== null) openDetail(issueId);
    else openChat();
  };

  // 收起态：窄条 + 展开按钮
  if (!rightOpen) {
    return (
      <aside
        data-testid="right-panel-collapsed"
        className="flex w-10 shrink-0 flex-col items-center gap-2 border-l border-neutral-200 bg-white py-2 dark:border-neutral-800 dark:bg-neutral-900"
      >
        <button
          type="button"
          data-testid="right-panel-expand"
          aria-label="展开右侧面板"
          title="展开右侧面板"
          onClick={restore}
          className="rounded px-1.5 py-1 text-sm text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          ◀
        </button>
        <span className="text-xs [writing-mode:vertical-rl] text-neutral-400 dark:text-neutral-600">
          {view === 'detail' ? '任务详情' : '聊天'}
        </span>
      </aside>
    );
  }

  const onHandlePointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;
    const onMove = (ev: PointerEvent): void => {
      setWidth(clampWidth(startWidth + (startX - ev.clientX)));
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setWidth((w) => {
        const c = clampWidth(w);
        localStorage.setItem(WIDTH_KEY, String(c));
        return c;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <aside
      data-testid="right-panel"
      style={{ width: `${width}px` }}
      className="relative flex shrink-0 flex-col border-l border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
    >
      <div
        data-testid="right-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整面板宽度"
        title="拖拽调整宽度"
        onPointerDown={onHandlePointerDown}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-blue-400/60"
      />
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-neutral-200 px-3 dark:border-neutral-800">
        <h2 className="text-sm font-semibold">{view === 'detail' ? '任务详情' : '聊天'}</h2>
        <button
          type="button"
          data-testid="right-panel-collapse"
          aria-label="收起右侧面板"
          title="收起右侧面板"
          onClick={closeRight}
          className="rounded px-2 py-0.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          ×
        </button>
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {view === 'detail' ? <DetailPanel /> : <ChatPanelPlaceholder />}
      </div>
    </aside>
  );
}
