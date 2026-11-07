/**
 * ACC-REASON-01：账号面板不再展示裸原因码。
 *
 * 三条验收对应：
 * 1. 服务端会出现的 `*_reason_code` 全部有中文文案（清单来自服务端代码，逐个核对，不猜码）；
 * 2. 未收录的码不以裸码作主文案：中性文案 + 可展开「技术码」；
 * 3. 服务端 message 保留为副文案。
 *
 * ACC-UI-TOPBAR：捕获按钮与捕获 notice 已随「捕获当前账号」整体删除，
 * 原因码渲染口径（主文案中文 / 技术码可展开）改由 reasonLabel / reasonTechnicalCode 纯函数用例锁定。
 */
import { describe, expect, it } from 'vitest';
import {
  hasReasonLabel,
  reasonLabel,
  reasonTechnicalCode,
  UNKNOWN_REASON_LABEL,
} from '../components/settings/accountCapabilities';

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

  it('未收录的码：主文案只能是中性文案，裸码只进可展开技术码', () => {
    // 未收录码不再回裸码
    expect(reasonLabel('SOMETHING_UNSEEN')).toBe(UNKNOWN_REASON_LABEL);
    // 技术码口径：未收录码原样保留（排障能力在可展开技术码里）
    expect(reasonTechnicalCode('SOMETHING_UNSEEN')).toBe('SOMETHING_UNSEEN');
  });

  it('无码与非字符串兜底：reasonLabel(null) 给中性文案，reasonTechnicalCode 空码返回 null', () => {
    expect(reasonLabel(null)).toBe('能力未验证');
    expect(reasonLabel(undefined)).toBe('能力未验证');
    expect(reasonTechnicalCode(null)).toBeNull();
    expect(reasonTechnicalCode('')).toBeNull();
    expect(reasonTechnicalCode('CLIENT_NOT_RUNNING')).toBe('CLIENT_NOT_RUNNING');
  });
});
