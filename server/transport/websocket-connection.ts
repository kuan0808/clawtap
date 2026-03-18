import type WebSocket from 'ws';
import { ClientConnection } from './client-connection.js';
import type { ServerMessage } from '../types/messages.js';

/**
 * WebSocketConnection — wraps a raw ws.WebSocket as a ClientConnection.
 */
export class WebSocketConnection extends ClientConnection {
  private ws: WebSocket;

  constructor(ws: WebSocket) {
    super('websocket');
    this.ws = ws;
    ws.on('close', () => this.notifyDisconnect());
  }

  send(message: ServerMessage): void {
    try {
      if (this.ws.readyState === 1) this.ws.send(JSON.stringify(message));
    } catch {}
  }

  sendRaw(json: string): void {
    try {
      if (this.ws.readyState === 1) this.ws.send(json);
    } catch {}
  }

  isAlive(): boolean {
    return this.ws.readyState === 1;
  }

  close(): void {
    this.ws.close();
  }

  /** Access the underlying WebSocket (for ping/pong, etc.) */
  get rawWs(): WebSocket { return this.ws; }
}
