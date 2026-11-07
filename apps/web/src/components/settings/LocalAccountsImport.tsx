/**
 * 刷新本机账号（ACC-11 导入端点的界面入口，ACC-14 增加；ACC-REFRESH 改为「刷新」；
 * ACC-UI-TOPBAR 起拆为 useLocalAccountsImport + LocalAccountsImportButton（上标题栏）+ LocalAccountsImportResult（面板底部））。
 *
 * 契约：`POST /api/accounts/import-credentials` → `CredentialImportResult`
 * `{ batch_id, actor, duration_ms, platforms[{ platform, app_id, found, created, updated, skipped, error }], accounts[], error }`。
 * - ACC-REFRESH：设置面板首次可用时由前端自动触发**一次**刷新；服务端仍没有启动/定时扫描。
 *   自动刷新失败必须静默（服务端可能未就绪），**不重试**；手动刷新失败才显示可解释原因。
 * - 顶层汇总文案：发现 N 个账号，新增 X，已存在 Y。
 * - 失败只显示可解释原因（PYTHON_UNAVAILABLE / 超时 / 输出不可解析…），**不回显脚本 stdout/stderr 原文**，
 *   也不显示 token / 凭据引用。
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Badge } from '../ui/Badge';
import { BUTTON_SECONDARY } from '../ui/buttonStyles';
import { appLabel, importErrorLabel, reasonCodeOf } from './accountCapabilities';

/** ACC-UI-TOPBAR:刷新按钮与导入结果框拆成两块——按钮上标题栏,结果框留在面板底部;状态共用同一 hook */
export interface LocalAccountsImportController {
  pending: boolean;
  refresh: () => void;
  result: CredentialImportResult | null;
  failure: string | null;
  totals: { found: number; created: number; updated: number; skipped: number };
}

export type ExportPlatform = 'workbuddy' | 'trae' | 'minimax';

export interface PlatformImportSummary {
  platform: ExportPlatform;
  app_id: 'workbuddy_desktop' | 'trae' | 'minimax';
  found: number;
  created: number;
  updated: number;
  skipped: number;
  error: string | null;
}

export interface CredentialImportResult {
  batch_id: string;
  actor: string;
  duration_ms: number;
  platforms: PlatformImportSummary[];
  accounts: Array<{ account_id: string; app_id: string; display_name: string; action: 'created' | 'updated'; expires_at: number | null }>;
  error: string | null;
}

const PLATFORM_LABEL: Record<ExportPlatform, string> = {
  workbuddy: 'WorkBuddy',
  trae: 'Trae',
  minimax: 'MiniMax',
};

function refreshLocalAccounts(): Promise<CredentialImportResult> {
  return api.post<CredentialImportResult>('/api/accounts/import-credentials', { actor: 'web' });
}

/**
 * 自动刷新只跑一次：模块级标记位保证 StrictMode 双挂载、路由切换、面板反复开关都不会重复扫描。
 * 失败只把 promise 落为 null，不弹错、不重试；返回值供调用方在成功后失效账号列表。
 */
let startupRefreshPromise: Promise<CredentialImportResult | null> | null = null;

export function triggerStartupLocalAccountsRefresh(): Promise<CredentialImportResult | null> {
  if (startupRefreshPromise !== null) return startupRefreshPromise;
  startupRefreshPromise = refreshLocalAccounts().catch(() => null);
  return startupRefreshPromise;
}

/** 仅测试使用：清空模块级标记，验证「只触发一次」与失败静默。 */
export function resetLocalAccountsStartupRefreshForTests(): void {
  startupRefreshPromise = null;
}

