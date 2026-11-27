// @ts-check
// The relay's room logic, shared by the Node server (`node.js`) and the Cloudflare Durable
// Object (`worker.ts`). Neither keeps anything of its own about a room: the Node server holds
// its connections in memory, and the Durable Object finds them again after hibernation from
// the small record each WebSocket carries (`Meta`). So every function here reads the room's
// connections afresh, and writes a connection's record back with `save()` when it changes.
//
// A room has one host and any number of guests. A guest's message goes to the host, tagged
// with the guest's id; the host's go to one guest, or to all. What they carry is the apps'
// business: encrypted end to end, they are bytes the relay cannot read. See PROTOCOL.md.

export const VERSION = '1.0.0';
export const PROTOCOL = 1;

/**
 * @typedef {object} Limits
 * @property {number} message   The largest message, in bytes, either way.
 * @property {number} guests    Guests in one room at once.
 * @property {number} idle      Seconds a connection may stay silent; its "ping" counts.
 * @property {number} claim     Seconds a host has to claim its room after connecting.
 * @property {number} connects  New connections from one IP address in a minute.
 * @property {number} messages  Messages one connection may send in a minute (a host: times the guests, plus one).
 * @property {number} bytes     Bytes one connection may send in a minute (a host: likewise).
 */

/** @type {Readonly<Limits>} */
export const DEFAULT_LIMITS = Object.freeze({
  message: 4 * 1024 * 1024,
  guests: 32,
  idle: 600,
  claim: 10,
  connects: 60,
  messages: 1200,
  bytes: 64 * 1024 * 1024,
});

/** Close codes the relay uses (4000–4999 are an application's own, RFC 6455 §7.4.2). */
export const CLOSE = Object.freeze({
  /** The host ended the room. */
  ended: 4000,
  /** Another connection of the host claimed the room. */
  replaced: 4001,
  /** No claim, or a token that does not open this room. */
  claim: 4003,
  /** Nothing heard for longer than `idle`. */
  idle: 4008,
  /** The host sent this guest away. */
  kicked: 4009,
  /** The room has as many guests as it takes. */
  full: 4030,
  /** Too many messages or bytes. */
  rate: 4029,
  /** A message over `message` bytes (RFC 6455's own code). */
  tooBig: 1009,
  /** Something that is not this protocol. */
  protocol: 1002,
});

/** A room id: 16 bytes in base64url, as `roomOf` makes them. */
export const ROOM = /^[A-Za-z0-9_-]{22}$/;
/** A host token: at least 24 random bytes in base64url. */
export const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
/** The tag of a host's message to every guest. */
export const EVERYONE = '*';

/**
 * Limits read from settings (environment variables or `[vars]`), each falling back to `base`
 * when it is missing or not a positive whole number.
 * @param {Record<string, unknown>} vars
 * @param {Readonly<Limits>} [base]
 * @returns {Limits}
 */
export function limitsFrom(vars, base = DEFAULT_LIMITS) {
  /** @param {string} name @param {number} fallback */
  const num = (name, fallback) => {
    const v = Number(vars[name]);
    return Number.isInteger(v) && v > 0 ? v : fallback;
  };
  return {
    message: num('RELAY_MAX_MESSAGE', base.message),
    guests: num('RELAY_MAX_GUESTS', base.guests),
    idle: num('RELAY_IDLE_SECONDS', base.idle),
    claim: num('RELAY_CLAIM_SECONDS', base.claim),
    connects: num('RELAY_CONNECTS_PER_MINUTE', base.connects),
    messages: num('RELAY_MESSAGES_PER_MINUTE', base.messages),
    bytes: num('RELAY_BYTES_PER_MINUTE', base.bytes),
  };
}

/** @param {Uint8Array} bytes */
export function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The room a host token opens: the first 16 bytes of SHA-256 over `selfscribe-relay/1 room `
 * and the token. A room id is the hash of its host's token, so only the holder of the token
 * can be its host, here or on any other relay, after a restart as before it; and the relay
 * needs to keep nothing to check it.
 * @param {string} token
 */
