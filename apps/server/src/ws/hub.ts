/**
 * Task 9：/ws 升级与广播 hub。
 *
 * broadcast 把一个 WsEvent 序列化为单行 JSON 推给全部 OPEN 客户端；
 * index.ts 装配 sessionManager.setBroadcaster(hub.broadcast)。
 */
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ServerWsEvent } from '@agentboard/shared';

export interface WsHub {
  /**
   * 向全部在线客户端广播一个事件（JSON 一行）。
   * CHAT-TURN1：参数放宽到 `ServerWsEvent`（= 前端 `WsEvent` + 轮次观测事件），
   * 广播方（routes / sessionManager / provider）传 `WsEvent` 依然可赋值，行为不变。
   */
  broadcast(event: ServerWsEvent): void;
  /** 在 HTTP server 上挂 upgrade 处理（路径 /ws） */
  attach(server: HttpServer): void;
  /** 当前 OPEN 连接数（冒烟/测试观察用） */
  clientCount(): number;
}

export function createWsHub(): WsHub {
  const wss = new WebSocketServer({ noServer: true });
  // 连接即推送当前快照：可选行为，暂不做（前端经 REST 拉初始态）

  return {
    broadcast(event) {
      const payload = JSON.stringify(event);
      for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        try {
          client.send(payload);
        } catch {
          // 验收 4：没有监听方 / 客户端在发送瞬间关闭时不得炸广播链路。
          // 观测事件（session.plan / session.usage）丢掉一条不影响正确性：
          // 前端下一次快照/重连后以服务端状态为准。
        }
      }
    },
    attach(server) {
      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        // 同一 upgrade 事件会依次触发所有监听：语音会话 WS 已由 attachVoiceWebSocket 接管，
        // 这里必须跳过，否则会把刚握手成功的语音连接 destroy（表现为音频帧一帧都收不到）。
        if (url.pathname.startsWith('/api/voice/session/')) return;
        if (url.pathname !== '/ws') {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      });
    },
    clientCount() {
      let n = 0;
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) n += 1;
      }
      return n;
    },
  };
}
