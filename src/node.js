#!/usr/bin/env node
// @ts-check
// The relay on a server of your own: Node 20 or newer, nothing to install. HTTP from
// `node:http`, WebSockets from `frames.js`, rooms from `core.js`. Put it behind Caddy (or any
// proxy that speaks TLS) for `wss://`; see README.md.
//
//   node src/node.js                  listens on 0.0.0.0:8787
//   PORT=9000 HOST=127.0.0.1 TRUST_PROXY=1 node src/node.js
//
// Settings (environment variables): PORT, HOST, TRUST_PROXY (1: the client's address is the
// first of X-Forwarded-For, for a relay behind a proxy), RELAY_MAX_CONNECTIONS, and the limits
// of `core.js` (RELAY_MAX_MESSAGE, RELAY_MAX_GUESTS, RELAY_IDLE_SECONDS, …).

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { admit, Buckets, closed, CORS, health, homePage, invitePage, limitsFrom, message, opened, PAGE_HEADERS, route, sweep, VERSION } from './core.js';
import { closePayload, encodeFrame, FrameReader, OP, sendableCode } from './frames.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** How often the server pings each connection, and how long it waits to hear anything back. */
const PING_MS = 30_000;
const DEAD_MS = 75_000;
/** How often rooms are looked over: idle connections, unclaimed hosts, pings due. */
const TICK_MS = 5_000;

/** @typedef {import('./core.js').Meta} Meta */
/** @typedef {import('./core.js').Peer} Peer */
/** @typedef {import('./core.js').Room} Room */
/** @typedef {import('./core.js').Limits} Limits */

/**
 * @typedef {object} RelayOptions
 * @property {number} [port]            0 for any free port.
 * @property {string} [host]
 * @property {boolean} [trustProxy]
 * @property {Partial<Limits>} [limits]
 * @property {number} [maxConnections]  Open connections in all.
 * @property {number} [maxPerAddress]   Open connections from one IP address.
 */

/** A timer that does not keep the process alive by itself. @param {unknown} timer */
function unref(timer) {
  /** @type {{ unref?: () => void }} */ (timer).unref?.();
}

const STATUS = /** @type {Record<number, string>} */ ({ 400: 'Bad Request', 404: 'Not Found', 409: 'Conflict', 426: 'Upgrade Required', 429: 'Too Many Requests', 503: 'Service Unavailable' });

/** One WebSocket connection over a socket. */
class Connection {
  /**
   * @param {import('node:net').Socket} socket @param {Meta} meta @param {Limits} limits
   * @param {(c: Connection, data: string | Uint8Array) => void} onMessage
   */
  constructor(socket, meta, limits, onMessage) {
    this.socket = socket;
    this.limits = limits;
    this.reader = new FrameReader({ maxMessage: limits.message, masked: true });
    this.closing = false;
    this.heard = Date.now();
    this.pinged = Date.now();
    /** @type {Peer} */
    this.peer = {
      meta,
      send: (data) => this.send(data),
      close: (code, reason) => this.close(code, reason),
      save: () => undefined,
    };
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      this.heard = Date.now();
      for (const e of this.reader.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
        if (e.type === 'text' || e.type === 'binary') {
          if (!this.closing) onMessage(this, e.data);
        } else if (e.type === 'ping') this.write(encodeFrame(OP.pong, e.data));
        else if (e.type === 'close') {
          // Answered with the same code, then the line is shut (§5.5.1).
          if (!this.closing) this.write(encodeFrame(OP.close, sendableCode(e.code) ? closePayload(e.code) : new Uint8Array(0)));
          this.closing = true;
          socket.end();
        } else if (e.type === 'error') {
          // A line that broke the protocol is not read any more, so its answer to the close
          // would not be heard: it is shut at once (§7.1.7).
          this.close(e.code, e.reason);
          socket.end();
        }
      }
    });
    socket.on('error', () => socket.destroy());
  }

  /** @param {Uint8Array} frame */
  write(frame) {
    if (this.socket.destroyed) return;
    this.socket.write(frame);
    // A reader that does not keep up is let go, not buffered for without end.
    if (this.socket.writableLength > this.limits.message * 4 + 1_000_000) this.socket.destroy();
  }

  /** @param {string | Uint8Array} data */
  send(data) {
    if (this.closing) return;
    this.write(typeof data === 'string' ? encodeFrame(OP.text, new TextEncoder().encode(data)) : encodeFrame(OP.binary, data));
  }

  /** @param {number} code @param {string} reason */
  close(code, reason) {
    if (this.closing) return;
    this.closing = true;
    this.write(encodeFrame(OP.close, closePayload(sendableCode(code) ? code : 1000, reason)));
    // The other side answers with its own close; one that does not is cut off.
    unref(setTimeout(() => this.socket.destroy(), 2_000));
  }
}

/** @param {import('node:http').IncomingMessage} req @param {boolean} trustProxy */
function addressOf(req, trustProxy) {
  const forwarded = req.headers['x-forwarded-for'];
  if (trustProxy && typeof forwarded === 'string' && forwarded.trim() !== '') return forwarded.split(',')[0]?.trim() ?? '';
  return req.socket.remoteAddress ?? '';
}

/**
 * Starts a relay. Resolves once it listens, with its port and a way to stop it.
 * @param {RelayOptions} [options]
 * @returns {Promise<{ port: number; close(): Promise<void>; rooms(): number }>}
 */
