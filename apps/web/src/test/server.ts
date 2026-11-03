import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

/** 默认 handlers：空列表；各测试按需 server.use 覆盖 */
export const server = setupServer(
  http.get('/api/workspaces', () => HttpResponse.json([])),
  http.get('/api/issues', () => HttpResponse.json([])),
  // 技能联想端点（CHAT-MENTION；server 线落地前默认空列表，具体用例用 server.use 覆盖）
  http.get('/api/skills', () => HttpResponse.json({ items: [] })),
  http.get('/api/sessions', () => HttpResponse.json([])),
  // 任务详情「依赖」区默认无依赖（DEP-3；各测试可覆盖）
  http.get('/api/issues/:id/dependencies', () => HttpResponse.json({ blockers: [], blocked: [] })),
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
  // 顶栏/设置弹窗版本号（各测试可覆盖）
  http.get('/api/version', () => HttpResponse.json({ name: 'agentboard-server', version: '0.1.0' })),
  // ACC-QUOTA-01：账号页额度卡默认夹具（ok / unsupported / error 三态各一条，避免走真实 fetch）
  http.get('/api/managed-account-quotas', () => HttpResponse.json({
    workspace_id: null,
    fetched_at: 1_700_000_000_000,
    items: [
      { source: 'deepseek', status: 'ok', balance: 12.34, unit: 'CNY', windows: [], fetched_at: 1_700_000_000_000, reason_code: null, detail: null },
      { source: 'opencode_go', status: 'unsupported', balance: null, unit: null, windows: [], fetched_at: 1_700_000_000_000, reason_code: 'NO_PUBLIC_QUOTA_ENDPOINT', detail: null },
      { source: 'codex', status: 'error', balance: null, unit: null, windows: [], fetched_at: 1_700_000_000_000, reason_code: 'NETWORK_ERROR', detail: null },
    ],
  })),
);
