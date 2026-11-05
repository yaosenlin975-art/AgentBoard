/**
 * 右侧面板视图状态：detail / ref 互斥，可整体收起（rightOpen）。
 * S2b（聊天整屏化）：聊天不再是右侧面板的一种视图，而是主区第五视图（`navStore.view === 'chat'`）；
 * `openChat` 只切 `navStore`，并把面板视图清空收起，保证「整屏聊天 + detail/ref 浮窗计数 0」。
 * openDetail/openRef 只切换视图并展开，不重置另一视图的数据：
 * 视图组件各持 react-query 缓存，往返切换不丢选中 issue。
 * chatSession 携带打开聊天时的会话对象（ChatPanel 刷新后经 GET /api/sessions/:id 兜底恢复，
 * 以此定位 workspace 并显示 CLI/模型；后续以 WS session.changed 覆盖）。
 * unread：各会话未读新消息计数，由 unreadCollector 在 wsBus 全局层统计
 * （message.added 且非当前会话 +1，openChat 清零，session.deleted 清对应计数），
 * 不依赖 ChatPanel 挂载。
 * 持久化 localStorage（键 agentboard.panel）：sessionId/chatSession/unread；
 * （view/issueId/rightOpen 是瞬时意图，不持久化 —— 见 PANEL-VIEW-BUG）
 * unread 重水合经 sanitizeUnread 容错（非对象/非正整数条目剔除，坏结构回空对象）。
 */
import { create } from 'zustand';
import { useNavStore } from './navStore';
import { persist } from 'zustand/middleware';
import type { Session } from '@agentboard/shared';

/** S2b：聊天已从面板视图移除（整屏由 navStore.view === 'chat' 表达） */
export type PanelView = 'detail' | 'ref';

/** 软链接浮窗目标（MD-LINKS）：知识页或日志详情，只带定位信息，正文由 RefPanel 自己拉取 */
export interface RefPanelTarget {
  kind: 'knowledge' | 'log';
  id: string;
  title: string;
}

/** 未读恢复容错：非对象/数组回空对象；仅保留正整数值条目（坏值剔除，0 值视为无未读不恢复） */
function sanitizeUnread(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [id, n] of Object.entries(value)) {
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) out[id] = n;
  }
  return out;
}

/** 草稿恢复容错：非对象/数组回空对象；只保留字符串草稿（空串也保留，避免已清空的草稿被历史值覆盖） */
function sanitizeDrafts(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [id, draft] of Object.entries(value)) {
    if (typeof draft === 'string') out[id] = draft;
  }
  return out;
}

interface PanelState {
  view: PanelView | null;
  issueId: string | null;
  sessionId: string | null;
  /** 打开聊天视图时携带的会话对象（同 sessionId 下被 WS session.changed 更新前的基础数据） */
  chatSession: Session | null;
  /** 各会话未读新消息计数（会话 id → 条数） */
  unread: Record<string, number>;
  /** 软链接浮窗目标（MD-LINKS），仅 view==='ref' 时有意义 */
  refPanel: RefPanelTarget | null;
  /**
   * 聊天输入草稿（CHAT-SB2）：按会话独立保存（会话 id → 草稿）。
   * DETAIL-VIEW-BUG2 的根因不变（视图同一时刻只挂载一个，ChatPanel 卸载会丢组件内 state），
   * 只是从单值改为按会话存，切会话互不覆盖；无会话时用空串键。
   */
  chatDrafts: Record<string, string>;
  setChatDraft: (sessionId: string | null, draft: string) => void;
  /** 右侧面板是否展开（收起保留 view/issueId/sessionId，展开按钮恢复） */
  rightOpen: boolean;
  /** 打开任务详情并展开右侧 */
  openDetail: (issueId: string) => void;
  /** 打开知识/日志软链接浮窗（MD-LINKS）并展开右侧 */
  openRef: (target: RefPanelTarget) => void;
  /** 切到聊天视图并展开右侧；不传 sessionId 时沿用当前选中会话 */
  openChat: (sessionId?: string, session?: Session) => void;
  /** 清空会话选择（会话按 id 恢复失败时回空态） */
  clearSession: () => void;
  /** 会话被删（session.deleted）：清其未读计数；被删的是当前选中会话时回空态 */
  removeSession: (sessionId: string) => void;
  /** 记一条未读（非当前聊天会话收到 message.added） */
  markUnread: (sessionId: string) => void;
  /** 清除某会话未读计数 */
  clearUnread: (sessionId: string) => void;
  /** 收起右侧面板（数据保留） */
  closeRight: () => void;
  /** 关闭浮窗并清空视图意图（view/issueId 归零，聊天会话与未读保留） */
  clearView: () => void;
}

