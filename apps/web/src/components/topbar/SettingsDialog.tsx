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
import { McpSection } from '../settings/McpSection';
import { PersonaSection } from '../settings/PersonaSection';
import { RestartServerPanel } from '../settings/RestartServerPanel';
import { SkillsSyncSection } from '../settings/SkillsSyncSection';
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
  // AUDIT-SETTINGS：保存成功的一次可见提示（对话框保留，让用户看到「哪些改动何时生效」）
  const [saved, setSaved] = useState<string | null>(null);
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
    // AUDIT-SETTINGS（F-12）：保存成功给一次可见提示，并说明生效时机；不再静默关闭，用户看完再手动关
    onSuccess: () => {
      setError(null);
      setSaved('已保存：并发上限立即生效；端口改动需重启服务后生效。');
    },
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
  // AUDIT-SETTINGS（F-12）：端口/并发有未保存改动时，关闭前确认一次，避免「改完直接点关闭」丢改动
  const dirty = loaded
    && settingsQuery.data !== undefined
    && (port !== String(settingsQuery.data.port) || maxTurns !== String(settingsQuery.data.maxConcurrentTurns));
  const requestClose = (): void => {
    if (dirty && typeof window !== 'undefined' && !window.confirm('有未保存的修改（端口 / 并发上限），确定关闭？')) return;
    onClose();
  };

  return (
    <Modal open={open} title="设置" onClose={requestClose} size="lg" scrollable variant={variant}>
      <form onSubmit={submit} className="space-y-3">
        {/* AUDIT-SETTINGS（F-12/V-08）：分组标注「需保存 / 即时生效」，让用户先知道改动何时生效 */}
        <section data-testid="settings-section-server" aria-labelledby="settings-section-server-title" className="space-y-3">
          <h3 id="settings-section-server-title" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
            服务与并发
            <span data-testid="settings-badge-save" className="rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium normal-case text-ink-3">需保存</span>
          </h3>
          <label className="block text-sm">
            <span className="mb-1 flex items-center gap-2 text-ink-2">
              服务端口
              <span data-testid="settings-effect-port" className="rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] text-ink-3">保存后需重启服务生效</span>
            </span>
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
            <span className="mb-1 flex items-center gap-2 text-ink-2">
              并发上限
              <span data-testid="settings-effect-max-turns" className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">保存后立即生效</span>
            </span>
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
        </section>
        {/* SETTINGS-DB-DEDUP：数据库位置只在「数据存储」分区维护（含迁移），这里不再重复输入框；
            保存不再发 dbPath —— 路径的唯一写入口是迁移端点，避免绕过迁移直接改路径。 */}
        <p data-testid="settings-db-path-hint" className="text-xs text-ink-3">
          中心库路径与迁移见下方「数据存储」分区
        </p>
        <section data-testid="settings-section-theme" aria-labelledby="settings-section-theme-title" className="text-sm">
          <span id="settings-section-theme-title" className="mb-1 flex items-center gap-2 text-ink-2">
            主题
            {/* AUDIT-SETTINGS（F-13）：主题的唯一权威入口就在这里；切换即生效，不需要保存 */}
            <span data-testid="settings-effect-theme" className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">即时生效，无需保存</span>
          </span>
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
        </section>
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
        {saved !== null && (
          <p role="status" data-testid="settings-saved" className="text-sm text-accent">{saved}</p>
        )}
        {/* AUDIT-SETTINGS（F-12）：DB 路径已不在保存体内（SETTINGS-DB-DEDUP），文案只说端口与并发，
            避免「DB 路径修改后需重启」这种已无对应输入的说法 */}
        <p data-testid="settings-save-hint" className="text-xs text-ink-3">
          端口：保存后需重启服务生效；并发上限：保存后立即生效；主题：点击即时生效，无需保存。
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <span data-testid="settings-version" className="mr-auto self-center text-xs text-ink-3">
            服务端 {serverVersion ?? '?'} · 前端 {WEB_VERSION}
          </span>
          <button
            type="button"
            onClick={requestClose}
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
      {/* PERSONA-LIB-2：智能体人设（全局库列表 / 新建编辑抽屉 / 删除 / 专家包导入 / 智能创建） */}
      <PersonaSection />
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
      {/* MCP：本机 stdio 服务接入配置（mcpServers JSON / 工具清单 / 未构建警示） */}
      <McpSection />
      {/* SKILLS-SYNC：一键把 8 份配套技能复制到常见 agent skills 目录（含冲突三选与移除） */}
      <SkillsSyncSection />
      <RestartServerPanel />
    </Modal>
  );
}