export async function roomOf(token) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`selfscribe-relay/1 room ${token}`));
  return base64url(new Uint8Array(hash).subarray(0, 16));
}

/**
 * What an address asks for.
 * @param {string} path
 * @returns {{ kind: 'health' } | { kind: 'home' } | { kind: 'invite'; room: string } | { kind: 'socket'; room: string; role: 'host' | 'guest' } | null}
 */
export function route(path) {
  if (path === '/v1/health') return { kind: 'health' };
  if (path === '/' || path === '') return { kind: 'home' };
  const socket = /^\/v1\/rooms\/([A-Za-z0-9_-]{22})\/(host|guest)$/.exec(path);
  if (socket) return { kind: 'socket', room: /** @type {string} */ (socket[1]), role: socket[2] === 'host' ? 'host' : 'guest' };
  const invite = /^\/live\/([A-Za-z0-9_-]{22})\/?$/.exec(path);
  if (invite) return { kind: 'invite', room: /** @type {string} */ (invite[1]) };
  return null;
}

/** Headers for every HTTP answer: anyone may ask, since everything is encrypted. */
export const CORS = Object.freeze({
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
});

/**
 * What `GET /v1/health` answers.
 * @param {Readonly<Limits>} limits
 * @param {'node' | 'cloudflare'} platform
 */
export function health(limits, platform) {
  return { name: 'selfscribe-relay', version: VERSION, protocol: PROTOCOL, platform, limits: shown(limits) };
}

/** @param {Readonly<Limits>} limits */
function shown(limits) {
  return { message: limits.message, guests: limits.guests, idle: limits.idle };
}

const PAGE_HEAD = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><style>body{font:16px/1.5 system-ui,sans-serif;max-width:34em;margin:3em auto;padding:0 1em;color:#1d2230;background:#fbfaf7}@media (prefers-color-scheme:dark){body{color:#e6e8ee;background:#161923}}code{font-size:.95em}</style>';

/** Headers for the relay's own two pages: nothing on them runs, loads or is remembered. */
export const PAGE_HEADERS = Object.freeze({
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex',
  'cache-control': 'no-store',
});

/** The page of an invitation link opened in a browser. Its key stays in the address bar. */
export function invitePage() {
  return `${PAGE_HEAD}<title>A live Selfscribe document</title></head><body><h1>A live Selfscribe document</h1><p>Someone invited you to write in a document with them.</p><ol><li>Open Selfscribe, on the web or the desktop app.</li><li>Choose <b>File › Join a live document…</b></li><li>Paste this page's whole address, from the address bar, and press <b>Join</b>.</li></ol><p>The end of the address, after <code>#</code>, is the key to the document. It never left your browser: this relay passes the document between you encrypted, and cannot read it.</p></body></html>`;
}

/** The relay's front page. */
export function homePage() {
  return `${PAGE_HEAD}<title>Selfscribe relay</title></head><body><h1>Selfscribe relay ${VERSION}</h1><p>This relay passes encrypted messages between Selfscribe apps: a live document between the people writing in it. It cannot read them, and it stores nothing.</p><p>To use it, put this page's address in Selfscribe, under <b>Settings › Sync › Relay</b>. Its state: <a href="/v1/health">/v1/health</a>.</p></body></html>`;
}

/**
 * A connection's record. On Cloudflare it travels with the WebSocket (its attachment), so it
 * survives the Durable Object's hibernation: keep it small and plain.
 * @typedef {object} Meta
 * @property {string} room
 * @property {'host' | 'guest'} role
 * @property {string} id       A host's or guest's id in its room.
 * @property {string} ip
 * @property {boolean} claimed A host that has claimed the room.
 * @property {number} opened   When it connected (ms).
 * @property {number} seen     When it last sent anything (ms).
 */

/**
 * A connection as the room sees it.
 * @typedef {object} Peer
 * @property {Meta} meta
 * @property {(data: string | Uint8Array) => void} send
 * @property {(code: number, reason: string) => void} close
 * @property {() => void} save    Keeps `meta` as it is now.
 * @property {number} [pinged]    When it last sent a "ping" that was answered without waking the room (Cloudflare).
 */

/**
 * A room: its id, its open connections, and the server's limits, clock and buckets.
 * @typedef {object} Room
 * @property {string} room
 * @property {() => Peer[]} peers
 * @property {Readonly<Limits>} limits
 * @property {() => number} now
 * @property {Buckets} buckets
 */

/** Token buckets, by key: a rate per minute, with a minute's worth to spend at once. */
export class Buckets {
  constructor() {
    /** @type {Map<string, { tokens: number; at: number }>} */
    this.map = new Map();
    this.pruned = 0;
  }

  /**
   * Takes `cost` from the bucket of `key`. False when there is not that much in it.
   * @param {string} key @param {number} perMinute @param {number} now @param {number} [cost]
   */
  take(key, perMinute, now, cost = 1) {
    if (now - this.pruned > 60_000) this.prune(now);
    let b = this.map.get(key);
    if (!b) {
      b = { tokens: perMinute, at: now };
      this.map.set(key, b);
    }
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) * perMinute) / 60_000);
    b.at = now;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  /** @param {string} key */
  forget(key) {
    this.map.delete(key);
  }

  /** Buckets untouched for two minutes are full again: they can go. @param {number} now */
  prune(now) {
    this.pruned = now;
    for (const [k, b] of this.map) if (now - b.at > 120_000) this.map.delete(k);
  }
}

