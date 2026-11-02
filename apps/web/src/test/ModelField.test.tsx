/**
 * ModelField 模型选择字段（新建会话/修改模型弹窗共用）：
 * models 非空 → 真下拉（空值选项 + 模型列表 + 末尾"手动输入…"）；
 * 选手动输入切文本输入框（可"返回列表"回下拉）；models 空/查询失败/cliId 空 → 纯文本输入框；
 * CLI supportsModelSelection=false → 控件禁用 + "由 profile 配置决定"标注。
 */
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { useState } from 'react';
import { ModelField } from '../components/chat/ModelField';
import { server } from './server';

function Harness({ cliId, emptyOptionLabel }: { cliId: string; emptyOptionLabel?: string }) {
  const [value, setValue] = useState('');
  return (
    <ModelField
      cliId={cliId}
      value={value}
      onChange={setValue}
      testid="mf"
      ariaLabel="模型"
      emptyOptionLabel={emptyOptionLabel}
    />
  );
}

function renderField(cliId: string, emptyOptionLabel?: string): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Harness cliId={cliId} emptyOptionLabel={emptyOptionLabel} />
    </QueryClientProvider>,
  );
}

/** 等 models 查询返回且字段切换为下拉（models 非空场景；加载中先渲染输入框） */
async function findSelect(): Promise<HTMLSelectElement> {
  await waitFor(() => {
    const el = screen.getByTestId('mf');
    expect(el.tagName).toBe('SELECT');
  });
  return screen.getByTestId('mf') as HTMLSelectElement;
}

