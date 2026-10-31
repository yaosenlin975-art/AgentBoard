import { Modal } from '../ui/Modal';

// TODO(Task 15+): 后端暂无 settings 端点（GET /api/settings 未实现），此处展示默认值；
// 端点可用后改为拉取真实配置并支持修改（配置文件 %APPDATA%\AgentBoard\config.json）。
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} title="设置" onClose={onClose}>
      <dl className="space-y-3 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-neutral-500 dark:text-neutral-400">服务端口</dt>
          <dd className="font-medium">8787（默认值）</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-neutral-500 dark:text-neutral-400">并发上限</dt>
          <dd className="font-medium">3（默认值）</dd>
        </div>
      </dl>
      <p className="mt-4 text-xs text-neutral-400 dark:text-neutral-500">
        暂不支持修改：后端设置端点尚未实现。
      </p>
    </Modal>
  );
}
