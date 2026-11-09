/**
 * 会话设置三节（P1-C）：人设 / 工具 / 技能。
 * - 人设：GET /api/personas 下拉（builtin 标记）+ 正文查看/编辑（builtin 只读）+ persona_injection 四选；
 *   flag 档按 GET /api/cli-capabilities 的能力置灰并给原因。
 * - 工具：approval_mode 四选 + allow/deny 标签输入 → tool_policy。
 * - 技能：allow/deny 标签输入 → skill_policy（仅存储，物化在 P2）。
 * session 字段自动防抖 PATCH；失败回滚未被后续编辑覆盖的字段并提示。
 * 人设正文是全局 persona 更新，使用单独的显式保存。
 * 会话四列由服务端 SELECT * 回传（shared.Session 未声明），此处按本地扩展类型读取。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Session } from '@agentboard/shared';
import { api } from '../../api/client';
import { Modal } from '../ui/Modal';

export interface PersonaSummary {
  id: string;
  name: string;
  description: string;
  body_md: string;
  source: 'builtin' | 'user' | 'import';
  package_path: string | null;
  created_at: number;
}

export interface CliCapabilitiesResponse {
  adapter: string;
  command: string;
  personaFlag: boolean;
  toolFlags: boolean;
  permissionFlags: string[];
}

/** P1-C：session 表 persona 注入四列（迁移 personaInjection 补列；tool/skill policy 存 JSON 字符串） */
export interface SessionPersonaFields {
  persona_id?: string | null;
  tool_policy?: string | null;
  skill_policy?: string | null;
  persona_injection?: string | null;
}

