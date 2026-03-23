/**
 * StreamingDO — Durable Object for Mastodon Streaming API
 *
 * Manages WebSocket connections per user using Hibernatable WebSockets.
 * Receives events from the queue consumer (via service binding fetch)
 * and broadcasts to connected clients.
 */

import { DurableObject } from 'cloudflare:workers';

interface StreamEvent {
  event: 'update' | 'notification' | 'delete' | 'status.update' | 'filters_changed';
  payload: string;
  stream?: string[];
}

export class StreamingDO extends DurableObject {
  private connections: Map<WebSocket, Set<string>> = new Map();

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

      this.ctx.acceptWebSocket(server);

      const streams = new Set<string>();
      streams.add(stream);
      this.connections.set(server, streams);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    return new Response('Expected WebSocket or /event POST', { status: 400 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Handle client messages (subscribe/unsubscribe)
    try {
      const data = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));

      if (data.type === 'subscribe' && data.stream) {
        const streams = this.connections.get(ws);
        if (streams) {
          streams.add(data.stream);
        }
      } else if (data.type === 'unsubscribe' && data.stream) {
        const streams = this.connections.get(ws);
        if (streams) {
          streams.delete(data.stream);
        }
      }
    } catch {
      // Ignore malformed messages
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    this.connections.delete(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    this.connections.delete(ws);
  }

  private broadcast(event: StreamEvent): void {
    const message = JSON.stringify({
      event: event.event,
      payload: event.payload,
      stream: event.stream,
    });

    for (const [ws, streams] of this.connections) {
      // If event has target streams, only send to matching subscriptions
      if (event.stream && event.stream.length > 0) {
        const hasMatch = event.stream.some((s) => streams.has(s));
        if (!hasMatch) continue;
      }

      try {
        ws.send(message);
      } catch {
        // Connection dead, clean up
        this.connections.delete(ws);
        try { ws.close(); } catch { /* ignore */ }
      }
    }
  }
}
