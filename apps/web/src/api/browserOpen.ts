/**
 * ACC-INCOGNITO：无痕打开授权地址的 web 侧 client。
 *
 * 服务端端点：POST /api/browser/open-incognito（apps/server/src/api/browserRoutes.ts）。
 * 降级语义：mode='normal' 时 degraded_reason 是服务端给出的中文原因，
 * 调用方（账号授权向导）必须把它展示给用户，不能静默降级。
 * 错误不在这里吞：client.ts 的 ApiError（code / message）原样透出，供调用方展示中文文案。
 */
import { api } from './client';

export interface BrowserOpenResult {
  opened_with: 'chrome' | 'edge' | 'brave' | 'default';
  mode: 'incognito' | 'normal';
  /** 仅 mode='normal'（降级为系统默认浏览器普通窗口）时非空 */
  degraded_reason: string | null;
}

export const browserOpenApi = {
  /** 让本机服务用无痕窗口打开授权地址 */
  openIncognito(url: string): Promise<BrowserOpenResult> {
    return api.post<BrowserOpenResult>('/api/browser/open-incognito', { url });
  },
};
