import { useState } from 'react';
import type { Workspace } from '@agentboard/shared';
import { useAppStore, type WsStatus } from '../../state/appStore';
import { THEME_LABEL, useTheme } from '../../theme';
import { CliBadges } from './CliBadges';
import { SettingsDialog } from './SettingsDialog';

const WS_DOT: Record<WsStatus, string> = {
  connecting: 'bg-yellow-500',
  open: 'bg-green-500',
  closed: 'bg-red-500',
};

const WS_LABEL: Record<WsStatus, string> = {
  connecting: '连接中',
  open: '已连接',
  closed: '已断开',
};

export function TopBar({ workspace }: { workspace: Workspace | null }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const wsStatus = useAppStore((s) => s.wsStatus);
  const [theme, cycleTheme] = useTheme();

  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-neutral-200 bg-white px-4 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold">
          {workspace ? workspace.name : '未选择工作空间'}
        </div>
        {workspace && (
          <div
            className="truncate text-xs text-neutral-500 dark:text-neutral-400"
            title={workspace.path}
          >
            {workspace.path}
          </div>
        )}
      </div>

      <div className="ml-auto flex items-center gap-3">
        <CliBadges />

        <div
          className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400"
          title={`服务状态：${WS_LABEL[wsStatus]}`}
        >
          <span className={`inline-block h-2 w-2 rounded-full ${WS_DOT[wsStatus]}`} aria-hidden="true" />
          <span>{WS_LABEL[wsStatus]}</span>
        </div>

        <button
          type="button"
          onClick={cycleTheme}
          aria-label="切换主题"
          className="rounded px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {THEME_LABEL[theme]}
        </button>

        <button
          type="button"
          aria-label="设置"
          onClick={() => setSettingsOpen(true)}
          className="rounded px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          设置
        </button>

        {/* TODO(Task 13): 打开新建 issue 弹窗；Task 11 先禁用（未选工作空间禁用） */}
        <button
          type="button"
          aria-label="新建 issue"
          disabled={!workspace}
          title={workspace ? '新建 issue' : '请先选择工作空间'}
          onClick={() => {
            /* Task 13 接管 */
          }}
          className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          + 新建 issue
        </button>
      </div>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  );
}
