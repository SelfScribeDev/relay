// The Cloudflare Worker and its Durable Object, with the runtime stood in for: a socket pair,
// a state that keeps the sockets and their attachments, alarms. The object is made afresh
// between messages, as hibernation does, and must find its room again from the attachments.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { base64url, roomOf, tag } from '../src/core.js';

/** A socket of the stand-in runtime. Attachments come back as copies, as Cloudflare's do. */
class FakeSocket {
  readyState = 0;
  sent: (string | Uint8Array)[] = [];
  shut: [number, string] | null = null;
  attachment: string | null = null;
  pingedAt: Date | null = null;
  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(data);
  }
  close(code: number, reason: string): void {
    if (this.readyState === 3) throw new Error('closed already');
    this.readyState = 3;
    this.shut = [code, reason];
  }
  serializeAttachment(value: unknown): void {
    this.attachment = JSON.stringify(value);
  }
  deserializeAttachment(): unknown {
    return this.attachment === null ? null : JSON.parse(this.attachment);
  }
  said(): Record<string, unknown>[] {
    return this.sent.filter((s): s is string => typeof s === 'string' && s !== 'pong').map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

class FakeState {
  sockets: FakeSocket[] = [];
  auto: unknown = null;
  alarm: number | null = null;
  storage = {
    getAlarm: async (): Promise<number | null> => this.alarm,
    setAlarm: async (at: number): Promise<void> => {
      this.alarm = at;
    },
  };
  acceptWebSocket(ws: FakeSocket): void {
    ws.readyState = 1;
    this.sockets.push(ws);
  }
  getWebSockets(): FakeSocket[] {
    return this.sockets.filter((s) => s.readyState !== 3);
  }
  setWebSocketAutoResponse(pair: unknown): void {
    this.auto = pair;
  }
  getWebSocketAutoResponseTimestamp(ws: FakeSocket): Date | null {
    return ws.pingedAt;
  }
}

const g = globalThis as unknown as Record<string, unknown>;
g['WebSocketPair'] = class {
  0 = new FakeSocket();
  1 = new FakeSocket();
};
g['WebSocketRequestResponsePair'] = class {
  request: string;
  response: string;
  constructor(request: string, response: string) {
    this.request = request;
    this.response = response;
  }
};
// Outside the Workers runtime a response may not be 101: it stands in with 200 and says so.
const RealResponse = Response;
g['Response'] = class extends RealResponse {
  upgrade: number | undefined;
  webSocket: unknown;
  constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
    super(body, init?.status === 101 ? { ...init, status: 200 } : init);
    this.upgrade = init?.status;
    this.webSocket = init?.webSocket;
  }
};

const { handle, Room } = await import('../src/worker.ts');

/** A namespace of rooms: one state per name, and a fresh object over it for each call. */
function namespace(env: Record<string, unknown>) {
  const states = new Map<string, FakeState>();
  return {
    states,
    ns: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id: { toString(): string }) => ({
        fetch: (request: Request) => {
          const name = id.toString();
          if (!states.has(name)) states.set(name, new FakeState());
          return new Room(states.get(name) as never, env as never).fetch(request);
        },
      }),
    },
  };
}

const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
const upgrade = (path: string): Request => new Request(`https://relay.example.com${path}`, { headers: { upgrade: 'websocket', 'cf-connecting-ip': '203.0.113.7' } });

