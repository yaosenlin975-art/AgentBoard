/**
 * ACC-REASON-01：账号面板不再展示裸原因码。
 *
 * 三条验收对应：
 * 1. 服务端会出现的 `*_reason_code` 全部有中文文案（清单来自服务端代码，逐个核对，不猜码）；
 * 2. 未收录的码不以裸码作主文案：中性文案 + 可展开「技术码」；
 * 3. 服务端 message 保留为副文案。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { AccountCapability } from '@agentboard/shared';
import { AccountsPanel } from '../components/settings/AccountsPanel';
import {
  hasReasonLabel,
  reasonLabel,
  reasonTechnicalCode,
  UNKNOWN_REASON_LABEL,
} from '../components/settings/accountCapabilities';
import { server } from './server';

/**
 * 服务端实际会产生的原因码（来源逐个标注，改服务端时要同步这张清单）：
 * - registry 静态表：apps/server/src/services/accounts/registry.ts
 * - 能力矩阵推导：apps/server/src/api/accountRoutes.ts（mergeAccountCapabilities）
 * - 捕获/切换抛错：services/accounts/workbuddyDesktopProvider.ts、minimaxDesktopProvider.ts、operationRunner.ts、secretVault.ts
 * - 签到：services/accounts/checkinRunner.ts、checkinAuthorization.ts、httpCheckinProviders.ts
 * - 导入：services/accounts/credentialImport.ts
 * - 通用：apps/server/src/errors.ts
 */
const SERVER_REASON_CODES = [
  // registry 静态表
  'CHECKIN_READY',
  'TARGET_KIND_UNCONFIRMED',
  'CLIENT_NOT_INSTALLED',
  'LOGIN_STATE_NOT_FILE_BASED',
  // 能力矩阵推导 / 可用态
  'OK',
  'CHECKIN_PROVIDER_AVAILABLE',
  'CHECKIN_PROVIDER_UNVERIFIED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_UNVERIFIED',
  // 桌面客户端捕获 / 切换
  'CLIENT_NOT_RUNNING',
  'CLIENT_NOT_LOGGED_IN',
  'CLIENT_INSTANCE_NOT_FOUND',
  'CLIENT_VERSION_UNSUPPORTED',
  'CLIENT_SCHEMA_UNSUPPORTED',
  'CLIENT_PATH_MISSING',
  'CLIENT_STATE_UNREADABLE',
  'CLIENT_STOP_UNAVAILABLE',
  'CLIENT_START_UNAVAILABLE',
  'EXIT_NOT_CONFIRMED',
  // ACC-KB-B4S：进程控制（B4S-1 clientProcess.ts）
  'CLIENT_PROCESS_PROBE_FAILED',
  'CLIENT_PROCESS_CONTROL_UNAVAILABLE',
  'CLIENT_STOP_TIMEOUT',
  'IDENTITY_UNAVAILABLE',
  'IDENTITY_CHANGED',
  'IDENTITY_VERIFY_FAILED',
  'WORKBUDDY_PATHS_UNAVAILABLE',
  'OPERATION_NOT_FOUND',
  'OPERATION_START_TIMEOUT',
  'RECOVERY_REQUIRED',
  'RECOVERY_NOT_REQUIRED',
  'RESTORED',
  'SWITCH_ROLLED_BACK',
  'SWITCH_WRITE_FAILED',
  'SWITCH_STAGE_FAILED',
  'STARTUP_TIMEOUT',
  'TARGET_ACCOUNT_NOT_FOUND',
  'TARGET_CREDENTIAL_MISSING',
  'TARGET_IDENTITY_UNKNOWN',
  'TARGET_IDENTITY_MISMATCH',
  'TARGET_INSTANCE_MISMATCH',
  'TARGET_SNAPSHOT_INVALID',
  // ACC-KB-B4S：S5 服务端身份校验（B4S-3 switchStages.ts）
  'SERVER_CREDENTIAL_REJECTED',
  'SERVER_IDENTITY_UNAVAILABLE',
  'SERVER_IDENTITY_MISMATCH',
  'SNAPSHOT_MISSING',
  'SNAPSHOT_FILE_MISSING',
  'SNAPSHOT_VERSION_MISMATCH',
  'SNAPSHOT_WRITE_FAILED',
  // Trae / 协议级添加账号
  'TRAE_STORAGE_MISSING',
  'ADD_ACCOUNT_PROTOCOL_UNSUPPORTED',
  'ADD_ACCOUNT_SESSION_EXISTS',
  // 账号与凭据
  'ACCOUNT_EXISTS',
  'ACCOUNT_NOT_FOUND',
  'ACCOUNT_DISABLED',
  'ACCOUNT_BUSY',
  'ACCOUNT_APP_MISMATCH',
  'ACCOUNT_OPERATION_FAILED',
  'VAULT_UNAVAILABLE',
  'VAULT_READ_FAILED',
  // 签到
  'CHECKIN_FAILED',
  'CHECKIN_RATE_LIMITED',
  'CHECKIN_CREDENTIAL_MISSING',
  'CHECKIN_CREDENTIAL_INVALID',
  'CHECKIN_PROVIDER_MISMATCH',
  'CHECKIN_IDENTITY_MISMATCH',
  'CHECKIN_AUTH_UNSUPPORTED',
  'CHECKIN_AUTHORIZATION_EXISTS',
  'CHECKIN_BATCH_IN_PROGRESS',
  'CHECKIN_BATCH_FINISHED',
  'OPERATION_UNKNOWN',
  'LOCAL_RECORD',
  // 通用
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'INTERNAL',
  'NETWORK',
];

