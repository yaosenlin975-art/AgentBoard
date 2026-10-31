/**
 * 新建自由会话弹窗（设计 §7.5 顶部切换器"+ 新建会话"）：
 * CLI（未安装禁用）+ 模型（默认该 CLI 上次使用，可手输）+ 工作空间（自由会话 workspace_id 必填），
 * 确认 → POST /api/sessions {cli, model, workspace_id}（不带 issue_id / prompt，首条消息由输入框发起）。
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CliInfo, ModelInfo, Session, Workspace } from '@agentboard/shared';
import { api } from '../../api/client';
import { loadLastModel, saveLastModel } from '../../lib/dispatchTemplate';
import { usePanelStore } from '../../state/panelStore';
import { Modal } from '../ui/Modal';

const inputCls =
  'w-full rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-800';

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
  const [error, setError] = useState<string | null>(null);

  const { data: clis } = useQuery({
    queryKey: ['clis'],
    queryFn: () => api.get<CliInfo[]>('/api/clis'),
  });
  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.get<Workspace[]>('/api/workspaces'),
  });
  const { data: models } = useQuery({
    queryKey: ['clis', cliId, 'models'],
    queryFn: () => api.get<ModelInfo[]>(`/api/clis/${cliId}/models`),
    enabled: cliId !== '',
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
    mutationFn: () =>
      api.post<Session>('/api/sessions', {
        cli: cliId,
        model: model.trim() === '' ? null : model.trim(),
        workspace_id: workspaceId,
      }),
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
          <input
            data-testid="ns-model"
            aria-label="模型"
            list="ns-model-options"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="输入模型 id"
            className={inputCls}
          />
          <datalist id="ns-model-options">
            {(models ?? []).map((m) => (
              <option key={m.id} value={m.id} />
            ))}
          </datalist>
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
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {create.isPending ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
