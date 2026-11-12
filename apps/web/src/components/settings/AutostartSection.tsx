/**
 * 设置 → 开机自启（SETTINGS-AUTOSTART）。
 *
 * 状态与开关全部走桌面壳 IPC（`autostart_status` / `autostart_set`），服务端不参与：
 * 服务可能跑在容器/远端，读不到宿主登录项。浏览器里没有壳能力时显示不可用并禁用开关，
 * 不假装成功。切换即时生效，不并入底部「保存」按钮。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  AUTOSTART_TAKEOVER_CONFIRM,
  AUTOSTART_UNAVAILABLE_TEXT,
  autostartErrorText,
  autostartStatusText,
  fetchAutostartStatus,
  getTauriInvoke,
  parseAutostartError,
  setAutostart,
  type AutostartStatus,
} from './autostart';

export function AutostartSection() {
  const invoke = useMemo(() => getTauriInvoke(), []);
  const [status, setStatus] = useState<AutostartStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (invoke === null) return;
    let cancelled = false;
    void fetchAutostartStatus(invoke)
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(autostartErrorText(parseAutostartError(e)));
      });
    return () => {
      cancelled = true;
    };
  }, [invoke]);

  const apply = async (next: boolean, takeOver: boolean): Promise<void> => {
    if (invoke === null) return;
    setPending(true);
    setError(null);
    try {
      // 成功后以壳回读的新状态为准，不在前端猜测结果
      setStatus(await setAutostart(invoke, { enabled: next, takeOver }));
    } catch (e) {
      // 失败保留原状态，只展示人话原因
      setError(autostartErrorText(parseAutostartError(e)));
    } finally {
      setPending(false);
    }
  };

  const enabled = status?.enabled === true;
  const unavailable = invoke === null || status === null || !status.supported;
  const disabled = unavailable || pending;

  const toggle = (): void => {
    if (disabled) return;
    const next = !enabled;
    // owner=cli 时开启必须先确认「由桌面应用接管」，确认后带 takeOver:true 改写同一入口
    if (next && status.owner === 'cli' && !window.confirm(AUTOSTART_TAKEOVER_CONFIRM)) return;
    void apply(next, next && status.owner === 'cli');
  };

  return (
    <section
      data-testid="settings-section-autostart"
      aria-labelledby="settings-section-autostart-title"
      className="mt-4 border-t border-hairline pt-3"
    >
      <h3
        id="settings-section-autostart-title"
        className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-3"
      >
        开机自启
        <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium normal-case text-accent">
          即时生效，无需保存
        </span>
      </h3>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p id="settings-autostart-label" className="text-sm text-ink">
            登录后自动启动 AgentBoard
          </p>
          <p className="mt-0.5 text-xs text-ink-3">
            与 CLI 共用同一系统入口；开启后登录时自动拉起（最小化到托盘），不会出现两个启动项。
          </p>
        </div>
        <button
          type="button"
          role="switch"
          data-testid="settings-autostart-toggle"
          aria-checked={enabled}
          aria-labelledby="settings-autostart-label"
          disabled={disabled}
          onClick={toggle}
          className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-40 ${
            enabled ? 'border-accent bg-accent' : 'border-hairline bg-surface-raised'
          }`}
        >
          <span
            aria-hidden="true"
            className={`absolute top-0.5 size-3.5 rounded-full bg-surface-card shadow transition-[left] duration-150 motion-reduce:transition-none ${
              enabled ? 'left-[18px]' : 'left-0.5'
            }`}
          />
        </button>
      </div>
      {invoke === null && (
        <p data-testid="autostart-unavailable" className="mt-2 text-xs text-ink-3">
          {AUTOSTART_UNAVAILABLE_TEXT}
        </p>
      )}
      {invoke !== null && status !== null && (
        <p data-testid="autostart-status" className="mt-2 text-xs text-ink-2">
          {autostartStatusText(status)}
        </p>
      )}
      {invoke !== null && status?.detail !== undefined && status.detail !== '' && (
        <p data-testid="autostart-detail" className="mt-1 break-all text-xs text-ink-3">
          {status.detail}
        </p>
      )}
      {invoke !== null && status?.error !== undefined && status.error !== '' && (
        <p data-testid="autostart-read-error" className="mt-1 break-all text-xs text-ink-3">
          读取状态异常：{status.error}
        </p>
      )}
      {error !== null && (
        <p role="alert" data-testid="autostart-error" className="mt-2 text-sm text-ink-2">
          {error}
        </p>
      )}
    </section>
  );
}
