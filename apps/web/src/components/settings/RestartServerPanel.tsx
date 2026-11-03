/**
 * 重启服务器面板（SYSTEM-RESTART 前端，卡 f4aa2602 / 父卡 66d5f3e8；RESTART-HARDENING 卡 3ab175f5）。
 *
 * 契约（server 线实测）：
 * - `POST /api/system/restart` 无 body → **202** `{restarting, old_pid, new_pid, log_path, started_at}`
 * - 403 RESTART_FORBIDDEN / 409 RESTART_PORT_CONFLICT / 500 RESTART_ENTRY_MISSING /
 *   500 RESTART_SPAWN_FAILED / 503 RESTART_UNAVAILABLE
 *   → **没有重启**，只显示 `error.message`，保持原界面
 * - 202 后服务约 0.75s 不可用；轮询 `GET /api/version` 每 500ms、最多 60s
 *
 * 行为：二次确认 → 202 后进入「正在重启…（旧进程 X → 新进程 Y，日志 …）」→ 轮询 → 用
 * `/api/version` 的 `pid` 与 `new_pid` 比对判定结果：
 * - pid === new_pid → 「服务已恢复（新进程 Y）」并全量 invalidate；
 * - pid !== new_pid → 服务端已回退旧监听（重启未生效），显示日志路径；
 * - 超时 → 「重启超时，请手动检查」并给日志路径（202 返回的 log_path）。
 * 重启期间通过全局 `restarting` 标志禁用写操作。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useRestartStore } from '../../state/restartStore';
import { BUTTON_SECONDARY } from '../ui/buttonStyles';

export const RESTART_POLL_INTERVAL_MS = 500;
export const RESTART_TIMEOUT_MS = 60_000;
/** 202 未带 log_path 时的兜底提示路径 */
export const RESTART_LOG_PATH = '%APPDATA%\\AgentBoard\\logs';

type Phase = 'idle' | 'confirm' | 'restarting' | 'recovered' | 'rolledback' | 'timeout' | 'failed';

interface RestartAccepted {
  restarting: boolean;
  old_pid?: number;
  new_pid?: number | null;
  log_path?: string;
  started_at?: number;
}

interface VersionBody {
  name: string;
  version: string;
  pid?: number;
}

export interface RestartServerPanelProps {
  /** 测试注入：轮询间隔 / 总时限 */
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export function RestartServerPanel({
  pollIntervalMs = RESTART_POLL_INTERVAL_MS,
  timeoutMs = RESTART_TIMEOUT_MS,
}: RestartServerPanelProps = {}) {
  const queryClient = useQueryClient();
  const setRestarting = useRestartStore((s) => s.setRestarting);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [oldPid, setOldPid] = useState<number | null>(null);
  const [newPid, setNewPid] = useState<number | null>(null);
  const [logPath, setLogPath] = useState<string>(RESTART_LOG_PATH);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => () => {
    cancelledRef.current = true;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setRestarting(false);
  }, [setRestarting]);