/** @param {Peer[]} peers */
function claimedHost(peers) {
  return peers.find((p) => p.meta.role === 'host' && p.meta.claimed) ?? null;
}

/** @param {Peer[]} peers */
function guestsOf(peers) {
  return peers.filter((p) => p.meta.role === 'guest');
}

/** @param {Peer} peer @param {Record<string, unknown>} msg */
function tell(peer, msg) {
  try {
    peer.send(JSON.stringify(msg));
  } catch {
    // A connection that is going: what it misses does not matter any more.
  }
}

/**
 * Says why, then closes.
 * @param {Peer} peer @param {number} code @param {string} why @param {string} message
 */
export function fail(peer, code, why, message) {
  tell(peer, { t: 'error', code: why, message });
  try {
    peer.close(code, why);
  } catch {
    // Already closed.
  }
}

/** @param {string} prefix @param {Peer[]} peers */
function newId(prefix, peers) {
  const letters = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let id = prefix;
    for (const b of bytes) id += letters[b % letters.length];
    if (!peers.some((p) => p.meta.id === id)) return id;
  }
}

/**
 * Whether a new connection may come in, before its WebSocket is accepted. A guest over the
 * limit is let in to be told the room is full (`opened`), which a refused handshake cannot say.
 * @param {Room} room @param {'host' | 'guest'} role @param {string} ip
 * @returns {{ ok: true; meta: Meta } | { ok: false; status: number; error: string }}
 */
export function admit(room, role, ip) {
  const now = room.now();
  if (!room.buckets.take(`connect ${ip}`, room.limits.connects, now)) return { ok: false, status: 429, error: 'Too many new connections from this address. Wait a minute, then try again.' };
  const peers = room.peers();
  // A host that lost its line comes back before the relay has noticed: room for a few.
  if (role === 'host' && peers.filter((p) => p.meta.role === 'host').length >= 4) return { ok: false, status: 409, error: 'This room has too many hosts connecting at once.' };
  return { ok: true, meta: { room: room.room, role, id: newId(role === 'host' ? 'h' : 'g', peers), ip, claimed: false, opened: now, seen: now } };
}

/**
 * A connection was accepted. A guest is welcomed, told whether its host is here, and the host
 * is told it came. A host says nothing until it has claimed the room.
 * @param {Room} room @param {Peer} peer
 */