/** 刷新状态与动作：按钮（顶栏）与结果框（面板底部）共用一份 */
export function useLocalAccountsImport(): LocalAccountsImportController {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<CredentialImportResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // 启动静默刷新：失败不 setFailure、不弹错；成功才失效列表让计数/今日 x/y 更新
    void triggerStartupLocalAccountsRefresh().then((data) => {
      if (!active || data === null) return;
      void queryClient.invalidateQueries({ queryKey: ['managed-accounts'] });
    });
    return () => { active = false; };
  }, [queryClient]);

  const importMutation = useMutation({
    mutationFn: refreshLocalAccounts,
    onSuccess: (data) => {
      setFailure(null);
      setResult(data);
      void queryClient.invalidateQueries({ queryKey: ['managed-accounts'] });
    },
    onError: (error) => {
      setResult(null);
      const label = importErrorLabel(reasonCodeOf(error));
      setFailure(label ?? (error instanceof Error ? error.message : '读取失败'));
    },
  });

  const totals = (result?.platforms ?? []).reduce(
    (sum, item) => ({ found: sum.found + item.found, created: sum.created + item.created, updated: sum.updated + item.updated, skipped: sum.skipped + item.skipped }),
    { found: 0, created: 0, updated: 0, skipped: 0 },
  );

  return {
    pending: importMutation.isPending,
    refresh: () => importMutation.mutate(),
    result,
    failure,
    totals,
  };
}

/** 顶栏「刷新」按钮（`accounts-import-local` testid 保持不变） */
export function LocalAccountsImportButton({ controller }: { controller: LocalAccountsImportController }) {
  return (
    <button
      type="button"
      data-testid="accounts-import-local"
      className={BUTTON_SECONDARY}
      disabled={controller.pending}
      title="扫描本机三平台凭据并写入加密存储；启动时会自动扫描一次，也可手动刷新"
      onClick={controller.refresh}
    >
      {controller.pending ? '刷新中…' : '刷新'}
    </button>
  );
}

/** 导入结果框与手动刷新失败原因：不随按钮上顶栏，留在面板底部原区域 */
export function LocalAccountsImportResult({ controller }: { controller: LocalAccountsImportController }) {
  const { result, failure, totals } = controller;
  return (
    <>
      {failure !== null && (
        <p role="alert" data-testid="accounts-import-error" className="text-xs text-red-600 dark:text-red-400">
          刷新失败：{failure}
        </p>
      )}

      {result !== null && (
        <div data-testid="accounts-import-result" className="rounded-md border border-neutral-200 p-2 text-xs dark:border-neutral-800">
          <p data-testid="accounts-import-summary" className="text-neutral-800 dark:text-neutral-200">
            发现 {totals.found} 个账号，新增 {totals.created}，已存在 {totals.updated}
            {totals.skipped > 0 && `，跳过 ${totals.skipped}`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {result.platforms.map((item) => (
              <li key={item.platform} data-testid={`accounts-import-platform-${item.platform}`} className="flex flex-wrap items-center gap-1.5 text-neutral-600 dark:text-neutral-400">
                <span>{PLATFORM_LABEL[item.platform]}</span>
                <span>发现 {item.found} · 新增 {item.created} · 已存在 {item.updated}</span>
                {item.error !== null
                  ? <Badge tone="red">{importErrorLabel(item.error) ?? '读取失败'}</Badge>
                  : <Badge tone="green">已读取</Badge>}
                <span className="text-[11px] text-neutral-400 dark:text-neutral-500">{appLabel(item.app_id)}</span>
              </li>
            ))}
          </ul>
          {result.error !== null && (
            <p data-testid="accounts-import-batch-error" className="mt-1 text-red-600 dark:text-red-400">{importErrorLabel(result.error)}</p>
          )}
        </div>
      )}
    </>
  );
}

/** 组合用法（等价旧 DOM 结构；单测与无 drawer 宿主的独立渲染用） */
export function LocalAccountsImport() {
  const controller = useLocalAccountsImport();
  return (
    <div data-testid="accounts-import" className="inline-flex flex-col gap-1">
      <LocalAccountsImportButton controller={controller} />
      <LocalAccountsImportResult controller={controller} />
    </div>
  );
}
