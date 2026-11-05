/**
 * CHAT-APP2：会话头「⋯ → 审批规则」工作表（弹层，不是新页面）。
 *
 * - 数据源：`GET /api/workspaces/:workspaceId/approval-rules`（只列未撤销规则）；
 * - 撤销：`DELETE /api/workspaces/:workspaceId/approval-rules/:ruleId`（服务端软撤销，行保留作审计）；
 * - 撤销后自动失效重取，列表移除；下次同类调用因无生效规则而重新弹确认框。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApprovalRule, ApprovalRuleScope } from '@agentboard/shared';
import { api } from '../../api/client';
import { Modal } from '../ui/Modal';

const SCOPE_LABEL: Record<ApprovalRuleScope, string> = {
  task: '本任务',
  workspace: '本工作区',
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

export function ApprovalRulesDialog({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const rules = useQuery({
    queryKey: ['approval-rules', workspaceId],
    queryFn: () => api.get<ApprovalRule[]>(`/api/workspaces/${encodeURIComponent(workspaceId)}/approval-rules`),
  });

  const revoke = useMutation({
    mutationFn: (ruleId: string) =>
      api.del<ApprovalRule>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/approval-rules/${encodeURIComponent(ruleId)}`,
      ),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['approval-rules', workspaceId] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : '撤销审批规则失败'),
  });

  return (
    <Modal open title="审批规则" onClose={onClose} size="lg" scrollable>
      <div className="space-y-2 text-sm" data-testid="approval-rules-dialog">
        <p className="text-xs text-ink-3">
          列出本工作区当前生效的审批规则（已撤销的规则不再显示）。撤销后，下一次同类调用会重新弹确认框。
        </p>
        {rules.isLoading && (
          <p data-testid="approval-rules-loading" className="text-xs text-ink-3">
            加载中…
          </p>
        )}
        {rules.isError && (
          <p data-testid="approval-rules-error" role="alert" className="text-xs text-red-600 dark:text-red-400">
            {rules.error instanceof Error ? rules.error.message : '审批规则加载失败'}
          </p>
        )}
        {rules.data !== undefined && rules.data.length === 0 && (
          <p data-testid="approval-rules-empty" className="text-xs text-ink-3">
            暂无生效规则。
          </p>
        )}
        {rules.data !== undefined && rules.data.length > 0 && (
          <table data-testid="approval-rules-table" className="w-full table-fixed border-collapse text-xs">
            <thead>
              <tr className="border-b border-hairline text-left text-ink-3">
                <th className="w-[18%] py-1 pr-2 font-medium">工具</th>
                <th className="w-[30%] py-1 pr-2 font-medium">匹配键</th>
                <th className="w-[12%] py-1 pr-2 font-medium">档位</th>
                <th className="w-[20%] py-1 pr-2 font-medium">创建时间</th>
                <th className="w-[10%] py-1 pr-2 font-medium">创建者</th>
                <th className="w-[10%] py-1 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {rules.data.map((rule) => (
                <tr key={rule.id} data-testid={`approval-rule-row-${rule.id}`} className="border-b border-hairline">
                  <td className="truncate py-1 pr-2" title={rule.tool_name}>
                    {rule.tool_name}
                  </td>
                  <td className="truncate py-1 pr-2" title={rule.match_key}>
                    {rule.match_key}
                  </td>
                  <td className="py-1 pr-2">{SCOPE_LABEL[rule.scope]}</td>
                  <td className="truncate py-1 pr-2" title={formatTime(rule.created_at)}>
                    {formatTime(rule.created_at)}
                  </td>
                  <td className="truncate py-1 pr-2" title={rule.created_by}>
                    {rule.created_by}
                  </td>
                  <td className="py-1">
                    <button
                      type="button"
                      data-testid={`approval-rule-revoke-${rule.id}`}
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(rule.id)}
                      className="rounded border border-red-300 px-2 py-0.5 text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/40"
                    >
                      撤销
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {error !== null && (
          <p data-testid="approval-rules-action-error" role="alert" className="text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