export function opened(room, peer) {
  if (peer.meta.role !== 'guest') return;
  const others = room.peers().filter((p) => p.meta.id !== peer.meta.id);
  if (guestsOf(others).length >= room.limits.guests) return fail(peer, CLOSE.full, 'full', 'This document has as many guests as the relay takes.');
  const host = claimedHost(others);
  tell(peer, { t: 'welcome', guest: peer.meta.id, host: host !== null, limits: shown(room.limits) });
  if (host) tell(host, { t: 'joined', guest: peer.meta.id });
}

/** @param {string} text */
function utf8Length(text) {
  // Most control messages are ASCII; only a long or unusual one is measured exactly.
  return text.length < 1024 && /^[\x00-\x7f]*$/.test(text) ? text.length : new TextEncoder().encode(text).length;
}

/**
 * A message from a connection: "ping", a control message (JSON text), or data (binary).
 * Messages of one connection are handled one at a time, in order (the servers chain them).
 * @param {Room} room @param {Peer} peer @param {string | Uint8Array} data
 * @returns {Promise<void>}
 */
export async function message(room, peer, data) {
  const now = room.now();
  const size = typeof data === 'string' ? utf8Length(data) : data.byteLength;
  if (size > room.limits.message) return fail(peer, CLOSE.tooBig, 'too-big', `A message may be at most ${room.limits.message} bytes.`);
  peer.meta.seen = now;
  // A host passes on every guest's questions: its allowance grows with them.
  const share = peer.meta.role === 'host' ? 1 + guestsOf(room.peers()).length : 1;
  if (!room.buckets.take(`messages ${peer.meta.id}`, room.limits.messages * share, now) || !room.buckets.take(`bytes ${peer.meta.id}`, room.limits.bytes * share, now, size)) {
    return fail(peer, CLOSE.rate, 'slow-down', 'Too many messages. Wait a few seconds, then connect again.');
  }
  peer.save();
  // Plain words, not JSON: Cloudflare answers "ping" itself without waking the room, and the
  // two servers say the same.
  if (data === 'ping') {
    try {
      peer.send('pong');
    } catch {
      // A connection that is going.
    }
    return;
  }
  if (typeof data === 'string') return control(room, peer, data);
  forward(room, peer, data);
}

/** @param {Room} room @param {Peer} peer @param {string} text */
async function control(room, peer, text) {
  /** @type {unknown} */
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    msg = null;
  }
  const t = msg && typeof msg === 'object' ? /** @type {Record<string, unknown>} */ (msg) : {};
  if (peer.meta.role === 'guest') return tell(peer, { t: 'error', code: 'unknown', message: 'A guest sends data, and "ping".' });
  if (!peer.meta.claimed && t['t'] !== 'claim') return fail(peer, CLOSE.claim, 'claim-first', 'A host claims its room first.');
  switch (t['t']) {
    case 'claim':
      return claim(room, peer, t['token']);
    case 'kick': {
      const guest = guestsOf(room.peers()).find((g) => g.meta.id === t['guest']);
      if (guest) fail(guest, CLOSE.kicked, 'kicked', 'The host sent you away.');
      return;
    }
    case 'end': {
      for (const g of guestsOf(room.peers())) fail(g, CLOSE.ended, 'ended', 'The host has ended this room.');
      peer.meta.claimed = false;
      peer.save();
      try {
        peer.close(1000, 'ended');
      } catch {
        // Already closed.
      }
      return;
    }
    default:
      return tell(peer, { t: 'error', code: 'unknown', message: 'Not a message the relay knows.' });
  }
}

/** @param {Room} room @param {Peer} peer @param {unknown} token */
async function claim(room, peer, token) {
  if (peer.meta.claimed) return;
  if (typeof token !== 'string' || !TOKEN.test(token) || (await roomOf(token)) !== room.room) return fail(peer, CLOSE.claim, 'bad-token', 'This token does not open this room.');
  // Read the room again: it may have changed while the token was checked.
  const others = room.peers().filter((p) => p.meta.id !== peer.meta.id);
  // The same host, connecting again before the relay noticed its old line had gone.
  for (const old of others) {
    if (old.meta.role !== 'host' || !old.meta.claimed) continue;
    old.meta.claimed = false;
    old.save();
    fail(old, CLOSE.replaced, 'replaced', 'Another connection of the host took this room.');
  }
  peer.meta.claimed = true;
  peer.save();
  const guests = guestsOf(others);
  tell(peer, { t: 'claimed', room: room.room, guests: guests.map((g) => g.meta.id), limits: shown(room.limits) });
  for (const g of guests) tell(g, { t: 'host', here: true });
}

