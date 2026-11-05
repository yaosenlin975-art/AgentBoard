/**
 * 浏览器 WebSocket 连接 /ws（dev 经 Vite 代理，prod 由 server 同源托管）。
 * 断线 2s 重连；每条消息一个 JSON 事件（容忍一行一事件的多行拼接）。
 */
import type { ServerWsEvent } from '@agentboard/shared';
import type { QueryClient } from '@tanstack/react-query';
import type { WsStatus } from '../state/appStore';

export const RECONNECT_MS = 2000;

/**
 * CHAT-AWAIT2：前端按服务端实际广播的联合类型收事件（`ServerWsEvent` = `WsEvent` + 轮次观测事件）。
 * 轮次阻塞态（`session.turn`）与审批请求（`session.approval_request`）由 turnStore 经 wsBus 增量消费，
 * 与既有观测事件同口径：不触发 react-query invalidation。
 */
export function eventToQueryKeys(event: ServerWsEvent): unknown[][] {
  switch (event.type) {
    case 'issue.changed':
      return [
        ['issues', event.issue.workspace_id],
        ['issue', event.issue.id],
        // 依赖区（blocker 状态、被阻塞者增减）按前缀失效；不新增 WS 事件类型（设计 §17 末条）
        ['dependencies'],
      ];
    case 'issue.deleted':
      return [
        ['issues', event.workspace_id],
        ['issue', event.issue_id],
        ['dependencies'],
      ];
    case 'comment.added':
      // 载荷无 workspace_id，看板列表按 ['issues'] 前缀失效（与 DetailPanel 既有粒度一致）；
      // 详情 issue 对象含 comment_count，一并精确失效
      return [
        ['comments', event.comment.issue_id],
        ['issues'],
        ['issue', event.comment.issue_id],
        ...(event.comment.attachments?.length ? [['pending-attachments', event.comment.issue_id]] : []),
      ];
    case 'comment.delivery.changed':
      return [['comments', event.issue_id], ['pending-attachments', event.issue_id]];
    case 'session.changed':
      return [['sessions']];
    case 'session.deleted':
      return [['sessions']];
    case 'message.added':
      return [['messages', event.message.session_id]];
    case 'clis.changed':
      return [['clis']];
    case 'session.event':
      // 流式事件由聊天视图增量拼接（Task 14），不触发 invalidation
      return [];
    case 'session.runtime':
      // 运行时态（queued_count/槽位）由聊天视图经 wsBus 增量校正，不触发 invalidation（避免每次发送全量刷列表）
      return [];
    case 'account.notice':
      // 账号操作提示（如请求用户手动退出客户端），当前无对应查询需失效
      return [];
    case 'session.plan':
    case 'session.usage':
    case 'session.turn':
    case 'session.approval_request':
      // CHAT-VIS1 / CHAT-AWAIT2：轮次观测（计划条 / 成本脚注 / 阻塞态 / 审批请求）由 turnStore 经 wsBus 增量消费，
      // 不触发 invalidation——否则每个 tool 事件与每个 usage 窗口都会全量刷会话列表
      return [];
    case 'decision.grace_started':
    case 'decision.answered':
    case 'decision.expired':
    case 'decision.revised':
    case 'decision.withdrawn':
    case 'issue.stop_requested':
      // DEC-3：决策事件已进入 `ServerWsEvent`（服务端可广播）；前端待决策视图/通知归 DEC-6/DEC-7 消费，
      // 当前无对应查询需失效，返回空列表。
      return [];
    case 'session.paused':
    case 'session.resumed':
      // BORROW-4.3：暂停/恢复只改会话行上的 paused_at，无新增列表项。
      // `['sessions']` 前缀覆盖会话列表与侧栏（`['sessions', wsId]` / `['sessions', wsId, 'sidebar']`）；
      // 会话详情与 turn 列表不走 react-query（经 wsBus → turnStore 增量消费），没有可失效的 query key，
      // 恢复后的增量拉取由消费方从 `resume_after_seq` 继续，不在这里失效。
      return [['sessions']];
    default:
      // 新增 `ServerWsEvent` 类型默认不做缓存失效，确实需要刷新查询的必须在上方显式加 case。
      // 本分支同时保证穷尽 switch 不因联合类型扩展而失去出口（TS2366 已复发两次：decision.*、session.paused/resumed）。
      // 显式处理清单的完整性由 test/ws.test.ts 的事件夹具约束（Record<ServerWsEvent['type'], …> 缺键即编译失败）。
      return [];
  }
}

export interface ConnectWsOptions {
  queryClient: QueryClient;
  onEvent?: (event: ServerWsEvent) => void;
  onStatus?: (status: WsStatus) => void;
}

/** 连接 /ws 并自动失效受影响查询；返回清理函数 */
export function connectWs(options: ConnectWsOptions): () => void {
  const { queryClient, onEvent, onStatus } = options;
  let closedByUs = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const handleEvent = (event: ServerWsEvent): void => {
    onEvent?.(event);
    for (const key of eventToQueryKeys(event)) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };

  const handleMessage = (raw: unknown): void => {
    for (const line of String(raw).split('\n')) {
      const text = line.trim();
      if (text === '') continue;
      try {
        handleEvent(JSON.parse(text) as ServerWsEvent);
      } catch {
        // 非 JSON 行忽略
      }
    }
  };

  const open = (): void => {
    if (closedByUs) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    onStatus?.('connecting');
    try {
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    } catch {
      onStatus?.('closed');
      reconnectTimer = setTimeout(open, RECONNECT_MS);
      return;
    }
    ws.onopen = () => onStatus?.('open');
    ws.onmessage = (ev) => handleMessage(ev.data);
    // onerror 后必然跟随 onclose，重连统一在 onclose 处理
    ws.onclose = () => {
      onStatus?.('closed');
      if (!closedByUs) reconnectTimer = setTimeout(open, RECONNECT_MS);
    };
  };

  open();

  return () => {
    closedByUs = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    ws?.close();
  };
}
