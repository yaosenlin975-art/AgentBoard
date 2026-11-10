/**
 * PERSONA-LIB-2：设置页「智能体人设」一节（全局库唯一管理入口）。
 *
 * 按已通过原型（Docs/prototypes/persona-library-2026-11-10/）落地：
 * - 列表：三来源徽标（builtin / import / user）、描述、包目录 / 创建时间、行内编辑与删除；
 * - 新建 / 编辑：右侧抽屉（Modal placement="right"），新建抽屉带「智能创建」三态；
 * - 删除：居中确认（写清 session.persona_id 无外键的后果，只告知不阻断）；
 * - 导入：输入专家包目录 → POST /api/expert-packages/import（成功 / 409 原文展示）；
 * - builtin 禁改删：按钮禁用并说明服务端 409，给出「新建一份」的替代路径。
 *
 * 数据：[`personas`] 与 SessionSettingsDialog / NewSessionDialog 同 key；写操作后
 * invalidateQueries(['personas'])，会话设置下拉与新建会话弹窗自动同步。
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useAppStore } from '../../state/appStore';
import { ADAPTER_LABEL, DRAFT_ADAPTERS, DraftAbortError, type DraftAdapter } from '../../lib/smartDraft';
import { mapPersonaDraftError, requestPersonaDraft } from '../../lib/personaDraft';
import { Modal } from '../ui/Modal';
import { BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY } from '../ui/buttonStyles';
import type { PersonaSummary } from '../chat/SessionSettingsDialog';

const inputCls =
  'w-full rounded border border-hairline bg-surface-card px-2 py-1.5 text-sm text-ink outline-none transition-colors duration-150 focus:border-accent motion-reduce:transition-none';
const labelCls = 'mb-1 block text-xs text-ink-2';

const SOURCE_LABEL: Record<PersonaSummary['source'], string> = {
  builtin: '内置',
  import: '导入',
  user: '自建',
};
const SOURCE_BADGE: Record<PersonaSummary['source'], string> = {
  builtin: 'bg-surface-raised text-ink-3',
  import: 'bg-accent-soft text-accent',
  user: 'border border-hairline text-ink-2',
};

const SMART_CHIPS = [
  '严谨的技术文档编辑，把口语化的笔记改写成可发布的说明',
  '挑剔的代码评审，先指出会导致错误的问题，再谈风格',
  '有耐心的新手导师，一次只讲一个概念并给练习',
];

interface DraftFields {
  role: string;
  tone: string;
  boundary: string;
  domain: string;
}

const EMPTY_DRAFT: DraftFields = { role: '', tone: '', boundary: '', domain: '' };

/** 四段拼成 body_md（与原型 / DESIGN-NOTES §10 同口径） */
export function composePersonaBody(draft: DraftFields): string {
  const parts = ['## 角色', draft.role.trim()];
  if (draft.tone.trim() !== '') parts.push('## 语气', draft.tone.trim());
  if (draft.boundary.trim() !== '') parts.push('## 边界与禁忌', draft.boundary.trim());
  if (draft.domain.trim() !== '') parts.push('## 擅长领域', draft.domain.trim());
  return parts.join('\n\n');
}

/** 从 Markdown 原文回读四段；缺某段返回 null（保留字段里已有的值） */
export function parsePersonaSections(md: string): { [K in keyof DraftFields]: string | null } {
  const keys: Record<string, keyof DraftFields> = {
    角色: 'role',
    语气: 'tone',
    边界与禁忌: 'boundary',
    擅长领域: 'domain',
  };
  const out: { [K in keyof DraftFields]: string | null } = { role: null, tone: null, boundary: null, domain: null };
  let current: keyof DraftFields | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (current !== null) out[current] = buffer.join('\n').trim();
  };
  for (const line of md.split(/\r?\n/)) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match !== null) {
      flush();
      current = keys[match[1]!] ?? null;
      buffer = [];
    } else if (current !== null) {
      buffer.push(line);
    }
  }
  flush();
  return out;
}

function formatDate(createdAt: number): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN');
}

interface CliInfoLike {
  id: string;
  installed: boolean;
}

