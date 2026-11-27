// The parts of the Cloudflare Workers runtime the relay uses, declared here so that it needs
// no @cloudflare/workers-types to type-check: a Durable Object with hibernatable WebSockets
// (`state.acceptWebSocket`, attachments, the automatic "ping" answer, alarms), and the
// optional Rate Limiting binding.

interface CfWebSocket extends WebSocket {
  /** Keeps a small value with the socket, which survives the object's hibernation (at most 2 KB). */
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

declare class WebSocketPair {
  0: CfWebSocket;
  1: CfWebSocket;
}

declare class WebSocketRequestResponsePair {
  constructor(request: string, response: string);
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

interface DurableObjectState {
  /** Accepts a socket the runtime keeps open while the object hibernates. */
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): CfWebSocket[];
  setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): void;
  getWebSocketAutoResponseTimestamp(ws: WebSocket): Date | null;
  readonly storage: DurableObjectStorage;
}

/** The Workers Rate Limiting binding (`[[ratelimits]]` in wrangler.toml). */
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The Workers runtime lets a response carry the client's end of a WebSocket (status 101). */
interface ResponseInit {
  webSocket?: WebSocket | null;
}
