import { DurableObject } from "cloudflare:workers";

export class StreamingDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sessions = new Map();

    this.ctx.getWebSockets().forEach((ws) => {
      const attachment = ws.deserializeAttachment();
      this.sessions.set(ws, attachment || { streams: ["user"] });
    });

    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/event" && request.method === "POST") {
      const event = await request.json();
      this.broadcast(event);
      return new Response("ok", { status: 200 });
    }

    if (request.headers.get("Upgrade") === "websocket") {
      const stream = url.searchParams.get("stream") || "user";
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      this.ctx.acceptWebSocket(server);

      const attachment = { streams: [stream] };
      server.serializeAttachment(attachment);
      this.sessions.set(server, attachment);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    return new Response("Expected WebSocket or /event POST", { status: 400 });
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(
        typeof message === "string" ? message : new TextDecoder().decode(message),
      );

      if (data.type === "subscribe" && data.stream) {
        const session = this.sessions.get(ws);
        if (session && !session.streams.includes(data.stream)) {
          session.streams.push(data.stream);
          ws.serializeAttachment(session);
        }
      } else if (data.type === "unsubscribe" && data.stream) {
        const session = this.sessions.get(ws);
        if (session) {
          session.streams = session.streams.filter((s) => s !== data.stream);
          ws.serializeAttachment(session);
        }
      }
    } catch {
    }
  }

  async webSocketClose(ws, code, reason) {
    ws.close(code, reason);
    this.sessions.delete(ws);
  }

  async webSocketError(ws) {
    this.sessions.delete(ws);
    try {
      ws.close();
    } catch {
    }
  }

  broadcast(event) {
    const message = JSON.stringify({
      event: event.event,
      payload: event.payload,
      stream: event.stream,
    });

    for (const [ws, session] of this.sessions) {
      if (event.stream && event.stream.length > 0) {
        const hasMatch = event.stream.some((s) => session.streams.includes(s));
        if (!hasMatch) continue;
      }

      try {
        ws.send(message);
      } catch {
        this.sessions.delete(ws);
        try {
          ws.close();
        } catch {
        }
      }
    }
  }
}
