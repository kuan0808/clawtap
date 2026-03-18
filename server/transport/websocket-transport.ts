import { EventEmitter } from 'events';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import type { Server as HttpServer } from 'http';
import type { Server as HttpsServer } from 'https';
import { verifyWebSocketToken } from '../auth.js';
import { WebSocketConnection } from './websocket-connection.js';
import type { ClientConnection } from './client-connection.js';
import type { ClientMessage } from '../types/messages.js';

/**
 * WebSocketTransport — manages the WebSocket server lifecycle.
 *
 * Emits:
 *   'connection' (conn: ClientConnection) — new authenticated client connected
 *   'message'    (conn: ClientConnection, msg: ClientMessage) — parsed message from client
 */
export class WebSocketTransport extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  /** Create WebSocketServer on /ws path with JWT verification and ping/pong keepalive. */
  setup(server: HttpServer | HttpsServer): void {
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      verifyClient: ({ req }, cb) => {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const token = url.searchParams.get('token');
        if (!token || !verifyWebSocketToken(token)) {
          cb(false, 401, 'Unauthorized');
          return;
        }
        cb(true);
      },
    });

    this.wss.on('connection', (ws: WebSocket) => {
      const conn = new WebSocketConnection(ws);

      this.emit('connection', conn);

      ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(raw.toString()) as ClientMessage;
        } catch {
          conn.send({ type: 'error', error: 'Invalid JSON' });
          return;
        }
        this.emit('message', conn, msg);
      });
    });

    // Ping/pong keepalive every 30s
    this.pingInterval = setInterval(() => {
      if (!this.wss) return;
      for (const ws of this.wss.clients) {
        if (ws.readyState === 1) {
          ws.ping();
        }
      }
    }, 30_000);
    this.pingInterval.unref();
  }

  /** Shut down the WebSocket server and stop keepalive. */
  destroy(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }
}
