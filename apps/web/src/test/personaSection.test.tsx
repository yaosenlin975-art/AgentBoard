/**
 * PERSONA-LIB-2：设置页「智能体人设」一节。
 * 覆盖：三来源列表与 builtin 禁改删、新建落库、删除二次确认、导入成功与 409、
 * 智能创建三态（生成中可取消 / 成功进结构化草稿并拼 body_md / 失败原地重试）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { PersonaSection } from '../components/settings/PersonaSection';
import { useAppStore } from '../state/appStore';
import { server } from './server';

interface Row {
  id: string;
  name: string;
  description: string;
  body_md: string;
  source: 'builtin' | 'import' | 'user';
  package_path: string | null;
  created_at: number;
}

const SEED: Row[] = [
  { id: 'b1', name: '通用助手', description: '内置通用', body_md: 'BUILTIN', source: 'builtin', package_path: null, created_at: 1 },
  { id: 'i1', name: '数据分析师', description: '从专家包导入', body_md: 'IMPORT', source: 'import', package_path: 'D:\\pkg\\data', created_at: 2 },
  { id: 'u1', name: '发布协调员', description: '自建人设', body_md: 'USER', source: 'user', package_path: null, created_at: 3 },
];

function setup(initial: Row[] = SEED): { rows: Row[]; posts: Array<Record<string, unknown>> } {
  const rows = initial.map((row) => ({ ...row }));
  const posts: Array<Record<string, unknown>> = [];
  server.use(
    http.get('/api/personas', () => HttpResponse.json(rows)),
    http.get('/api/clis', () =>
      HttpResponse.json([
        { id: 'codex', displayName: 'Codex', installed: true, version: '1' },
        { id: 'dsh', displayName: 'DSH', installed: false, version: null },
      ]),
    ),
    http.post('/api/personas', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      posts.push(body);
      const row: Row = {
        id: `new-${rows.length + 1}`,
        name: String(body.name),
        description: String(body.description ?? ''),
        body_md: String(body.body_md),
        source: 'user',
        package_path: null,
        created_at: 10,
      };
      rows.unshift(row);
      return HttpResponse.json(row);
    }),
    http.patch('/api/personas/:id', async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>;
      posts.push(body);
      const index = rows.findIndex((row) => row.id === params.id);
      if (index !== -1) rows[index] = { ...rows[index]!, ...body } as Row;
      return HttpResponse.json(rows[index]);
    }),
    http.delete('/api/personas/:id', ({ params }) => {
      const index = rows.findIndex((row) => row.id === params.id);
      if (index !== -1) rows.splice(index, 1);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return { rows, posts };
}

function renderSection(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PersonaSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ workspaceId: 'ws-1' });
});

describe('设置页 · 智能体人设', () => {
  it('列表展示三来源徽标；builtin 行禁改删并给出说明', async () => {
    setup();
    renderSection();

    expect(await screen.findByText('通用助手')).toBeInTheDocument();
    expect(screen.getByTestId('persona-badge-b1')).toHaveTextContent('内置');
    expect(screen.getByTestId('persona-badge-i1')).toHaveTextContent('导入');
    expect(screen.getByTestId('persona-badge-u1')).toHaveTextContent('自建');
    expect(screen.getByText(/D:\\pkg\\data/)).toBeInTheDocument();

    expect(screen.getByTestId('persona-edit-b1')).toBeDisabled();
    expect(screen.getByTestId('persona-delete-b1')).toBeDisabled();
    expect(screen.getByTestId('persona-builtin-note')).toHaveTextContent('内置人设由程序包提供，只读');
    expect(screen.getByTestId('persona-edit-u1')).toBeEnabled();
  });

  it('新建人设 → POST /api/personas → 列表出现', async () => {
    const { posts } = setup();
    renderSection();
    await screen.findByText('通用助手');

    await userEvent.click(screen.getByTestId('persona-create'));
    await userEvent.type(screen.getByTestId('persona-name'), '新协调员');
    await userEvent.type(screen.getByTestId('persona-desc'), '负责发布');
    await userEvent.type(screen.getByTestId('persona-body'), '你是发布协调员。');
    await userEvent.click(screen.getByTestId('persona-save'));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ name: '新协调员', description: '负责发布', body_md: '你是发布协调员。' });
    expect(await screen.findByText('新协调员')).toBeInTheDocument();
    expect(screen.getByTestId('persona-notice')).toHaveTextContent('已保存人设「新协调员」');
  });

  it('空名称就地报错，不发请求', async () => {
    const { posts } = setup();
    renderSection();
    await screen.findByText('通用助手');

    await userEvent.click(screen.getByTestId('persona-create'));
    await userEvent.type(screen.getByTestId('persona-body'), '正文');
    await userEvent.click(screen.getByTestId('persona-save'));

    expect(await screen.findByTestId('persona-field-error')).toHaveTextContent('名称不能为空');
    expect(posts).toHaveLength(0);
  });

  it('删除需二次确认，确认后行消失并提示', async () => {
    const { rows } = setup();
    renderSection();
    await screen.findByText('发布协调员');

    await userEvent.click(screen.getByTestId('persona-delete-u1'));
    expect(await screen.findByTestId('persona-delete-message')).toHaveTextContent('删除后不可恢复');
    expect(screen.getByText(/未知人设/)).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('persona-delete-confirm'));
    await waitFor(() => expect(screen.queryByText('发布协调员')).toBeNull());
    expect(rows.map((row) => row.id)).toEqual(['b1', 'i1']);
    expect(screen.getByTestId('persona-notice')).toHaveTextContent('已删除人设「发布协调员」');
  });

  it('导入成功：提交 workspace_id + path，提示人设与团队模板', async () => {
    const { posts } = setup();
    const imports: Array<Record<string, unknown>> = [];
    server.use(
      http.post('/api/expert-packages/import', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        imports.push(body);
        return HttpResponse.json({
          package: { name: '用研小队', path: String(body.path), type: 'team' },
          personas: [{ id: 'p1', name: '用户研究员' }, { id: 'p2', name: '访谈主持' }],
          team: { name: '用研小队' },
        }, { status: 201 });
      }),
    );
    renderSection();
    await screen.findByText('通用助手');

    await userEvent.click(screen.getByTestId('persona-import'));
    await userEvent.type(screen.getByTestId('persona-import-path'), 'D:\\WorkBuddy\\packages\\research');
    await userEvent.click(screen.getByTestId('persona-import-submit'));

    await waitFor(() => expect(imports).toHaveLength(1));
    expect(imports[0]).toEqual({ workspace_id: 'ws-1', path: 'D:\\WorkBuddy\\packages\\research' });
    expect(await screen.findByTestId('persona-notice')).toHaveTextContent('已导入 2 个人设（用户研究员、访谈主持） · 团队模板「用研小队」');
    expect(posts).toHaveLength(0);
  });

  it('重复导入 409：原样展示服务端文案', async () => {
    setup();
    server.use(
      http.post('/api/expert-packages/import', () =>
        HttpResponse.json(
          { error: { code: 'CONFLICT', message: '同名专家包「用研小队」已导入过（团队 t1），不重复导入' } },
          { status: 409 },
        ),
      ),
    );
    renderSection();
    await screen.findByText('通用助手');

    await userEvent.click(screen.getByTestId('persona-import'));
    await userEvent.type(screen.getByTestId('persona-import-path'), 'D:\\pkg\\dup');
    await userEvent.click(screen.getByTestId('persona-import-submit'));

    expect(await screen.findByTestId('persona-import-error')).toHaveTextContent('同名专家包「用研小队」已导入过（团队 t1）');
  });

  it('智能创建：生成中可取消，需求原文保留', async () => {
    setup();
    let release!: () => void;
    server.use(
      http.post('/api/personas/draft', async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return HttpResponse.json({ name: 'x', description: 'y', role: 'z', tone: '', boundary: '', domain: '', warnings: [] });
      }),
    );
    renderSection();
    await screen.findByText('通用助手');

    await userEvent.click(screen.getByTestId('persona-create'));
    await userEvent.type(screen.getByTestId('persona-smart-prompt'), '严谨的技术文档编辑');
    await userEvent.click(screen.getByTestId('persona-smart-generate'));

    expect(await screen.findByTestId('smart-generating')).toHaveTextContent('正在生成草稿');
    await userEvent.click(screen.getByTestId('persona-smart-cancel'));
    expect(await screen.findByTestId('persona-smart-prompt')).toHaveValue('严谨的技术文档编辑');
    expect(screen.queryByTestId('smart-generating')).toBeNull();
    release();
  });

  it('智能创建成功：四段可编辑，保存拼成 body_md', async () => {
    const { posts } = setup();
    server.use(
      http.post('/api/personas/draft', () =>
        HttpResponse.json({
          name: '技术文档编辑',
          description: '把笔记改成说明',
          role: '你是严谨的技术文档编辑。',
          tone: '冷静、克制。',
          boundary: '- 不改动原意',
          domain: '发布说明与使用指南',
          warnings: [],
        }),
      ),
    );
    renderSection();
    await screen.findByText('通用助手');

    await userEvent.click(screen.getByTestId('persona-create'));
    await userEvent.type(screen.getByTestId('persona-smart-prompt'), '技术文档编辑');
    await userEvent.click(screen.getByTestId('persona-smart-generate'));

    expect(await screen.findByTestId('persona-smart-draft')).toBeInTheDocument();
    expect(screen.getByTestId('persona-name')).toHaveValue('技术文档编辑');
    expect(screen.getByTestId('persona-desc')).toHaveValue('把笔记改成说明');
    const role = screen.getByTestId('persona-role');
    await userEvent.clear(role);
    await userEvent.type(role, '你是技术文档编辑（改写）。');
    await userEvent.click(screen.getByTestId('persona-save'));

    await waitFor(() => expect(posts).toHaveLength(1));
    const bodyMd = String(posts[0]!.body_md);
    expect(bodyMd).toContain('## 角色\n\n你是技术文档编辑（改写）。');
    expect(bodyMd).toContain('## 语气');
    expect(bodyMd).toContain('## 边界与禁忌');
    expect(bodyMd).toContain('## 擅长领域');
    expect(await screen.findByText('技术文档编辑')).toBeInTheDocument();
  });

  it('智能创建失败：原地报错，按钮改为「重试生成」', async () => {
    setup();
    server.use(
      http.post('/api/personas/draft', () =>
        HttpResponse.json({ error: { code: 'PERSONA_DRAFT_FAILED', message: 'CLI 退出码 1' } }, { status: 502 }),
      ),
    );
    renderSection();
    await screen.findByText('通用助手');

    await userEvent.click(screen.getByTestId('persona-create'));
    await userEvent.type(screen.getByTestId('persona-smart-prompt'), '数据分析师');
    await userEvent.click(screen.getByTestId('persona-smart-generate'));

    expect(await screen.findByTestId('persona-smart-error')).toHaveTextContent('生成失败');
    const button = await screen.findByTestId('persona-smart-generate');
    expect(button).toHaveTextContent('重试生成');
    expect(screen.getByTestId('persona-smart-prompt')).toHaveValue('数据分析师');
    // 失败后可继续手填：正文入口仍在
    expect(screen.getByTestId('persona-body')).toBeInTheDocument();
    expect(within(screen.getByTestId('persona-drawer')).getByText('名称（必填，上限 100 字）')).toBeInTheDocument();
  });

  it('SETTINGS-LAYOUT：设置面板打开时新建人设面板并排贴其右缘（无深色遮罩）', async () => {
    setup();
    // jsdom 无真实布局：造一个右缘 788 的锚定面板（1440 视口下设置抽屉 248+540）
    const anchor = document.createElement('div');
    anchor.setAttribute('data-testid', 'drawer-panel');
    anchor.getBoundingClientRect = () => ({
      right: 788, left: 248, top: 0, bottom: 900, width: 540, height: 900, x: 248, y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
    document.body.appendChild(anchor);
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1440 });
    try {
      renderSection();
      await screen.findByText('通用助手');

      await userEvent.click(screen.getByTestId('persona-create'));
      const side = await screen.findByTestId('modal-side');
      expect(side.style.left).toBe('788px');
      expect(side.style.width).toBe('480px');
      expect(screen.queryByTestId('modal-overlay')).toBeNull();
      expect(screen.getByTestId('persona-drawer')).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
      anchor.remove();
    }
  });
});
