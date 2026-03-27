/**
 * WebSocket streaming client for Mastodon Streaming API.
 *
 * Connects to /api/v1/streaming via WebSocket upgrade.
 * Auto-reconnects with exponential backoff.
 * Parses Mastodon streaming events and dispatches to callbacks.
 */

import type { Status, Notification } from '@/types/mastodon';

export interface EmojiInfo {
  shortcode: string;
  url: string;
  static_url: string;
  domain: string;
}

export type StreamEventType =
  | 'update'
  | 'notification'
  | 'delete'
  | 'status.update'
  | 'filters_changed'
  | 'emoji_update'
  | 'notifications_read';

export interface StreamEvent {
  event: StreamEventType;
  payload: string; // JSON string
  stream?: string[];
}

export interface StreamCallbacks {
  onUpdate?: (status: Status) => void;
  onNotification?: (notification: Notification) => void;
  onDelete?: (statusId: string) => void;
  onStatusUpdate?: (status: Status) => void;
  onFiltersChanged?: () => void;
  onEmojiUpdate?: (emojis: EmojiInfo[]) => void;
  onNotificationsRead?: (count: number) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export class StreamingClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30000;
  private intentionalClose = false;

  private token: string;
  private stream: string;
  private callbacks: StreamCallbacks;

  constructor(token: string, stream: string, callbacks: StreamCallbacks) {
    this.token = token;
    this.stream = stream;
    this.callbacks = callbacks;
  }

  connect(): void {
    this.intentionalClose = false;
    this.cleanup();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const url = `${protocol}//${host}/api/v1/streaming?stream=${encodeURIComponent(this.stream)}&access_token=${encodeURIComponent(this.token)}`;

    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.callbacks.onConnect?.();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event);
    };

    this.ws.onclose = () => {
      this.callbacks.onDisconnect?.();
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror, so reconnect is handled there
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.cleanup();
  }

  private cleanup(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;

      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  private handleMessage(event: MessageEvent): void {
    let data: StreamEvent;
    try {
      data = JSON.parse(event.data as string) as StreamEvent;
    } catch {
      return;
    }

    switch (data.event) {
      case 'update': {
        if (this.callbacks.onUpdate) {
          try {
            const status = JSON.parse(data.payload) as Status;
            this.callbacks.onUpdate(status);
          } catch { /* ignore malformed payload */ }
        }
        break;
      }
      case 'notification': {
        if (this.callbacks.onNotification) {
          try {
            const notification = JSON.parse(data.payload) as Notification;
            this.callbacks.onNotification(notification);
          } catch { /* ignore malformed payload */ }
        }
        break;
      }
      case 'delete': {
        if (this.callbacks.onDelete) {
          // delete payload is just the status ID string
          this.callbacks.onDelete(data.payload);
        }
        break;
      }
      case 'status.update': {
        if (this.callbacks.onStatusUpdate) {
          try {
            const status = JSON.parse(data.payload) as Status;
            this.callbacks.onStatusUpdate(status);
          } catch { /* ignore malformed payload */ }
        }
        break;
      }
      case 'filters_changed': {
        this.callbacks.onFiltersChanged?.();
        break;
      }
      case 'emoji_update': {
        if (this.callbacks.onEmojiUpdate) {
          try {
            const emojis = JSON.parse(data.payload) as EmojiInfo[];
            this.callbacks.onEmojiUpdate(emojis);
          } catch { /* ignore */ }
        }
        break;
      }
      case 'notifications_read': {
        if (this.callbacks.onNotificationsRead) {
          try {
            const { count } = JSON.parse(data.payload) as { count: number };
            this.callbacks.onNotificationsRead(count);
          } catch { /* ignore */ }
        }
        break;
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay,
    );
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
