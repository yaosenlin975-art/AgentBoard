/**
 * 契约：fixture 必须使用服务端真实字段名（bytes_total / downloaded_bytes）——
 * 曾经因为 fixture 用自造的 total_bytes/bytes_estimate，导致字段名不一致的 bug 测试全绿。
 * VOICE-4 用例：设置页语音分区（开关默认关 + 未下载模型时不可用 + 模型列表/下载/删除/占用空间/检测麦克风）。
 * 服务端 /api/voice/models* 用 msw mock，不下载任何真实模型。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { VoiceSection } from '../components/settings/VoiceSection';
import { VOICE_SETTINGS_KEY } from '../lib/voice/settings';
import { server } from './server';

const MODEL_A = {
  id: 'zipformer-zh-en',
  name: 'Zipformer 中英双语（流式，int8）',
  languages: ['zh', 'en'],
  streaming: true,
  note: '推荐默认项',
  state: 'not_downloaded' as const,
  downloaded_bytes: 0,
  bytes_total: 186_000_000,
  error_message: null,
};
const MODEL_B = {
  ...MODEL_A,
  id: 'paraformer-zh',
  name: 'Paraformer 中文（非流式，int8）',
  languages: ['zh'],
  streaming: false,
  bytes_total: 216_800_000,
};

function renderSection(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <VoiceSection />
    </QueryClientProvider>,
  );
}

function mockModels(models: Array<Record<string, unknown>>): void {
  server.use(http.get('/api/voice/models', () => HttpResponse.json({ models })));
}

beforeEach(() => {
  localStorage.clear();
});

describe('设置页语音分区（VOICE-4）', () => {
  it('未下载模型：开关禁用 + 可操作提示 + 占用 0 B', async () => {
    mockModels([MODEL_A, MODEL_B]);
    renderSection();
    expect(await screen.findByTestId('voice-model-zipformer-zh-en')).toBeInTheDocument();
    expect(screen.getByTestId('voice-enabled')).toBeDisabled();
    expect(screen.getByTestId('voice-needs-model')).toHaveTextContent('先在下面的列表里下载一个模型');
    expect(screen.getByTestId('voice-used-space')).toHaveTextContent('已占用 0 B');
  });

  it('默认关闭；已下载后可开启并持久化到 localStorage', async () => {
    mockModels([{ ...MODEL_A, state: 'downloaded', downloaded_bytes: MODEL_A.bytes_total }]);
    renderSection();
    await waitFor(() => expect(screen.getByTestId('voice-enabled')).toBeEnabled());
    expect(screen.getByTestId('voice-enabled')).not.toBeChecked();
    await userEvent.click(screen.getByTestId('voice-enabled'));
    expect(JSON.parse(localStorage.getItem(VOICE_SETTINGS_KEY) ?? '{}')).toMatchObject({ enabled: true, modelId: 'zipformer-zh-en' });
    expect(screen.getByTestId('voice-used-space')).toHaveTextContent('177.4 MB');
  });

  it('下载触发 POST，进行中显示进度条，完成后可删除', async () => {
    let state: 'not_downloaded' | 'downloading' | 'downloaded' = 'not_downloaded';
    let downloadedBytes = 0;
    const posted: string[] = [];
    server.use(
      http.get('/api/voice/models', () =>
        HttpResponse.json({
          models: [{ ...MODEL_A, state, downloaded_bytes: downloadedBytes, bytes_total: MODEL_A.bytes_total }],
        }),
      ),
      http.post('/api/voice/models/:id/download', ({ params }) => {
        posted.push(String(params.id));
        state = 'downloading';
        downloadedBytes = MODEL_A.bytes_total / 2;
        return HttpResponse.json({ accepted: true }, { status: 202 });
      }),
      http.delete('/api/voice/models/:id', () => {
        state = 'not_downloaded';
        downloadedBytes = 0;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderSection();
    await userEvent.click(await screen.findByTestId('voice-download-zipformer-zh-en'));
    await waitFor(() => expect(posted).toEqual(['zipformer-zh-en']));
    const bar = await screen.findByTestId('voice-progress-zipformer-zh-en');
    expect(bar).toHaveAttribute('data-width', '50');
  });

  it('真实响应形状（bytes_total/downloaded_bytes）→ 占用、每模型体积、百分比三处都不为 0', async () => {
    // 数字取服务端实测形状：bytes_total 用 198270793（≈189.1 MB）
    const DONE = { ...MODEL_A, id: 'real-done', state: 'downloaded' as const, bytes_total: 198_270_793, downloaded_bytes: 198_270_793 };
    const HALF = { ...MODEL_A, id: 'real-half', name: '流式半程模型', state: 'downloading' as const, bytes_total: 198_270_793, downloaded_bytes: 99_135_396 };
    mockModels([DONE, HALF]);
    renderSection();

    // ① 占用合计：只统计已下载模型 → 189.1 MB（不再 0 B）
    const used = await screen.findByTestId('voice-used-space');
    await waitFor(() => expect(used).toHaveTextContent('已占用 189.1 MB'));
    expect(used).not.toHaveTextContent('已占用 0 B');

    // ② 每模型体积：读 bytes_total（否则 undefined → 「约 0 B」）
    expect(screen.getAllByText(/约 189\.1 MB/).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/约 0 B/)).toBeNull();

    // ③ 百分比：downloaded_bytes / bytes_total = 50%（进度条 + 文案都要读 bytes_total）
    const bar = screen.getByTestId('voice-progress-real-half');
    expect(bar).toHaveAttribute('data-width', '50');
    expect(screen.getByText(/\/ .*（50%）/)).toBeInTheDocument();
  });
  it('已下载的模型可删除：DELETE 后回到「未下载」并释放占用', async () => {
    let state: 'not_downloaded' | 'downloaded' = 'downloaded';
    let downloadedBytes = MODEL_A.bytes_total;
    const deleted: string[] = [];
    server.use(
      http.get('/api/voice/models', () =>
        HttpResponse.json({ models: [{ ...MODEL_A, state, downloaded_bytes: downloadedBytes, bytes_total: MODEL_A.bytes_total }] }),
      ),
      http.delete('/api/voice/models/:id', ({ params }) => {
        deleted.push(String(params.id));
        state = 'not_downloaded';
        downloadedBytes = 0;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderSection();
    await userEvent.click(await screen.findByTestId('voice-delete-zipformer-zh-en'));
    await waitFor(() => expect(deleted).toEqual(['zipformer-zh-en']));
    await waitFor(() => expect(screen.getByTestId('voice-download-zipformer-zh-en')).toBeInTheDocument());
    expect(screen.getByTestId('voice-used-space')).toHaveTextContent('已占用 0 B');
  });

  it('语言切换写入 localStorage；检测麦克风成功/失败各给文案', async () => {
    mockModels([{ ...MODEL_A, state: 'downloaded', downloaded_bytes: MODEL_A.bytes_total }]);
    renderSection();
    await userEvent.click(await screen.findByTestId('voice-language-zh'));
    expect(JSON.parse(localStorage.getItem(VOICE_SETTINGS_KEY) ?? '{}')).toMatchObject({ language: 'zh-CN' });

    const stop = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }) },
    });
    await userEvent.click(screen.getByTestId('voice-check-mic'));
    expect(await screen.findByTestId('voice-mic-result')).toHaveTextContent('麦克风可用');
    expect(stop).toHaveBeenCalled();

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) },
    });
    await userEvent.click(screen.getByTestId('voice-check-mic'));
    await waitFor(() => expect(screen.getByTestId('voice-mic-result')).toHaveTextContent('麦克风权限被拒绝'));
  });
});
