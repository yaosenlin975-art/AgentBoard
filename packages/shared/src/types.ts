export type IssueStatus = '待规划' | '进行中' | '待验收' | '已关闭';
export type Priority = '低' | '中' | '高';
export type SessionStatus = '运行中' | '已结束' | '失败';
export type CommentAuthor = string; // 'user' | 'agent:<cliId>' | 'system'
export interface Workspace { id: string; name: string; path: string; created_at: number }
export interface Issue {
  id: string; workspace_id: string; title: string; description: string;
  priority: Priority; labels: string[]; status: IssueStatus; sort_order: number;
  claimed_by: string | null; claimed_at: number | null; session_id: string | null;
  created_at: number; updated_at: number;
}
export interface IssueComment { id: string; issue_id: string; author: CommentAuthor; content: string; ts: number }
export interface Session {
  id: string; workspace_id: string; issue_id: string | null; cli: string; model: string | null;
  status: SessionStatus; adapter_session_id: string | null; created_at: number;
}
export interface Message { id: string; session_id: string; role: 'user' | 'assistant' | 'event' | 'error'; content: string; ts: number }
export interface CliInfo { id: string; displayName: string; installed: boolean; version: string | null }
export interface ModelInfo { id: string; source: 'probed' | 'static' | 'manual' }
export type WsEvent =
  | { type: 'issue.changed'; issue: Issue }
  | { type: 'comment.added'; comment: IssueComment }
  | { type: 'session.changed'; session: Session }
  | { type: 'session.event'; session_id: string; event: { type: 'text' | 'tool' | 'error' | 'end'; [k: string]: unknown } }
  | { type: 'message.added'; message: Message }
  | { type: 'clis.changed'; clis: CliInfo[] };
