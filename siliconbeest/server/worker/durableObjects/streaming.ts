/**
 * StreamingDO — Durable Object for Mastodon Streaming API
 *
 * Uses Hibernatable WebSockets with serializeAttachment/deserializeAttachment
 * to persist stream subscriptions across hibernation cycles.
 *
 * Based on Cloudflare's official WebSocket Hibernation example:
 * https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/
 */

import { DurableObject } from 'cloudflare:workers';
import type { StreamEventPayload } from '../internal-contract';

function streamEventBytes(event: StreamEventPayload): number {
  return new TextEncoder().encode(JSON.stringify(event)).byteLength;
}

interface SessionAttachment {
  streams: string[];
  allowedStreams: string[];
  pausedStreams: string[];
  pendingNewItems: Record<string, number>;
}

function normalizeAttachment(attachment: SessionAttachment): SessionAttachment {
  return {
    streams: Array.isArray(attachment.streams) ? attachment.streams : [],
    allowedStreams: Array.isArray(attachment.allowedStreams) ? attachment.allowedStreams : [],
    pausedStreams: Array.isArray(attachment.pausedStreams) ? attachment.pausedStreams : [],
    pendingNewItems: attachment.pendingNewItems && typeof attachment.pendingNewItems === 'object'
      ? attachment.pendingNewItems
      : {},
  };
}

function parseAllowedStreams(header: string | null): string[] {
  if (!header) return [];
  try {
    const value: unknown = JSON.parse(header);
    return Array.isArray(value)
      ? value.filter((stream): stream is string => typeof stream === 'string')
      : [];
  } catch {
    return [];
  }
}

export class StreamingDO extends DurableObject {
  // Reconstructed from hibernating WebSockets in constructor
  sessions: Map<WebSocket, SessionAttachment>;
  countFlushScheduled = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sessions = new Map();

    // Restore hibernating WebSocket sessions
    this.ctx.getWebSockets().forEach((ws) => {
      const attachment = ws.deserializeAttachment() as SessionAttachment | null;
      if (attachment && Array.isArray(attachment.allowedStreams)) {
        this.sessions.set(ws, normalizeAttachment(attachment));
      } else {
        // Pre-policy hibernated sockets have no verified scope attachment.
        try { ws.close(1008, 'Reconnect required'); } catch { /* ignore */ }
      }
    });

