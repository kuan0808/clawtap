import crypto from 'crypto';
import type { ServerMessage } from '../types/messages.js';

/**
 * ClientConnection — abstract base class for transport-agnostic client connections.
 *
 * Each connected client (WebSocket, SSE, etc.) is represented by a ClientConnection.
 * SessionManager works exclusively with this abstraction — never with raw WebSocket.
 */
export abstract class ClientConnection {
  readonly clientId: string = crypto.randomUUID();
  readonly transportName: string;
  sessionId: string | null = null;
  onDisconnect: ((conn: ClientConnection) => void) | null = null;

  constructor(transportName: string) {
    this.transportName = transportName;
  }

  /** Send a message to this client. Implementation handles serialization. */
  abstract send(message: ServerMessage): void;

  /** Check if the connection is still alive. */
  abstract isAlive(): boolean;

  /** Close the connection. */
  close(): void {}

  /** Filter: should this client receive a given message? Default: yes. */
  shouldReceive(_message: ServerMessage): boolean { return true; }

  /** Send a pre-serialized JSON string. Default fallback parses and calls send(). */
  sendRaw(json: string): void { this.send(JSON.parse(json)); }

  /** Notify the disconnect handler (called by subclass when connection drops). */
  notifyDisconnect(): void { this.onDisconnect?.(this); }
}
