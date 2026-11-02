/**
 * 知识页打印视图（KB-EXPORT 方案 A：浏览器打印，零依赖）。
 * - 只读快照：内容全部来自已加载的 `page` prop，打印过程不发起新查询、不改页面状态；
 * - portal 到 document.body 的 `#kg-print-root`，平时 `display:none`，仅 `@media print` + `body.kg-printing` 时可见；
 * - 打印样式：隐藏应用外壳（#root）、强制浅色、标题不与正文分离、代码块/表格/引用不跨页断裂。
 */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { KnowledgePage } from '@agentboard/shared';

const PRINT_BODY_CLASS = 'kg-printing';

const PRINT_STYLES = `
#kg-print-root { display: none; }
@media print {
  body.${PRINT_BODY_CLASS} { background: #fff !important; }
  body.${PRINT_BODY_CLASS} #root { display: none !important; }
  body.${PRINT_BODY_CLASS} #kg-print-root {
    display: block !important; color: #000; font-size: 12pt; line-height: 1.6;
  }
  body.${PRINT_BODY_CLASS} #kg-print-root * { color: #000 !important; background: transparent !important; box-shadow: none !important; }
  body.${PRINT_BODY_CLASS} #kg-print-root h1 { font-size: 20pt; margin: 0 0 8pt; }
  body.${PRINT_BODY_CLASS} #kg-print-root h2 { font-size: 14pt; margin: 14pt 0 6pt; break-after: avoid; page-break-after: avoid; }
  body.${PRINT_BODY_CLASS} #kg-print-root h3 { font-size: 12pt; margin: 10pt 0 4pt; break-after: avoid; page-break-after: avoid; }
  body.${PRINT_BODY_CLASS} #kg-print-root pre,
  body.${PRINT_BODY_CLASS} #kg-print-root blockquote,
  body.${PRINT_BODY_CLASS} #kg-print-root table,
  body.${PRINT_BODY_CLASS} #kg-print-root li { break-inside: avoid; page-break-inside: avoid; }
  body.${PRINT_BODY_CLASS} #kg-print-root pre { white-space: pre-wrap; word-break: break-word; border: 1px solid #999; padding: 6pt; }
  body.${PRINT_BODY_CLASS} #kg-print-root table { border-collapse: collapse; width: 100%; }
  body.${PRINT_BODY_CLASS} #kg-print-root th,
  body.${PRINT_BODY_CLASS} #kg-print-root td { border: 1px solid #999; padding: 2pt 4pt; text-align: left; }
  body.${PRINT_BODY_CLASS} #kg-print-root code { font-family: ui-monospace, monospace; }
  body.${PRINT_BODY_CLASS} #kg-print-root .print-meta { font-size: 10pt; border: 1px solid #bbb; padding: 6pt; }
  body.${PRINT_BODY_CLASS} #kg-print-root .print-provenance { font-size: 10pt; }
  @page { margin: 16mm; }
}
`;

export interface KnowledgePrintViewProps {
  page: KnowledgePage;
  workspaceName?: string | null;
  /** 正文渲染器（复用详情页同一个 MarkdownView，保持与页面一致） */
  renderBody: (markdown: string) => React.ReactNode;
  /** 是否处于打印流程；false 时不挂载（避免与详情页文本重复、避免无谓 DOM） */
  open: boolean;
  /** 打印结束（afterprint）回调：由调用方卸载视图 */
  onAfterPrint: () => void;
}

const isoDate = (ms: number | null | undefined): string =>
  typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toLocaleString() : '—';

export function KnowledgePrintView({ page, workspaceName, renderBody, open, onAfterPrint }: KnowledgePrintViewProps) {
  // 打印结束（afterprint）或组件卸载时都要还原 body 类，并把「打印中」状态交回调用方
  useEffect(() => {
    if (!open) return undefined;
    const onAfter = (): void => {
      document.body.classList.remove(PRINT_BODY_CLASS);
      onAfterPrint();
    };
    window.addEventListener('afterprint', onAfter);
    document.body.classList.add(PRINT_BODY_CLASS);
    // 等打印视图完成一次提交后再唤起打印对话框，保证打印内容已就位
    const timer = window.setTimeout(() => window.print(), 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('afterprint', onAfter);
      document.body.classList.remove(PRINT_BODY_CLASS);
    };
  }, [open, onAfterPrint]);

  if (!open) return null;
  const workspace = page.scope === 'common' ? '公共' : (workspaceName ?? page.workspace_id ?? '—');

  return createPortal(
    <div id="kg-print-root" data-testid="knowledge-print-view" aria-hidden="true">
      <style dangerouslySetInnerHTML={{ __html: PRINT_STYLES }} />
      <h1>{page.title}</h1>
      <div className="print-meta">
        <div>slug: {page.slug}</div>
        <div>范围: {page.scope === 'common' ? '公共经验' : '项目知识'}</div>
        <div>工作空间: {workspace}</div>
        <div>版本: v{page.revision} · 状态: {page.status}</div>
        <div>更新时间: {isoDate(page.updated_at)}</div>
      </div>
      <h2>正文</h2>
      <div>{renderBody(page.body_md)}</div>
      <h2>来源（{page.sources.length}）</h2>
      {page.sources.length === 0 ? (
        <p>（无）</p>
      ) : (
        <ul className="print-provenance">
          {page.sources.map((s) => (
            <li key={s.source_id}>
              <code>{s.locator}</code>
              {s.content_hash ? ` · SHA-256 ${s.content_hash.slice(0, 12)}…` : ''} · {isoDate(s.captured_at)}
            </li>
          ))}
        </ul>
      )}
      <h2>证据（{page.evidence.length}）</h2>
      {page.evidence.length === 0 ? (
        <p>（无）</p>
      ) : (
        <ul className="print-provenance">
          {page.evidence.map((e, i) => (
            <li key={`${e.source_id}-${i}`}>
              <code>{e.locator}</code>
              {e.snapshot ? <blockquote>{e.snapshot}</blockquote> : null}
            </li>
          ))}
        </ul>
      )}
    </div>,
    document.body,
  );
}