/**
 * A guest's id before the data, for the host: one byte of length, the id in ASCII, the data.
 * @param {string} id @param {Uint8Array} data
 */
export function tag(id, data) {
  const out = new Uint8Array(1 + id.length + data.byteLength);
  out[0] = id.length;
  for (let i = 0; i < id.length; i++) out[1 + i] = id.charCodeAt(i);
  out.set(data, 1 + id.length);
  return out;
}

/**
 * The guest's id and the data of a tagged message; null when it is not one.
 * @param {Uint8Array} bytes
 * @returns {{ id: string; data: Uint8Array } | null}
 */
export function untag(bytes) {
  const n = bytes[0];
  if (n === undefined || n === 0 || n > 64 || bytes.byteLength < 1 + n) return null;
  let id = '';
  for (let i = 1; i <= n; i++) id += String.fromCharCode(/** @type {number} */ (bytes[i]));
  return /^[A-Za-z0-9*_-]+$/.test(id) ? { id, data: bytes.subarray(1 + n) } : null;
}

/** @param {Room} room @param {Peer} peer @param {Uint8Array} data */
function forward(room, peer, data) {
  const peers = room.peers();
  if (peer.meta.role === 'guest') {
    const host = claimedHost(peers);
    if (!host) return tell(peer, { t: 'error', code: 'no-host', message: 'The host is not connected just now.' });
    host.send(tag(peer.meta.id, data));
    return;
  }
  if (!peer.meta.claimed) return fail(peer, CLOSE.claim, 'claim-first', 'A host claims its room first.');
  const got = untag(data);
  if (!got) return tell(peer, { t: 'error', code: 'bad-tag', message: 'A host’s data starts with the guest it is for.' });
  const guests = guestsOf(peers);
  if (got.id === EVERYONE) {
    for (const g of guests) g.send(got.data);
    return;
  }
  const guest = guests.find((g) => g.meta.id === got.id);
  if (guest) guest.send(got.data);
  else tell(peer, { t: 'error', code: 'no-guest', guest: got.id, message: 'That guest is not connected.' });
}

/**
 * A connection has closed. Its host hears that a guest left; guests hear that their host has
 * gone, unless another connection of the host has the room.
 * @param {Room} room @param {Peer} peer
 */
export function closed(room, peer) {
  const others = room.peers().filter((p) => p.meta.id !== peer.meta.id);
  room.buckets.forget(`messages ${peer.meta.id}`);
  room.buckets.forget(`bytes ${peer.meta.id}`);
  if (peer.meta.role === 'guest') {
    const host = claimedHost(others);
    if (host) tell(host, { t: 'left', guest: peer.meta.id });
    return;
  }
  if (peer.meta.claimed && !claimedHost(others)) for (const g of guestsOf(others)) tell(g, { t: 'host', here: false });
}

/**
 * Closes the connections that have been silent too long, and hosts that never claimed their
 * room. Returns when the next one would be due (ms), or null when the room is empty.
 * @param {Room} room
 * @returns {number | null}
 */
export function sweep(room) {
  const now = room.now();
  /** @type {number | null} */
  let next = null;
  for (const p of room.peers()) {
    const due = p.meta.role === 'host' && !p.meta.claimed ? p.meta.opened + room.limits.claim * 1000 : Math.max(p.meta.seen, p.pinged ?? 0) + room.limits.idle * 1000;
    if (now >= due) {
      if (p.meta.role === 'host' && !p.meta.claimed) fail(p, CLOSE.claim, 'claim-first', 'A host claims its room first.');
      else fail(p, CLOSE.idle, 'idle', 'Nothing was heard from this connection for too long.');
    } else if (next === null || due < next) next = due;
  }
  return next;
}
