/**
 * CHAT-STREAM-PROBE 测试：聊天头部按会话 CLI 的流式粒度给轻量提示。
 * - block（codex/dsh）与 none（opencode）渲染提示；
 * - token（codebuddy）与未声明（未知）不渲染提示。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { CliInfo, Session, StreamingGranularity, Workspace } from '@agentboard/shared';
import { ChatPanel } from '../components/chat/ChatPanel';
import { useAppStore } from '../state/appStore';
import { usePanelStore } from '../state/panelStore';
import { useStreamingStore } from '../state/streamingStore';
import { useTurnStore } from '../state/turnStore';
import { server } from './server';

const ws: Workspace = { id: 'ws-1', name: '主项目', path: 'D:/ws/main', created_at: 1 };

function makeSession(cli: string): Session {
  return {
    id: 's1',
    workspace_id: 'ws-1',
    issue_id: null,
    cli,
    model: 'm1',
    status: '已结束',
    adapter_session_id: null,
    created_at: 1,
  };
}

function makeCli(id: string, streaming?: StreamingGranularity): CliInfo {
  return {
    id,
    displayName: id,
    installed: true,
    version: '1.0.0',
    supportsModelSelection: true,
    ...(streaming !== undefined ? { streaming } : {}),
  };
}

function mockApi(session: Session, clis: CliInfo[]): void {
  server.use(
    http.get('/api/sessions', () => HttpResponse.json([session])),
    http.get('/api/sessions/:id', () => HttpResponse.json({ ...session, turns: [] })),
    http.get('/api/sessions/:id/messages', () => HttpResponse.json([])),
    http.get('/api/sessions/:id/queue', () => HttpResponse.json({ texts: [] })),
    http.get('/api/workspaces', () => HttpResponse.json([ws])),
    http.get('/api/clis', () => HttpResponse.json(clis)),
    http.get('/api/skills', () => HttpResponse.json({ items: [] })),
    http.get('/api/issues', () => HttpResponse.json([])),
  );
}

function renderChat(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ChatPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useTurnStore.getState().reset();
  useAppStore.setState({ workspaceId: 'ws-1' });
  usePanelStore.setState({
    view: null,
    issueId: null,
    sessionId: null,
    chatSession: null,
    unread: {},
    rightOpen: false,
  });
  useStreamingStore.setState({ streams: new Map() });
});

describe('聊天头部流式粒度提示', () => {
  it('block（codex）→ 渲染「按段输出」提示', async () => {
    const session = makeSession('codex');
    usePanelStore.setState({ sessionId: 's1', chatSession: session });
    mockApi(session, [makeCli('codex', 'block')]);
    renderChat();

    const hint = await screen.findByTestId('chat-streaming-hint');
    expect(hint).toHaveTextContent('按段输出，非逐字流式');
    expect(hint.getAttribute('title')).toContain('该 CLI 按段输出，非逐字流式');
  });

  it('none（opencode）→ 渲染「一次性输出」提示', async () => {
    const session = makeSession('opencode');
    usePanelStore.setState({ sessionId: 's1', chatSession: session });
    mockApi(session, [makeCli('opencode', 'none')]);
    renderChat();

    const hint = await screen.findByTestId('chat-streaming-hint');
    expect(hint).toHaveTextContent('一次性输出，无流式');
  });

  it('token（codebuddy）→ 不渲染提示', async () => {
    const session = makeSession('codebuddy');
    usePanelStore.setState({ sessionId: 's1', chatSession: session });
    mockApi(session, [makeCli('codebuddy', 'token')]);
    renderChat();

    await screen.findByTestId('chat-panel');
    expect(screen.queryByTestId('chat-streaming-hint')).toBeNull();
  });

  it('粒度未声明（旧缓存/未知）→ 不渲染提示', async () => {
    const session = makeSession('dsh');
    usePanelStore.setState({ sessionId: 's1', chatSession: session });
    mockApi(session, [makeCli('dsh')]);
    renderChat();

    await screen.findByTestId('chat-panel');
    expect(screen.queryByTestId('chat-streaming-hint')).toBeNull();
  });
});
