/**
 * DETAIL-D6 统一图片灯箱：描述内联图与评论内联图共用同一实现。
 *
 * 口径：
 * - 渲染到 body 的 portal —— 右侧面板有 transform/锚定定位，`fixed` 若留在面板内会以面板为包含块，遮不住全屏；
 * - Esc / 遮罩 / 关闭按钮三种退出；退出（卸载）时把焦点还给触发原图（由本组件在挂载时记录 activeElement）；
 * - `role="dialog"` + `aria-modal="true"`，关闭按钮有 aria-label；
 * - 灯箱只是「看大图」，不承担图注编辑；图注沿用 alt（缺失时上游已兜底「图片」），不自动编造内容；
 * - 图片内联图仅作讨论内容，不是证据 locator（证据仍只认仓库相对路径与 issue:/cmd:/agent: 前缀）。
 */
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';

export interface ImageLightboxProps {
  src: string;
  /** 图注：内联图的 alt；空值由调用方兜底为「图片」 */
  alt: string;
  onClose: () => void;
}

export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  const [entered, setEntered] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    // 记录打开前的焦点元素，卸载时归还（卡面：退出后焦点回原图）
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const frame = requestAnimationFrame(() => setEntered(true));
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // 先关灯箱：吞掉这次 Esc，避免继续冒泡把右侧面板一起关掉
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown, true);
      previous?.focus();
    };
  }, []);

  return createPortal(
    <div
      data-testid="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-black/75 p-4"
      onMouseDown={(event) => {
        // 只有点遮罩（空白区）才退出；点图片本身不关
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        ref={closeRef}
        type="button"
        data-testid="image-lightbox-close"
        aria-label="关闭图片预览"
        onClick={onClose}
        className="absolute right-3 top-3 rounded-full bg-white/15 px-2.5 py-1 text-lg leading-6 text-white transition-colors hover:bg-white/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        ✕
      </button>
      <img
        src={src}
        alt={alt}
        className={`max-h-[85vh] max-w-full rounded object-contain transition-transform duration-150 motion-reduce:transition-none ${entered ? 'scale-100' : 'scale-95'}`}
      />
      {alt.trim() !== '' && (
        <p
          data-testid="image-lightbox-caption"
          className="max-w-[90vw] break-all text-center text-sm text-white/90"
        >
          {alt}
        </p>
      )}
    </div>,
    document.body,
  );
}