const CAPTURE_OK: AccountCapability[] = [
  {
    app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: false,
    capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_UNVERIFIED',
    reason_code: 'CHECKIN_PROVIDER_UNVERIFIED', source: 'static',
  },
];

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><AccountsPanel /></QueryClientProvider>);
}

beforeEach(() => {
  server.resetHandlers();
  server.use(
    http.get('/api/managed-account-capabilities', () => HttpResponse.json(CAPTURE_OK)),
    http.get('/api/managed-accounts', () => HttpResponse.json([])),
  );
});

describe('原因码文案（ACC-REASON-01）', () => {
  it('服务端会出现的每个原因码都有中文文案，且文案不是裸码回显', () => {
    const missing = SERVER_REASON_CODES.filter((code) => !hasReasonLabel(code));
    expect(missing).toEqual([]);
    for (const code of SERVER_REASON_CODES) {
      const label = reasonLabel(code);
      expect(label).not.toBe(code);
      expect(label).not.toBe(UNKNOWN_REASON_LABEL);
      // 中文文案：含 CJK 字符
      expect(/[\u4e00-\u9fff]/.test(label)).toBe(true);
    }
  });

  it('CLIENT_NOT_RUNNING：主文案中文可解释，服务端 message 作副文案，裸码不进主文案', async () => {
    server.use(http.post('/api/managed-accounts/workbuddy_desktop/capture-current', () => HttpResponse.json({
      error: { code: 'CLIENT_NOT_RUNNING', message: 'WorkBuddy 未在运行，无法捕获当前登录态' },
    }, { status: 409 })));
    renderPanel();

    // ACC-PANEL-03：捕获入口在展开层内，先展开该平台行
    await userEvent.click(await screen.findByTestId('accounts-toggle-workbuddy_desktop'));
    await userEvent.click(await screen.findByTestId('accounts-capture-workbuddy_desktop'));
    const reason = await screen.findByTestId('accounts-notice-reason-workbuddy_desktop');
    expect(reason).toHaveTextContent('客户端未在运行');
    expect(reason).toHaveTextContent('WorkBuddy 未在运行，无法捕获当前登录态');
    // 裸码不得出现在主文案 / 提示条可见区（已知码不渲染技术码区）
    expect(reason.textContent ?? '').not.toContain('CLIENT_NOT_RUNNING');
    expect(screen.queryByTestId('accounts-notice-code-workbuddy_desktop')).not.toBeInTheDocument();
  });

  it('未收录的码：主文案只能是中性文案，裸码放在可展开技术码里', async () => {
    server.use(http.post('/api/managed-accounts/workbuddy_desktop/capture-current', () => HttpResponse.json({
      error: { code: 'SERVER_ADDED_A_NEW_CODE', message: '客户端目标未确认' },
    }, { status: 409 })));
    renderPanel();

    await userEvent.click(await screen.findByTestId('accounts-toggle-workbuddy_desktop'));
    await userEvent.click(await screen.findByTestId('accounts-capture-workbuddy_desktop'));
    const reason = await screen.findByTestId('accounts-notice-reason-workbuddy_desktop');
    expect(reason).toHaveTextContent(UNKNOWN_REASON_LABEL);
    expect(reason).toHaveTextContent('客户端目标未确认');
    expect(reason.textContent ?? '').not.toContain('SERVER_ADDED_A_NEW_CODE');

    // 技术码可展开：默认收起，展开后可见原码（排障能力保留）
    const details = await screen.findByTestId('accounts-notice-code-workbuddy_desktop');
    expect(details.tagName).toBe('DETAILS');
    expect(within(details).getByText('技术码')).toBeInTheDocument();
    expect(details.textContent).toContain('SERVER_ADDED_A_NEW_CODE');
  });

  it('签到 409 提示同样走中文文案 + 服务端 message，不打重复文案', async () => {
    server.use(
      http.get('/api/managed-account-capabilities', () => HttpResponse.json([
        { ...CAPTURE_OK[0]!, checkin: true, checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived' },
      ] satisfies AccountCapability[])),
      http.get('/api/managed-accounts', () => HttpResponse.json([
        {
          id: '22222222-2222-4222-8222-222222222222', app_id: 'workbuddy_desktop', client_instance_id: 'wb-inst-1',
          service_region: 'cn', display_name: 'WorkBuddy 副号', identity_hint: 'a1b2c3d4', client_snapshot_version: 1,
          checkin_capability: 'supported', enabled: true, last_checkin_day: null, last_checkin_status: null,
          last_checkin_at: null, created_at: 1, updated_at: 2, is_current: false,
        },
      ])),
      http.post('/api/checkin-runs', () => HttpResponse.json({
        error: { code: 'CHECKIN_BATCH_IN_PROGRESS', message: '该产品已有进行中的签到批次', details: { batch_id: '33333333-3333-4333-8333-333333333333' } },
      }, { status: 409 })),
    );
    renderPanel();

    await userEvent.click(await screen.findByTestId('accounts-checkin-all-workbuddy_desktop'));
    const notice = await screen.findByTestId('accounts-notice-workbuddy_desktop');
    expect(notice).toHaveTextContent('该产品已有进行中的签到批次');
    // 主文案与 message 相同 → 只出现一次
    expect((notice.textContent ?? '').match(/该产品已有进行中的签到批次/g)?.length).toBe(1);
    expect(screen.queryByTestId('accounts-notice-code-workbuddy_desktop')).not.toBeInTheDocument();
  });

  it('无码与非字符串兜底：reasonLabel(null) 给中性文案，reasonTechnicalCode 空码返回 null', () => {
    expect(reasonLabel(null)).toBe('能力未验证');
    expect(reasonLabel(undefined)).toBe('能力未验证');
    expect(reasonTechnicalCode(null)).toBeNull();
    expect(reasonTechnicalCode('')).toBeNull();
    expect(reasonTechnicalCode('CLIENT_NOT_RUNNING')).toBe('CLIENT_NOT_RUNNING');
    // 未收录码不再回裸码
    expect(reasonLabel('SOMETHING_UNSEEN')).toBe(UNKNOWN_REASON_LABEL);
  });
});
