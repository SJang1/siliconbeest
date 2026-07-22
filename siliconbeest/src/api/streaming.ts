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
  | 'notifications_read'
  | 'new_items'
  | 'reaction';

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
  /** Coalesced body-free update hint received while content delivery is paused. */
  onNewItems?: (count: number, streams: Record<string, number>) => void;
  /** A status's emoji reactions changed — payload carries the status id. */
  onReaction?: (statusId: string) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export class StreamingClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30000;
  private connectTimeoutMs = 30000;
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
    if (typeof window === 'undefined') return;

    this.intentionalClose = false;
    this.cleanup();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const url = new URL(`${protocol}//${host}/api/v1/streaming`);
    url.searchParams.set('stream', this.stream);
    if (!this.hasAuthCookie()) {
      url.searchParams.set('access_token', this.token);
    }
    const urlString = url.toString();

    this.log('connecting', {
      url: this.redactAccessToken(urlString),
      readyState: this.ws?.readyState ?? null,
    });

    try {
      this.ws = new WebSocket(urlString);
      this.log('constructed', {
        readyState: this.ws.readyState,
        url: this.redactAccessToken(this.ws.url),
      });
    } catch (error) {
      this.log('connect constructor failed', { error });
      this.scheduleReconnect();
      return;
    }

    this.connectTimer = setTimeout(() => {
      if (this.ws?.readyState === WebSocket.CONNECTING) {
        this.log('connect timeout', {
          timeoutMs: this.connectTimeoutMs,
          readyState: this.ws.readyState,
        });
        this.ws.close();
      }
    }, this.connectTimeoutMs);

    this.ws.onopen = () => {
      this.clearConnectTimer();
      this.reconnectAttempts = 0;
      this.callbacks.onConnect?.();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event);
    };

    this.ws.onclose = (event: CloseEvent) => {
      this.clearConnectTimer();
      this.log('closed', {
        code: event.code,
        reason: event.reason || null,
        wasClean: event.wasClean,
        readyState: this.ws?.readyState,
      });
      this.callbacks.onDisconnect?.();
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (event: Event) => {
      this.log('error', {
        readyState: this.ws?.readyState,
        eventType: event.type,
      });
      // onclose will fire after onerror, so reconnect is handled there
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.cleanup();
  }

  isActive(): boolean {
    return this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING;
  }

  pauseContent(): void {
    this.sendControl({ type: 'pause_content', stream: this.stream });
  }

  resumeContent(): void {
    this.sendControl({ type: 'resume_content', stream: this.stream });
  }

  private sendControl(message: { type: string; stream: string }): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private cleanup(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearConnectTimer();

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

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
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
      case 'new_items': {
        if (this.callbacks.onNewItems) {
          try {
            const value = JSON.parse(data.payload) as {
              count?: unknown;
              streams?: unknown;
            };
            const count = typeof value.count === 'number' && value.count > 0
              ? Math.floor(value.count)
              : 0;
            const streams = value.streams && typeof value.streams === 'object'
              ? value.streams as Record<string, number>
              : {};
            if (count > 0) this.callbacks.onNewItems(count, streams);
          } catch { /* ignore */ }
        }
        break;
      }
      case 'reaction': {
        if (this.callbacks.onReaction) {
          try {
            const { status_id } = JSON.parse(data.payload) as { status_id: string };
            if (status_id) this.callbacks.onReaction(status_id);
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
    this.log('reconnect scheduled', { delayMs: delay, attempt: this.reconnectAttempts });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private log(message: string, data?: Record<string, unknown>): void {
    if (
      typeof window === 'undefined' ||
      (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1')
    ) return;
    console.warn(`[streaming:${this.stream}] ${message}`, data ?? {});
  }

  private redactAccessToken(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.searchParams.has('access_token')) {
        parsed.searchParams.set('access_token', 'REDACTED');
      }
      return parsed.toString();
    } catch {
      return url.replace(/access_token=[^&]+/, 'access_token=REDACTED');
    }
  }

  private hasAuthCookie(): boolean {
    return document.cookie
      .split(';')
      .some((part) => part.trim().startsWith('siliconbeest_token='));
  }
}
