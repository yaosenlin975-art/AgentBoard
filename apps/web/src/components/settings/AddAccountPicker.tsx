/**
 * accounts-add-flow：工具栏唯一「添加账号」→ 供应商选择页（7 卡平铺）。
 *
 * 动作只渲染真实可用的接口，不出现「点了必然失败」的按钮：
 * - 「授权添加」：只对 `GET /api/add-account-protocols` 里存在的平台渲染（服务端装配了协议才算可用），
 *   点开复用既有 `AddAccountWizard`（设备码 / CLI / 本地回调等链路不变）；
 * - 「读取本机」：只对 `POST /api/accounts/import-credentials` 支持的平台渲染
 *   （`workbuddy` / `trae` / `minimax`，见 `credentialImport.ts` 的 `EXPORT_PLATFORMS`）；
 * - DeepSeek（CLI 凭据导入）与 Codex（rollout 读取）当前没有可用接口 → 不出按钮，
 *   只在卡片 `title` 与一行原因里说明，原因文案与 `AccountsPanel` 里 CLI 来源的既有口径一致。
 *
 * 交互：打开后焦点落在第一张卡的第一个按钮；读取完成后失效账号列表，回调调用方切到该平台。
 */
import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AddAccountProtocolInfo, ManagedAppId } from '@agentboard/shared';
import { api } from '../../api/client';
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from '../ui/buttonStyles';
import { importErrorLabel, reasonCodeOf, reasonLabel } from './accountCapabilities';
import { fetchAddAccountProtocols } from './addAccountApi';
import { AddAccountWizard } from './AddAccountWizard';
import type { CredentialImportResult, ExportPlatform } from './LocalAccountsImport';

interface Vendor {
  /** ManagedAppId 或 CLI 来源 id（deepseek / codex 不是 ManagedAppId） */
  id: string;
  label: string;
  /** 有值＝支持「读取本机」，值对应 import-credentials 的 platform 枚举 */
  read: ExportPlatform | null;
  /** 无可用动作时的原因（只在 title 与一行小字里出现，不渲染按钮） */
  blockedReason: string | null;
}

/** 7 卡清单与顺序照 accounts-add-flow 原型 DESIGN-NOTES.md:23 */
const VENDORS: Vendor[] = [
  { id: 'workbuddy_desktop', label: 'WorkBuddy', read: 'workbuddy', blockedReason: null },
  { id: 'minimax', label: 'MiniMax', read: 'minimax', blockedReason: null },
  { id: 'trae', label: 'Trae', read: 'trae', blockedReason: null },
  { id: 'qoder_cn', label: 'Qoder CN', read: null, blockedReason: null },
  { id: 'zcode', label: 'ZCode', read: null, blockedReason: null },
  { id: 'deepseek', label: 'DeepSeek', read: null, blockedReason: '仅支持导入凭据：CLI 凭据导入尚未接入' },
  { id: 'codex', label: 'Codex', read: null, blockedReason: '仅读取 rollout：本机读取尚未接入' },
];

interface ReadState {
  status: 'reading' | 'done' | 'error';
  text: string;
}

