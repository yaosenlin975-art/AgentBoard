/**
 * ModelField 模型选择字段（新建会话/修改模型弹窗共用）：
 * models 非空 → 真下拉（空值选项 + 模型列表 + 末尾"手动输入…"）；
 * 选手动输入切文本输入框（可"返回列表"回下拉）；models 空/查询失败/cliId 空 → 纯文本输入框。
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
    // 在输入框清空/改写不弹回下拉（输入中保持输入框视图，同一 DOM 节点不被替换）
    await userEvent.clear(input);
    await userEvent.type(input, 'm2');
    expect(screen.getByTestId('mf')).toBe(input);
    expect(input).toHaveValue('m2');

    await userEvent.click(screen.getByTestId('mf-back'));
    expect((await findSelect()).tagName).toBe('SELECT');
  });

  it('models 为空 → 纯文本输入框（无返回按钮，可输入）', async () => {
    let requested = false;
    server.use(
      http.get('/api/clis/:id/models', () => {
        requested = true;
        return HttpResponse.json([]);
      }),
    );
    renderField('codebuddy');

    await waitFor(() => expect(requested).toBe(true));
    const input = screen.getByTestId('mf') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    expect(screen.queryByTestId('mf-back')).not.toBeInTheDocument();
    await userEvent.type(input, 'hand-written');
    expect(input).toHaveValue('hand-written');
  });

  it('查询失败 → 纯文本输入框（现状行为兜底）', async () => {
    let requested = false;
    server.use(
      http.get('/api/clis/:id/models', () => {
        requested = true;
        return HttpResponse.json({ error: { code: 'INTERNAL', message: 'boom' } }, { status: 500 });
      }),
    );
    renderField('codebuddy');

    await waitFor(() => expect(requested).toBe(true));
    const input = screen.getByTestId('mf') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    expect(screen.queryByTestId('mf-back')).not.toBeInTheDocument();
    await userEvent.type(input, 'hand-written');
    expect(input).toHaveValue('hand-written');
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
});

/** 初值不在模型列表的手动值场控（模拟修改模型弹窗打开即带旧值） */
function ManualValueHarness() {
  const [value, setValue] = useState('m1');
  return <ModelField cliId="codebuddy" value={value} onChange={setValue} testid="mf" ariaLabel="模型" />;
}
