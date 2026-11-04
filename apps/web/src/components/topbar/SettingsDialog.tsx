/**
 * 设置弹窗（设计 §7.1）：打开时拉取 GET /api/settings 展示真实持久化配置；
 * 保存 → PATCH /api/settings（端口 / DB 路径修改后需重启服务生效；并发上限即时生效）；
 * 主题三选项走 theme.ts setTheme：localStorage 持久化 + 即时切换。
 * 底部显示服务端版本（GET /api/version，不可达/加载中显示 ?）与前端版本。
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useServerVersion, WEB_VERSION } from '../../api/version';
import { setTheme, useTheme, type Theme } from '../../theme';
import { Modal } from '../ui/Modal';
import { RestartServerPanel } from '../settings/RestartServerPanel';
import { StorageSection } from '../settings/StorageSection';
import { WorkspaceStatusSettings } from '../settings/WorkspaceStatusSettings';
import { VoiceSection } from '../settings/VoiceSection';
import { useAppStore } from '../../state/appStore';

interface Settings {
  port: number;
  /** SETTINGS-DB-DEDUP：响应仍带 dbPath（只读展示用），但保存体不再发送 */
  dbPath: string;
  maxConcurrentTurns: number;
}

const inputCls =
  'w-full rounded border border-hairline bg-surface-card px-2 py-1.5 text-sm text-ink outline-none transition-colors duration-150 focus:border-accent motion-reduce:transition-none';

const THEME_OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
];

export function SettingsDialog({ open, onClose, variant = 'modal' }: { open: boolean; onClose: () => void; /** S2c：drawer 内联渲染时不再自带 Modal 壳（标题由 DrawerPanel 提供） */ variant?: 'modal' | 'inline' }) {
  const currentWorkspaceId = useAppStore((s) => s.workspaceId);
  const [port, setPort] = useState('');
  const [maxTurns, setMaxTurns] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [theme] = useTheme();
  const serverVersion = useServerVersion().data?.version;

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
      setMaxTurns(String(data.maxConcurrentTurns));
      setError(null);
    }
  }, [settingsQuery.data]);

  const save = useMutation({
    // SETTINGS-DB-DEDUP：只发 port / maxConcurrentTurns，不发 dbPath（路径唯一写入口是迁移端点）
    mutationFn: (body: { port: number; maxConcurrentTurns: number }) => api.patch<Settings>('/api/settings', body),
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
    save.mutate({ port: Number(port), maxConcurrentTurns: Number(maxTurns) });
  };

  const loaded = settingsQuery.data !== undefined;

  return (
    <Modal open={open} title="设置" onClose={onClose} size="lg" scrollable variant={variant}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-2">服务端口</span>
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
          <span className="mb-1 block text-ink-2">并发上限</span>
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
        {/* SETTINGS-DB-DEDUP：数据库位置只在「数据存储」分区维护（含迁移），这里不再重复输入框；
            保存不再发 dbPath —— 路径的唯一写入口是迁移端点，避免绕过迁移直接改路径。 */}
        <p data-testid="settings-db-path-hint" className="text-xs text-ink-3">
          数据库位置与迁移见下方「数据存储」分区
        </p>
        <div className="text-sm">
          <span className="mb-1 block text-ink-2">主题</span>
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
                      ? 'rounded border border-accent bg-accent-soft px-3 py-1 text-sm font-medium text-accent'
                      : 'rounded border border-hairline px-3 py-1 text-sm text-ink-2 transition-colors duration-150 hover:bg-surface-raised motion-reduce:transition-none'
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
        <p className="text-xs text-ink-3">
          端口 / DB 路径修改后需重启服务生效；并发上限即时生效。
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <span data-testid="settings-version" className="mr-auto self-center text-xs text-ink-3">
            服务端 {serverVersion ?? '?'} · 前端 {WEB_VERSION}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-hairline bg-surface-card px-3 py-1.5 text-sm text-ink transition-colors duration-150 hover:bg-surface-raised motion-reduce:transition-none"
          >
            取消
          </button>
          <button
            type="submit"
            data-testid="settings-save"
            disabled={!loaded || save.isPending}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink transition-colors duration-150 hover:border-accent hover:bg-accent-soft hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
          >
            保存
          </button>
        </div>
      </form>
      {/* STATUS-3-UI：自定义状态增删（删除必须选迁移目标）；成功后失效状态字典与任务列表 */}
      <section data-testid="settings-statuses" className="mt-4 border-t border-hairline pt-3">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">
          工作区状态
        </h3>
        <WorkspaceStatusSettings workspaceId={currentWorkspaceId} />
      </section>
      {/* VOICE-4：语音输入（总开关 / 语言 / 模型下载与删除 / 占用空间 / 检测麦克风） */}
      <section data-testid="settings-voice-wrap" className="mt-4 border-t border-hairline pt-3">
        <h3 className="mb-2 text-xs font-medium text-ink-2">语音输入</h3>
        <VoiceSection />
      </section>
      {/* DB-3：数据存储（当前路径/来源/占用/附件目录 + 迁移确认与阶段进度；端点待 DB-2B） */}
      <StorageSection />
      <RestartServerPanel />
    </Modal>
  );
}