export const usePanelStore = create<PanelState>()(
  persist(
    (set) => ({
      view: null,
      issueId: null,
      sessionId: null,
      chatSession: null,
      unread: {},
      refPanel: null,
      chatDrafts: {},
      rightOpen: false,
      setChatDraft: (sessionId, draft) =>
        set((s) => ({ chatDrafts: { ...s.chatDrafts, [sessionId ?? '']: draft } })),
      openDetail: (issueId) => {
        // S2b：从「整屏聊天」点任务卡时先把主区切回看板，否则详情浮窗会盖在整屏聊天上（切换不串）
        if (useNavStore.getState().view === 'chat') useNavStore.getState().setView('board');
        set({ view: 'detail', issueId, refPanel: null, rightOpen: true });
      },
      openRef: (target) => {
        if (useNavStore.getState().view === 'chat') useNavStore.getState().setView('board');
        set({ view: 'ref', refPanel: target, issueId: null, rightOpen: true });
      },
      openChat: (sessionId, session) => {
        // S2b：聊天是主区第五视图 → 只切 navStore；panelStore 只负责「把右侧浮窗清空收起」，
        // 不再写 `view`（'chat' 已不是 PanelView 的取值），保证整屏聊天时 detail/ref 浮窗计数为 0。
        useNavStore.getState().setView('chat');
        set((s) => {
          const id = sessionId ?? s.sessionId;
          return {
            view: null,
            // 关闭详情/引用浮窗：两者都是绝对定位覆盖层，不能与整屏聊天并存
            issueId: null,
            refPanel: null,
            sessionId: id,
            // 同会话沿用已存会话对象；换会话只认新传入的
            chatSession: session ?? (id === s.sessionId ? s.chatSession : null),
            unread: id !== null ? { ...s.unread, [id]: 0 } : s.unread,
            rightOpen: false,
          };
        });
      },
      clearSession: () => set({ sessionId: null, chatSession: null }),
      removeSession: (sessionId) =>
        set((s) => {
          const unread = { ...s.unread };
          delete unread[sessionId];
          // 会话删除后草稿一并丢弃，避免 localStorage 残留无主草稿
          const chatDrafts = { ...s.chatDrafts };
          delete chatDrafts[sessionId];
          return s.sessionId === sessionId
            ? { sessionId: null, chatSession: null, unread, chatDrafts }
            : { unread, chatDrafts };
        }),
      markUnread: (sessionId) =>
        set((s) => ({ unread: { ...s.unread, [sessionId]: (s.unread[sessionId] ?? 0) + 1 } })),
      clearUnread: (sessionId) => set((s) => ({ unread: { ...s.unread, [sessionId]: 0 } })),
      closeRight: () => set({ rightOpen: false }),
      clearView: () => set({ view: null, issueId: null, refPanel: null, rightOpen: false }),
    }),
    {
      name: 'agentboard.panel',
      // PANEL-VIEW-BUG：视图意图（view/issueId/rightOpen）不持久化 —— 刷新后一律「无视图」，
      // 由用户点击入口（任务卡 / 顶栏聊天）决定显示什么，杜绝「上次停在聊天 → 刷新点任务却出聊天」。
      // 会话选择与未读计数仍持久化（聊天恢复与未读徽标依赖它们）。
      partialize: (state) => ({
        sessionId: state.sessionId,
        chatSession: state.chatSession,
        unread: state.unread,
        chatDrafts: state.chatDrafts,
      }),
      // 重水合容错：unread 做结构/取值校验（脏数据回空对象，不抛错）；
      // 视图意图一律丢弃 —— 旧版快照里可能残留 `view:'chat'`（S2b 前聊天曾是面板视图），
      // 该值已不是合法 PanelView，带回来就是脏状态，统一落 null（PANEL-VIEW-BUG / S2b）。
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PanelState>;
        return {
          ...current,
          sessionId: typeof p.sessionId === 'string' ? p.sessionId : null,
          chatSession: p.chatSession ?? null,
          unread: sanitizeUnread(p.unread),
          chatDrafts: sanitizeDrafts(p.chatDrafts),
          view: null,
          issueId: null,
          rightOpen: false,
        };
      },
    },
  ),
);



