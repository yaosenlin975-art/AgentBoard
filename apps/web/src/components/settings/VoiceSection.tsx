/**
 * 设置 → 语音输入（VOICE-4）。
 *
 * 交互：总开关（默认关）、语言（跟随系统 / 手动）、模型列表（名称 / 体积 / 状态 / 下载 / 进度 / 删除）、
 * 占用空间合计、「检测麦克风」。未下载任何模型时总开关不可用并给出可操作提示（引导去下载）。
 *
 * 持久化：开关/语言/所选模型写 localStorage `agentboard.voice`（见 lib/voice/settings.ts 头注）；
 * 模型文件在服务端 `<data>/models`，本组件只通过 `/api/voice/models*` 读状态与触发下载。
 * 下载进度用 `?poll=1` 轮询（1s，仅在 downloading 时），不引入 SSE 依赖。
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { VOICE_ERROR_TEXT, type VoiceErrorCode } from '../../lib/voice/contract';
import { useVoiceSettings } from '../voice/useLongPressVoice';

interface VoiceModelState {
  id: string;
  name: string;
  languages: string[];
  streaming: boolean;
  note: string;

  state: 'not_downloaded' | 'downloading' | 'downloaded' | 'failed';
  downloaded_bytes: number;
  bytes_total: number;
  error_message: string | null;
}

interface VoiceModelsResponse {
  models: VoiceModelState[];
  /** VOICE-DL-FAIL：服务端只读探测结果（是否检测到代理，绝不含凭据） */
  download_env?: { proxy_detected: boolean; proxy_var: string | null; proxy_host: string | null };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const STATE_LABEL: Record<VoiceModelState['state'], string> = {
  not_downloaded: '未下载',
  downloading: '下载中',
  downloaded: '已下载',
  failed: '下载失败',
};

const chip = 'rounded-md border border-hairline px-2.5 py-1 text-xs';
const chipActive = 'border-transparent bg-accent-soft font-medium text-accent';

