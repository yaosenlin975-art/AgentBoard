/**
 * 知识页导出（KB-EXPORT）：Markdown 文本拼装 + 文件名净化 + 浏览器下载。
 * 零依赖：不引入 PDF 库；PDF 走浏览器打印路径（见 KnowledgePrintView，待批准后接线）。
 */

import { KNOWLEDGE_SHORT_ID_LEN, type KnowledgePage } from '@agentboard/shared';

/** 文件名非法字符（Windows 最严）：\ / : * ? " < > | 与控制字符 */
const ILLEGAL_FILENAME = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const MAX_FILENAME_LENGTH = 80;

/**
 * 导出文件名净化：非法字符与控制字符 → `-`；连续 `-` 折叠；首尾 `-`/空白去掉；
 * 超过 80 字符截断；空标题回退 `knowledge-<pageId 前 8 位>`（pageId 不足 8 位则全取）。
 */
export function sanitizeExportFilename(title: string, pageId: string): string {
  const cleaned = String(title ?? '')
    .replace(ILLEGAL_FILENAME, '-')
    // 连续横线与其周围空白一起折叠成单个 `-`（"缓存/策略: 失效" → "缓存-策略-失效"）
    .replace(/\s*-+\s*/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[-\s]+|[-\s]+$/g, '')
    .slice(0, MAX_FILENAME_LENGTH)
    .replace(/[-\s]+$/, '');
  if (cleaned !== '') return cleaned;
  const fallbackId = String(pageId ?? '').slice(0, KNOWLEDGE_SHORT_ID_LEN);
  return fallbackId === '' ? 'knowledge-page' : `knowledge-${fallbackId}`;
}

export interface ExportOptions {
  /** KB-IMG-3：站内图片绝对地址的 base（缺省 window.location.origin；测试注入用） */
  imageBaseUrl?: string;
  /** 工作空间显示名；缺省时用 workspace_id，公共知识写「公共」 */
  workspaceName?: string | null;
  /** 导出时间，默认当前时间（测试可注固定值） */
  exportedAt?: number;
}

const isoDate = (ms: number | undefined | null): string =>
  typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString().replace('.000Z', 'Z') : '—';

const scopeLabel = (scope: KnowledgePage['scope']): string => (scope === 'common' ? '公共经验' : '项目知识');

/** 站内图片 URL 形态：`/api/knowledge/images/:id`（KB-IMG-2 上传后插入的正是这种） */
const IMAGE_URL_TEST = /!\[[^\]]*\]\(\/api\/knowledge\/images\/[^)\s]+/u;
const ABSOLUTE_IMAGE = /(!\[[^\]]*\]\()(\/api\/knowledge\/images\/[^)\s]+)(\))/gu;

/**
 * 站内图片是相对路径，导出到本地 Markdown 后无法渲染 → 换成绝对地址（KB-IMG-3）。
 * `baseUrl` 缺省取 `window.location.origin`（测试/SSR 可注入）。
 */
export function absolutizeImageUrls(markdown: string, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/u, '');
  if (base === '') return markdown;
  return markdown.replace(ABSOLUTE_IMAGE, (_match, prefix: string, path: string, suffix: string) => `${prefix}${base}${path}${suffix}`);
}

function defaultImageBaseUrl(): string {
  if (typeof window !== 'undefined' && typeof window.location?.origin === 'string') return window.location.origin;
  return '';
}

/**
 * 拼装导出用 Markdown：
 * 头部元信息（标题 / slug / scope / 工作空间 / revision / 状态 / 更新时间 / 导出时间）
 * + `## 正文`（body_md 原样）+ `## 来源`（locator + SHA-256 前 12 位 + 捕获时间）
 * + `## 证据`（locator + snapshot 引用块）。空来源/证据写「（无）」。
 */
export function buildKnowledgeMarkdown(page: KnowledgePage, options: ExportOptions = {}): string {
  const exportedAt = options.exportedAt ?? Date.now();
  const workspace =
    page.scope === 'common' ? '公共' : (options.workspaceName ?? page.workspace_id ?? '—');
  // 头部 meta 块字段顺序固定（lead 批准）：title / slug / scope / workspace / revision / updated_at / sources
  const lines: string[] = [];
  lines.push(`# ${page.title}`, '');
  lines.push('---');
  lines.push(`title: ${page.title}`);
  lines.push(`slug: ${page.slug}`);
  lines.push(`scope: ${page.scope}`);
  lines.push(`workspace: ${workspace}`);
  lines.push(`revision: ${page.revision}`);
  lines.push(`updated_at: ${isoDate(page.updated_at)}`);
  lines.push(`sources: ${page.sources.length}`);
  lines.push(`status: ${page.status}`);
  lines.push(`exported_at: ${isoDate(exportedAt)}`);
  lines.push('---', '');

  const body = absolutizeImageUrls(String(page.body_md ?? ''), options.imageBaseUrl ?? defaultImageBaseUrl());
  lines.push('## 正文', '', body.replace(/\s+$/, ''), '');
  if (IMAGE_URL_TEST.test(String(page.body_md ?? ''))) {
    lines.push('> 说明：正文图片为站内受保护资源，需登录本看板后在同一浏览器中打开链接才能显示。', '');
  }

  lines.push('## 来源', '');
  if (page.sources.length === 0) lines.push('（无）');
  else {
    for (const s of page.sources) {
      const hash = typeof s.content_hash === 'string' ? s.content_hash.slice(0, 12) : '';
      lines.push(`- \`${s.locator}\`${hash === '' ? '' : ` · SHA-256 \`${hash}…\``} · ${isoDate(s.captured_at)}`);
    }
  }
  lines.push('');

  lines.push('## 证据', '');
  if (page.evidence.length === 0) lines.push('（无）');
  else {
    for (const e of page.evidence) {
      lines.push(`- \`${e.locator}\``);
      if (e.snapshot !== undefined && e.snapshot !== '') lines.push('', `  > ${e.snapshot.replace(/\n/g, '\n  > ')}`, '');
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
}

/** 触发浏览器下载；无论成功失败都 revoke objectURL（避免泄漏） */
export function downloadText(filename: string, text: string, mime = 'text/markdown;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 导出知识页为 Markdown 文件（文件名经净化，扩展名 `.md`） */
export function downloadKnowledgeMarkdown(page: KnowledgePage, options: ExportOptions = {}): string {
  const filename = `${sanitizeExportFilename(page.title, page.id)}.md`;
  downloadText(filename, buildKnowledgeMarkdown(page, options));
  return filename;
}
