/**
 * MCP 设置分区：本机 stdio MCP 服务的接入配置（GET /api/system/mcp-info）。
 *
 * - mcpServers JSON 代码块：command=node + mcp_entry（反斜杠统一替换为 /，便于粘贴进客户端配置）；
 *   env 带服务地址、当前工作区 id（全局 store 取不到留空串，并提示手填）、agent 名占位；
 * - 「复制配置」：copyText（clipboard API 失败回退 execCommand），成功后文案短暂变「已复制」；
 * - tools 非空 → 主名/别名计数（协议版本）+ details 折叠主名清单（契约只给名字数组，无读/写标记）；
 * - tools_error 非空或 mcp_built=false → 警示行 + 构建命令提示。
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useAppStore } from '../../state/appStore';
import { BUTTON_SECONDARY } from '../ui/buttonStyles';

interface McpToolsInfo {
  protocol_version: string;
  primary: string[];
  primary_count: number;
  alias_count: number;
}

interface McpInfo {
  mcp_entry: string;
  mcp_built: boolean;
  base_url: string;
  tools: McpToolsInfo | null;
  tools_error: string | null;
}

/** 复制文本：clipboard API 失败（非安全上下文/权限拒绝/不存在）时回退 execCommand */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      return document.execCommand('copy');
    } finally {
      document.body.removeChild(textarea);
    }
  }
}

export function McpSection() {
  const workspaceId = useAppStore((s) => s.workspaceId) ?? '';
  const info = useQuery({
    queryKey: ['system-mcp-info'],
    queryFn: () => api.get<McpInfo>('/api/system/mcp-info'),
    staleTime: 30_000,
  });
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
  }, []);

  const data = info.data;
  const configJson = data === undefined
    ? null
    : JSON.stringify(
        {
          mcpServers: {
            agentboard: {
              command: 'node',
              args: [data.mcp_entry.replace(/\\/g, '/')],
              env: {
                AGENTBOARD_BASE_URL: data.base_url,
                AGENTBOARD_WORKSPACE_ID: workspaceId,
                AGENTBOARD_AGENT_ID: 'your-agent-name',
              },
            },
          },
        },
        null,
        2,
      );

  const copy = async (): Promise<void> => {
    if (configJson === null) return;
    if (!(await copyText(configJson))) return;
    setCopied(true);
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  // 警示优先级：tools_error 文案 > 「MCP 未构建」；两者都没有则不警示
  const warningText = data === undefined
    ? null
    : data.tools_error
      ? data.tools_error
      : data.mcp_built
        ? null
        : 'MCP 未构建';

  return (
    <section data-testid="settings-section-mcp" aria-labelledby="settings-section-mcp-title" className="mt-4 border-t border-hairline pt-3">
      <h3 id="settings-section-mcp-title" className="mb-1 text-xs font-medium text-ink-2">MCP（模型上下文协议）</h3>
      <p className="text-xs text-ink-3">本机 stdio 服务，供 Codex / DSH / WorkBuddy 等客户端接入。</p>

      {info.isPending && <p data-testid="settings-mcp-loading" className="mt-1 text-xs text-ink-3">读取 MCP 信息…</p>}
      {/* 错误只显示一行文案，不用 role=alert：设置弹窗内已有用例断言「无错误提示」时不含分区自身读取失败 */}
      {info.isError && (
        <p data-testid="settings-mcp-error" className="mt-1 text-xs text-red-600 dark:text-red-400">
          读取 MCP 信息失败：{info.error instanceof Error ? info.error.message : '未知错误'}
        </p>
      )}

      {configJson !== null && (
        <>
          <pre
            data-testid="settings-mcp-config"
            className="mt-2 overflow-x-auto rounded border border-hairline bg-surface-page px-2 py-1.5 font-mono text-[11px] leading-5 whitespace-pre-wrap text-ink-2"
          >
            {configJson}
          </pre>
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              data-testid="settings-mcp-copy"
              onClick={() => void copy()}
              className={`mt-1 ${BUTTON_SECONDARY}`}
            >
              {copied ? '已复制' : '复制配置'}
            </button>
            {workspaceId === '' && (
              <p data-testid="settings-mcp-workspace-hint" className="mt-1 text-xs text-ink-3">
                工作区 id 取不到时请手填
              </p>
            )}
          </div>
        </>
      )}

      {data?.tools != null && (
        <div data-testid="settings-mcp-tools" className="mt-2 text-xs text-ink-2">
          <p>
            工具：主名 {data.tools.primary_count} 个 / 别名 {data.tools.alias_count} 个（协议 {data.tools.protocol_version}）
          </p>
          <details className="mt-1">
            <summary className="cursor-pointer text-ink-3">主名清单</summary>
            <ul className="mt-1 space-y-0.5">
              {data.tools.primary.map((name) => (
                <li key={name} className="font-mono text-[11px]">{name}</li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {warningText !== null && (
        <>
          <p role="alert" data-testid="settings-mcp-warning" className="mt-2 text-xs text-amber-700 dark:text-amber-400">
            {warningText}
          </p>
          <p data-testid="settings-mcp-build-hint" className="mt-1 text-xs text-ink-3">
            构建命令：<code className="font-mono">pnpm --filter @agentboard/mcp build</code>
          </p>
        </>
      )}
    </section>
  );
}
