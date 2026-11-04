/**
 * FOLDER-PICK：数据存储分区的「选择…」按钮（接服务端原生目录选择端点）。
 *
 * 覆盖：成功填绝对路径、用户取消（null）不改输入不报错、请求期间按钮禁用 + 文案「选择中…」、
 * 失败时原样展示服务端中文原因、env 覆盖态按钮禁用、375 窄屏下按钮不与输入框重叠（换行）。
 *
 * 端点两侧都走 msw：`GET /api/settings/storage` 提供最小可渲染数据，`POST /api/system/pick-folder` 控制返回值。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { StorageSection } from '../components/settings/StorageSection';
import { server } from './server';
import { STORAGE_INFO_FIXTURE, pickHandler } from './folderPickFixture';

const renderSection = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StorageSection />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  server.use(
    http.get('/api/settings/storage', () => HttpResponse.json(STORAGE_INFO_FIXTURE)),
    pickHandler(null),
  );
});

describe('FOLDER-PICK 选择…按钮', () => {
  it('成功：把返回的绝对路径填进输入框，并触发既有校验（不再显示校验错误）', async () => {
    server.use(pickHandler('D:\\AgentBoard\\agentboard.db'));
    renderSection();
    const input = (await screen.findByTestId('settings-storage-target')) as HTMLInputElement;
    fireEvent.click(screen.getByTestId('settings-storage-pick'));
    await waitFor(() => expect(input.value).toBe('D:\\AgentBoard\\agentboard.db'));
    expect(screen.queryByTestId('settings-storage-pick-error')).toBeNull();
    expect(screen.queryByTestId('settings-storage-validation')).toBeNull();
  });

  it('取消（服务端 path=null）：不改输入、不报错', async () => {
    server.use(pickHandler(null));
    renderSection();
    const input = (await screen.findByTestId('settings-storage-target')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'D:\\keep\\agentboard.db' } });
    fireEvent.click(screen.getByTestId('settings-storage-pick'));
    await waitFor(() => expect(input.value).toBe('D:\\keep\\agentboard.db'));
    expect(screen.queryByTestId('settings-storage-pick-error')).toBeNull();
  });

  it('请求期间：按钮禁用 + 文案「选择中…」+ aria-busy', async () => {
    let release: (value: string | null) => void = () => {};
    server.use(http.post('/api/system/pick-folder', () => new Promise((resolve) => {
      release = (value) => resolve(HttpResponse.json({ path: value }));
    })));
    renderSection();
    const button = await screen.findByTestId('settings-storage-pick');
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveTextContent('选择中…');
    expect(button).toHaveAttribute('aria-busy', 'true');
    release(null);
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it('失败：原样展示服务端中文原因（不吞）', async () => {
    server.use(http.post('/api/system/pick-folder', () => HttpResponse.json(
      { error: { code: 'PICK_FOLDER_FAILED', message: '打开文件夹选择窗口失败: PowerShell 不可用' } },
      { status: 500 },
    )));
    renderSection();
    fireEvent.click(await screen.findByTestId('settings-storage-pick'));
    const error = await screen.findByTestId('settings-storage-pick-error');
    expect(error).toHaveTextContent('打开文件夹选择窗口失败');
  });

  it('env 覆盖态：按钮与输入框一起禁用', async () => {
    server.use(http.get('/api/settings/storage', () => HttpResponse.json({ ...STORAGE_INFO_FIXTURE, db_path_source: 'env' })));
    renderSection();
    expect(await screen.findByTestId('settings-storage-pick')).toBeDisabled();
    expect(screen.getByTestId('settings-storage-target')).toBeDisabled();
  });
});