describe('the Worker', () => {
  it('answers its health check with the Cloudflare limits, its pages, and sends each socket to its room', async () => {
    const env: Record<string, unknown> = {};
    const { ns, states } = namespace(env);
    env['ROOMS'] = ns;
    const res = await handle(new Request('https://relay.example.com/v1/health'), env as never);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await res.json(), { name: 'selfscribe-relay', version: '1.0.0', protocol: 1, platform: 'cloudflare', limits: { message: 1048576, guests: 32, idle: 600 } });
    const room = await roomOf(token);
    assert.match(await (await handle(new Request(`https://relay.example.com/live/${room}`), env as never)).text(), /Join a live document/);
    assert.equal((await handle(new Request(`https://relay.example.com/v1/rooms/${room}/host`), env as never)).status, 426);
    assert.equal((await handle(new Request('https://relay.example.com/v1/rooms/x/host'), env as never)).status, 404);
    const up = (await handle(upgrade(`/v1/rooms/${room}/host`), env as never)) as Response & { upgrade?: number; webSocket?: unknown };
    assert.equal(up.upgrade, 101);
    assert.ok(up.webSocket instanceof FakeSocket);
    assert.deepEqual([...states.keys()], [room]);
    // Pings are answered by the runtime itself, without waking the room.
    assert.deepEqual({ ...(states.get(room)?.auto as object) }, { request: 'ping', response: 'pong' });
    assert.ok((states.get(room)?.alarm ?? 0) > Date.now());
  });

  it('keeps a room across hibernation: claim, guests, data both ways, a guest leaving, the host replaced', async () => {
    const env: Record<string, unknown> = {};
    const { ns, states } = namespace(env);
    env['ROOMS'] = ns;
    const room = await roomOf(token);
    await handle(upgrade(`/v1/rooms/${room}/host`), env as never);
    const state = states.get(room) as FakeState;
    const host = state.sockets[0] as FakeSocket;
    // Each call on a new object: nothing is kept in memory between them.
    const wake = () => new Room(state as never, env as never);
    await wake().webSocketMessage(host as never, JSON.stringify({ t: 'claim', token }));
    assert.equal(host.said()[0]?.['t'], 'claimed');

    await handle(upgrade(`/v1/rooms/${room}/guest`), env as never);
    const guest = state.sockets[1] as FakeSocket;
    const welcome = guest.said()[0] as { t: string; guest: string; host: boolean };
    assert.equal(welcome.host, true);
    assert.deepEqual(host.said().at(-1), { t: 'joined', guest: welcome.guest });

    await wake().webSocketMessage(guest as never, new Uint8Array([1, 2]).buffer);
    assert.deepEqual(host.sent.at(-1), tag(welcome.guest, new Uint8Array([1, 2])));
    await wake().webSocketMessage(host as never, tag(welcome.guest, new Uint8Array([3])).slice().buffer);
    assert.deepEqual(guest.sent.at(-1), new Uint8Array([3]));

    // Another connection of the host takes the room; the first is closed, the guest stays.
    await handle(upgrade(`/v1/rooms/${room}/host`), env as never);
    const again = state.sockets[2] as FakeSocket;
    await wake().webSocketMessage(again as never, JSON.stringify({ t: 'claim', token }));
    assert.deepEqual(host.shut, [4001, 'replaced']);
    await wake().webSocketClose(host as never, 4001, 'replaced');
    assert.equal(guest.said().filter((m) => m['t'] === 'host' && m['here'] === false).length, 0);

    // The guest goes: the host hears it.
    guest.readyState = 3;
    await wake().webSocketClose(guest as never, 1000, 'bye');
    assert.deepEqual(again.said().at(-1), { t: 'left', guest: welcome.guest });
  });

  it('wakes on its alarm to close a host that never claimed, and a line that went quiet', async () => {
    const env: Record<string, unknown> = { RELAY_IDLE_SECONDS: '60' };
    const { ns, states } = namespace(env);
    env['ROOMS'] = ns;
    const room = await roomOf(token);
    await handle(upgrade(`/v1/rooms/${room}/host`), env as never);
    await handle(upgrade(`/v1/rooms/${room}/guest`), env as never);
    await handle(upgrade(`/v1/rooms/${room}/guest`), env as never);
    const state = states.get(room) as FakeState;
    const [host, quiet, pinging] = state.sockets as [FakeSocket, FakeSocket, FakeSocket];
    const now = Date.now;
    try {
      const at = now();
      Date.now = () => at + 11_000;
      await new Room(state as never, env as never).alarm();
      assert.deepEqual(host.shut, [4003, 'claim-first']);
      // Next: when the first guest's quiet minute is up.
      assert.ok((state.alarm ?? 0) > at + 50_000 && (state.alarm ?? 0) <= at + 60_000);
      // The guest that said "ping" (answered by the runtime) is heard; the other is not.
      pinging.pingedAt = new Date(at + 30_000);
      Date.now = () => at + 61_000;
      await new Room(state as never, env as never).alarm();
      assert.deepEqual(quiet.shut, [4008, 'idle']);
      assert.equal(pinging.shut, null);
    } finally {
      Date.now = now;
    }
  });

  it('uses the Rate Limiting binding for new connections when there is one', async () => {
    const env: Record<string, unknown> = { CONNECT_LIMIT: { limit: async () => ({ success: false }) } };
    env['ROOMS'] = namespace(env).ns;
    assert.equal((await handle(upgrade(`/v1/rooms/${await roomOf(token)}/guest`), env as never)).status, 429);
  });
});