  const finish = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    setRestarting(false);
  }, [setRestarting]);

  const poll = useCallback(async (deadline: number, expectedPid: number | null, path: string) => {
    if (cancelledRef.current) return;
    if (Date.now() > deadline) {
      setPhase('timeout');
      setMessage(`重启超时，请手动检查（日志：${path}）`);
      finish();
      return;
    }
    try {
      const version = await api.get<VersionBody>('/api/version');
      if (cancelledRef.current) return;
      if (typeof version.version === 'string') {
        // pid 对不上 = 新进程没接管，服务端已回退旧监听
        if (expectedPid !== null && typeof version.pid === 'number' && version.pid !== expectedPid) {
          setPhase('rolledback');
          setMessage(`重启未生效：服务仍由 pid ${version.pid} 应答（已回退旧进程），日志：${path}`);
          await queryClient.invalidateQueries();
          finish();
          return;
        }
        setPhase('recovered');
        setMessage(expectedPid !== null ? `服务已恢复（新进程 ${expectedPid}）` : '服务已恢复');
        // 全量失效：重启后旧缓存一律不可信
        await queryClient.invalidateQueries();
        finish();
        return;
      }
    } catch {
      // 服务还没起来：继续轮询
    }
    timerRef.current = setTimeout(() => { void poll(deadline, expectedPid, path); }, pollIntervalMs);
  }, [finish, pollIntervalMs, queryClient]);

  const start = useCallback(async () => {
    setPhase('restarting');
    setMessage('正在重启…');
    setRestarting(true);
    try {
      const res = await api.post<RestartAccepted>('/api/system/restart', {});
      if (res?.restarting === true) {
        const acceptedNewPid = typeof res.new_pid === 'number' ? res.new_pid : null;
        const acceptedLogPath = typeof res.log_path === 'string' && res.log_path !== '' ? res.log_path : RESTART_LOG_PATH;
        setOldPid(typeof res.old_pid === 'number' ? res.old_pid : null);
        setNewPid(acceptedNewPid);
        setLogPath(acceptedLogPath);
        void poll(Date.now() + timeoutMs, acceptedNewPid, acceptedLogPath);
        return;
      }
      // 理论上不会到这（非 202 会抛错），保守处理为未重启
      setPhase('failed');
      setMessage('服务未重启');
      finish();
    } catch (error) {
      // 403 / 409 / 500 / 503：都没重启，保持原界面并给出服务端文案
      setPhase('failed');
      setMessage(error instanceof Error ? error.message : '重启请求失败');
      finish();
    }
  }, [finish, poll, setRestarting, timeoutMs]);

  const busy = phase === 'restarting';

  return (
    <section data-testid="restart-panel" aria-label="服务重启" className="mt-4 rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800">
      <h3 className="text-sm font-semibold">服务重启</h3>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        重启会短暂中断服务（约 1 秒），期间无法提交任何修改。
      </p>

      {phase === 'idle' || phase === 'failed' || phase === 'rolledback' ? (
        <button
          type="button"
          data-testid="restart-open"
          onClick={() => { setPhase('confirm'); setMessage(null); }}
          className={`mt-2 ${BUTTON_SECONDARY}`}
        >
          重启服务器
        </button>
      ) : null}

      {phase === 'confirm' && (
        <div data-testid="restart-confirm" className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 dark:border-amber-800 dark:bg-amber-950/40">
          <p className="text-xs text-amber-900 dark:text-amber-200">重启不可撤销，进行中的任务可能中断。确定重启？</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              data-testid="restart-confirm-yes"
              onClick={() => { void start(); }}
              className="rounded bg-red-600 px-2.5 py-1 text-xs font-medium text-white"
            >
              确认重启
            </button>
            <button
              type="button"
              data-testid="restart-confirm-no"
              onClick={() => setPhase('idle')}
              className={BUTTON_SECONDARY}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {(busy || phase === 'recovered' || phase === 'timeout') && (
        <p
          role="status"
          data-testid="restart-status"
          data-phase={phase}
          className={`mt-2 text-xs ${phase === 'recovered' ? 'text-ink' : phase === 'timeout' ? 'text-red-600 dark:text-red-400' : 'text-neutral-600 dark:text-neutral-300'}`}
        >
          {message}
          {busy && (oldPid !== null || newPid !== null)
            ? `（旧进程 ${oldPid ?? '未知'} → 新进程 ${newPid ?? '未知'}，日志 ${logPath}）`
            : ''}
        </p>
      )}

      {phase === 'rolledback' && message !== null && (
        <p role="alert" data-testid="restart-rollback" className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          {message}
        </p>
      )}

      {phase === 'failed' && message !== null && (
        <p role="alert" data-testid="restart-error" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {message}
        </p>
      )}

      {(phase === 'recovered' || phase === 'timeout') && (
        <button type="button" data-testid="restart-reset" onClick={() => { setPhase('idle'); setMessage(null); }} className={`mt-2 ${BUTTON_SECONDARY}`}>
          关闭提示
        </button>
      )}
    </section>
  );
}
