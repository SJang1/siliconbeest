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

interface StreamEvent {
  event: 'update' | 'notification' | 'delete' | 'status.update' | 'filters_changed';
  payload: string;
  stream?: string[];
}

interface SessionAttachment {
  streams: string[];
}

export class StreamingDO extends DurableObject {
  // Reconstructed from hibernating WebSockets in constructor
  sessions: Map<WebSocket, SessionAttachment>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sessions = new Map();

    // Restore hibernating WebSocket sessions
    this.ctx.getWebSockets().forEach((ws) => {
      const attachment = ws.deserializeAttachment() as SessionAttachment | null;
      if (attachment) {
        this.sessions.set(ws, attachment);
      } else {
        // Fallback — no attachment means unknown stream, default to 'user'
        this.sessions.set(ws, { streams: ['user'] });
      }
    });

    // Auto-respond to ping/pong without waking the DO
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal event delivery from queue consumer
    if (url.pathname === '/event' && request.method === 'POST') {
      const event = (await request.json()) as StreamEvent;
      this.broadcast(event);
      return new Response('ok', { status: 200 });
    }

    // WebSocket upgrade for streaming
    if (request.headers.get('Upgrade') === 'websocket') {
      const stream = url.searchParams.get('stream') || 'user';

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      // Accept with hibernation support
      this.ctx.acceptWebSocket(server);

      // Store stream subscription in attachment — survives hibernation
      const attachment: SessionAttachment = { streams: [stream] };
      server.serializeAttachment(attachment);

      // Also keep in-memory map for immediate broadcast
      this.sessions.set(server, attachment);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    return new Response('Expected WebSocket or /event POST', { status: 400 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const data = JSON.parse(
        typeof message === 'string' ? message : new TextDecoder().decode(message),
      );

      if (data.type === 'subscribe' && data.stream) {
        const session = this.sessions.get(ws);
        if (session && !session.streams.includes(data.stream)) {
          session.streams.push(data.stream);
          // Persist updated streams
          ws.serializeAttachment(session);
        }
      } else if (data.type === 'unsubscribe' && data.stream) {
        const session = this.sessions.get(ws);
        if (session) {
          session.streams = session.streams.filter((s) => s !== data.stream);
          ws.serializeAttachment(session);
        }
      }
    } catch {
      // Ignore malformed messages
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    ws.close(code, reason);
    this.sessions.delete(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    this.sessions.delete(ws);
    try { ws.close(); } catch { /* ignore */ }
  }

  private broadcast(event: StreamEvent): void {
    const message = JSON.stringify({
      event: event.event,
      payload: event.payload,
      stream: event.stream,
    });

    for (const [ws, session] of this.sessions) {
      // Filter by stream if event targets specific streams
      if (event.stream && event.stream.length > 0) {
        const hasMatch = event.stream.some((s) => session.streams.includes(s));
        if (!hasMatch) continue;
      }

      try {
        ws.send(message);
      } catch {
        this.sessions.delete(ws);
        try { ws.close(); } catch { /* ignore */ }
      }
    }
  }
}
