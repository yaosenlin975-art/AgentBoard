/**
 * Task 9：/ws 升级与广播 hub。
 *
 * broadcast 把一个 WsEvent 序列化为单行 JSON 推给全部 OPEN 客户端；
 * index.ts 装配 sessionManager.setBroadcaster(hub.broadcast)。
 */
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { WsEvent } from '@agentboard/shared';

export interface WsHub {
  /** 向全部在线客户端广播一个事件（JSON 一行） */
  broadcast(event: WsEvent): void;
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
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      }
    },
    attach(server) {
      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
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
