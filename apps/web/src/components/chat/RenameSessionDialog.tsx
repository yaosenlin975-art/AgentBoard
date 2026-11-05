/**
 * 会话重命名（会话级 title）：
 * - 列表行与聊天头部「⋯」菜单共用本弹窗；
 * - 校验在前端先拦一次（空值 / 超 50 字给明确文案），服务端仍会二次校验；
 * - 成功后把 ['sessions'] 前缀缓存整体失效（列表与头部同源，立刻显示新名字，不等 WS 帧）。
 *   Modal 实现属于 AUDIT-P1，本卡只复用、不改。
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Session } from '@agentboard/shared';
import { api } from '../../api/client';
import { Modal } from '../ui/Modal';

export const SESSION_TITLE_MAX = 50;

export function RenameSessionDialog({
  session,
  onClose,
}: {
  session: Session;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(session.title ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (): Promise<void> => {
    const next = value.trim();
    if (next === '') {
      setError('会话名称不能为空');
      return;
    }
    if (next.length > SESSION_TITLE_MAX) {
      setError(`会话名称最多 ${SESSION_TITLE_MAX} 字（当前 ${next.length} 字）`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.patch<Session>(`/api/sessions/${session.id}`, { title: next });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '改名失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open title="修改会话名称" onClose={onClose}>
      <div className="space-y-3 text-sm" data-testid="rename-session-dialog">
        <label className="block">
          <span className="mb-1 block text-xs text-ink-3">会话名称（1–{SESSION_TITLE_MAX} 字，留空不能提交）</span>
          <input
            data-testid="rename-session-input"
            value={value}
            maxLength={SESSION_TITLE_MAX + 10}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
            className="w-full rounded border border-hairline bg-surface-card px-2 py-1 text-sm text-ink outline-none focus-visible:outline-2 focus-visible:outline-accent"
          />
        </label>
        <p className="text-xs text-ink-3" data-testid="rename-session-counter">
          {value.trim().length}/{SESSION_TITLE_MAX}
        </p>
        {error !== null && (
          <p className="text-xs text-red-600 dark:text-red-400" data-testid="rename-session-error">{error}</p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-hairline px-3 py-1 text-sm text-ink-2 hover:bg-surface-raised"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="rename-session-submit"
            disabled={saving}
            onClick={() => void submit()}
            className="rounded bg-accent px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
