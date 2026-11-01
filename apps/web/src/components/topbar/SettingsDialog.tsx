/**
 * 设置弹窗（设计 §7.1）：打开时拉取 GET /api/settings 展示真实持久化配置；
 * 保存 → PATCH /api/settings（端口 / DB 路径修改后需重启服务生效；并发上限即时生效）；
 * 主题三选项走 theme.ts setTheme：localStorage 持久化 + 即时切换。
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { setTheme, useTheme, type Theme } from '../../theme';
import { Modal } from '../ui/Modal';

interface Settings {
  port: number;
  dbPath: string;
  maxConcurrentTurns: number;
}

const inputCls =
  'w-full rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-800';

const THEME_OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
];

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [port, setPort] = useState('');
  const [dbPath, setDbPath] = useState('');
  const [maxTurns, setMaxTurns] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [theme] = useTheme();

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<Settings>('/api/settings'),
    enabled: open,
  });

  // 接口值到达后回填表单（每次打开重新拉取，展示持久化值）
  useEffect(() => {
    const data = settingsQuery.data;
    if (data) {
      setPort(String(data.port));
      setDbPath(data.dbPath);
      setMaxTurns(String(data.maxConcurrentTurns));
      setError(null);
    }
  }, [settingsQuery.data]);

  const save = useMutation({
    mutationFn: (body: Settings) => api.patch<Settings>('/api/settings', body),
    // 成功静默关闭（跟随新建 issue 弹窗惯例）
    onSuccess: () => onClose(),
    onError: (e) => setError(e instanceof Error ? e.message : '保存失败'),
  });

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const data = settingsQuery.data;
    if (save.isPending || !data) return;
    setError(null);
    // 输入为空/非数字时按当前输入直发，由服务端 zod 校验并返回 400 错误信息
    save.mutate({ port: Number(port), dbPath, maxConcurrentTurns: Number(maxTurns) });
  };

  const loaded = settingsQuery.data !== undefined;

  return (
    <Modal open={open} title="设置" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-300">服务端口</span>
          <input
            data-testid="settings-port"
            aria-label="服务端口"
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            disabled={!loaded}
            className={inputCls}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-300">并发上限</span>
          <input
            data-testid="settings-max-turns"
            aria-label="并发上限"
            type="number"
            value={maxTurns}
            onChange={(e) => setMaxTurns(e.target.value)}
            disabled={!loaded}
            className={inputCls}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-300">数据库路径</span>
          <input
            data-testid="settings-db-path"
            aria-label="数据库路径"
            value={dbPath}
            onChange={(e) => setDbPath(e.target.value)}
            disabled={!loaded}
            className={inputCls}
          />
        </label>
        <div className="text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-300">主题</span>
          <div className="flex gap-2">
            {THEME_OPTIONS.map((opt) => {
              const selected = theme === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  data-testid={`theme-${opt.value}`}
                  aria-pressed={selected}
                  onClick={() => setTheme(opt.value)}
                  className={
                    selected
                      ? 'rounded border border-blue-500 bg-blue-50 px-3 py-1 text-sm font-medium text-blue-700 dark:border-blue-500 dark:bg-blue-950 dark:text-blue-300'
                      : 'rounded border border-neutral-300 px-3 py-1 text-sm text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800'
                  }
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
        {settingsQuery.isError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            读取设置失败
          </p>
        )}
        {error !== null && (
          <p role="alert" data-testid="settings-error" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          端口 / DB 路径修改后需重启服务生效；并发上限即时生效。
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            取消
          </button>
          <button
            type="submit"
            data-testid="settings-save"
            disabled={!loaded || save.isPending}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
}
