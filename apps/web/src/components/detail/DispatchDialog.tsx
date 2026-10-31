/**
 * 派发设置弹窗（§5.2）：
 * - CLI select：未安装项禁用标"未安装"，默认第一个已安装；
 * - 模型：select（默认该 CLI 上次使用的模型，localStorage 记录，无则第一项）+ 手输切换（datalist）；
 * - 会话选择：该 issue 有历史会话时单选——新建（默认）/ 续用最近（reuse_session:'last'）；
 * - prompt textarea 预填前端渲染后的默认模板全文（历史备注段由后端 dispatch.ts 自动追加，弹窗内只读提示）；
 * - 确认 → POST /api/sessions {cli, model, issue_id, prompt, reuse_session} → openChat 切聊天视图。
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CliInfo, Issue, ModelInfo, Session } from '@agentboard/shared';
import { api } from '../../api/client';
import { Modal } from '../ui/Modal';
import {
  DISPATCH_PROMPT_TEMPLATE,
  loadLastModel,
  renderDispatchPrompt,
  saveLastModel,
} from '../../lib/dispatchTemplate';
import { usePanelStore } from '../../state/panelStore';

const inputCls =
  'w-full rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-800';

export function DispatchDialog({
  issue,
  workspacePath,
  onClose,
}: {
  issue: Issue;
  workspacePath: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const openChat = usePanelStore((s) => s.openChat);

  const [cliId, setCliId] = useState('');
  const [model, setModel] = useState('');
  const [manual, setManual] = useState(false);
  const [reuse, setReuse] = useState<'new' | 'last'>('new');
  // 打开时预填渲染后的默认模板全文；此后用户编辑即整体替换（后端仍渲染 4 变量 + 追加历史备注）
  const [prompt, setPrompt] = useState(() =>
    renderDispatchPrompt(DISPATCH_PROMPT_TEMPLATE, {
      issue_id: issue.id,
      title: issue.title,
      description: issue.description,
      workspace_path: workspacePath,
    }),
  );
  const [error, setError] = useState<string | null>(null);

  const { data: clis } = useQuery({
    queryKey: ['clis'],
    queryFn: () => api.get<CliInfo[]>('/api/clis'),
  });
  const { data: models } = useQuery({
    queryKey: ['clis', cliId, 'models'],
    queryFn: () => api.get<ModelInfo[]>(`/api/clis/${cliId}/models`),
    enabled: cliId !== '',
  });
  const { data: allSessions } = useQuery({
    queryKey: ['sessions', issue.workspace_id],
    queryFn: () => api.get<Session[]>(`/api/sessions?workspace=${encodeURIComponent(issue.workspace_id)}`),
  });
  const issueSessions = (allSessions ?? []).filter((s) => s.issue_id === issue.id);

  const modelTouchedRef = useRef(false);

  // CLI 默认第一个已安装项
  useEffect(() => {
    if (clis === undefined) return;
    if (cliId !== '') return;
    const firstInstalled = clis.find((c) => c.installed);
    if (firstInstalled !== undefined) setCliId(firstInstalled.id);
  }, [clis, cliId]);

  // 切换 CLI：重置模型与手输态
  useEffect(() => {
    if (cliId === '') return;
    setModel('');
    setManual(false);
    modelTouchedRef.current = false;
  }, [cliId]);

  // 默认模型：上次使用（在清单内），否则第一项；用户已手动选择/输入则不覆盖
  useEffect(() => {
    if (cliId === '' || models === undefined || modelTouchedRef.current || model !== '') return;
    const last = loadLastModel(cliId);
    const restored = last !== null && models.some((m) => m.id === last) ? last : (models[0]?.id ?? '');
    if (restored !== '') setModel(restored);
  }, [cliId, models, model]);

  const changeModel = (value: string): void => {
    modelTouchedRef.current = true;
    setModel(value);
  };

  const dispatch = useMutation({
    mutationFn: () =>
      api.post<Session>('/api/sessions', {
        cli: cliId,
        model: model.trim() === '' ? null : model.trim(),
        issue_id: issue.id,
        prompt,
        reuse_session: reuse,
      }),
    onSuccess: async (session) => {
      const m = model.trim();
      if (m !== '') saveLastModel(cliId, m);
      void queryClient.invalidateQueries({ queryKey: ['issues'] });
      void queryClient.invalidateQueries({ queryKey: ['issue', issue.id] });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      onClose();
      openChat(session.id);
    },
    onError: (e) => setError(e instanceof Error ? e.message : '派发失败'),
  });

  const modelIds = (models ?? []).map((m) => m.id);
  const selectOptions =
    model !== '' && !modelIds.includes(model) ? [model, ...modelIds] : modelIds;

  const submit = (): void => {
    if (dispatch.isPending || cliId === '') return;
    setError(null);
    dispatch.mutate();
  };

  return (
    <Modal open title="派发设置" onClose={onClose}>
      <div className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-300">CLI</span>
          <select
            data-testid="cli-select"
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

        <div className="text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-300">模型</span>
          <div className="flex items-center gap-2">
            {manual ? (
              <input
                data-testid="model-manual-input"
                aria-label="模型（手动输入）"
                list="dispatch-model-options"
                value={model}
                onChange={(e) => changeModel(e.target.value)}
                placeholder="输入模型 id"
                className={inputCls}
              />
            ) : (
              <select
                data-testid="model-select"
                aria-label="模型"
                value={model}
                onChange={(e) => changeModel(e.target.value)}
                disabled={cliId === '' || modelIds.length === 0}
                className={inputCls}
              >
                {modelIds.length === 0 && <option value="">（无可用模型，可手输）</option>}
                {selectOptions.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            )}
            <label className="flex shrink-0 items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              <input
                type="checkbox"
                data-testid="model-mode-toggle"
                checked={manual}
                onChange={(e) => setManual(e.target.checked)}
              />
              手输
            </label>
          </div>
          <datalist id="dispatch-model-options">
            {modelIds.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </div>

        {issueSessions.length > 0 && (
          <fieldset className="text-sm">
            <legend className="mb-1 text-neutral-600 dark:text-neutral-300">会话</legend>
            <div data-testid="reuse-group" className="flex flex-col gap-1">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="reuse-session"
                  value="new"
                  checked={reuse === 'new'}
                  onChange={() => setReuse('new')}
                />
                新建会话（默认，干净上下文）
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="reuse-session"
                  value="last"
                  checked={reuse === 'last'}
                  onChange={() => setReuse('last')}
                />
                续用最近会话（保留 agent 已有进度）
              </label>
            </div>
          </fieldset>
        )}

        <label className="block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-300">Prompt 模板</span>
          <textarea
            data-testid="dispatch-prompt"
            aria-label="Prompt 模板"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={12}
            className={`${inputCls} font-mono text-xs`}
          />
          <span data-testid="history-note" className="mt-1 block text-xs text-neutral-400 dark:text-neutral-500">
            历史备注（后端自动追加，最近10条）
          </span>
        </label>

        {error !== null && (
          <p role="alert" data-testid="dispatch-error" className="text-sm text-red-600 dark:text-red-400">
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
            data-testid="dispatch-confirm"
            onClick={submit}
            disabled={cliId === '' || dispatch.isPending}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {dispatch.isPending ? '派发中…' : '确认派发'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
