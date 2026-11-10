import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

/** 默认 handlers：空列表；各测试按需 server.use 覆盖 */
export const server = setupServer(
  http.get('/api/workspaces', () => HttpResponse.json([])),
  http.get('/api/issues', () => HttpResponse.json([])),
  // 工作区状态字典默认空（组件回落内置五条；各测试按需覆盖）
  http.get('/api/workspaces/:id/statuses', () => HttpResponse.json([])),
  // 技能联想端点（CHAT-MENTION；server 线落地前默认空列表，具体用例用 server.use 覆盖）
  http.get('/api/skills', () => HttpResponse.json({ items: [] })),
  http.get('/api/sessions', () => HttpResponse.json([])),
  // 任务详情「依赖」区默认无依赖（DEP-3；各测试可覆盖）
  http.get('/api/issues/:id/dependencies', () => HttpResponse.json({ blockers: [], blocked: [] })),
  // D7：详情附件路径索引默认空列表（各测试可覆盖）
  http.get('/api/issues/:id/attachments', () => HttpResponse.json({ items: [], next_offset: null })),
  // T14 聊天视图打开会话即拉消息：默认空列表（各测试可覆盖）
  http.get('/api/sessions/:id/messages', () => HttpResponse.json([])),
  // panelStore 刷新恢复兜底：默认 404（各测试可覆盖）
  http.get('/api/sessions/:id', () =>
    HttpResponse.json({ error: { code: 'NOT_FOUND', message: '会话不存在' } }, { status: 404 }),
  ),
  // DEC-6：待决策列表 / 徽标 / 详情默认空（各测试用 server.use 覆盖）
  http.get('/api/decisions', () =>
    HttpResponse.json({ decisions: [], counts: { grace: 0, open: 0, stale_open: 0, answered_recent: 0 } }),
  ),
  http.get('/api/workspaces/:id/decisions/count', () =>
    HttpResponse.json({ grace: 0, open: 0, stale_open: 0, answered_recent: 0 }),
  ),
  http.get('/api/decisions/:id', () =>
    HttpResponse.json({ error: { code: 'NOT_FOUND', message: '决策不存在' } }, { status: 404 }),
  ),
  // P1-C 人设列表：默认空（新建会话弹窗/会话设置弹窗会拉；各测试按需覆盖）
  http.get('/api/personas', () => HttpResponse.json([])),
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
  // ACC-KB-B2W：协议级「添加账号」的协议清单默认夹具。
  // 与生产一致（createAddAccountProviders 装配的五平台）；各用例可用 server.use 覆盖。
  http.get('/api/add-account-protocols', () => HttpResponse.json({
    items: [
      { app_id: 'minimax', protocol: 'minimax_device', provider_version: 'acc-kb-b2s-v1', requires_browser: true, regions: ['cn', 'global'] },
      { app_id: 'zcode', protocol: 'zcode_cli', provider_version: 'acc-kb-b2s-v1', requires_browser: true, regions: ['cn', 'global'] },
      { app_id: 'qoder_cn', protocol: 'qoder_device', provider_version: 'acc-kb-b2s-v1', requires_browser: true, regions: ['cn'] },
      { app_id: 'workbuddy_desktop', protocol: 'workbuddy_oneid', provider_version: 'acc-kb-b2s-v1', requires_browser: true, regions: ['cn', 'global'] },
      { app_id: 'trae', protocol: 'trae_oauth', provider_version: 'acc-kb-b2s-v1', requires_browser: true, regions: ['cn'] },
    ],
  })),
  // ACC-REFRESH：设置面板首次可用会自动刷新一次；默认给空成功结果，避免未挂载面板的用例打到未处理请求
  http.post('/api/accounts/import-credentials', () => HttpResponse.json({
    batch_id: 'startup-auto',
    actor: 'web',
    duration_ms: 0,
    platforms: [
      { platform: 'workbuddy', app_id: 'workbuddy_desktop', found: 0, created: 0, updated: 0, skipped: 0, error: null },
      { platform: 'minimax', app_id: 'minimax', found: 0, created: 0, updated: 0, skipped: 0, error: null },
      { platform: 'trae', app_id: 'trae', found: 0, created: 0, updated: 0, skipped: 0, error: null },
    ],
    accounts: [],
    error: null,
  })),
  // ACC-CLI-MULTI：CLI 三来源的本机凭据登记默认空列表；具体用例用 server.use 覆盖
  http.get('/api/cli-accounts', () => HttpResponse.json({ items: [] })),
  // ACC-CC-3：Command Code 本机能力默认「未安装」；具体用例用 server.use 覆盖
  http.get('/api/cli-accounts/commandcode/capability', () => HttpResponse.json({
    capability: {
      app_id: 'commandcode',
      installed: false,
      capture: false,
      capture_reason_code: 'CLI_NOT_INSTALLED',
      capture_reason: '本机未安装 Command Code CLI',
      switch: false,
      switch_reason_code: 'AUTH_WRITE_UNVERIFIED',
      switch_reason: '写回 auth.json 是否等价于有效登录态未验证，暂不支持切换',
      checkin: false,
      checkin_reason_code: 'CHECKIN_NOT_APPLICABLE',
      checkin_reason: 'Command Code 没有签到功能',
      auth_file_state: 'missing',
    },
  })),
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