describe('ModelField', () => {
  it('models 非空 → 渲染 select：空值选项 + 模型列表 + 末尾"手动输入…"，选中模型 onChange', async () => {
    server.use(
      http.get('/api/clis/:id/models', () =>
        HttpResponse.json([
          { id: 'a/b', source: 'probed' },
          { id: 'c/d', source: 'static' },
        ]),
      ),
    );
    renderField('codebuddy', '（留空）');

    const select = await findSelect();
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(['', 'a/b', 'c/d', '__manual__']);
    expect(select.selectedOptions[0]).toHaveTextContent('（留空）');

    await userEvent.selectOptions(select, 'c/d');
    await waitFor(() => expect(select).toHaveValue('c/d'));
  });

  it('选"手动输入…"切文本输入框（可输入），"返回列表"回下拉', async () => {
    server.use(http.get('/api/clis/:id/models', () => HttpResponse.json([{ id: 'a/b', source: 'probed' }])));
    renderField('codebuddy', '（留空）');

    await userEvent.selectOptions(await findSelect(), '手动输入…');

    const input = screen.getByTestId('mf') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    await userEvent.type(input, 'mx-9');
    await waitFor(() => expect(input).toHaveValue('mx-9'));

    await userEvent.click(screen.getByTestId('mf-back'));
    const backToSelect = await findSelect();
    expect(backToSelect.tagName).toBe('SELECT');
    expect(screen.queryByTestId('mf-back')).not.toBeInTheDocument();
  });

  it('当前值不在模型列表 → 直接渲染输入框（保留手输值），"返回列表"回下拉', async () => {
    server.use(http.get('/api/clis/:id/models', () => HttpResponse.json([{ id: 'a/b', source: 'probed' }])));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ManualValueHarness />
      </QueryClientProvider>,
    );

    // 初值 m1 不在列表 → 输入框；等 models 返回（出现"返回列表"按钮）后仍是输入框
    await waitFor(() => expect(screen.getByTestId('mf-back')).toBeInTheDocument());
    const input = screen.getByTestId('mf') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveValue('m1');
    expect(screen.getByText('当前模型不在此 CLI 列表中')).toBeInTheDocument();
    // 在输入框清空/改写不弹回下拉（输入中保持输入框视图，同一 DOM 节点不被替换）
    await userEvent.clear(input);
    await userEvent.type(input, 'm2');
    expect(screen.getByTestId('mf')).toBe(input);
    expect(input).toHaveValue('m2');

    await userEvent.click(screen.getByTestId('mf-back'));
    const select = await findSelect();
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveValue('m2');
    expect(screen.getByRole('option', { name: 'm2（不在当前列表）' })).toBeInTheDocument();
  });

  it('模型列表延迟时允许先手输，返回后保留输入并标出当前值不在列表', async () => {
    let resolveResponse: (() => void) | undefined;
    const responseReady = new Promise<void>((resolve) => { resolveResponse = resolve; });
    server.use(
      http.get('/api/clis/:id/models', async () => {
        await responseReady;
        return HttpResponse.json([{ id: 'a/b', source: 'static' }]);
      }),
    );
    renderField('codebuddy');

    expect(await screen.findByText('正在加载模型列表，可先手动输入')).toBeInTheDocument();
    const input = screen.getByTestId('mf') as HTMLInputElement;
    await userEvent.type(input, 'custom/model');
    resolveResponse?.();

    await screen.findByTestId('mf-not-in-list');
    expect(screen.getByTestId('mf')).toBe(input);
    expect(input).toHaveValue('custom/model');
    expect(screen.getByText('当前模型不在此 CLI 列表中')).toBeInTheDocument();
  });

  it('models 为空 → 说明未返回模型并允许刷新与手输', async () => {
    let requests = 0;
    let requested = false;
    server.use(
      http.get('/api/clis/:id/models', () => {
        requested = true;
        requests += 1;
        return HttpResponse.json(requests === 1 ? [] : [{ id: 'a/b', source: 'static' }]);
      }),
    );
    renderField('codebuddy');

    await waitFor(() => expect(requested).toBe(true));
    expect(screen.getByText('当前 CLI 未返回模型，可手动输入')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('mf-refresh'));
    await findSelect();
    const input = screen.getByTestId('mf') as HTMLInputElement;
    expect(input.tagName).not.toBe('INPUT');
    expect(requests).toBe(2);
  });

  it('查询失败时说明错误并保留手输，刷新可恢复模型清单', async () => {
    let requests = 0;
    server.use(
      http.get('/api/clis/:id/models', () => {
        requests += 1;
        return requests === 1
          ? HttpResponse.json({ error: { code: 'INTERNAL', message: 'boom' } }, { status: 500 })
          : HttpResponse.json([{ id: 'a/b', source: 'static' }]);
      }),
    );
    renderField('codebuddy');

    expect(await screen.findByText('模型列表加载失败，可重试或手动输入')).toBeInTheDocument();
    const input = screen.getByTestId('mf') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    await userEvent.type(input, 'hand-written');
    expect(input).toHaveValue('hand-written');
    await userEvent.click(screen.getByTestId('mf-refresh'));
    await screen.findByTestId('mf-back');
    const select = await userEvent.click(screen.getByTestId('mf-back')).then(findSelect);
    expect(select).toHaveValue('hand-written');
    expect(requests).toBe(2);
  });

  it('cliId 为空 → 不拉 models，渲染纯文本输入框', async () => {
    const requests: string[] = [];
    server.use(
      http.get('/api/clis/:id/models', ({ params }) => {
        requests.push(String(params.id));
        return HttpResponse.json([{ id: 'a/b', source: 'probed' }]);
      }),
    );
    renderField('');

    const input = (await screen.findByTestId('mf')) as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    await new Promise((r) => setTimeout(r, 50));
    expect(requests).toEqual([]);
  });

  it('CLI supportsModelSelection=false（dsh）→ select 禁用 + 标注"由 profile 配置决定"，无手输入口', async () => {
    server.use(
      http.get('/api/clis', () =>
        HttpResponse.json([
          { id: 'dsh', displayName: 'DSH', installed: true, version: '0.2.4', supportsModelSelection: false },
        ]),
      ),
      http.get('/api/clis/:id/models', () =>
        HttpResponse.json([
          { id: 'deepseek-v4-flash', source: 'static' },
          { id: 'deepseek-v4-pro', source: 'static' },
        ]),
      ),
    );
    renderField('dsh', '（留空）');

    const select = await findSelect();
    expect(select).toBeDisabled();
    expect(screen.getByTestId('mf-readonly-hint')).toHaveTextContent('由 profile 配置决定');
    // 只读不提供"手动输入…"切换入口
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'deepseek-v4-flash', 'deepseek-v4-pro']);
  });

  it('CLI supportsModelSelection=false 且值不在清单 → 输入框禁用 + 同标注', async () => {
    server.use(
      http.get('/api/clis', () =>
        HttpResponse.json([
          { id: 'dsh', displayName: 'DSH', installed: true, version: '0.2.4', supportsModelSelection: false },
        ]),
      ),
      http.get('/api/clis/:id/models', () => HttpResponse.json([])),
    );
    renderField('dsh');

    // 等只读态生效：控件切到禁用输入框（clis 载入前先渲染可用输入框，随后被替换）
    await waitFor(() => {
      const el = screen.getByTestId('mf');
      expect(el.tagName).toBe('INPUT');
      expect(el).toBeDisabled();
    });
    expect(screen.getByTestId('mf-readonly-hint')).toHaveTextContent('由 profile 配置决定');
  });

  it('CLI supportsModelSelection=true → 行为不变：select 可用、无只读标注', async () => {
    server.use(
      http.get('/api/clis', () =>
        HttpResponse.json([
          { id: 'codebuddy', displayName: 'CodeBuddy', installed: true, version: '2.0.0', supportsModelSelection: true },
        ]),
      ),
      http.get('/api/clis/:id/models', () => HttpResponse.json([{ id: 'a/b', source: 'probed' }])),
    );
    renderField('codebuddy');

    const select = await findSelect();
    expect(select).not.toBeDisabled();
    expect(screen.queryByTestId('mf-readonly-hint')).not.toBeInTheDocument();
    await userEvent.selectOptions(select, 'a/b');
    await waitFor(() => expect(select).toHaveValue('a/b'));
  });
});

/** 初值不在模型列表的手动值场控（模拟修改模型弹窗打开即带旧值） */
function ManualValueHarness() {
  const [value, setValue] = useState('m1');
  return <ModelField cliId="codebuddy" value={value} onChange={setValue} testid="mf" ariaLabel="模型" />;
}
