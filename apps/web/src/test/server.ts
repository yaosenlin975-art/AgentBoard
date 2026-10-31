import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

/** 默认 handlers：空列表；各测试按需 server.use 覆盖 */
export const server = setupServer(
  http.get('/api/workspaces', () => HttpResponse.json([])),
  http.get('/api/issues', () => HttpResponse.json([])),
  http.get('/api/sessions', () => HttpResponse.json([])),
  // T14 聊天视图打开会话即拉消息：默认空列表（各测试可覆盖）
  http.get('/api/sessions/:id/messages', () => HttpResponse.json([])),
  // panelStore 刷新恢复兜底：默认 404（各测试可覆盖）
  http.get('/api/sessions/:id', () =>
    HttpResponse.json({ error: { code: 'NOT_FOUND', message: '会话不存在' } }, { status: 404 }),
  ),
  http.get('/api/clis', () =>
    HttpResponse.json([
      { id: 'codebuddy', displayName: 'CodeBuddy', installed: false, version: null },
      { id: 'codex', displayName: 'Codex', installed: false, version: null },
      { id: 'opencode', displayName: 'OpenCode', installed: false, version: null },
      { id: 'dsh', displayName: 'DSH', installed: false, version: null },
    ]),
  ),
);