export function AddAccountPicker({
  onClose,
  onImported,
}: {
  onClose: () => void;
  /** 读取/授权成功后的回调：由调用方决定是否切到该平台详情 */
  onImported?: (app: string) => void;
}) {
  const queryClient = useQueryClient();
  const [wizard, setWizard] = useState<{ app: ManagedAppId; info: AddAccountProtocolInfo } | null>(null);
  const [readStates, setReadStates] = useState<Record<string, ReadState>>({});

  // 与平台行内向导共用同一份协议清单（同一 queryKey → 一次请求、全局缓存）
  const protocols = useQuery({
    queryKey: ['add-account-protocols'],
    queryFn: fetchAddAccountProtocols,
    staleTime: 60_000,
  });

  const readLocal = useCallback(async (vendor: Vendor) => {
    if (vendor.read === null) return;
    setReadStates((previous) => ({ ...previous, [vendor.id]: { status: 'reading', text: '读取中…' } }));
    try {
      const result = await api.post<CredentialImportResult>('/api/accounts/import-credentials', {
        actor: 'web',
        platforms: [vendor.read],
      });
      const row = result.platforms.find((item) => item.platform === vendor.read);
      if (row !== undefined && row.error !== null) {
        setReadStates((previous) => ({
          ...previous,
          [vendor.id]: { status: 'error', text: importErrorLabel(row.error) ?? '读取失败' },
        }));
        return;
      }
      const totals = (result.platforms ?? []).reduce(
        (sum, item) => ({ found: sum.found + item.found, created: sum.created + item.created, updated: sum.updated + item.updated }),
        { found: 0, created: 0, updated: 0 },
      );
      setReadStates((previous) => ({
        ...previous,
        [vendor.id]: { status: 'done', text: `发现 ${totals.found} · 新增 ${totals.created} · 已存在 ${totals.updated}` },
      }));
      void queryClient.invalidateQueries({ queryKey: ['managed-accounts'] });
      onImported?.(vendor.id);
    } catch (error) {
      const label = importErrorLabel(reasonCodeOf(error)) ?? (error instanceof Error ? error.message : '读取失败');
      setReadStates((previous) => ({ ...previous, [vendor.id]: { status: 'error', text: label } }));
    }
  }, [onImported, queryClient]);

  const protocolOf = (vendor: Vendor): AddAccountProtocolInfo | null => {
    if (protocols.data === undefined) return null;
    return protocols.data.items.find((item) => item.app_id === vendor.id) ?? null;
  };

  /** 第一张「有按钮」的卡：打开后焦点落在它的第一个按钮（原型：无搜索、无分组，打开即可操作） */
  const firstActionId = VENDORS.find((vendor) => vendor.read !== null || protocolOf(vendor) !== null)?.id ?? null;

  return (
    <div
      data-testid="accounts-add-picker"
      aria-label="添加供应商"
      className="mt-2 rounded-md border border-neutral-200 p-2 dark:border-neutral-800"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-neutral-800 dark:text-neutral-200">添加供应商</span>
        <button
          type="button"
          data-testid="accounts-add-picker-close"
          className={`${BUTTON_SECONDARY} ml-auto`}
          onClick={onClose}
        >
          收起
        </button>
      </div>

      {wizard !== null && (
        <AddAccountWizard app={wizard.app} info={wizard.info} onClose={() => setWizard(null)} />
      )}

      <div className="mt-2 grid grid-cols-1 gap-1.5 min-[640px]:grid-cols-2 min-[920px]:grid-cols-3">
        {VENDORS.map((vendor) => {
          const info = protocolOf(vendor);
          const protocolsUnavailable = protocols.isError;
          const state = readStates[vendor.id];
          const reason = vendor.blockedReason
            ?? (protocolsUnavailable ? '添加账号能力读取失败，暂不提供授权入口' : null)
            ?? (vendor.read === null && protocols.data !== undefined && info === null
              ? reasonLabel('ADD_ACCOUNT_PROTOCOL_UNSUPPORTED')
              : null);
          const title = reason ?? undefined;
          return (
            <div
              key={vendor.id}
              data-testid={`accounts-add-picker-card-${vendor.id}`}
              title={title}
              className="flex min-h-[64px] flex-col justify-between gap-1.5 rounded-md bg-surface-raised px-2 py-1.5"
            >
              <span
                data-testid={`accounts-add-picker-name-${vendor.id}`}
                className="truncate text-xs font-medium text-neutral-800 dark:text-neutral-200"
              >
                {vendor.label}
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                {/* 授权添加：只对服务端装配了协议的平台渲染 */}
                {info !== null && (
                  <button
                    type="button"
                    data-testid={`accounts-add-picker-action-authorize-${vendor.id}`}
                    className={BUTTON_PRIMARY}
                    autoFocus={vendor.id === firstActionId}
                    onClick={() => setWizard({ app: info.app_id, info })}
                  >
                    授权添加
                  </button>
                )}
                {/* 读取本机：只对 import-credentials 支持的平台渲染 */}
                {vendor.read !== null && (
                  <button
                    type="button"
                    data-testid={`accounts-add-picker-action-read-${vendor.id}`}
                    className={BUTTON_SECONDARY}
                    autoFocus={info === null && vendor.id === firstActionId}
                    disabled={state?.status === 'reading'}
                    onClick={() => { void readLocal(vendor); }}
                  >
                    {state?.status === 'reading' ? '读取中…' : '读取本机'}
                  </button>
                )}
                {reason !== null && (
                  <span
                    data-testid={`accounts-add-picker-reason-${vendor.id}`}
                    className="text-[11px] leading-tight text-ink-3"
                  >
                    {reason}
                  </span>
                )}
              </div>
              {state !== undefined && state.status !== 'reading' && (
                <span
                  data-testid={`accounts-add-picker-result-${vendor.id}`}
                  className={`text-[11px] ${state.status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-ink-3'}`}
                >
                  {state.text}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {protocols.isPending && (
        <p data-testid="accounts-add-picker-pending" className="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500">
          读取添加账号能力…
        </p>
      )}
      {onImported !== undefined && (
        <p className="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500">
          读取只扫描本机已登录凭据，不切换当前账号
        </p>
      )}
    </div>
  );
}