export function VoiceSection() {
  const queryClient = useQueryClient();
  const { settings, update } = useVoiceSettings();
  const [micState, setMicState] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [micMessage, setMicMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const modelsQuery = useQuery({
    queryKey: ['voice-models'],
    queryFn: () => api.get<VoiceModelsResponse>('/api/voice/models'),
    refetchInterval: (query) => {
      const data = query.state.data as VoiceModelsResponse | undefined;
      return data?.models.some((m) => m.state === 'downloading') === true ? 1000 : false;
    },
  });

  const models = modelsQuery.data?.models ?? [];
  const downloaded = models.filter((m) => m.state === 'downloaded');
  const usedBytes = downloaded.reduce((sum, m) => sum + (m.bytes_total || 0), 0);
  const anyDownloaded = downloaded.length > 0;

  // 未下载模型时总开关不可用；已下载但所选模型被删 → 回落第一个已下载模型
  useEffect(() => {
    if (!anyDownloaded) return;
    const exists = downloaded.some((m) => m.id === settings.modelId);
    const first = downloaded[0];
    if (!exists && first !== undefined) update({ modelId: first.id });
  }, [anyDownloaded, downloaded, settings.modelId, update]);

  const download = useMutation({
    mutationFn: (id: string) => api.post<unknown>(`/api/voice/models/${encodeURIComponent(id)}/download`, {}),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: ['voice-models'] });
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : '下载失败'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del<unknown>(`/api/voice/models/${encodeURIComponent(id)}`),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: ['voice-models'] });
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : '删除失败'),
  });

  const checkMic = async (): Promise<void> => {
    setMicState('checking');
    setMicMessage(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setMicState('ok');
      setMicMessage('麦克风可用');
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      const code: VoiceErrorCode = name === 'NotAllowedError' || name === 'SecurityError' ? 'VOICE_PERMISSION_DENIED' : 'VOICE_NO_DEVICE';
      setMicState('error');
      setMicMessage(VOICE_ERROR_TEXT[code]);
    }
  };

  return (
    <section data-testid="settings-voice" className="space-y-3 rounded-lg border border-hairline p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-ink">语音输入</h3>
          <p className="text-xs text-ink-3">长按输入框 400ms 说话，松手插入光标处；全部在本地识别，不联网。</p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="voice-enabled"
            aria-label="启用语音输入"
            checked={settings.enabled}
            disabled={!anyDownloaded}
            onChange={(e) => update({ enabled: e.target.checked })}
            className="h-4 w-4 accent-[var(--ab-accent)]"
          />
          <span className={anyDownloaded ? 'text-ink' : 'text-ink-3'}>启用</span>
        </label>
      </div>

      {!anyDownloaded && (
        <p data-testid="voice-needs-model" className="rounded-md bg-surface-raised px-2.5 py-2 text-xs text-ink-2">
          还没有可用模型，长按不会录音。先在下面的列表里下载一个模型（中英混说推荐第一个），下载完成后开关可用。
        </p>
      )}

      <div className="text-sm">
        <span className="mb-1 block text-xs text-ink-3">语言</span>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="voice-language-system"
            aria-pressed={settings.language === 'system'}
            onClick={() => update({ language: 'system' })}
            className={`${chip} ${settings.language === 'system' ? chipActive : 'text-ink-2 hover:bg-surface-raised'}`}
          >
            跟随系统（{typeof navigator === 'undefined' ? 'zh-CN' : navigator.language}）
          </button>
          <button
            type="button"
            data-testid="voice-language-zh"
            aria-pressed={settings.language === 'zh-CN'}
            onClick={() => update({ language: 'zh-CN' })}
            className={`${chip} ${settings.language === 'zh-CN' ? chipActive : 'text-ink-2 hover:bg-surface-raised'}`}
          >
            中文
          </button>
          <button
            type="button"
            data-testid="voice-language-en"
            aria-pressed={settings.language === 'en-US'}
            onClick={() => update({ language: 'en-US' })}
            className={`${chip} ${settings.language === 'en-US' ? chipActive : 'text-ink-2 hover:bg-surface-raised'}`}
          >
            English
          </button>
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-xs text-ink-3">模型</span>
          <span data-testid="voice-used-space" className="tabular-nums text-xs text-ink-3">
            已占用 {formatBytes(usedBytes)}
          </span>
        </div>
        {modelsQuery.isError && <p className="text-xs text-red-600 dark:text-red-400">读取模型列表失败（服务端语音能力可能未启用）</p>}
        <ul className="space-y-2">
          {models.map((model) => {
            const selected = settings.modelId === model.id;
            const percent = model.bytes_total > 0 ? Math.min(100, Math.round((model.downloaded_bytes / model.bytes_total) * 100)) : 0;
            return (
              <li key={model.id} data-testid={`voice-model-${model.id}`} className="rounded-md border border-hairline p-2">
                <div className="flex items-start justify-between gap-2">
                  <label className="flex min-w-0 items-start gap-2">
                    <input
                      type="radio"
                      name="voice-model"
                      data-testid={`voice-model-select-${model.id}`}
                      aria-label={`选择模型 ${model.name}`}
                      checked={selected}
                      disabled={model.state !== 'downloaded'}
                      onChange={() => update({ modelId: model.id })}
                      className="mt-0.5 h-3.5 w-3.5 accent-[var(--ab-accent)]"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-ink">{model.name}</span>
                      <span className="block text-xs text-ink-3">
                        {model.languages.join('/')} · {model.streaming ? '流式' : '非流式'} · 约 {formatBytes(model.bytes_total)} · {STATE_LABEL[model.state]}
                      </span>
                    </span>
                  </label>
                  <div className="flex shrink-0 items-center gap-2">
                    {model.state !== 'downloaded' && model.state !== 'downloading' && (
                      <button
                        type="button"
                        data-testid={`voice-download-${model.id}`}
                        onClick={() => download.mutate(model.id)}
                        disabled={download.isPending}
                        className={`${chip} text-ink hover:bg-surface-raised disabled:opacity-40`}
                      >
                        {/* 失败后重试只补没下完的文件（服务端按 .part 续传，已就绪的文件跳过） */}
                        {model.state === 'failed' ? '重试' : '下载'}
                      </button>
                    )}
                    {model.state === 'downloaded' && (
                      <button
                        type="button"
                        data-testid={`voice-delete-${model.id}`}
                        onClick={() => remove.mutate(model.id)}
                        disabled={remove.isPending}
                        className={`${chip} text-ink-2 hover:bg-surface-raised disabled:opacity-40`}
                      >
                        删除
                      </button>
                    )}
                  </div>
                </div>
                {model.state === 'downloading' && (
                  <div className="mt-2">
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface-raised">
                      <div data-testid={`voice-progress-${model.id}`} data-width={percent} style={{ width: `${percent}%` }} className="h-full rounded-full bg-accent" />
                    </div>
                    <p className="mt-1 tabular-nums text-xs text-ink-3">
                      {formatBytes(model.downloaded_bytes)} / {formatBytes(model.bytes_total)}（{percent}%）
                    </p>
                  </div>
                )}
                {model.error_message !== null && (
                  <div className="mt-1 space-y-1">
                    <p data-testid={`voice-error-${model.id}`} className="text-xs text-red-600 dark:text-red-400">{model.error_message}</p>
                    {/* VOICE-DL-FAIL：只在确实没检测到代理时提示，不猜用户网络 */}
                    {modelsQuery.data?.download_env !== undefined && !modelsQuery.data.download_env.proxy_detected && (
                      <p data-testid="voice-proxy-hint" className="text-xs text-ink-3">
                        未检测到 HTTP(S)_PROXY：访问 HuggingFace 通常需要代理；配好代理并重启服务后点「重试」，会从已下载的位置续传。
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-xs text-ink-3">模型由你手动下载，不会自动拉取；删除后释放占用空间。</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="voice-check-mic"
          onClick={() => void checkMic()}
          disabled={micState === 'checking'}
          className={`${chip} text-ink hover:bg-surface-raised disabled:opacity-40`}
        >
          检测麦克风
        </button>
        {micMessage !== null && (
          <span
            data-testid="voice-mic-result"
            role="status"
            className={`text-xs ${micState === 'ok' ? 'text-ink-2' : 'text-red-600 dark:text-red-400'}`}
          >
            {micMessage}
          </span>
        )}
        {micState === 'checking' && <span className="text-xs text-ink-3">检测中…</span>}
      </div>

      {actionError !== null && (
        <p role="alert" data-testid="voice-action-error" className="text-xs text-red-600 dark:text-red-400">
          {actionError}
        </p>
      )}
    </section>
  );
}
