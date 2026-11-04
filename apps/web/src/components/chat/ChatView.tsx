/**
 * 聊天整屏视图容器（S3，设计稿 `Docs/designs/chat/2026-11-04-nav-sidebar-chat-view.md` §5）。
 *
 * 结构：左会话列表 250px（ChatSessionList）+ 右消息区（ChatPanel）。
 * 设计 §11 把拆法留给实施者：会话列表独立成组件，ChatPanel 保持消息渲染与发送职责不变，
 * 本容器只管两栏拼装与「新建会话」弹窗（入口在列表顶部，弹窗归属容器，避免两处各持一份 state）。
 *
 * 默认选中口径在 ChatSessionList（面板里有 sessions 才谈得上最近一条）；本容器不做选择逻辑。
 */
import { useState } from 'react';
import { useAppStore } from '../../state/appStore';
import { usePanelStore } from '../../state/panelStore';
import { ChatPanel } from './ChatPanel';
import { ChatSessionList } from './ChatSessionList';
import { NewSessionDialog } from './NewSessionDialog';

export function ChatView() {
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const currentWorkspaceId = usePanelStore((s) => s.chatSession?.workspace_id ?? null);
  const appWorkspaceId = useAppStore((s) => s.workspaceId);
  // 新建会话的工作空间默认值：当前会话所属空间优先，其次应用当前空间（自由会话 workspace_id 必填）
  const defaultWorkspaceId = currentWorkspaceId ?? appWorkspaceId;

  return (
    <div data-testid="chat-view-body" className="flex h-full min-h-0">
      <ChatSessionList onNewSession={() => setNewDialogOpen(true)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatPanel onNewSession={() => setNewDialogOpen(true)} />
      </div>
      {newDialogOpen && (
        <NewSessionDialog defaultWorkspaceId={defaultWorkspaceId} onClose={() => setNewDialogOpen(false)} />
      )}
    </div>
  );
}
