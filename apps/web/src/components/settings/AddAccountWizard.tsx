/**
 * 协议级「添加账号」向导（ACC-KB-B2W）。
 *
 * 与既有「捕获当前账号」（读本机已登录态）**并列但不同**：本组件走平台自己的授权协议，
 * 授权成功后凭据落 vault、建 `managed_account`，**不需要客户端在跑、不需要重启客户端**
 * （知识页 `89c72721` §3「加号 ≠ 切号」）。
 *
 * 界面按**服务端装配的协议**分支，不维护平台副本：
 * - 协议清单来自 `GET /api/add-account-protocols`（未装配的平台不在列表里）；
 * - 平台不在清单里 → **不给入口**，只给一句 reason 文案（不出现「点了必然失败」的按钮，
 *   也不给一个禁用的灰按钮，见卡面「能力不可用时给出 reason 文案而不是禁用按钮」）；
 * - 协议清单读取失败 → 同样只给文案，不给入口（与能力矩阵失败时禁用写操作的口径一致）。
 *
 * 五平台各自的流程形态（文案见 `addAccountProtocols.ts`）：
 * - `minimax_device`：展示**设备码**（`user_code`）+ 授权链接 → 轮询；
 * - `qoder_device`：设备授权页（浏览器选账号）→ 轮询；
 * - `zcode_cli`：CLI 轮询流（浏览器登录后由服务端轮询收口）→ 轮询；
 * - `workbuddy_oneid`：浏览器登录 → 轮询；
 * - `trae_oauth`：本地回调（**必须同一台机器的浏览器**）→ 轮询。
 *
 * 轮询语义（`POST /api/add-account-sessions/:id/poll`）：`pending` 不产生任何落库副作用；
 * `authorized` 时凭据落库并建/更新账号（同一 app + 同一 uid 不产生重复账号）→ 本组件让
 * 账号列表重新拉取（`managed-accounts` 查询失效），新账号随即出现在列表里。
 *
 * testid 口径：
 * `accounts-add-<app>`（入口）/ `accounts-add-panel-<app>`（向导容器）/
 * `accounts-add-region-<app>-<region>`（区域）/ `accounts-add-start-<app>`（开始授权）/
 * `accounts-add-url-<app>`（授权链接）/ `accounts-add-code-<app>`（设备码）/
 * `accounts-add-check-<app>`（检查授权结果）/ `accounts-add-cancel-<app>`（取消）/
 * `accounts-add-status-<app>`（状态与原因）/ `accounts-add-unsupported-<app>`（能力不可用文案）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AddAccountProtocolInfo, AddAccountSession, ManagedAppId } from '@agentboard/shared';
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from '../ui/buttonStyles';
import { appLabel, reasonCodeOf, reasonLabel } from './accountCapabilities';
import {
  cancelAddAccountSession,
  fetchAddAccountProtocols,
  pollAddAccountSession,
  startAddAccountSession,
} from './addAccountApi';
import { addAccountFailureLabel, addAccountFlowCopy, addAccountRegionLabel } from './addAccountProtocols';

/** 自动轮询间隔（毫秒）。协议轮询都由服务端发起，前端只负责问结果。 */
const POLL_INTERVAL_MS = 3_000;

/** 失败提示：中文主文案 + 服务端 message 副文案 + 裸码只进可展开技术码 */
interface AddAccountNotice {
  label: string;
  message: string | null;
  technicalCode: string | null;
}

function noticeOf(code: string | null, message: string | null): AddAccountNotice {
  const label = addAccountFailureLabel(code);
  return {
    label,
    message: message !== null && message !== label ? message : null,
    technicalCode: code,
  };
}

/**
 * 添加账号入口 + 向导。挂在平台行的展开层里（与「捕获当前账号」并列）。
 *
 * @param app 平台 id（协议清单按它查）
 */
