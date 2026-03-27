import { WS } from './ws-types';

export type WsStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

type MessageHandler = (msg: any) => void;
type StatusHandler = (status: WsStatus) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private onMessage: MessageHandler;
  private onStatus: StatusHandler;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private shouldReconnect = true;
  private activeSessionId: string | null = null;
  private activeAdapter: string | null = null;

  constructor(token: string, onMessage: MessageHandler, onStatus: StatusHandler) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.url = `${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
  }

  connect() {
    this.shouldReconnect = true;
    this.onStatus('connecting');

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.onStatus('connected');

      if (this.activeSessionId) {
        this.send({ type: WS.RECONNECT, sessionId: this.activeSessionId, adapter: this.activeAdapter });
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === WS.SESSION_CREATED) {
          this.activeSessionId = msg.sessionId;
          if (msg.adapter) this.activeAdapter = msg.adapter;
        }
        this.onMessage(msg);
      } catch {}
    };

    this.ws.onclose = () => {
      this.onStatus('disconnected');
      if (this.shouldReconnect) {
        this.onStatus('reconnecting');
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      }
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  send(msg: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  setActiveSession(sessionId: string | null, adapter?: string | null) {
    this.activeSessionId = sessionId;
    this.activeAdapter = adapter || null;
  }

  disconnect() {
    this.shouldReconnect = false;
    this.ws?.close();
    this.ws = null;
  }
}
