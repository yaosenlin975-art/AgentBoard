/**
 * MCP 设置分区（GET /api/system/mcp-info）：
 * 覆盖：正常响应（标题 / JSON 正斜杠路径 / 三个 AGENTBOARD_ 键 / 工具计数与主名清单）、
 * 复制配置写入剪贴板（内容可 parse 且 args[0] 为正斜杠路径）、
 * tools_error 与 mcp_built=false 的警示行 + 构建命令提示、工作区 id 缺失提示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { McpSection } from '../components/settings/McpSection';
import { useAppStore } from '../state/appStore';
import { server } from './server';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');

function stubClipboard(impl: { writeText: ReturnType<typeof vi.fn> } | undefined): void {
  Object.defineProperty(navigator, 'clipboard', { value: impl, configurable: true, writable: true });
}

interface McpInfoMock {
  mcp_entry: string;
  mcp_built: boolean;
  base_url: string;
  tools: { protocol_version: string; primary: string[]; primary_count: number; alias_count: number } | null;
  tools_error: string | null;
}

const MCP_INFO: McpInfoMock = {
  mcp_entry: 'D:\\repos\\agentboard\\apps\\mcp\\dist\\index.js',
  mcp_built: true,
  base_url: 'http://127.0.0.1:9000',
  tools: {
    protocol_version: '2025-06-18',
    primary: ['search_issues', 'create_issue', 'update_issue'],
    primary_count: 40,
    alias_count: 12,
  },
  tools_error: null,
};

function mockMcpInfo(over: Partial<McpInfoMock> = {}): void {
  server.use(http.get('/api/system/mcp-info', () => HttpResponse.json({ ...MCP_INFO, ...over })));
}

function renderSection(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <McpSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ workspaceId: 'ws-1' });
});

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
  if (originalExecCommand) Object.defineProperty(document, 'execCommand', originalExecCommand);
  else delete (document as { execCommand?: unknown }).execCommand;
});

describe('MCP 分区', () => {
  it('正常响应：标题 / JSON 含正斜杠路径与三个 AGENTBOARD_ 键 / 工具计数与主名清单', async () => {
    mockMcpInfo();
    renderSection();

    expect(await screen.findByTestId('settings-section-mcp')).toBeInTheDocument();
    expect(screen.getByText('MCP（模型上下文协议）')).toBeInTheDocument();
    const config = await screen.findByTestId('settings-mcp-config');
    expect(config.textContent).toContain('D:/repos/agentboard/apps/mcp/dist/index.js');
    expect(config.textContent).not.toContain('\\');
    for (const key of ['AGENTBOARD_BASE_URL', 'AGENTBOARD_WORKSPACE_ID', 'AGENTBOARD_AGENT_ID']) {
      expect(config.textContent).toContain(key);
    }
    expect(config.textContent).toContain('"AGENTBOARD_WORKSPACE_ID": "ws-1"');
    const tools = screen.getByTestId('settings-mcp-tools');
    expect(tools).toHaveTextContent('主名 40 个');
    expect(tools).toHaveTextContent('别名 12 个（协议 2025-06-18）');
    for (const name of MCP_INFO.tools!.primary) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    // 工作区 id 已取到：不显示手填提示
    expect(screen.queryByTestId('settings-mcp-workspace-hint')).toBeNull();
    expect(screen.queryByTestId('settings-mcp-warning')).toBeNull();
  });

  it('复制配置：写入剪贴板的内容是合法 JSON，parse 后 args[0] 为正斜杠路径，按钮短暂变「已复制」', async () => {
    mockMcpInfo();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });
    renderSection();

    await userEvent.click(await screen.findByTestId('settings-mcp-copy'));
    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = writeText.mock.calls[0]![0] as string;
    const parsed = JSON.parse(payload) as {
      mcpServers: { agentboard: { command: string; args: string[]; env: Record<string, string> } };
    };
    expect(parsed.mcpServers.agentboard.command).toBe('node');
    expect(parsed.mcpServers.agentboard.args[0]).toBe('D:/repos/agentboard/apps/mcp/dist/index.js');
    expect(parsed.mcpServers.agentboard.env).toMatchObject({
      AGENTBOARD_BASE_URL: 'http://127.0.0.1:9000',
      AGENTBOARD_WORKSPACE_ID: 'ws-1',
      AGENTBOARD_AGENT_ID: 'your-agent-name',
    });
    expect(await screen.findByText('已复制')).toBeInTheDocument();
  });

  it('tools_error 非空：警示行显示错误文案 + 构建命令提示可见', async () => {
    mockMcpInfo({ tools_error: '工具清单加载失败：入口模块缺失', tools: null });
    renderSection();

    expect(await screen.findByTestId('settings-mcp-warning')).toHaveTextContent('工具清单加载失败：入口模块缺失');
    expect(screen.getByTestId('settings-mcp-build-hint')).toHaveTextContent('pnpm --filter @agentboard/mcp build');
    expect(screen.queryByTestId('settings-mcp-tools')).toBeNull();
  });

  it('mcp_built=false 且无 tools_error：警示「MCP 未构建」+ 构建命令提示', async () => {
    mockMcpInfo({ mcp_built: false, tools: null });
    renderSection();

    expect(await screen.findByTestId('settings-mcp-warning')).toHaveTextContent('MCP 未构建');
    expect(screen.getByTestId('settings-mcp-build-hint')).toHaveTextContent('pnpm --filter @agentboard/mcp build');
  });

  it('工作区 id 取不到：JSON 留空串 + 提示手填', async () => {
    mockMcpInfo();
    useAppStore.setState({ workspaceId: null });
    renderSection();

    const config = await screen.findByTestId('settings-mcp-config');
    expect(config.textContent).toContain('"AGENTBOARD_WORKSPACE_ID": ""');
    expect(screen.getByTestId('settings-mcp-workspace-hint')).toHaveTextContent('工作区 id 取不到时请手填');
  });
});