    // Auto-respond to ping/pong without waking the DO
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    );
  }

  async sendEvent(event: StreamEventPayload): Promise<void> {
    const maxBytes = Number(this.env.STREAM_EVENT_MAX_BYTES || 98_304);
    if (streamEventBytes(event) > maxBytes) {
      console.warn(JSON.stringify({ message: 'stream event dropped: payload too large', maxBytes }));
      return;
    }
    await this.#broadcast(event);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for streaming
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const stream = url.searchParams.get('stream') || 'user';
      const allowedStreams = parseAllowedStreams(
        request.headers.get('X-Siliconbeest-Allowed-Streams'),
      );
      if (!allowedStreams.includes(stream)) {
        return new Response('This action is outside the authorized scopes', { status: 403 });
      }

      const requestedSocketLimit = Number(request.headers.get('X-Siliconbeest-Socket-Limit'));
      const socketLimit = Number.isInteger(requestedSocketLimit)
        ? Math.min(Math.max(requestedSocketLimit, 4), 1_000)
        : 32;
      if (this.ctx.getWebSockets().length >= socketLimit) {
        return new Response('Streaming leaf is at capacity', {
          status: 503,
          headers: { 'Retry-After': '1' },
        });
      }

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      // Accept with hibernation support
      this.ctx.acceptWebSocket(server);

      // Store stream subscription in attachment — survives hibernation
      const attachment: SessionAttachment = {
        streams: [stream],
        allowedStreams,
        pausedStreams: [],
        pendingNewItems: {},
      };
      server.serializeAttachment(attachment);

      // Also keep in-memory map for immediate broadcast
      this.sessions.set(server, attachment);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    return new Response('Expected WebSocket upgrade', { status: 400 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const data = JSON.parse(
        typeof message === 'string' ? message : new TextDecoder().decode(message),
      ) as { type?: unknown; stream?: unknown };

      if (data.type === 'subscribe' && typeof data.stream === 'string') {
        const session = this.sessions.get(ws);
        if (!session?.allowedStreams.includes(data.stream)) {
          ws.send(JSON.stringify({ error: 'This action is outside the authorized scopes', status: 403 }));
          return;
        }
        if (!session.streams.includes(data.stream)) {
          session.streams.push(data.stream);
          // Persist updated streams
          ws.serializeAttachment(session);
        }
      } else if (data.type === 'unsubscribe' && typeof data.stream === 'string') {
        const session = this.sessions.get(ws);
        if (session) {
          session.streams = session.streams.filter((s) => s !== data.stream);
          ws.serializeAttachment(session);
        }
      } else if (data.type === 'pause_content' && typeof data.stream === 'string') {
        const session = this.sessions.get(ws);
        if (!session?.streams.includes(data.stream)) return;
        if (!session.pausedStreams.includes(data.stream)) {
          session.pausedStreams.push(data.stream);
          ws.serializeAttachment(session);
        }
      } else if (data.type === 'resume_content' && typeof data.stream === 'string') {
        const session = this.sessions.get(ws);
        if (!session?.streams.includes(data.stream)) return;
        session.pausedStreams = session.pausedStreams.filter((stream) => stream !== data.stream);
        delete session.pendingNewItems[data.stream];
        ws.serializeAttachment(session);
      }
    } catch {
      // Ignore malformed messages
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // The socket is already closed when this callback runs. Do not echo the
    // observed close code back into close(); 1006 is reserved and invalid here.
    this.sessions.delete(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    this.sessions.delete(ws);
    try { ws.close(); } catch { /* ignore */ }
  }

  async alarm(): Promise<void> {
    this.countFlushScheduled = false;
    for (const [ws, session] of this.sessions) {
      const counts = Object.entries(session.pendingNewItems)
        .filter(([, count]) => Number.isFinite(count) && count > 0);
      if (counts.length === 0) continue;
      session.pendingNewItems = {};
      ws.serializeAttachment(session);
      try {
        ws.send(JSON.stringify({
          event: 'new_items',
          payload: JSON.stringify({
            count: counts.reduce((total, [, count]) => total + count, 0),
            streams: Object.fromEntries(counts),
          }),
          stream: counts.map(([stream]) => stream),
        }));
      } catch {
        this.sessions.delete(ws);
        try { ws.close(); } catch { /* ignore */ }
      }
    }
  }

  async #broadcast(event: StreamEventPayload): Promise<void> {
    const message = JSON.stringify({
      event: event.event,
      payload: event.payload,
      stream: event.stream,
    });

    for (const [ws, session] of this.sessions) {
      // Filter by stream if event targets specific streams
      if (event.stream && event.stream.length > 0) {
        const matchingStreams = event.stream.filter((stream) => session.streams.includes(stream));
        if (matchingStreams.length === 0) continue;
        const activeMatch = matchingStreams.some((stream) => !session.pausedStreams.includes(stream));
        if (!activeMatch && event.event === 'update') {
          for (const stream of matchingStreams) {
            session.pendingNewItems[stream] = (session.pendingNewItems[stream] ?? 0) + 1;
          }
          if (!this.countFlushScheduled) {
            this.countFlushScheduled = true;
            await this.ctx.storage.setAlarm(Date.now() + 1_000);
          }
          continue;
        }
      }

      try {
        const maxBufferedBytes = Number(this.env.STREAM_SOCKET_MAX_BUFFERED_BYTES || 262_144);
        const bufferedAmount = Reflect.get(ws, 'bufferedAmount');
        if (typeof bufferedAmount === 'number' && bufferedAmount > maxBufferedBytes) {
          this.sessions.delete(ws);
          ws.close(1013, 'Streaming client is too slow');
          continue;
        }
        ws.send(message);
      } catch {
        this.sessions.delete(ws);
        try { ws.close(); } catch { /* ignore */ }
      }
    }
  }
}
