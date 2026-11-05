import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { KnowledgePage, KnowledgeRevision } from '@agentboard/shared';
import { api } from '../../api/client';
import { MarkdownView } from '../../lib/markdown';
import { KnowledgeImageComposer } from './KnowledgeImageComposer';
import { Badge, type BadgeTone } from '../ui/Badge';
import { BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY, FIELD_CLASS } from '../ui/buttonStyles';
import { downloadKnowledgeMarkdown } from '../../lib/knowledgeExport';
import { diffLines, DIFF_LARGE_CHARS } from '../../lib/textDiff';
import {
  CATEGORY_STYLES,
  normalizeCategory,
  normalizeLanded,
  type KnowledgeCategory,
  type KnowledgeLanded,
} from '../../lib/knowledgeGraph';
import { KnowledgePrintView } from './KnowledgePrintView';

const STATUS_LABEL: Record<string, string> = { active: '有效', archived: '归档', deleted: '已删除' };
const STATUS_TONE: Record<string, BadgeTone> = { active: 'green', archived: 'neutral', deleted: 'red' };
/** KB-MODEL：五类固定 tone（缺失 → legacy 灰，不报错） */
const CATEGORY_TONE: Record<KnowledgeCategory, BadgeTone> = {
  design: 'blue',
  solved: 'green',
  pinned: 'purple',
  open: 'red',
  legacy: 'gray',
};
const LANDED_LABEL: Record<KnowledgeLanded, string> = { landed: '已落地', partial: '部分落地', proposed: '未落地' };

/* ============ PROV-A：来源与证据的展示口径 ============
 * 只做展示与复制：不渲染可点击跳转、不输出 file:/// 链接（跳转能力属 PROV-B）。
 * 取证口径（真实数据 kb knowledge show --json 核对得到）：
 *   sources[].locator 写「仓库相对路径」（apps/web/src/.../Board.tsx），
 *   evidence[].locator 常只写行号区间（file:185-193）→ 必须靠 evidence.source_id ==
 *   sources[].source_id 命中后回填路径，否则界面就只剩一串没有文件名的孤立行号。
 */

type ProvenanceSource = KnowledgePage['sources'][number];
type ProvenanceEvidence = KnowledgePage['evidence'][number];

/** 非文件取证前缀：命令 / 工单 / 外链。本身不指向仓库路径，不回填、也不给「复制路径」。 */
const NON_FILE_SCHEME = /^(?:cmd|command|issue|task|url|https?):/i;

/** 「含路径」判定：有目录分隔符，或有一段扩展名（真实数据一律仓库相对 + 正斜杠）。 */
const HAS_PATH_HINT = /[/\\]|\.[A-Za-z][A-Za-z0-9]{0,7}(?=[\s:/]|$)/;

/** 去掉 `file:` / `file:///` 前缀（真实数据把行号取证写成 `file:125-137`） */
function stripFileScheme(value: string): string {
  return value.replace(/^file:\/{0,3}/i, '');
}

/** 尾部行号区间（`:1`、`:125-137`、`:12,15`）与路径分离，回填后再原样拼回去 */
function splitTrailingRange(value: string): { path: string; range: string } {
  const match = value.match(/^(.*?):(\d+(?:\s*[-,]\s*\d+)*)$/);
  return match ? { path: match[1] ?? value, range: match[2] ?? '' } : { path: value, range: '' };
}

/** locator 主体 → { path, range, note }；`1-41（口径说明）` 这类畸形条目 path 为空 */
function parseLocatorBody(body: string): { path: string; range: string; note: string } {
  const bare = body.match(/^(\d+(?:\s*[-,]\s*\d+)*)\s*([\s\S]*)$/);
  if (bare) return { path: '', range: bare[1] ?? '', note: (bare[2] ?? '').trim() };
  const split = splitTrailingRange(body);
  return { path: split.path, range: split.range, note: '' };
}

/** source_id → 可回填的仓库相对路径：优先 sources[].locator，退化到 source_id 自身 */
function provenancePathById(sources: readonly ProvenanceSource[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const source of sources) {
    const fromLocator = splitTrailingRange(stripFileScheme((source.locator ?? '').trim())).path;
    const fromSourceId = splitTrailingRange(stripFileScheme((source.source_id ?? '').trim())).path;
    const path = HAS_PATH_HINT.test(fromLocator) ? fromLocator : HAS_PATH_HINT.test(fromSourceId) ? fromSourceId : '';
    if (path !== '' && !map.has(source.source_id)) map.set(source.source_id, path);
  }
  return map;
}