export function AddAccountEntry({ app }: { app: ManagedAppId }) {
  const [open, setOpen] = useState(false);
  // 五个平台共用同一份协议清单（同一 queryKey → 一次请求、全局缓存）
  const protocols = useQuery({
    queryKey: ['add-account-protocols'],
    queryFn: fetchAddAccountProtocols,
    staleTime: 60_000,
  });

  if (protocols.isPending) {
    return <p data-testid={`accounts-add-pending-${app}`} className="text-[11px] text-neutral-400 dark:text-neutral-500">读取添加账号能力…</p>;
  }
  if (protocols.isError) {
    return (
      <p data-testid={`accounts-add-unsupported-${app}`} className="text-[11px] text-neutral-500 dark:text-neutral-400">
        添加账号能力读取失败：{protocols.error instanceof Error ? protocols.error.message : '未知错误'}；为避免误操作，未提供添加入口
      </p>
    );
  }

  const info = protocols.data?.items.find((item) => item.app_id === app) ?? null;
  if (info === null) {
    // 能力不可用：给 reason 文案，**不给按钮**（不出现可点但必然失败的入口）
    return (
      <p data-testid={`accounts-add-unsupported-${app}`} className="text-[11px] text-neutral-500 dark:text-neutral-400">
        {reasonLabel('ADD_ACCOUNT_PROTOCOL_UNSUPPORTED')}
      </p>
    );
  }

  const copy = addAccountFlowCopy(info.protocol);
  return (
    <>
      <button
        type="button"
        data-testid={`accounts-add-${app}`}
        className={BUTTON_PRIMARY}
        title={`通过 ${appLabel(app)} 的官方授权流程添加账号（不需要客户端在跑）`}
        onClick={() => setOpen(true)}
      >
        添加账号
      </button>
      {/* 链路形态标签：让用户点之前就知道这条平台链路怎么走（设备码 / CLI / 本地回调…） */}
      <span
        data-testid={`accounts-add-flow-${app}`}
        className="rounded-full bg-surface-raised px-2 py-0.5 text-[11px] text-ink-3"
      >
        {copy.flowLabel}
      </span>
      {open && <AddAccountWizard app={app} info={info} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 向导本体：选区域 → 发起授权 → 展示授权地址/设备码 → 轮询 → 成功或给出原因 */
function AddAccountWizard({
  app,
  info,
  onClose,
}: {
  app: ManagedAppId;
  info: AddAccountProtocolInfo;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const copy = addAccountFlowCopy(info.protocol);
  const [region, setRegion] = useState<'cn' | 'global'>(info.regions[0] ?? 'cn');
  const [session, setSession] = useState<AddAccountSession | null>(null);
  const [notice, setNotice] = useState<AddAccountNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [polling, setPolling] = useState(false);

  /** 发起授权：拿到授权地址（+ 设备码）。凭据只进服务端 vault，界面只拿脱敏字段。 */
  const start = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await startAddAccountSession(app, region);
      setSession(result.session);
    } catch (error) {
      setNotice(noticeOf(reasonCodeOf(error), error instanceof Error ? error.message : null));
    } finally {
      setBusy(false);
    }
  }, [app, region]);

  /** 轮询一次授权结果；`pending` 无副作用，`authorized` 时刷新账号列表 */
  const runPoll = useCallback(async (sessionId: string): Promise<AddAccountSession | null> => {
    setPolling(true);
    try {
      const result = await pollAddAccountSession(sessionId);
      setSession(result.session);
      if (result.session.status === 'authorized') {
        setNotice(null);
        // 新账号进列表：让账号列表重新拉取
        void queryClient.invalidateQueries({ queryKey: ['managed-accounts'] });
      } else if (result.session.status === 'failed' || result.session.status === 'expired') {
        setNotice(noticeOf(result.session.safe_error_code, null));
      }
      return result.session;
    } catch (error) {
      setNotice(noticeOf(reasonCodeOf(error), error instanceof Error ? error.message : null));
      return null;
    } finally {
      setPolling(false);
    }
  }, [queryClient]);

  // 自动轮询：只在会话处于 pending 时排下一次；状态一变即停（effect 依赖 session，天然重排）
  useEffect(() => {
    if (session === null || session.status !== 'pending') return undefined;
    const timer = setTimeout(() => { void runPoll(session.id); }, POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [session, runPoll]);

  /** 放弃授权：会话置 cancelled，不建账号、待激活凭据删除 */
  const cancel = useCallback(async () => {
    if (session === null) return;
    setBusy(true);
    try {
      const result = await cancelAddAccountSession(session.id);
      setSession(result.session);
    } catch (error) {
      setNotice(noticeOf(reasonCodeOf(error), error instanceof Error ? error.message : null));
    } finally {
      setBusy(false);
    }
  }, [session]);

  const pending = session?.status === 'pending';
  const authorized = session?.status === 'authorized';

  return (
    <div data-testid={`accounts-add-panel-${app}`} className="mt-2 rounded-md border border-neutral-200 p-2 text-xs dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-neutral-800 dark:text-neutral-200">{appLabel(app)} · 添加账号</span>
        <button type="button" data-testid={`accounts-add-close-${app}`} className={`${BUTTON_SECONDARY} ml-auto`} onClick={onClose}>
          收起
        </button>
      </div>

      <p data-testid={`accounts-add-instruction-${app}`} className="mt-1 text-neutral-600 dark:text-neutral-400">
        {copy.instruction}
      </p>

      {/* 区域：只有一个区时不显示（避免无意义的选择） */}
      {info.regions.length > 1 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-neutral-500 dark:text-neutral-400">区域</span>
          {info.regions.map((item) => (
            <button
              key={item}
              type="button"
              data-testid={`accounts-add-region-${app}-${item}`}
              aria-pressed={region === item}
              className={region === item ? BUTTON_PRIMARY : BUTTON_SECONDARY}
              disabled={session !== null}
              onClick={() => setRegion(item)}
            >
              {addAccountRegionLabel(item)}
            </button>
          ))}
        </div>
      )}

      {/* 发起授权 */}
      {session === null && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid={`accounts-add-start-${app}`}
            className={BUTTON_PRIMARY}
            disabled={busy}
            onClick={() => { void start(); }}
          >
            {busy ? '发起中…' : '开始授权'}
          </button>
          <span className="text-[11px] text-neutral-400 dark:text-neutral-500">授权在浏览器完成；凭据只进加密存储</span>
        </div>
      )}

      {/* 授权中：授权地址 + 设备码 + 步骤 */}
      {session !== null && (
        <div className="mt-2 space-y-1.5">
          {session.authorization_url !== null && (
            <p className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-neutral-500 dark:text-neutral-400">授权地址</span>
              <a
                data-testid={`accounts-add-url-${app}`}
                href={session.authorization_url}
                target="_blank"
                rel="noreferrer"
                className="break-all text-blue-600 underline dark:text-blue-300"
              >
                {session.authorization_url}
              </a>
            </p>
          )}

          {/* 设备码只有 MiniMax 有（RFC 8628 需要用户手工输入） */}
          {copy.showsUserCode && session.user_code !== null && (
            <p className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-neutral-500 dark:text-neutral-400">{copy.userCodeLabel ?? '设备码'}</span>
              <code data-testid={`accounts-add-code-${app}`} className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono dark:bg-neutral-800">
                {session.user_code}
              </code>
            </p>
          )}

          <ol data-testid={`accounts-add-steps-${app}`} className="list-decimal space-y-0.5 pl-5 text-[11px] text-neutral-500 dark:text-neutral-400">
            {copy.steps.map((step) => <li key={step}>{step}</li>)}
          </ol>

          <div className="flex flex-wrap items-center gap-2">
            {pending && (
              <>
                <button
                  type="button"
                  data-testid={`accounts-add-check-${app}`}
                  className={BUTTON_SECONDARY}
                  disabled={polling}
                  onClick={() => { void runPoll(session.id); }}
                >
                  {polling ? '检查中…' : '检查授权结果'}
                </button>
                <button type="button" data-testid={`accounts-add-cancel-${app}`} className={BUTTON_SECONDARY} disabled={busy} onClick={() => { void cancel(); }}>
                  取消
                </button>
                <span className="text-[11px] text-neutral-400 dark:text-neutral-500">等待你在浏览器完成授权</span>
              </>
            )}
            {authorized && (
              <span data-testid={`accounts-add-status-${app}`} className="text-green-700 dark:text-green-300">
                已添加账号，账号列表已更新
              </span>
            )}
            {session.status === 'cancelled' && (
              <span data-testid={`accounts-add-status-${app}`} className="text-neutral-500 dark:text-neutral-400">
                已取消添加账号，未创建任何账号
              </span>
            )}
          </div>
        </div>
      )}

      {/* 失败原因：中文主文案 + 服务端 message；裸码只进可展开技术码 */}
      {notice !== null && (
        <div role="alert" data-testid={`accounts-add-notice-${app}`} className="mt-1.5 text-xs text-red-600 dark:text-red-400">
          <p data-testid={`accounts-add-notice-reason-${app}`}>
            {notice.label}
            {notice.message !== null && <span className="ml-1 text-neutral-600 dark:text-neutral-400">{notice.message}</span>}
          </p>
          {notice.technicalCode !== null && (
            <details data-testid={`accounts-add-notice-code-${app}`} className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
              <summary className="cursor-pointer select-none">技术码</summary>
              <code className="font-mono">{notice.technicalCode}</code>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