/** 智能创建状态机：idle → generating → draft | error（与原型 §10 一致） */
type SmartPhase = 'idle' | 'generating' | 'draft' | 'error';

export function PersonaSection() {
  const queryClient = useQueryClient();
  const workspaceId = useAppStore((s) => s.workspaceId);

  const personasQuery = useQuery({
    queryKey: ['personas'],
    queryFn: () => api.get<PersonaSummary[]>('/api/personas'),
    staleTime: 30_000,
  });
  const { data: clis } = useQuery({
    queryKey: ['clis'],
    queryFn: () => api.get<CliInfoLike[]>('/api/clis'),
    staleTime: 60_000,
  });

  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // ---- 抽屉（新建 / 编辑）----
  const [drawer, setDrawer] = useState<{ mode: 'create' | 'edit'; persona: PersonaSummary | null } | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  // ---- 智能创建 ----
  const [smartPhase, setSmartPhase] = useState<SmartPhase>('idle');
  const [requirement, setRequirement] = useState('');
  const [adapter, setAdapter] = useState<DraftAdapter>('codex');
  const [draftFields, setDraftFields] = useState<DraftFields>(EMPTY_DRAFT);
  const [draftWarnings, setDraftWarnings] = useState<string[]>([]);
  const [rawMode, setRawMode] = useState(false);
  const [smartError, setSmartError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const draftAuto = useRef({ name: false, desc: false });
  const abortRef = useRef<AbortController | null>(null);
  const cancelRef = useRef(false);

  // ---- 删除确认 ----
  const [deleteTarget, setDeleteTarget] = useState<PersonaSummary | null>(null);

  // ---- 导入 ----
  const [importOpen, setImportOpen] = useState(false);
  const [importPath, setImportPath] = useState('');
  const [importError, setImportError] = useState<string | null>(null);

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['personas'] });
  };

  const abortSmart = (): void => {
    abortRef.current?.abort();
    abortRef.current = null;
  };

  // 生成中计时（服务端 120s 超时），关闭抽屉时中断请求
  useEffect(() => {
    if (smartPhase !== 'generating') return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [smartPhase]);

  useEffect(() => () => abortSmart(), []);

  const resetSmart = (): void => {
    abortSmart();
    cancelRef.current = false;
    setSmartPhase('idle');
    setRequirement('');
    setDraftFields(EMPTY_DRAFT);
    setDraftWarnings([]);
    setRawMode(false);
    setSmartError(null);
    setElapsed(0);
    draftAuto.current = { name: false, desc: false };
  };

  const openDrawer = (mode: 'create' | 'edit', persona: PersonaSummary | null): void => {
    setActionError(null);
    setFieldError(null);
    save.reset();
    resetSmart();
    setDrawer({ mode, persona });
    setName(persona?.name ?? '');
    setDescription(persona?.description ?? '');
    setBody(persona?.body_md ?? '');
  };

  const closeDrawer = (): void => {
    if (save.isPending) return;
    abortSmart();
    setDrawer(null);
    setFieldError(null);
  };

  const save = useMutation({
    mutationFn: (payload: { name: string; description: string; body_md: string }) => {
      if (drawer?.mode === 'edit' && drawer.persona !== null) {
        return api.patch<PersonaSummary>(`/api/personas/${drawer.persona.id}`, payload);
      }
      return api.post<PersonaSummary>('/api/personas', payload);
    },
    onSuccess: async () => {
      await invalidate();
      setNotice(`已保存人设「${name.trim()}」`);
      setDrawer(null);
      setFieldError(null);
    },
    onError: (e) => setFieldError(e instanceof Error ? e.message : '保存失败'),
  });

  const remove = useMutation({
    mutationFn: (persona: PersonaSummary) => api.del<void>(`/api/personas/${persona.id}`),
    onSuccess: async (_data, persona) => {
      await invalidate();
      setDeleteTarget(null);
      setNotice(`已删除人设「${persona.name}」`);
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : '删除失败'),
  });

  const importPackage = useMutation({
    mutationFn: (path: string) =>
      api.post<{
        package: { name: string };
        personas: Array<{ id: string; name: string }>;
        team: { name: string } | null;
      }>('/api/expert-packages/import', { workspace_id: workspaceId, path }),
    onSuccess: async (data) => {
      await invalidate();
      await queryClient.invalidateQueries({ queryKey: ['teams'] });
      const names = data.personas.map((p) => p.name).join('、');
      const team = data.team === null ? '' : ` · 团队模板「${data.team.name}」`;
      setImportOpen(false);
      setImportPath('');
      setImportError(null);
      setNotice(`已导入 ${data.personas.length} 个人设（${names}）${team}`);
    },
    onError: (e) => setImportError(e instanceof Error ? e.message : '导入失败'),
  });

  // ---- 智能创建动作 ----
  const applyDraft = (draft: {
    name: string;
    description: string;
    role: string;
    tone: string;
    boundary: string;
    domain: string;
    warnings: string[];
  }): void => {
    setDraftFields({
      role: draft.role,
      tone: draft.tone,
      boundary: draft.boundary,
      domain: draft.domain,
    });
    setDraftWarnings(draft.warnings);
    if (name.trim() === '') {
      setName(draft.name);
      draftAuto.current.name = true;
    }
    if (description.trim() === '') {
      setDescription(draft.description);
      draftAuto.current.desc = true;
    }
    setBody('');
    setRawMode(false);
    setSmartPhase('draft');
    setSmartError(null);
  };

  const generate = async (): Promise<void> => {
    if (smartPhase === 'generating') return;
    const text = requirement.trim();
    if (text === '') {
      setSmartError('先用一句话描述你要的人设，再生成草稿。');
      setSmartPhase('error');
      return;
    }
    setSmartError(null);
    setSmartPhase('generating');
    cancelRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const draft = await requestPersonaDraft({ requirement: text, adapter }, { signal: controller.signal });
      if (cancelRef.current) return;
      applyDraft(draft);
    } catch (e) {
      if (cancelRef.current || e instanceof DraftAbortError) return;
      setSmartError(mapPersonaDraftError(e, adapter));
      setSmartPhase('error');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const cancelGenerate = (): void => {
    if (smartPhase !== 'generating') return;
    cancelRef.current = true;
    abortSmart();
    setSmartPhase('idle');
    setSmartError(null);
  };

  const discardDraft = (): void => {
    if (draftAuto.current.name) setName('');
    if (draftAuto.current.desc) setDescription('');
    draftAuto.current = { name: false, desc: false };
    setDraftFields(EMPTY_DRAFT);
    setDraftWarnings([]);
    setBody('');
    setRawMode(false);
    setSmartPhase('idle');
    setSmartError(null);
    setNotice('已放弃草稿，回到手动填写');
  };

  const toggleRawMode = (): void => {
    if (smartPhase !== 'draft') return;
    if (!rawMode) {
      setBody(composePersonaBody(draftFields));
    } else {
      const parsed = parsePersonaSections(body);
      setDraftFields((current) => ({
        role: parsed.role ?? current.role,
        tone: parsed.tone ?? current.tone,
        boundary: parsed.boundary ?? current.boundary,
        domain: parsed.domain ?? current.domain,
      }));
    }
    setRawMode((value) => !value);
  };

  const submitForm = (event: FormEvent): void => {
    event.preventDefault();
    if (save.isPending || drawer === null) return;
    const drafting = drawer.mode === 'create' && smartPhase === 'draft';
    const trimmedName = name.trim();
    const bodyMd = drafting && !rawMode ? composePersonaBody(draftFields) : body.trim();
    if (trimmedName === '') {
      setFieldError('名称不能为空（上限 100 字）');
      return;
    }
    if (drafting && !rawMode && draftFields.role.trim() === '') {
      setFieldError('角色不能为空（可点「放弃草稿」回到手填）');
      return;
    }
    if (bodyMd === '') {
      setFieldError('人设正文不能为空');
      return;
    }
    setFieldError(null);
    save.mutate({ name: trimmedName, description: description.trim(), body_md: bodyMd });
  };

  const personas = personasQuery.data ?? [];
  const isCreate = drawer?.mode === 'create';
  const readOnly = drawer?.persona?.source === 'builtin';
  const generating = smartPhase === 'generating';
  const selectedCli = clis?.find((c) => c.id === adapter);
  const adapterUnavailable = selectedCli !== undefined && selectedCli.installed === false;

  return (
    <section data-testid="settings-personas" aria-labelledby="settings-personas-title" className="mt-4 border-t border-hairline pt-3">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 id="settings-personas-title" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
          智能体人设
          <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium normal-case text-accent">全局库 · 即时生效</span>
        </h3>
        <div className="flex gap-2">
          <button type="button" data-testid="persona-import" onClick={() => { setImportError(null); importPackage.reset(); setImportOpen(true); }} className={BUTTON_SECONDARY}>
            从专家包导入
          </button>
          <button type="button" data-testid="persona-create" onClick={() => openDrawer('create', null)} className={BUTTON_PRIMARY}>
            ＋ 新建人设
          </button>
        </div>
      </div>
      <p className="mb-3 text-xs text-ink-3">
        人设是全局资源（落中心库）。这里管理「库里有什么」；某个会话用哪个人设，仍到「会话设置 → 人设」里选。
      </p>

      {personasQuery.isLoading && <p className="text-xs text-ink-3">人设加载中…</p>}
      {personasQuery.isError && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          人设加载失败：{personasQuery.error instanceof Error ? personasQuery.error.message : '未知错误'}
          <button type="button" onClick={() => void personasQuery.refetch()} className="ml-2 underline">重试</button>
        </p>
      )}
      {actionError !== null && (
        <p role="alert" data-testid="persona-action-error" className="mb-2 text-xs text-red-600 dark:text-red-400">{actionError}</p>
      )}
      {notice !== null && (
        <p role="status" data-testid="persona-notice" className="mb-2 text-xs text-accent">{notice}</p>
      )}

      {personasQuery.isSuccess && personas.length === 0 && (
        <div data-testid="persona-empty" className="rounded-lg border border-dashed border-hairline p-4 text-center">
          <p className="text-sm font-medium text-ink-2">还没有人设</p>
          <p className="mt-1 text-xs text-ink-3">新建一条人设，或从 WorkBuddy 专家包整包导入。不设人设的会话照常可用。</p>
          <div className="mt-3 flex justify-center gap-2">
            <button type="button" onClick={() => { setImportError(null); importPackage.reset(); setImportOpen(true); }} className={BUTTON_SECONDARY}>从专家包导入</button>
            <button type="button" onClick={() => openDrawer('create', null)} className={BUTTON_PRIMARY}>＋ 新建人设</button>
          </div>
        </div>
      )}

      {personas.length > 0 && (
        <ul data-testid="persona-list" className="divide-y divide-hairline rounded-lg border border-hairline">
          {personas.map((persona) => {
            const builtin = persona.source === 'builtin';
            return (
              <li key={persona.id} data-testid={`persona-row-${persona.id}`} className="flex items-start gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{persona.name}</span>
                    <span data-testid={`persona-badge-${persona.id}`} className={`rounded-full px-1.5 py-0.5 text-[10px] ${SOURCE_BADGE[persona.source]}`}>
                      {SOURCE_LABEL[persona.source]}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-ink-2">{persona.description === '' ? '（无描述）' : persona.description}</p>
                  <p className="mt-0.5 truncate text-[11px] text-ink-3">
                    {persona.package_path !== null ? `${persona.package_path} · ` : ''}
                    创建于 {formatDate(persona.created_at)}
                    {builtin ? ' · 内置人设不可改删' : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    data-testid={`persona-edit-${persona.id}`}
                    disabled={builtin}
                    title={builtin ? '内置人设只读：服务端 PATCH / DELETE 返回 409，需要定制请新建一份' : undefined}
                    onClick={() => openDrawer('edit', persona)}
                    className={BUTTON_SECONDARY}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    data-testid={`persona-delete-${persona.id}`}
                    disabled={builtin}
                    title={builtin ? '内置人设只读：服务端 PATCH / DELETE 返回 409，需要定制请新建一份' : undefined}
                    onClick={() => { setActionError(null); remove.reset(); setDeleteTarget(persona); }}
                    className={BUTTON_DANGER}
                  >
                    删除
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {personas.some((p) => p.source === 'builtin') && (
        <p data-testid="persona-builtin-note" className="mt-2 text-[11px] text-ink-3">
          内置人设由程序包提供，只读（服务端 409）；需要定制请「新建人设」复制一份再改。
        </p>
      )}

      {/* 新建 / 编辑抽屉：SETTINGS-LAYOUT 起优先与设置面板并排（右侧、无深色遮罩）；
          剩余空间不足或窄视口时由 Modal 自动降级为覆盖式右侧抽屉 */}
      <Modal
        open={drawer !== null}
        title={drawer?.mode === 'create' ? '新建人设' : readOnly ? '查看内置人设' : '编辑人设'}
        onClose={closeDrawer}
        placement="side"
        anchorSelector='[data-testid="drawer-panel"]'
      >
        <form onSubmit={submitForm} className="space-y-3" data-testid="persona-drawer">
          {readOnly && (
            <p className="rounded border border-hairline bg-surface-raised p-2 text-xs text-ink-2">
              内置人设由程序包提供，只读。需要定制请「新建人设」复制一份再改。
            </p>
          )}

          {isCreate && (
            <section data-testid="smart-create" className="rounded-lg border border-hairline bg-surface-raised/40 p-3">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-xs font-semibold text-ink-2">智能创建</span>
                <span className="rounded-full bg-surface-card px-1.5 py-0.5 text-[10px] text-ink-3">一句话生成草稿</span>
              </div>
              <p className="mb-2 text-[11px] text-ink-3">描述你要的人设，生成后仍可逐字段修改；也可以跳过它直接手填。</p>

              {(smartPhase === 'idle' || smartPhase === 'error') && (
                <div className="space-y-2" data-testid="smart-form">
                  <textarea
                    data-testid="persona-smart-prompt"
                    aria-label="一句话描述人设"
                    rows={2}
                    value={requirement}
                    disabled={generating}
                    onChange={(e) => setRequirement(e.target.value)}
                    placeholder="例如：一个严谨的技术文档编辑，把口语化笔记改成可发布的说明"
                    className={inputCls}
                  />
                  <div className="flex flex-wrap gap-1">
                    {SMART_CHIPS.map((chip) => (
                      <button
                        key={chip}
                        type="button"
                        disabled={generating}
                        onClick={() => {
                          setRequirement(chip);
                          if (smartPhase === 'error') {
                            setSmartPhase('idle');
                            setSmartError(null);
                          }
                        }}
                        className="rounded-full border border-hairline px-2 py-0.5 text-[11px] text-ink-2 hover:bg-surface-raised"
                      >
                        {chip.split('，')[0]}
                      </button>
                    ))}
                  </div>
                  {smartError !== null && (
                    <p data-testid="persona-smart-error" role="alert" className="text-xs text-red-600 dark:text-red-400">{smartError}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-testid="persona-smart-generate"
                      disabled={generating || adapterUnavailable}
                      onClick={() => void generate()}
                      className={BUTTON_PRIMARY}
                    >
                      {smartPhase === 'error' ? '重试生成' : '生成草稿'}
                    </button>
                    <label className="flex items-center gap-1 text-[11px] text-ink-3">
                      执行方式
                      <select
                        data-testid="persona-smart-adapter"
                        aria-label="执行方式"
                        value={adapter}
                        onChange={(e) => setAdapter(e.target.value as DraftAdapter)}
                        className="rounded border border-hairline bg-surface-card px-1 py-0.5 text-[11px] text-ink"
                      >
                        {DRAFT_ADAPTERS.map((id) => {
                          const info = clis?.find((c) => c.id === id);
                          const unavailable = info !== undefined && info.installed === false;
                          return (
                            <option key={id} value={id} disabled={unavailable}>
                              {ADAPTER_LABEL[id]}{unavailable ? '（本机不可用）' : ''}
                            </option>
                          );
                        })}
                      </select>
                    </label>
                    {adapterUnavailable && (
                      <span className="text-[11px] text-amber-700 dark:text-amber-300">{ADAPTER_LABEL[adapter]} 在本机不可用，请换一个执行方式。</span>
                    )}
                  </div>
                </div>
              )}

              {generating && (
                <div data-testid="smart-generating" className="space-y-2">
                  <p role="status" className="flex items-center gap-2 text-xs text-ink-2">
                    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-hairline border-t-accent" aria-hidden="true" />
                    正在生成草稿… {elapsed}s（最多 120s）
                  </p>
                  <div className="h-1 overflow-hidden rounded bg-surface-card" aria-hidden="true">
                    <div className="h-full w-1/3 animate-pulse rounded bg-accent" />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-ink-3">生成期间表单暂不可改</span>
                    <button type="button" data-testid="persona-smart-cancel" onClick={cancelGenerate} className={BUTTON_SECONDARY}>
                      取消生成
                    </button>
                  </div>
                </div>
              )}

              {smartPhase === 'draft' && (
                <div data-testid="persona-smart-draft" className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-hairline bg-surface-card p-2">
                    <span className="text-xs text-ink-2">
                      <strong className="text-ink">草稿已生成</strong> · 可逐段修改；保存时按 Markdown 小节拼进人设正文。
                    </span>
                    <span className="flex gap-2">
                      <button type="button" data-testid="persona-smart-regenerate" onClick={() => void generate()} className="text-[11px] text-accent underline">
                        重新生成
                      </button>
                      <button type="button" data-testid="persona-smart-discard" onClick={discardDraft} className="text-[11px] text-red-600 underline dark:text-red-400">
                        放弃草稿
                      </button>
                    </span>
                  </div>
                  {draftWarnings.length > 0 && (
                    <ul className="list-disc pl-4 text-[11px] text-amber-700 dark:text-amber-300">
                      {draftWarnings.map((warning) => <li key={warning}>{warning}</li>)}
                    </ul>
                  )}
                  {!rawMode && (
                    <div className="space-y-2" data-testid="persona-draft-fields">
                      <label className="block">
                        <span className={labelCls}>角色（必填）</span>
                        <textarea
                          data-testid="persona-role"
                          aria-label="角色"
                          rows={3}
                          value={draftFields.role}
                          onChange={(e) => setDraftFields((f) => ({ ...f, role: e.target.value }))}
                          className={inputCls}
                        />
                      </label>
                      <label className="block">
                        <span className={labelCls}>语气</span>
                        <textarea
                          data-testid="persona-tone"
                          aria-label="语气"
                          rows={2}
                          value={draftFields.tone}
                          onChange={(e) => setDraftFields((f) => ({ ...f, tone: e.target.value }))}
                          className={inputCls}
                        />
                      </label>
                      <label className="block">
                        <span className={labelCls}>边界与禁忌</span>
                        <textarea
                          data-testid="persona-boundary"
                          aria-label="边界与禁忌"
                          rows={3}
                          value={draftFields.boundary}
                          onChange={(e) => setDraftFields((f) => ({ ...f, boundary: e.target.value }))}
                          className={inputCls}
                        />
                      </label>
                      <label className="block">
                        <span className={labelCls}>擅长领域</span>
                        <textarea
                          data-testid="persona-domain"
                          aria-label="擅长领域"
                          rows={3}
                          value={draftFields.domain}
                          onChange={(e) => setDraftFields((f) => ({ ...f, domain: e.target.value }))}
                          className={inputCls}
                        />
                      </label>
                    </div>
                  )}
                  <button type="button" data-testid="persona-smart-raw-toggle" onClick={toggleRawMode} className="text-[11px] text-accent underline">
                    {rawMode ? '改回分字段编辑' : '改为 Markdown 编辑'}
                  </button>
                </div>
              )}
            </section>
          )}

          <label className="block">
            <span className={labelCls}>名称（必填，上限 100 字）</span>
            <input
              data-testid="persona-name"
              aria-label="名称"
              maxLength={100}
              value={name}
              disabled={readOnly || generating}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：发布协调员"
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className={labelCls}>描述（≤ 2000 字）</span>
            <input
              data-testid="persona-desc"
              aria-label="描述"
              maxLength={2000}
              value={description}
              disabled={readOnly || generating}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="一句话说明这个人在什么时候用"
              className={inputCls}
            />
          </label>

          {(!(isCreate && smartPhase === 'draft') || rawMode) && (
            <label className="block">
              <span className={labelCls}>人设正文（Markdown，必填）</span>
              <textarea
                data-testid="persona-body"
                aria-label="人设正文"
                rows={8}
                value={body}
                disabled={readOnly || generating}
                onChange={(e) => setBody(e.target.value)}
                placeholder="写清角色、工作方式、输出要求……"
                className={`${inputCls} font-mono`}
              />
              <span className="mt-1 block text-[11px] text-ink-3">
                正文会作为系统提示词注入使用该人设的会话；工具与技能开关仍在会话设置里单独配置。
              </span>
            </label>
          )}

          {fieldError !== null && (
            <p role="alert" data-testid="persona-field-error" className="text-xs text-red-600 dark:text-red-400">{fieldError}</p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={closeDrawer} className={BUTTON_SECONDARY}>
              {readOnly ? '关闭' : '取消'}
            </button>
            {!readOnly && (
              <button type="submit" data-testid="persona-save" disabled={save.isPending || generating} className={BUTTON_PRIMARY}>
                {save.isPending ? '保存中…' : '保存'}
              </button>
            )}
          </div>
        </form>
      </Modal>

      {/* 删除确认 */}
      <Modal open={deleteTarget !== null} title="删除人设？" onClose={() => setDeleteTarget(null)}>
        {deleteTarget !== null && (
          <div className="space-y-3 text-sm">
            <p data-testid="persona-delete-message">
              「{deleteTarget.name}」删除后不可恢复，也不会同步到已经绑定它的会话。
            </p>
            <p className="text-xs text-ink-3">
              会话与团队只保存 persona_id，没有外键约束；引用它的会话会显示「未知人设」，下一轮起不再注入该人设，但会话本身仍可正常启动。
            </p>
            {remove.isError && (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {remove.error instanceof Error ? remove.error.message : '删除失败'}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" data-testid="persona-delete-cancel" onClick={() => setDeleteTarget(null)} className={BUTTON_SECONDARY}>
                取消
              </button>
              <button
                type="button"
                data-testid="persona-delete-confirm"
                disabled={remove.isPending}
                onClick={() => remove.mutate(deleteTarget)}
                className="inline-flex h-8 items-center rounded-lg bg-red-600 px-3 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                删除
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* 从专家包导入 */}
      <Modal open={importOpen} title="从 WorkBuddy 专家包导入" onClose={() => setImportOpen(false)}>
        <div className="space-y-3 text-sm">
          <p className="text-xs text-ink-3">
            整包导入：包内每个专家各生成一条人设（来源标记「导入」）；包内带 teamInfo 时，同时生成一个团队模板。
          </p>
          <label className="block">
            <span className={labelCls}>专家包目录</span>
            <input
              data-testid="persona-import-path"
              aria-label="专家包目录"
              value={importPath}
              onChange={(e) => setImportPath(e.target.value)}
              placeholder="D:\WorkBuddy\packages\data-analyst"
              className={inputCls}
            />
            <span className="mt-1 block text-[11px] text-ink-3">绝对路径优先；相对路径按服务进程 cwd 解析。</span>
          </label>
          <label className="block">
            <span className={labelCls}>归属工作区</span>
            <input
              data-testid="persona-import-workspace"
              aria-label="归属工作区"
              value={workspaceId ?? '未选择工作区'}
              disabled
              className={inputCls}
            />
            <span className="mt-1 block text-[11px] text-ink-3">团队模板挂在该工作区；人设本身是全局资源。</span>
          </label>
          {importError !== null && (
            <p data-testid="persona-import-error" role="alert" className="text-xs text-red-600 dark:text-red-400">{importError}</p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => setImportOpen(false)} className={BUTTON_SECONDARY}>
              取消
            </button>
            <button
              type="button"
              data-testid="persona-import-submit"
              disabled={importPackage.isPending}
              onClick={() => {
                const path = importPath.trim();
                if (path === '') {
                  setImportError('请填写专家包目录（绝对路径优先）。');
                  return;
                }
                if (workspaceId === null) {
                  setImportError('未选择工作区，无法导入（团队模板按工作区归属）。');
                  return;
                }
                setImportError(null);
                importPackage.mutate(path);
              }}
              className={BUTTON_PRIMARY}
            >
              {importPackage.isPending ? '导入中…' : '开始导入'}
            </button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