/**
 * 归一一条 locator（来源与证据共用）：
 * ① 命令/工单/外链类取证原样显示；② locator 自带路径就用它自己的；
 * ③ locator 只剩行号 → 按 source_id 回填成「仓库相对路径 + 行号区间」；
 * ④ 回填不出来仍原样显示——宁缺毋伪，绝不编造文件名。
 */
export function resolveProvenanceLocator(
  locator: string | undefined,
  sourceId: string | undefined,
  paths: Map<string, string>,
): { display: string; copyPath: string | null } {
  const raw = (locator ?? '').trim();
  if (NON_FILE_SCHEME.test(raw)) return { display: raw, copyPath: null };
  const parsed = parseLocatorBody(stripFileScheme(raw));
  const ownPath = HAS_PATH_HINT.test(parsed.path) ? parsed.path : '';
  const sourcePath = sourceId === undefined ? '' : (paths.get(sourceId) ?? '');
  const path = ownPath || sourcePath;
  if (path === '') return { display: raw, copyPath: null };
  const withRange = parsed.range === '' ? path : `${path}:${parsed.range}`;
  return { display: [withRange, parsed.note].filter(Boolean).join(' '), copyPath: withRange };
}

/** 去重键：locator 有路径 → 按 locator 折叠；没有（同一提交的 sha 之类）→ 退到 content_hash */
function provenanceDedupKey(display: string, contentHash: string): string {
  if (HAS_PATH_HINT.test(display)) return display;
  return contentHash === '' ? display : `commit:${contentHash}`;
}

/** 折叠后的一行来源/证据 */
export type ProvenanceRow = {
  key: string;
  kind: 'source' | 'evidence';
  display: string;
  copyPath: string | null;
  contentHash: string;
  capturedAt: number | null;
  snapshot: string;
};

/** 来源行信息更全（带 SHA-256 与采集时间）→ 与证据行同键时留来源行 */
const ROW_RANK: Record<ProvenanceRow['kind'], number> = { evidence: 0, source: 1 };
const NO_TIME = Number.MAX_SAFE_INTEGER;
const timeOf = (row: ProvenanceRow): number => row.capturedAt ?? NO_TIME;

/**
 * 回填 + 去重（PROV-A）：同一 locator / 同一提交只留一条，时间冲突保留最早 captured_at
 * （都没有时间就保留首次出现顺序）；被折叠那条若带 snapshot 而留下的没有，则把 snapshot 带上，
 * 去重不丢内容。
 */
export function buildProvenanceRows(
  sources: readonly ProvenanceSource[],
  evidence: readonly ProvenanceEvidence[],
): ProvenanceRow[] {
  const paths = provenancePathById(sources);
  const rows: ProvenanceRow[] = [];
  const position = new Map<string, number>();
  const put = (row: ProvenanceRow): void => {
    const at = position.get(row.key);
    if (at === undefined) {
      position.set(row.key, rows.length);
      rows.push(row);
      return;
    }
    const current = rows[at];
    if (current === undefined) return;
    if (ROW_RANK[row.kind] < ROW_RANK[current.kind]) return;
    if (ROW_RANK[row.kind] === ROW_RANK[current.kind] && timeOf(current) <= timeOf(row)) return;
    rows[at] = { ...row, snapshot: row.snapshot === '' ? current.snapshot : row.snapshot };
  };
  for (const source of sources) {
    const resolved = resolveProvenanceLocator(source.locator, source.source_id, paths);
    put({
      key: provenanceDedupKey(resolved.display, (source.content_hash ?? '').trim()),
      kind: 'source',
      display: resolved.display,
      copyPath: resolved.copyPath,
      contentHash: (source.content_hash ?? '').trim(),
      capturedAt: typeof source.captured_at === 'number' ? source.captured_at : null,
      snapshot: (source.snapshot ?? '').trim() === '' ? '' : String(source.snapshot),
    });
  }
  for (const item of evidence) {
    const resolved = resolveProvenanceLocator(item.locator, item.source_id, paths);
    put({
      key: provenanceDedupKey(resolved.display, ''),
      kind: 'evidence',
      display: resolved.display,
      copyPath: resolved.copyPath,
      contentHash: '',
      capturedAt: null,
      snapshot: (item.snapshot ?? '').trim() === '' ? '' : String(item.snapshot),
    });
  }
  return rows;
}

/** snapshot 折叠阈值：JSON 一律折叠；纯文本超过 200 字符或 3 行才折叠（短文本仍直接显示） */
const SNAPSHOT_MAX_CHARS = 200;
const SNAPSHOT_MAX_LINES = 3;

