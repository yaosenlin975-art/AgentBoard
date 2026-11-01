/**
 * 未读计数全局收集器（issue 6def6819）：message.added → markUnread 从 ChatPanel
 * 提升到 wsBus 全局层（模块加载即 subscribeWsEvents，非组件生命周期），面板收起、
 * 切 detail 视图等 ChatPanel 未挂载期间的新消息同样计数；计数与清零动作在
 * panelStore（unread 随 agentboard.panel 持久化，刷新恢复）。
 * 计数规则与原 ChatPanel 分支一致：非当前选中会话每条 message.added +1（含 assistant
 * 落定消息），当前会话消息不计；openChat 打开对应会话即清零。
 * session.deleted → clearUnread：被删会话的未读条目不再残留（此前该清理仅在 ChatPanel
 * 挂载且为当前会话时经 removeSession 发生）。
 * 本模块需在应用启动即加载（ChatPanel 静态 import），订阅进程内单份。
 */
import { subscribeWsEvents } from '../api/wsBus';
import { usePanelStore } from './panelStore';

subscribeWsEvents((event) => {
  const { markUnread, clearUnread, sessionId } = usePanelStore.getState();
  if (event.type === 'message.added') {
    if (event.message.session_id !== sessionId) markUnread(event.message.session_id);
  } else if (event.type === 'session.deleted') {
    clearUnread(event.session_id);
  }
});
