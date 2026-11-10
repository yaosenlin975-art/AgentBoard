/**
 * 新建自由会话弹窗（设计 §7.5 顶部切换器"+ 新建会话"）：
 * CLI（未安装禁用）+ 模型（默认该 CLI 上次使用，可手输）+ 工作空间（自由会话 workspace_id 必填）
 * + 智能体人设（可选，默认不使用），
 * 确认 → POST /api/sessions {cli, model, workspace_id}（不带 issue_id / prompt，首条消息由输入框发起）；
 * 选了人设时紧接着 PATCH /api/sessions/:id {persona_id}（服务端 patchSessionSchema 校验人设存在）。
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CliInfo, Session, Workspace } from '@agentboard/shared';
import { api } from '../../api/client';
import { loadLastModel, saveLastModel } from '../../lib/dispatchTemplate';
import { usePanelStore } from '../../state/panelStore';
import { Modal } from '../ui/Modal';
import { ModelField } from './ModelField';
import type { PersonaSummary } from './SessionSettingsDialog';

const inputCls =
  'w-full rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-accent dark:border-neutral-700 dark:bg-neutral-800';

export function NewSessionDialog({
  defaultWorkspaceId,
  onClose,
}: {
  defaultWorkspaceId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const openChat = usePanelStore((s) => s.openChat);

  const [cliId, setCliId] = useState('');
  const [model, setModel] = useState('');
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId ?? '');
  const [personaId, setPersonaId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: clis } = useQuery({
    queryKey: ['clis'],
    queryFn: () => api.get<CliInfo[]>('/api/clis'),
  });
  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.get<Workspace[]>('/api/workspaces'),
  });
  // 人设与会话设置弹窗共用 queryKey（同一份缓存，无额外请求）
  const {
    data: personas,
    isPending: personasPending,
    isError: personasError,
    refetch: refetchPersonas,
  } = useQuery({
    queryKey: ['personas'],
    queryFn: () => api.get<PersonaSummary[]>('/api/personas'),
    staleTime: 30_000,
  });

  // CLI 默认第一个已安装项
  useEffect(() => {
    if (clis === undefined || cliId !== '') return;
    const first = clis.find((c) => c.installed);
    if (first !== undefined) setCliId(first.id);
  }, [clis, cliId]);

  // 切 CLI：模型回该 CLI 上次使用值（localStorage），无则清空
  useEffect(() => {
    if (cliId === '') return;
    setModel(loadLastModel(cliId) ?? '');
  }, [cliId]);

  const create = useMutation({
    mutationFn: async () => {
      const session = await api.post<Session>('/api/sessions', {
        cli: cliId,
        model: model.trim() === '' ? null : model.trim(),
        workspace_id: workspaceId,
      });
      if (personaId !== '') {
        await api.patch<Session>(`/api/sessions/${session.id}`, { persona_id: personaId });
      }
      return session;
    },
    onSuccess: async (session) => {
      const m = model.trim();
      if (m !== '') saveLastModel(cliId, m);
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
      onClose();
      openChat(session.id, session);
    },
    onError: (e) => setError(e instanceof Error ? e.message : '创建失败'),
  });

  const canSubmit = cliId !== '' && workspaceId !== '' && !create.isPending;

  return (
    <Modal open title="新建会话" onClose={onClose}>
      <div className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-300">CLI</span>
          <select
            data-testid="ns-cli"
            aria-label="CLI"
            value={cliId}
            onChange={(e) => setCliId(e.target.value)}
            className={inputCls}
          >
            <option value="" disabled>
              选择 CLI
            </option>
            {(clis ?? []).map((c) => (
              <option key={c.id} value={c.id} disabled={!c.installed}>
                {c.displayName}
                {c.installed ? '' : '（未安装）'}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-300">模型（可留空）</span>
          <ModelField
            cliId={cliId}
            value={model}
            onChange={setModel}
            testid="ns-model"
            placeholder="输入模型 id"
            ariaLabel="模型"
            emptyOptionLabel="（留空）"
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-300">工作空间（必填）</span>
          <select
            data-testid="ns-workspace"
            aria-label="工作空间"
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            className={inputCls}
          >
            <option value="" disabled>
              选择工作空间
            </option>
            {(workspaces ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>

        <div className="block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-300">智能体人设（可选）</span>
          {personasPending ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">人设加载中…</p>
          ) : personasError ? (
            <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
              <span>人设加载失败</span>
              <button
                type="button"
                data-testid="ns-persona-retry"
                onClick={() => void refetchPersonas()}
                className="rounded border border-neutral-300 px-2 py-0.5 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                重试
              </button>
            </div>
          ) : (personas ?? []).length === 0 ? (
            <p data-testid="ns-persona-empty" className="text-xs text-neutral-500 dark:text-neutral-400">
              暂无人设，可只设置工具/技能。
            </p>
          ) : (
            <select
              data-testid="ns-persona"
              aria-label="智能体人设"
              value={personaId}
              onChange={(e) => setPersonaId(e.target.value)}
              className={inputCls}
            >
              <option value="">不使用人设（默认）</option>
              {(personas ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.source === 'builtin' ? '（内置）' : ''}
                </option>
              ))}
            </select>
          )}
        </div>

        {error !== null && (
          <p data-testid="ns-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="ns-confirm"
            onClick={() => {
              setError(null);
              create.mutate();
            }}
            disabled={!canSubmit}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {create.isPending ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
