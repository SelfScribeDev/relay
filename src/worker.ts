// The relay on Cloudflare: a Worker that answers the pages and the health check and sends
// each WebSocket to its room, and a Durable Object per room that holds the room's sockets.
// The sockets are accepted as hibernatable (`acceptWebSocket`): between messages the object is
// put away and costs nothing, and the runtime answers "ping" with "pong" by itself. Each
// socket's record (`Meta`) travels as its attachment, so the room is found again whenever the
// object wakes. The room logic is `core.js`, the same as the Node server's.
//
// Deploy with `npx wrangler deploy` from this folder (README.md).

import { admit, Buckets, closed, CORS, DEFAULT_LIMITS, health, homePage, invitePage, limitsFrom, message, opened, PAGE_HEADERS, route, sweep, type Limits, type Meta, type Peer, type Room as RoomView } from './core.js';

export interface Env {
  ROOMS: DurableObjectNamespace;
  /** Optional: a Rate Limiting binding for new connections, by address, across all rooms. */
  CONNECT_LIMIT?: RateLimit;
  RELAY_MAX_MESSAGE?: string;
  RELAY_MAX_GUESTS?: string;
  RELAY_IDLE_SECONDS?: string;
  RELAY_CONNECTS_PER_MINUTE?: string;
  RELAY_MESSAGES_PER_MINUTE?: string;
  RELAY_BYTES_PER_MINUTE?: string;
}

/** On Cloudflare a message is kept to 1 MiB, within the platform's WebSocket limits; apps split bigger ones. */
export const CLOUDFLARE_LIMITS: Readonly<Limits> = Object.freeze({ ...DEFAULT_LIMITS, message: 1024 * 1024 });

function limitsOf(env: Env): Limits {
  return limitsFrom(env as unknown as Record<string, unknown>, CLOUDFLARE_LIMITS);
}

function words(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8', ...headers } });
}

/** The Worker: everything but the sockets themselves. */
export async function handle(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const r = request.method === 'GET' || request.method === 'HEAD' ? route(new URL(request.url).pathname) : null;
  if (!r) return words(404, 'Nothing here. A Selfscribe relay answers /v1/health.\n');
  if (r.kind === 'health') return new Response(`${JSON.stringify(health(limitsOf(env), 'cloudflare'))}\n`, { headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  if (r.kind === 'home') return new Response(homePage(), { headers: { ...CORS, ...PAGE_HEADERS } });
  if (r.kind === 'invite') return new Response(invitePage(), { headers: { ...CORS, ...PAGE_HEADERS } });
  if ((request.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') return words(426, 'A WebSocket connects here.\n', { upgrade: 'websocket' });
  if (env.CONNECT_LIMIT) {
    const { success } = await env.CONNECT_LIMIT.limit({ key: request.headers.get('cf-connecting-ip') ?? '' });
    if (!success) return words(429, 'Too many new connections from this address. Wait a minute, then try again.\n');
  }
  // One Durable Object per room, named by the room's id: a room's host and guests meet there.
  return env.ROOMS.get(env.ROOMS.idFromName(r.room)).fetch(request);
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handle(request, env),
};

/** A room: the Durable Object. Its memory may be lost between any two messages. */
export class Room {
  state: DurableObjectState;
  limits: Limits;
  /** Rates by connection: kept while the object is awake, a fresh start after it slept. */
  buckets = new Buckets();
  /** Each connection's messages one at a time: a claim's token is checked before what follows it. */
  queues = new Map<string, Promise<void>>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.limits = limitsOf(env);
    // Answered without waking the room: an open, quiet line costs nothing.
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** The socket as the room sees it, from its attachment. */
  peer(ws: CfWebSocket): Peer | null {
    const meta = ws.deserializeAttachment() as Meta | null;
    if (!meta || typeof meta !== 'object' || typeof meta.id !== 'string') return null;
    const pinged = this.state.getWebSocketAutoResponseTimestamp(ws);
    const peer: Peer = {
      meta,
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
      save: () => ws.serializeAttachment(meta),
    };
    if (pinged) peer.pinged = pinged.getTime();
    return peer;
  }

  view(room: string): RoomView {
    return {
      room,
      peers: () => this.state.getWebSockets().flatMap((ws) => (ws.readyState === 1 ? [this.peer(ws)] : [])).filter((p): p is Peer => p !== null && p.meta.room === room),
      limits: this.limits,
      now: () => Date.now(),
      buckets: this.buckets,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const r = route(new URL(request.url).pathname);
    if (!r || r.kind !== 'socket') return words(404, 'Nothing here.\n');
    const room = this.view(r.room);
    const a = admit(room, r.role, request.headers.get('cf-connecting-ip') ?? '');
    if (!a.ok) return words(a.status, `${a.error}\n`);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server, [r.role]);
    server.serializeAttachment(a.meta);
    const peer = this.peer(server);
    if (peer) opened(room, peer);
    await this.arm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: CfWebSocket, data: string | ArrayBuffer): Promise<void> {
    const first = this.peer(ws);
    if (!first) return;
    const id = first.meta.id;
    const room = this.view(first.meta.room);
    const body = typeof data === 'string' ? data : new Uint8Array(data);
    const next = (this.queues.get(id) ?? Promise.resolve())
      .then(() => {
        // Read again: what came before it (a claim) may have changed the record.
        const peer = this.peer(ws);
        return peer ? message(room, peer, body) : undefined;
      })
      .catch(() => undefined);
    this.queues.set(id, next);
    await next;
    if (this.queues.get(id) === next) this.queues.delete(id);
  }

  async webSocketClose(ws: CfWebSocket, code: number, reason: string): Promise<void> {
    this.gone(ws);
    try {
      // The closing handshake is answered; codes no one may send become a plain close.
      ws.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws: CfWebSocket): Promise<void> {
    this.gone(ws);
  }

  gone(ws: CfWebSocket): void {
    const peer = this.peer(ws);
    if (!peer) return;
    this.queues.delete(peer.meta.id);
    closed(this.view(peer.meta.room), peer);
  }

  /** Wakes the room when a host's claim or a quiet connection's time is up. */
  async alarm(): Promise<void> {
    const first = this.state.getWebSockets().map((ws) => this.peer(ws)).find((p) => p !== null);
    if (!first) return;
    const next = sweep(this.view(first.meta.room));
    if (next !== null) await this.state.storage.setAlarm(next);
  }

  /** Makes sure the room is looked at again by the time a new host must have claimed it. */
  async arm(): Promise<void> {
    const due = Date.now() + Math.min(this.limits.claim, this.limits.idle) * 1000 + 1000;
    const at = await this.state.storage.getAlarm();
    if (at === null || at > due) await this.state.storage.setAlarm(due);
  }
}