/** 是 JSON 就返回两空格缩进后的文本，不是则 null（不做「猜一个像 JSON」的乐观折叠） */
export function prettyJsonSnapshot(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

export function shouldCollapseSnapshot(text: string): boolean {
  if (text.trim() === '') return false;
  if (prettyJsonSnapshot(text) !== null) return true;
  return text.length > SNAPSHOT_MAX_CHARS || text.split(/\r?\n/).length > SNAPSHOT_MAX_LINES;
}

/** JSON / 长文本收成「展开查看」，不再整段 blockquote 裸露（KB-SNAP-FOLD） */
function SnapshotBlock({ text }: { text: string }) {
  if (!shouldCollapseSnapshot(text)) {
    return <blockquote className="mt-1 whitespace-pre-wrap break-words border-l-2 border-hairline pl-2 text-xs text-ink-2">{text}</blockquote>;
  }
  const json = prettyJsonSnapshot(text);
  const lines = text.split(/\r?\n/).length;
  return <details data-testid="provenance-snapshot" className="mt-1">
    <summary className="cursor-pointer text-xs text-ink-3 hover:text-ink">
      展开查看（{json === null ? '长文本' : 'JSON'} · {lines} 行 / {text.length} 字符）
    </summary>
    <pre
      data-testid="provenance-snapshot-body"
      className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words border-l-2 border-hairline bg-surface-card px-2 py-1 text-[11px] text-ink-2"
    >
      {json ?? text}
    </pre>
  </details>;
}

const COPY_RESET_MS = 1500;

/**
 * 「复制路径」：只写剪贴板，不造跳转（无路由可跳，属 PROV-B）。
 * 非文件取证（cmd:/issue: 等）拿不到路径 → 不渲染本按钮，避免「复制路径」骗人。
 */
export function CopyPathButton({ path }: { path: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const resetTimer = useRef<number | null>(null);
  useEffect(() => () => { if (resetTimer.current !== null) window.clearTimeout(resetTimer.current); }, []);
  return <button
    type="button"
    data-testid="provenance-copy"
    title={`复制 ${path}`}
    className={`${BUTTON_SECONDARY} h-7 shrink-0 px-2`}
    onClick={() => {
      const clipboard = navigator.clipboard;
      if (typeof clipboard?.writeText !== 'function') {
        setState('fail');
        return;
      }
      clipboard.writeText(path).then(
        () => setState('ok'),
        () => setState('fail'),
      ).finally(() => {
        if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
        resetTimer.current = window.setTimeout(() => setState('idle'), COPY_RESET_MS);
      });
    }}
  >
    {state === 'ok' ? '已复制' : state === 'fail' ? '复制失败' : '复制路径'}
  </button>;
}

function Provenance({ rows }: { rows: ProvenanceRow[] }) {
  if (rows.length === 0) return <p data-testid="provenance-empty" className="text-xs text-ink-3">（无）</p>;
  return <ul className="space-y-2 text-sm">{rows.map(row => <li key={row.key} data-testid="provenance-row" data-kind={row.kind} className="rounded-md bg-surface-page px-2 py-1.5">
    <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
      <code className="min-w-0 flex-1 break-all text-xs text-ink">{row.display}</code>
      {row.copyPath !== null && <CopyPathButton path={row.copyPath} />}
    </div>
    {(row.contentHash !== '' || row.capturedAt !== null) && <div className="mt-0.5 break-all text-xs text-ink-3">
      {[row.contentHash === '' ? '' : `SHA-256 ${row.contentHash}`, row.capturedAt === null ? '' : new Date(row.capturedAt).toLocaleString()].filter(Boolean).join(' · ')}
    </div>}
    {row.snapshot !== '' && <SnapshotBlock text={row.snapshot} />}
  </li>)}</ul>;
}

export function KnowledgePageDetail({ pageId, scope, workspaceId, onChanged }: { pageId: string; scope: 'workspace' | 'common'; workspaceId: string | null; onChanged: () => void }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  /** KB-HIST-UI：抽屉里选中的快照（点一条 → 只读预览） */
  const [previewRevision, setPreviewRevision] = useState<number | null>(null);
  /** 恢复确认：选中待恢复的 revision（二次确认后才发 PUT） */
  const [restoreTarget, setRestoreTarget] = useState<KnowledgeRevision | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  /** KB-IMG-2：正文编辑（含图片上传）——折叠块，保存时才 PUT body_md */
  const [bodyEditing, setBodyEditing] = useState(false);
  const [bodyDraft, setBodyDraft] = useState('');
  const [historyOffset, setHistoryOffset] = useState(0);
  /** KB-DIFF-W：展开 diff 的 revision（再点收起）；基准 = 当前版本 / 上一版 */
  const [diffRevision, setDiffRevision] = useState<number | null>(null);
  const [diffBaseline, setDiffBaseline] = useState<'current' | 'previous'>('current');
  /** 大正文降级后，用户显式点「打开全文对比」的 revision */
  const [diffForced, setDiffForced] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<'archive' | 'restore' | 'delete' | null>(null);
  const [expiryDraft, setExpiryDraft] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const scopeData = { scope, ...(scope === 'workspace' ? { workspace_id: workspaceId! } : {}) };
  const query = new URLSearchParams(scopeData).toString();
  const path = `/api/knowledge/pages/${encodeURIComponent(pageId)}`;
  const page = useQuery({ queryKey: ['knowledge-page', pageId, scope, workspaceId], queryFn: () => api.get<KnowledgePage>(`${path}?${query}`) });
  const history = useQuery({ queryKey: ['knowledge-history', pageId, scope, workspaceId, historyOffset, page.data?.revision], enabled: historyOpen,
    queryFn: () => api.get<{ items: KnowledgeRevision[]; next_offset: number | null }>(`${path}/revisions?${query}&offset=${historyOffset}&limit=20`) });
  // KB-DIFF-W：展开 diff 时才按需拉单条 revision 全文（列表已瘦身，不批量拉）
  const revisionBody = useQuery({
    queryKey: ['knowledge-revision-body', pageId, scope, workspaceId, diffRevision],
    enabled: diffRevision !== null,
    queryFn: () => api.get<{ body_md?: string; body_snapshot?: string; title_snapshot?: string }>(`${path}/revisions/${diffRevision}?${query}`),
  });
  /** 基准 = 上一版时，再按需拉 r{n-1} 的正文 */
  const baselineBody = useQuery({
    queryKey: ['knowledge-revision-body', pageId, scope, workspaceId, diffBaseline === 'previous' ? (diffRevision ?? 0) - 1 : 0],
    enabled: diffRevision !== null && diffBaseline === 'previous' && (diffRevision ?? 0) > 1,
    queryFn: () => api.get<{ body_md?: string; body_snapshot?: string }>(`${path}/revisions/${(diffRevision ?? 1) - 1}?${query}`),
  });
  const bodyOf = (payload: { body_md?: string; body_snapshot?: string } | undefined): string =>
    payload?.body_md ?? payload?.body_snapshot ?? '';
  /**
   * KB-HIST-PREVIEW：列表瘦身后不再带正文，旧「点行 → 只读快照」恒空。
   * 修法选「复用单条端点」（而非并入 diff 展开）：预览是独立的只读能力（只看内容、不比对），
   * 并入 diff 会让纯预览也走 diff 逻辑；复用 `/revisions/:rev` 零新契约、列表继续瘦身。
   */
  const previewBody = useQuery({
    queryKey: ['knowledge-revision-body', pageId, scope, workspaceId, previewRevision],
    enabled: previewRevision !== null,
    queryFn: () => api.get<{ body_md?: string; body_snapshot?: string; title_snapshot?: string }>(`${path}/revisions/${previewRevision}?${query}`),
  });
  const action = useMutation({ mutationFn: async (kind: 'archive' | 'restore' | 'delete') => api.post<KnowledgePage>(`${path}/actions`, { ...scopeData, action: kind, expected_revision: page.data!.revision, actor: 'user' }),
    onSuccess: () => { setConfirm(null); void page.refetch(); onChanged(); }, onError: () => { setConfirm(null); void page.refetch(); } });
  const expiry = useMutation({ mutationFn: (expiresAt: number | null) => api.put<KnowledgePage>(path, { ...scopeData, expires_at: expiresAt, expected_revision: page.data!.revision, actor: 'user' }),
    onSuccess: () => { setExpiryDraft(null); void page.refetch(); onChanged(); }, onError: () => { void page.refetch(); } });
  /**
   * 恢复此版本（KB-HIST-UI）：用快照的 title+body 产生**新** revision（历史不删）。
   * CAS：expected_revision 用当前 revision；409 说明他人已更新。
   */
  const restore = useMutation({
    // KB-HIST-PREVIEW：列表已瘦身（无 body），恢复前必须按需拉该 revision 的完整快照，
    // 否则会把「空白正文」写回页面（数据丢失）。同一端点 `/revisions/:rev`。
    mutationFn: async (target: KnowledgeRevision) => {
      const detail = await api.get<{ body_md?: string; body_snapshot?: string }>(`${path}/revisions/${target.revision}?${query}`);
      return api.put<KnowledgePage>(path, {
        ...scopeData,
        title: target.title_snapshot,
        body_md: detail.body_md ?? detail.body_snapshot ?? '',
        change_note: `恢复自 r${target.revision}`,
        expected_revision: page.data!.revision,
        actor: 'user',
      });
    },
    onSuccess: () => {
      setRestoreTarget(null);
      setRestoreError(null);
      setPreviewRevision(null);
      void page.refetch();
      void history.refetch();
      onChanged();
    },
    onError: (error) => {
      // 409 = 他人已更新（CAS 冲突）
      const message = error instanceof Error ? error.message : String(error);
      setRestoreError(/409|已更新|冲突|CONFLICT/i.test(message) ? '他人已更新，请刷新后再试' : message);
      setRestoreTarget(null);
      void page.refetch();
    },
  });

  if (page.isPending) return <p className="min-w-0 flex-1 px-1 py-3 text-sm text-ink-3">加载详情…</p>;
  if (page.isError) return <p role="alert" className="min-w-0 flex-1 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{page.error.message}</p>;
  const p = page.data;
  const labels = { archive: '归档', restore: '恢复', delete: '软删除' };
  /** PROV-A：来源与证据先回填 + 去重，再统一渲染（条数与展开后的行必须同口径） */
  const provenanceRows = buildProvenanceRows(p.sources, p.evidence);
  const isExpired = p.expires_at !== null && p.expires_at !== undefined && p.expires_at <= Date.now();
  return <article aria-label="知识详情" className="min-w-0 flex-1 overflow-auto rounded-lg border border-hairline bg-surface-card px-7 py-4 text-ink">
    <header>
      <h2 className="text-base font-semibold leading-snug">{p.title}</h2>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge tone={scope === 'common' ? 'neutral' : 'blue'}>{scope === 'common' ? '公共经验' : '项目知识'}</Badge>
        <Badge tone="neutral">v{p.revision}</Badge>
        <Badge tone={STATUS_TONE[p.status] ?? 'neutral'}>{STATUS_LABEL[p.status] ?? p.status}</Badge>
        <Badge tone={CATEGORY_TONE[normalizeCategory((p as { category?: unknown }).category)]}>
          {CATEGORY_STYLES[normalizeCategory((p as { category?: unknown }).category)].label}
        </Badge>
        {(() => {
          const landed = normalizeLanded((p as { landed?: unknown }).landed);
          return landed === null ? null : <Badge tone={landed === 'landed' ? 'green' : landed === 'partial' ? 'blue' : 'neutral'}>{LANDED_LABEL[landed]}</Badge>;
        })()}
        {p.expires_at !== null && p.expires_at !== undefined && <Badge tone={isExpired ? 'red' : 'neutral'}>{isExpired ? '已过期 ' : '有效期 '}{new Date(p.expires_at).toLocaleDateString()}</Badge>}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-xs text-ink-3">
        <span data-testid="knowledge-page-created-at">创建时间 {new Date(p.created_at).toLocaleString()}</span>
        <span aria-hidden="true">·</span>
        <span data-testid="knowledge-page-updated-at">最后修改时间 {new Date(p.updated_at).toLocaleString()}</span>
      </div>
    </header>

    {/* KB-DETAIL-ALIGN：正文左对齐贴详情区内边距（article px-7=28px，与下方「编辑正文」
        「来源与证据」「归档/历史」共用同一条左边线），宽度上限在原 88ch 基础上 +100px；
        外层 min(...,100%) 保证窄屏不横向溢出 */}
    <div data-testid="knowledge-body" className="mr-auto mt-3 w-full max-w-[min(calc(88ch+100px),100%)] text-sm text-ink">
      <MarkdownView>{p.body_md}</MarkdownView>
    </div>

    {/* KB-IMG-2：正文编辑 + 图片（粘贴/拖拽/按钮）压缩上传，插入到光标处 */}
    <section className="mt-3" data-testid="knowledge-body-section">
      <button
        type="button"
        data-testid="knowledge-body-edit-toggle"
        className={BUTTON_SECONDARY}
        onClick={() => {
          setBodyEditing(!bodyEditing);
          setBodyDraft(p.body_md);
        }}
      >
        {bodyEditing ? '收起正文编辑' : '编辑正文（含图片）'}
      </button>
      {bodyEditing && (
        <div className="mt-2 space-y-2">
          <KnowledgeImageComposer
            scope={scope}
            workspaceId={workspaceId}
            pageId={pageId}
            value={bodyDraft}
            onChange={setBodyDraft}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="knowledge-body-save"
              className={BUTTON_PRIMARY}
              onClick={() => {
                api
                  .put<KnowledgePage>(`${path}`, { ...scopeData, body_md: bodyDraft, expected_revision: p.revision, actor: 'user', change_note: '编辑正文（含图片）' })
                  .then(() => {
                    setBodyEditing(false);
                    void page.refetch();
                    onChanged();
                  })
                  .catch((cause: unknown) => setRestoreError(cause instanceof Error ? cause.message : String(cause)));
              }}
            >
              保存正文
            </button>
            <button type="button" data-testid="knowledge-body-cancel" className={BUTTON_SECONDARY} onClick={() => setBodyEditing(false)}>
              取消
            </button>
          </div>
        </div>
      )}
    </section>

    <details data-testid="provenance" className="mt-4 rounded-md border border-hairline">
      <summary className="cursor-pointer px-2.5 py-1.5 text-xs font-medium text-ink-2">
        来源与证据（{provenanceRows.length} 条）
      </summary>
      <div className="px-2.5 pb-2.5">
        <Provenance rows={provenanceRows} />
      </div>
    </details>

    <div className="my-3 flex flex-wrap items-center gap-2">
      {p.status === 'active' && <button type="button" className={BUTTON_SECONDARY} onClick={() => setConfirm('archive')}>归档</button>}
      {p.status === 'archived' && <button type="button" className={BUTTON_SECONDARY} onClick={() => setConfirm('restore')}>恢复</button>}
      {p.status !== 'deleted' && <button type="button" className={BUTTON_DANGER} onClick={() => setConfirm('delete')}>软删除</button>}
      <button
        type="button"
        data-testid="knowledge-history-toggle"
        aria-expanded={historyOpen}
        className={BUTTON_SECONDARY}
        onClick={() => {
          setHistoryOpen(!historyOpen);
          setPreviewRevision(null);
          setRestoreTarget(null);
          setRestoreError(null);
        }}
      >
        历史（{p.revision}）
      </button>
      <button
        type="button"
        data-testid="export-markdown"
        className={BUTTON_SECONDARY}
        onClick={() => downloadKnowledgeMarkdown(p)}
      >
        导出 Markdown
      </button>
      <button type="button" data-testid="export-pdf" className={BUTTON_SECONDARY} onClick={() => setPrinting(true)}>
        导出 PDF
      </button>
    </div>

    {/* 打印视图（只读快照，复用同一 MarkdownView；仅打印期间挂载、@media print 可见） */}
    <KnowledgePrintView
      page={p}
      open={printing}
      onAfterPrint={() => setPrinting(false)}
      renderBody={(md) => <MarkdownView>{md}</MarkdownView>}
    />

    {confirm && <div className="rounded-md border border-hairline bg-surface-page p-2.5">
      <p className="text-sm text-ink">确认{labels[confirm]}此{scope === 'common' ? '公共' : '项目'}知识？历史仍保留。</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className={BUTTON_SECONDARY} disabled={action.isPending} onClick={() => action.mutate(confirm)}>确认{labels[confirm]}</button>
        <button type="button" className={BUTTON_SECONDARY} onClick={() => setConfirm(null)}>取消</button>
      </div>
    </div>}
    {action.isError && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{action.error.message}</p>}

    {p.status !== 'deleted' && <div className="my-3 flex flex-wrap items-end gap-2 text-xs text-ink-2">
      <label>有效期（本机时间，留空清除）
        <input aria-label="知识有效期" type="datetime-local" className={`${FIELD_CLASS} mt-1 block`} value={expiryDraft ?? (p.expires_at ? new Date(p.expires_at - new Date(p.expires_at).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '')} onChange={e => setExpiryDraft(e.target.value)} />
      </label>
      <button type="button" className={BUTTON_PRIMARY} disabled={expiry.isPending || expiryDraft === null} onClick={() => expiry.mutate(expiryDraft ? new Date(expiryDraft).getTime() : null)}>保存有效期</button>
    </div>}
    {expiry.isError && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{expiry.error.message}</p>}

    {/* KB-HIST-UI：右侧抽屉（不碰 panelStore——那属并行线在改的文件），列表 rev 降序 + 点一条只读预览 */}
    {historyOpen && (
      <aside
        data-testid="knowledge-history-drawer"
        aria-label="版本历史抽屉"
        className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-hairline bg-surface-card shadow-xl"
      >
        <header className="flex items-center gap-2 border-b border-hairline px-3 py-2">
          <span className="text-sm font-semibold">版本历史（{p.revision} 个版本）</span>
          <button type="button" data-testid="knowledge-history-close" className={`${BUTTON_SECONDARY} ml-auto`} onClick={() => { setHistoryOpen(false); setPreviewRevision(null); setRestoreTarget(null); setRestoreError(null); }}>
            关闭
          </button>
        </header>
        {restoreError !== null && (
          <p role="alert" data-testid="knowledge-restore-error" className="mx-3 mt-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {restoreError}
          </p>
        )}
        {history.isPending && <p className="px-3 py-3 text-sm text-ink-3">读取历史…</p>}
        {history.isError && <p role="alert" className="px-3 py-3 text-sm text-red-600 dark:text-red-400">{history.error.message}</p>}
        <ul data-testid="knowledge-history-list" className="min-h-0 flex-1 overflow-auto px-3 py-2 text-xs">
          {history.data?.items.map((r) => (
            <li key={r.revision} data-testid={`knowledge-revision-${r.revision}`} className="border-b border-hairline py-1.5 last:border-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  data-testid={`knowledge-revision-preview-${r.revision}`}
                  aria-pressed={previewRevision === r.revision}
                  onClick={() => setPreviewRevision(previewRevision === r.revision ? null : r.revision)}
                  className="rounded px-1 text-left font-medium text-accent hover:underline"
                >
                  r{r.revision}
                </button>
                {/* KB-DIFF-W：点这一行展开/收起 diff（Enter/Space 由 button 原生支持）；当前版本行不给展开 */}
                {r.revision !== p.revision && (
                  <button
                    type="button"
                    data-testid={`knowledge-revision-diff-toggle-${r.revision}`}
                    aria-expanded={diffRevision === r.revision}
                    aria-controls={`revision-diff-${r.revision}`}
                    onClick={() => {
                      if (diffRevision === r.revision) {
                        setDiffRevision(null);
                        return;
                      }
                      setDiffRevision(r.revision);
                      setDiffBaseline('current');
                      setDiffForced(null);
                    }}
                    className="rounded px-1 text-left text-ink-2 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  >
                    {diffRevision === r.revision ? '收起 diff' : '查看 diff'}
                  </button>
                )}
                <span data-testid={`knowledge-revision-kind-${r.revision}`} className="rounded bg-surface-raised px-1">{r.change_kind}</span>
                <span data-testid={`knowledge-revision-actor-${r.revision}`} className="text-ink-2">{r.actor}</span>
                <span data-testid={`knowledge-revision-time-${r.revision}`} className="text-ink-3">{new Date(r.created_at).toLocaleString()}</span>
                {r.change_note !== '' && <span data-testid={`knowledge-revision-note-${r.revision}`} className="text-ink-3">· {r.change_note}</span>}
                {r.revision !== p.revision && (
                  <button
                    type="button"
                    data-testid={`knowledge-revision-restore-${r.revision}`}
                    className={`${BUTTON_SECONDARY} ml-auto`}
                    onClick={() => { setRestoreTarget(r); setRestoreError(null); }}
                  >
                    恢复此版本
                  </button>
                )}
                {r.revision === p.revision && <span className="ml-auto text-ink-3">当前版本</span>}
              </div>
              {restoreTarget?.revision === r.revision && (
                <div data-testid={`knowledge-restore-confirm-${r.revision}`} className="mt-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                  用 r{r.revision} 的标题与正文恢复到当前页？会生成**新**版本（r{p.revision + 1}），历史不删。
                  <div className="mt-1 flex gap-1.5">
                    <button
                      type="button"
                      data-testid={`knowledge-restore-confirm-yes-${r.revision}`}
                      className={BUTTON_PRIMARY}
                      disabled={restore.isPending}
                      onClick={() => restore.mutate(r)}
                    >
                      确认恢复
                    </button>
                    <button type="button" data-testid={`knowledge-restore-confirm-no-${r.revision}`} className={BUTTON_SECONDARY} onClick={() => setRestoreTarget(null)}>
                      取消
                    </button>
                  </div>
                </div>
              )}
              {previewRevision === r.revision && (
                <div data-testid={`knowledge-revision-body-${r.revision}`} className="mt-1.5 rounded-md bg-surface-page px-2 py-1.5">
                  <div className="mb-1 text-[11px] font-medium text-ink-2">{previewBody.data?.title_snapshot ?? r.title_snapshot}（只读快照）</div>
                  {previewBody.isPending && <p data-testid={`knowledge-revision-preview-loading-${r.revision}`} className="text-[11px] text-ink-3">读取版本正文…</p>}
                  {previewBody.isError && (
                    <p role="alert" data-testid={`knowledge-revision-preview-error-${r.revision}`} className="text-[11px] text-ink-2">
                      读取该版本正文失败，稍后重试
                    </p>
                  )}
                  {!previewBody.isPending && !previewBody.isError && (
                    <div className="mx-auto max-w-[min(88ch,100%)] text-sm">
                      <MarkdownView>{bodyOf(previewBody.data)}</MarkdownView>
                    </div>
                  )}
                </div>
              )}
              {diffRevision === r.revision && (() => {
                const before = diffBaseline === 'current' ? bodyOf(revisionBody.data) : bodyOf(baselineBody.data);
                const after = diffBaseline === 'current' ? String(p.body_md ?? '') : bodyOf(revisionBody.data);
                const loading = revisionBody.isPending || (diffBaseline === 'previous' && baselineBody.isPending);
                const failed = revisionBody.isError || (diffBaseline === 'previous' && baselineBody.isError);
                const force = diffForced === r.revision;
                const result = diffLines(before, after, { force });
                const oldLabel = diffBaseline === 'current' ? `r${r.revision}` : `r${r.revision - 1}`;
                const newLabel = diffBaseline === 'current' ? `r${p.revision}（当前）` : `r${r.revision}`;
                return (
                  <div
                    id={`revision-diff-${r.revision}`}
                    data-testid={`revision-diff-${r.revision}`}
                    className="mt-1.5 rounded-md border border-hairline bg-surface-page px-2 py-1.5"
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-2">
                      <span>{oldLabel} → {newLabel}</span>
                      <span data-testid={`revision-diff-stats-${r.revision}`} className="text-ink-3">
                        +{result.added} / −{result.removed} 行
                        {result.truncated && `（大正文 ${result.oldLines} → ${result.newLines} 行，已降级）`}
                      </span>
                      <button
                        type="button"
                        data-testid={`revision-diff-baseline-${r.revision}`}
                        aria-pressed={diffBaseline === 'previous'}
                        onClick={() => setDiffBaseline(diffBaseline === 'current' ? 'previous' : 'current')}
                        className={`${BUTTON_SECONDARY} ml-auto`}
                      >
                        {diffBaseline === 'current' ? '与上一版对比' : '与当前版本对比'}
                      </button>
                    </div>
                    {loading && <p className="text-[11px] text-ink-3">读取版本正文…</p>}
                    {failed && <p role="alert" className="text-[11px] text-ink-2">读取该版本正文失败，稍后重试</p>}
                    {!loading && !failed && result.hunks.length === 0 && (
                      <p data-testid={`revision-diff-empty-${r.revision}`} className="text-[11px] text-ink-3">两版内容相同</p>
                    )}
                    {!loading && !failed && result.hunks.map((hunk, hunkIndex) => (
                      <div key={hunkIndex}>
                        {hunk.skippedBefore > 0 && (
                          <p data-testid={`revision-diff-collapsed-${r.revision}-${hunkIndex}`} className="my-0.5 text-[11px] text-ink-3">
                            … 共 {hunk.skippedBefore} 行未变 …
                          </p>
                        )}
                        <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5">
                          {hunk.lines.map((line, lineIndex) => (
                            <div
                              key={lineIndex}
                              data-kind={line.kind}
                              className={
                                line.kind === 'add'
                                  ? 'border-l-2 border-accent bg-accent-soft pl-1 text-ink'
                                  : line.kind === 'del'
                                    ? 'border-l-2 border-transparent pl-1 text-ink-3 line-through'
                                    : 'border-l-2 border-transparent pl-1 text-ink-2'
                              }
                            >
                              {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                              {line.text}
                            </div>
                          ))}
                        </pre>
                      </div>
                    ))}
                    {result.truncated && !force && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] text-ink-3">
                          正文超过 {Math.round(DIFF_LARGE_CHARS / 1000)} 千字符，已只显示变更块首尾（+{result.added} / −{result.removed} 行）
                        </span>
                        <button
                          type="button"
                          data-testid={`revision-diff-force-${r.revision}`}
                          className={BUTTON_SECONDARY}
                          onClick={() => setDiffForced(r.revision)}
                        >
                          在下方打开全文对比（可能卡顿）
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}
            </li>
          ))}
        </ul>
        <footer className="flex items-center gap-2 border-t border-hairline px-3 py-2">
          <button type="button" className={BUTTON_SECONDARY} disabled={!historyOffset} onClick={() => setHistoryOffset(Math.max(0, historyOffset - 20))}>历史上一页</button>
          <button type="button" className={BUTTON_SECONDARY} disabled={history.data?.next_offset == null} onClick={() => setHistoryOffset(history.data?.next_offset ?? historyOffset)}>历史下一页</button>
        </footer>
      </aside>
    )}
  </article>;
}




