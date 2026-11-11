/**
 * 教程视图（GUIDE-1，左栏第 7 个主入口）。
 *
 * 内容数据驱动：`chapters/*.ts` 每个模块导出 `chapter`，这里用 `import.meta.glob` 聚合，
 * 按 `order` 升序渲染；章节目录在宽屏（≥1024px）固定 220px 左栏，窄屏变成顶部横向 chip。
 * 章末 `goTo` 只调 `useNavStore.setView`，不新增路由。
 */
import { useMemo, type ReactNode } from 'react';
import { useNavStore, type NavView } from '../../state/navStore';
import type { GuideBlock, GuideChapter } from './types';

const modules = import.meta.glob('./chapters/*.ts', { eager: true }) as Record<
  string,
  { chapter?: GuideChapter }
>;

function collectChapters(): GuideChapter[] {
  return Object.values(modules)
    .map((module) => module.chapter)
    .filter((chapter): chapter is GuideChapter => chapter !== undefined)
    .sort((a, b) => a.order - b.order);
}

/** 供测试断言目录项数量与顺序（与渲染同源，避免测试另算一份） */
export const GUIDE_CHAPTERS: readonly GuideChapter[] = collectChapters();

function chapterAnchor(id: string): string {
  return `guide-chapter-${id}`;
}

function scrollToChapter(id: string): void {
  const el = document.getElementById(chapterAnchor(id));
  el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}

const NOTE_TONE: Record<'info' | 'warn', string> = {
  info: 'border-l-accent',
  warn: 'border-l-accent bg-accent-soft',
};

function renderBlock(block: GuideBlock, index: number): ReactNode {
  if (block.kind === 'steps') {
    return (
      <ol key={index} className="list-decimal space-y-2 pl-5 text-sm text-ink-2">
        {block.items.map((item, i) => (
          <li key={i}>
            <span className="text-ink">{item.do}</span>
            {item.result !== undefined && (
              <span className="mt-0.5 block text-xs text-ink-3">→ {item.result}</span>
            )}
          </li>
        ))}
      </ol>
    );
  }
  if (block.kind === 'note') {
    const tone = block.tone ?? 'info';
    return (
      <p
        key={index}
        data-tone={tone}
        className={`rounded-md border border-hairline border-l-2 bg-surface-card px-3 py-2 text-sm text-ink-2 ${NOTE_TONE[tone]}`}
      >
        {tone === 'warn' && <span className="mr-1 font-medium text-ink">注意</span>}
        {block.text}
      </p>
    );
  }
  return (
    <pre
      key={index}
      className="overflow-x-auto rounded-md border border-hairline bg-surface-raised p-3 text-xs leading-5 text-ink-2"
    >
      <code>{block.lines.join('\n')}</code>
    </pre>
  );
}

function ChapterSection({ chapter }: { chapter: GuideChapter }): ReactNode {
  const setView = useNavStore((s) => s.setView);
  const goTo = chapter.goTo;
  const jump = (view: NavView): void => setView(view);
  return (
    <section
      id={chapterAnchor(chapter.id)}
      data-testid={`guide-chapter-${chapter.id}`}
      aria-labelledby={`${chapterAnchor(chapter.id)}-title`}
      className="scroll-mt-4 border-b border-hairline pb-8 last:border-b-0 last:pb-0"
    >
      <h2 id={`${chapterAnchor(chapter.id)}-title`} className="text-lg font-semibold text-ink">
        <span className="mr-1.5 text-ink-3">{chapter.order}.</span>
        {chapter.title}
      </h2>
      <p className="mt-1 text-sm text-ink-2">{chapter.intro}</p>
      <div className="mt-3 space-y-3">{chapter.blocks.map(renderBlock)}</div>
      {goTo !== undefined && (
        <button
          type="button"
          data-testid={`guide-goto-${chapter.id}`}
          onClick={() => jump(goTo.view)}
          className="mt-4 rounded border border-hairline bg-surface-card px-3 py-1.5 text-sm text-ink transition-colors duration-150 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent motion-reduce:transition-none"
        >
          {goTo.label}
        </button>
      )}
    </section>
  );
}

export function GuideView() {
  const chapters = useMemo(() => GUIDE_CHAPTERS, []);

  return (
    <div data-testid="guide-view" className="mx-auto flex w-full max-w-[1100px] flex-col gap-6 p-6 lg:flex-row">
      <nav aria-label="教程目录" className="shrink-0 lg:w-[220px]">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">教程目录</p>
        <ul className="flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:pb-0">
          {chapters.map((chapter) => (
            <li key={chapter.id} className="shrink-0">
              <button
                type="button"
                data-testid={`guide-toc-${chapter.id}`}
                onClick={() => scrollToChapter(chapter.id)}
                className="flex w-full items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5 text-left text-[13px] text-ink-2 transition-colors duration-150 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent motion-reduce:transition-none lg:whitespace-normal"
              >
                <span className="text-ink-3">{chapter.order}</span>
                <span className="truncate">{chapter.title}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1 space-y-8 lg:max-w-[72ch]">
        {chapters.length === 0 ? (
          <p className="text-sm text-ink-3">教程内容准备中</p>
        ) : (
          chapters.map((chapter) => <ChapterSection key={chapter.id} chapter={chapter} />)
        )}
      </div>
    </div>
  );
}