export const APPROVAL_MODES = ['inherit', 'plan', 'acceptEdits', 'bypass'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export const APPROVAL_LABEL: Record<ApprovalMode, string> = {
  inherit: '跟随 CLI 默认',
  plan: '仅规划（只读）',
  acceptEdits: '自动接受编辑',
  bypass: '跳过审批（危险）',
};

export const PERSONA_INJECTIONS = ['auto', 'flag', 'file', 'off'] as const;
export type PersonaInjection = (typeof PERSONA_INJECTIONS)[number];
export const PERSONA_INJECTION_LABEL: Record<PersonaInjection, string> = {
  auto: '自动（按能力选 flag / 标记块）',
  flag: 'CLI 参数注入（--append-system-prompt）',
  file: '服务端标记块注入',
  off: '关闭注入',
};

export interface ToolPolicyValue {
  approval_mode: ApprovalMode;
  allow: string[];
  deny: string[];
}

export interface SkillPolicyValue {
  allow: string[];
  deny: string[];
  /** 设计 §5.3 的 MCP 三态；本卡不改它，保存时原样带回避免覆盖 */
  mcp?: string | { servers: Record<string, unknown> };
}

/** 能力探测只覆盖内置四家（服务端 ADAPTER_COMMANDS 白名单） */
const PROBE_ADAPTERS = new Set(['codebuddy', 'codex', 'opencode', 'dsh']);

const EMPTY_TOOL_POLICY: ToolPolicyValue = { approval_mode: 'inherit', allow: [], deny: [] };

function parseToolPolicy(raw: string | null | undefined): ToolPolicyValue {
  if (raw === null || raw === undefined || raw === '') return EMPTY_TOOL_POLICY;
  try {
    const parsed = JSON.parse(raw) as Partial<ToolPolicyValue>;
    const mode = APPROVAL_MODES.includes(parsed.approval_mode as ApprovalMode)
      ? (parsed.approval_mode as ApprovalMode)
      : 'inherit';
    return {
      approval_mode: mode,
      allow: Array.isArray(parsed.allow) ? parsed.allow.filter((v): v is string => typeof v === 'string') : [],
      deny: Array.isArray(parsed.deny) ? parsed.deny.filter((v): v is string => typeof v === 'string') : [],
    };
  } catch {
    return EMPTY_TOOL_POLICY;
  }
}

function parseSkillPolicy(raw: string | null | undefined): SkillPolicyValue {
  if (raw === null || raw === undefined || raw === '') return { allow: [], deny: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<SkillPolicyValue>;
    return {
      allow: Array.isArray(parsed.allow) ? parsed.allow.filter((v): v is string => typeof v === 'string') : [],
      deny: Array.isArray(parsed.deny) ? parsed.deny.filter((v): v is string => typeof v === 'string') : [],
      ...(parsed.mcp === undefined ? {} : { mcp: parsed.mcp }),
    };
  } catch {
    return { allow: [], deny: [] };
  }
}

function parseInjection(raw: string | null | undefined): PersonaInjection {
  return PERSONA_INJECTIONS.includes(raw as PersonaInjection) ? (raw as PersonaInjection) : 'auto';
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** allow/deny 标签输入：Enter / 逗号 / 中文逗号确认，退格删最后一个；重复项忽略 */
function TagInput({
  testId,
  values,
  onChange,
  placeholder,
  disabled,
}: {
  testId: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const commit = () => {
    const additions = draft
      .split(/[,，]/)
      .map((v) => v.trim())
      .filter((v) => v !== '');
    if (additions.length === 0) return;
    const next = [...values];
    for (const item of additions) if (!next.includes(item)) next.push(item);
    onChange(next);
    setDraft('');
  };
  return (
    <div className="rounded border border-hairline bg-surface-card px-2 py-1">
      {values.length > 0 && (
        <ul className="mb-1 flex flex-wrap gap-1" data-testid={`${testId}-chips`}>
          {values.map((value) => (
            <li
              key={value}
              className="flex items-center gap-1 rounded bg-surface-raised px-1.5 py-0.5 text-xs text-ink-2"
            >
              <span>{value}</span>
              <button
                type="button"
                aria-label={`移除 ${value}`}
                data-testid={`${testId}-remove-${value}`}
                disabled={disabled}
                onClick={() => onChange(values.filter((v) => v !== value))}
                className="text-ink-3 hover:text-red-600 disabled:opacity-40"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        data-testid={testId}
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
            e.preventDefault();
            commit();
          }
        }}
        className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
      />
    </div>
  );
}

export function SessionSettingsDialog(props: { session: Session; onClose: () => void }) {
  return <SessionSettingsDialogForm key={props.session.id} {...props} />;
}

function SessionSettingsDialogForm({ session, onClose }: { session: Session; onClose: () => void }) {
  const queryClient = useQueryClient();
  const raw = session as Session & SessionPersonaFields;

  const [personaId, setPersonaId] = useState<string>(raw.persona_id ?? '');
  const [injection, setInjection] = useState<PersonaInjection>(parseInjection(raw.persona_injection));
  const [toolPolicy, setToolPolicy] = useState<ToolPolicyValue>(() => parseToolPolicy(raw.tool_policy));
  const [skillPolicy, setSkillPolicy] = useState<SkillPolicyValue>(() => parseSkillPolicy(raw.skill_policy));
  const [bodyDraft, setBodyDraft] = useState('');
  const [saving, setSaving] = useState<'body' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const savedRef = useRef({
    personaId: raw.persona_id ?? '',
    injection: parseInjection(raw.persona_injection),
    toolPolicy: parseToolPolicy(raw.tool_policy),
    skillPolicy: parseSkillPolicy(raw.skill_policy),
  });
  const pendingRef = useRef<Record<string, unknown>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const patchQueueRef = useRef<Promise<void>>(Promise.resolve());
  const changeVersionRef = useRef<Record<string, number>>({});

  const takePending = useCallback((): Record<string, unknown> => {
    const body = pendingRef.current;
    pendingRef.current = {};
    return body;
  }, []);

  const sendPatch = useCallback((body: Record<string, unknown>): void => {
    if (Object.keys(body).length === 0) return;
    const sentVersions = Object.fromEntries(
      Object.keys(body).map((field) => [field, changeVersionRef.current[field] ?? 0]),
    ) as Record<string, number>;

    const send = async (): Promise<void> => {
      try {
        await api.patch<Session>(`/api/sessions/${session.id}`, body);
        if ('persona_id' in body) savedRef.current.personaId = typeof body.persona_id === 'string' ? body.persona_id : '';
        if ('persona_injection' in body) savedRef.current.injection = body.persona_injection as PersonaInjection;
        if ('tool_policy' in body) savedRef.current.toolPolicy = body.tool_policy as ToolPolicyValue;
        if ('skill_policy' in body) savedRef.current.skillPolicy = body.skill_policy as SkillPolicyValue;
        if (Object.entries(sentVersions).every(([field, version]) => changeVersionRef.current[field] === version)) setError(null);
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      } catch (e) {
        if ('persona_id' in body && changeVersionRef.current.persona_id === sentVersions.persona_id) {
          const failedValue = body.persona_id === null ? '' : body.persona_id;
          setPersonaId((current) => current === failedValue ? savedRef.current.personaId : current);
        }
        if ('persona_injection' in body && changeVersionRef.current.persona_injection === sentVersions.persona_injection) {
          setInjection((current) => current === body.persona_injection ? savedRef.current.injection : current);
        }
        if ('tool_policy' in body && changeVersionRef.current.tool_policy === sentVersions.tool_policy) {
          setToolPolicy((current) => sameJson(current, body.tool_policy) ? savedRef.current.toolPolicy : current);
        }
        if ('skill_policy' in body && changeVersionRef.current.skill_policy === sentVersions.skill_policy) {
          setSkillPolicy((current) => sameJson(current, body.skill_policy) ? savedRef.current.skillPolicy : current);
        }
        setError(e instanceof Error ? e.message : '会话设置保存失败，请重试');
      }
    };

    patchQueueRef.current = patchQueueRef.current.then(send, send);
  }, [queryClient, session.id]);

  const flushPending = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    sendPatch(takePending());
  }, [sendPatch, takePending]);

  // ponytail: keep the tiny pending/flush path local; this session PATCH has a different payload from DetailPanel.
  const schedulePatch = useCallback((field: string, value: unknown): void => {
    changeVersionRef.current[field] = (changeVersionRef.current[field] ?? 0) + 1;
    pendingRef.current[field] = value;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      sendPatch(takePending());
    }, 500);
  }, [sendPatch, takePending]);

  useEffect(() => () => flushPending(), [flushPending]);

  const personas = useQuery({
    queryKey: ['personas'],
    queryFn: () => api.get<PersonaSummary[]>('/api/personas'),
    staleTime: 30_000,
  });
  const capabilities = useQuery({
    queryKey: ['cli-capabilities', session.cli],
    queryFn: () => api.get<CliCapabilitiesResponse>(`/api/cli-capabilities?adapter=${encodeURIComponent(session.cli)}`),
    enabled: PROBE_ADAPTERS.has(session.cli),
    retry: false,
    staleTime: 60_000,
  });

  const personaList = personas.data ?? [];
  const selectedPersona = personaList.find((p) => p.id === personaId) ?? null;
  const personaMissing = personaId !== '' && !personas.isLoading && selectedPersona === null;

  useEffect(() => {
    setBodyDraft(selectedPersona?.body_md ?? '');
  }, [selectedPersona?.id, selectedPersona?.body_md]);

  const caps = capabilities.data ?? null;
  // flag 注入依赖 --append-system-prompt；file/off 不依赖 CLI flag
  const flagDisabled = caps !== null && !caps.personaFlag;
  const capabilityNote =
    capabilities.isLoading
      ? '能力探测中…'
      : capabilities.isError
        ? '能力探测失败：选项按默认口径提供（未置灰）'
        : caps !== null && !caps.personaFlag
          ? `该 CLI 未探测到 --append-system-prompt，flag 注入不可用（${caps.command}）`
          : null;

  const saveBody = async (): Promise<void> => {
    if (selectedPersona === null || selectedPersona.source === 'builtin') return;
    setSaving('body');
    setError(null);
    try {
      const updated = await api.patch<PersonaSummary>(`/api/personas/${selectedPersona.id}`, { body_md: bodyDraft });
      queryClient.setQueryData<PersonaSummary[]>(['personas'], (old) =>
        (old ?? []).map((p) => (p.id === updated.id ? updated : p)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '人设正文保存失败，请重试');
    } finally {
      setSaving(null);
    }
  };

  return (
    <Modal open title="会话设置" onClose={onClose} size="lg" scrollable>
      <div className="space-y-6 text-sm" data-testid="session-settings-dialog">
        {error !== null && (
          <p role="alert" data-testid="session-settings-error" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}

        {/* ---- 人设 ---- */}
        <section data-testid="settings-section-persona" className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-3">人设</h3>
          {personas.isLoading && <p className="text-xs text-ink-3">人设加载中…</p>}
          {personas.isError && (
            <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
              <span>人设加载失败：{personas.error instanceof Error ? personas.error.message : '未知错误'}</span>
              <button type="button" onClick={() => void personas.refetch()} className="rounded border border-hairline px-2 py-0.5 hover:bg-surface-raised">
                重试
              </button>
            </div>
          )}
          {personas.isSuccess && personaList.length === 0 && (
            <p className="text-xs text-ink-3" data-testid="persona-empty">暂无人设，可只设置工具/技能。</p>
          )}

          <label className="block">
            <span className="mb-1 block text-xs text-ink-3">选择人设</span>
            <select
              data-testid="persona-select"
              value={personaId}
              onChange={(e) => {
                const next = e.target.value;
                setPersonaId(next);
                schedulePatch('persona_id', next === '' ? null : next);
                setError(null);
              }}
              className="w-full rounded border border-hairline bg-surface-card px-2 py-1 text-sm text-ink outline-none focus-visible:outline-2 focus-visible:outline-accent"
            >
              <option value="">不使用人设（解绑）</option>
              {personaList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.source === 'builtin' ? '（内置）' : ''}
                </option>
              ))}
              {personaMissing && <option value={personaId}>未知人设 {personaId}</option>}
            </select>
          </label>

          {selectedPersona !== null && (
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs text-ink-3">
                <span data-testid="persona-source">
                  {selectedPersona.source === 'builtin' ? '内置人设（只读）' : selectedPersona.source === 'import' ? '导入人设' : '自定义人设'}
                </span>
                {selectedPersona.source === 'builtin' && (
                  <span data-testid="persona-builtin-badge" className="rounded bg-surface-raised px-1.5 py-0.5">builtin</span>
                )}
              </div>
              <textarea
                data-testid="persona-body"
                value={bodyDraft}
                readOnly={selectedPersona.source === 'builtin'}
                rows={6}
                onChange={(e) => setBodyDraft(e.target.value)}
                className="w-full rounded border border-hairline bg-surface-card px-2 py-1 font-mono text-xs text-ink outline-none read-only:bg-surface-raised/60 read-only:text-ink-3 focus-visible:outline-2 focus-visible:outline-accent"
              />
              {selectedPersona.source !== 'builtin' && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    data-testid="persona-body-save"
                    disabled={saving !== null || bodyDraft === selectedPersona.body_md}
                    onClick={() => void saveBody()}
                    className="rounded border border-hairline px-2 py-0.5 text-xs text-ink-2 hover:bg-surface-raised disabled:opacity-40"
                  >
                    {saving === 'body' ? '保存中…' : '保存人设正文'}
                  </button>
                </div>
              )}
            </div>
          )}

          <fieldset className="space-y-1">
            <legend className="mb-1 text-xs text-ink-3">注入方式</legend>
            {PERSONA_INJECTIONS.map((value) => {
              const disabled = value === 'flag' && flagDisabled;
              return (
                <label
                  key={value}
                  className={`flex items-center gap-2 text-xs ${disabled ? 'text-ink-3 opacity-60' : 'text-ink-2'}`}
                  title={disabled ? '该 CLI 不支持 --append-system-prompt，flag 注入不可用' : undefined}
                >
                  <input
                    type="radio"
                    name="persona-injection"
                    data-testid={`injection-option-${value}`}
                    value={value}
                    checked={injection === value}
                    disabled={disabled}
                    onChange={() => {
                      setInjection(value);
                      schedulePatch('persona_injection', value);
                      setError(null);
                    }}
                  />
                  <span>{PERSONA_INJECTION_LABEL[value]}</span>
                  {disabled && <span data-testid="injection-flag-reason">（不支持）</span>}
                </label>
              );
            })}
            {capabilityNote !== null && (
              <p data-testid="capability-note" className="text-[11px] text-ink-3">{capabilityNote}</p>
            )}
          </fieldset>

        </section>

        {/* ---- 工具 ---- */}
        <section data-testid="settings-section-tools" className="space-y-3 border-t border-hairline pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-3">工具</h3>
          <label className="block">
            <span className="mb-1 block text-xs text-ink-3">审批模式</span>
            <select
              data-testid="tools-approval-select"
              value={toolPolicy.approval_mode}
              onChange={(e) => {
                const next = { ...toolPolicy, approval_mode: e.target.value as ApprovalMode };
                setToolPolicy(next);
                schedulePatch('tool_policy', next);
                setError(null);
              }}
              className="w-full rounded border border-hairline bg-surface-card px-2 py-1 text-sm text-ink outline-none focus-visible:outline-2 focus-visible:outline-accent"
            >
              {APPROVAL_MODES.map((mode) => (
                <option key={mode} value={mode}>{APPROVAL_LABEL[mode]}</option>
              ))}
            </select>
          </label>
          <div>
            <span className="mb-1 block text-xs text-ink-3">允许的工具（allow）</span>
            <TagInput
              testId="tools-allow-input"
              values={toolPolicy.allow}
              onChange={(allow) => {
                const next = { ...toolPolicy, allow };
                setToolPolicy(next);
                schedulePatch('tool_policy', next);
                setError(null);
              }}
              placeholder="输入工具名后回车"
            />
          </div>
          <div>
            <span className="mb-1 block text-xs text-ink-3">禁止的工具（deny）</span>
            <TagInput
              testId="tools-deny-input"
              values={toolPolicy.deny}
              onChange={(deny) => {
                const next = { ...toolPolicy, deny };
                setToolPolicy(next);
                schedulePatch('tool_policy', next);
                setError(null);
              }}
              placeholder="输入工具名后回车"
            />
          </div>
          {caps !== null && !caps.toolFlags && (
            <p data-testid="tools-flag-note" className="text-[11px] text-ink-3">该 CLI 未探测到工具管控 flag，保存后不保证生效。</p>
          )}
        </section>

        {/* ---- 技能 ---- */}
        <section data-testid="settings-section-skills" className="space-y-3 border-t border-hairline pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-3">技能</h3>
          <p className="text-[11px] text-ink-3" data-testid="skills-storage-note">本阶段仅存储策略；技能物化在 P2 生效。</p>
          <div>
            <span className="mb-1 block text-xs text-ink-3">允许的技能（allow）</span>
            <TagInput
              testId="skills-allow-input"
              values={skillPolicy.allow}
              onChange={(allow) => {
                const next = { ...skillPolicy, allow };
                setSkillPolicy(next);
                schedulePatch('skill_policy', next);
                setError(null);
              }}
              placeholder="输入技能名后回车"
            />
          </div>
          <div>
            <span className="mb-1 block text-xs text-ink-3">禁止的技能（deny）</span>
            <TagInput
              testId="skills-deny-input"
              values={skillPolicy.deny}
              onChange={(deny) => {
                const next = { ...skillPolicy, deny };
                setSkillPolicy(next);
                schedulePatch('skill_policy', next);
                setError(null);
              }}
              placeholder="输入技能名后回车"
            />
          </div>
        </section>
      </div>
    </Modal>
  );
}