export function startRelay(options = {}) {
  const limits = { ...limitsFrom({}), ...(options.limits ?? {}) };
  const maxConnections = options.maxConnections ?? 2000;
  // A classroom behind one address is a few dozen guests: room for them, not for a flood.
  const maxPerAddress = options.maxPerAddress ?? 100;
  const trustProxy = options.trustProxy ?? false;
  const buckets = new Buckets();
  /** @type {Map<string, Set<Connection>>} */
  const rooms = new Map();
  /** Open connections by address. @type {Map<string, number>} */
  const open = new Map();
  let total = 0;

  /** A room as `core.js` sees it: its connections are read each time they are asked for. @param {string} id @returns {Room} */
  const roomOfId = (id) => ({ room: id, peers: () => [...(rooms.get(id) ?? [])].filter((c) => !c.closing).map((c) => c.peer), limits, now: Date.now, buckets });

  const server = createServer((req, res) => {
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }
    const url = new URL(req.url ?? '/', 'http://relay');
    const r = req.method === 'GET' || req.method === 'HEAD' ? route(url.pathname) : null;
    /** @param {number} status @param {Record<string, string>} headers @param {string} body */
    const answer = (status, headers, body) => {
      res.statusCode = status;
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (!r) return answer(404, { 'content-type': 'text/plain; charset=utf-8' }, 'Nothing here. A Selfscribe relay answers /v1/health.\n');
    if (r.kind === 'health') return answer(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, `${JSON.stringify(health(limits, 'node'))}\n`);
    if (r.kind === 'home') return answer(200, PAGE_HEADERS, homePage());
    if (r.kind === 'invite') return answer(200, PAGE_HEADERS, invitePage());
    return answer(426, { 'content-type': 'text/plain; charset=utf-8', upgrade: 'websocket' }, 'A WebSocket connects here.\n');
  });

  server.on('upgrade', (req, socket, head) => {
    /** @param {number} status @param {string} text */
    const refuse = (status, text) => {
      const body = `${text}\n`;
      const cors = Object.entries(CORS).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      socket.end(`HTTP/1.1 ${status} ${STATUS[status] ?? 'Error'}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n${cors}\r\n${body}`);
    };
    const url = new URL(req.url ?? '/', 'http://relay');
    const r = route(url.pathname);
    if (!r || r.kind !== 'socket') return refuse(404, 'Nothing here.');
    const key = req.headers['sec-websocket-key'];
    if (req.method !== 'GET' || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key.trim()) || req.headers['sec-websocket-version'] !== '13') {
      return refuse(400, 'A WebSocket handshake (version 13) is expected here.');
    }
    if (total >= maxConnections) return refuse(503, 'This relay is full just now. Try again in a while.');
    const ip = addressOf(req, trustProxy);
    if ((open.get(ip) ?? 0) >= maxPerAddress) return refuse(429, 'Too many connections from this address.');
    const view = roomOfId(r.room);
    const a = admit(view, r.role, ip);
    if (!a.ok) return refuse(a.status, a.error);
    const accept = createHash('sha1').update(key.trim() + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`);

    // A connection's messages are handled one at a time: a claim's token is checked before
    // whatever the host sends after it.
    let queue = Promise.resolve();
    const conn = new Connection(/** @type {import('node:net').Socket} */ (socket), a.meta, limits, (c, data) => {
      queue = queue.then(() => message(view, c.peer, data)).catch(() => undefined);
    });
    let set = rooms.get(r.room);
    if (!set) rooms.set(r.room, (set = new Set()));
    set.add(conn);
    total++;
    open.set(ip, (open.get(ip) ?? 0) + 1);
    socket.on('close', () => {
      total--;
      const left = (open.get(ip) ?? 1) - 1;
      if (left <= 0) open.delete(ip);
      else open.set(ip, left);
      conn.closing = true;
      const s = rooms.get(r.room);
      s?.delete(conn);
      closed(view, conn.peer);
      // A room with no one in it holds nothing: it is gone.
      if (s && s.size === 0) rooms.delete(r.room);
    });
    opened(view, conn.peer);
    if (head && head.byteLength > 0) socket.emit('data', head);
  });

  server.on('clientError', (_err, socket) => socket.destroy());

  // Each connection is pinged; one that has said nothing for too long is cut off. Rooms close
  // connections silent past their idle limit, and hosts that never claimed theirs.
  const ticker = setInterval(() => {
    const now = Date.now();
    for (const [id, set] of rooms) {
      for (const c of set) {
        if (now - c.heard > DEAD_MS) c.socket.destroy();
        else if (!c.closing && now - c.pinged >= PING_MS) {
          c.pinged = now;
          c.write(encodeFrame(OP.ping, new Uint8Array(0)));
        }
      }
      sweep(roomOfId(id));
    }
  }, TICK_MS);
  unref(ticker);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8787, options.host ?? '0.0.0.0', () => {
      const where = server.address();
      resolve({
        port: typeof where === 'object' && where ? where.port : 0,
        rooms: () => rooms.size,
        close: () =>
          new Promise((done) => {
            clearInterval(ticker);
            for (const set of rooms.values()) for (const c of set) c.close(1001, 'going away');
            server.close(() => done());
            // Lines that do not answer the goodbye are cut after a moment.
            unref(
              setTimeout(() => {
                for (const set of rooms.values()) for (const c of set) c.socket.destroy();
              }, 500),
            );
          }),
      });
    });
  });
}

// Run as a program: settings from the environment, a line to say where it listens.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const port = Number(env['PORT'] ?? 8787);
  const host = env['HOST'] ?? '0.0.0.0';
  const relay = await startRelay({
    port,
    host,
    trustProxy: env['TRUST_PROXY'] === '1' || env['TRUST_PROXY'] === 'true',
    limits: limitsFrom(env),
    ...(Number(env['RELAY_MAX_CONNECTIONS']) > 0 ? { maxConnections: Number(env['RELAY_MAX_CONNECTIONS']) } : {}),
  });
  console.log(`Selfscribe relay ${VERSION} listening on http://${host}:${relay.port}`);
  const stop = () => {
    void relay.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
