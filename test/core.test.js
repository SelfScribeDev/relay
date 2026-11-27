// @ts-check
// The room logic both servers share, with connections stood in for: who may come in, what
// a claim needs, where each message goes, and what closes a connection.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { admit, base64url, Buckets, closed, CLOSE, DEFAULT_LIMITS, health, limitsFrom, message, opened, roomOf, route, sweep, tag, untag } from '../src/core.js';

/** @typedef {import('../src/core.js').Peer} Peer */
/** @typedef {import('../src/core.js').Meta} Meta */

/**
 * A room of stand-in connections, and a clock the test moves.
 * @param {string} id @param {import('../src/core.js').Limits} [limits]
 */
function makeRoom(id, limits = DEFAULT_LIMITS) {
  /** @type {(Peer & { got: (string | Uint8Array)[]; shut: [number, string] | null })[]} */
  const peers = [];
  let now = 1_000_000;
  const room = { room: id, peers: () => peers.filter((p) => p.shut === null), limits, now: () => now, buckets: new Buckets() };
  /** @param {'host' | 'guest'} role @param {string} [ip] */
  const join = (role, ip = '10.0.0.1') => {
    const a = admit(room, role, ip);
    if (!a.ok) return { refused: a };
    /** @type {Peer & { got: (string | Uint8Array)[]; shut: [number, string] | null }} */
    const p = {
      meta: a.meta,
      got: [],
      shut: null,
      send: (d) => void p.got.push(d),
      close: (code, reason) => {
        if (p.shut) return;
        p.shut = [code, reason];
        closed(room, p);
      },
      save: () => undefined,
    };
    peers.push(p);
    opened(room, p);
    return p;
  };
  return { room, join, peers, tick: (/** @type {number} */ ms) => (now += ms) };
}

/** @param {{ got: (string | Uint8Array)[] }} p */
const said = (p) => p.got.filter((g) => typeof g === 'string' && g !== 'pong').map((g) => JSON.parse(/** @type {string} */ (g)));

const token = base64url(crypto.getRandomValues(new Uint8Array(32)));

describe('the room', () => {
  it('a room id is the hash of its host’s token, and the routes are what the protocol says', async () => {
    const id = await roomOf(token);
    assert.match(id, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(id, await roomOf(token));
    assert.notEqual(id, await roomOf(`${token}x`));
    assert.deepEqual(route(`/v1/rooms/${id}/host`), { kind: 'socket', room: id, role: 'host' });
    assert.deepEqual(route(`/v1/rooms/${id}/guest`), { kind: 'socket', room: id, role: 'guest' });
    assert.deepEqual(route(`/live/${id}`), { kind: 'invite', room: id });
    assert.deepEqual(route('/v1/health'), { kind: 'health' });
    for (const bad of [`/v1/rooms/${id}x/host`, '/v1/rooms/short/guest', `/v1/rooms/${id}/admin`, '/v2/health']) assert.equal(route(bad), null, bad);
    assert.deepEqual(health(DEFAULT_LIMITS, 'node'), { name: 'selfscribe-relay', version: '1.0.0', protocol: 1, platform: 'node', limits: { message: 4194304, guests: 32, idle: 600 } });
    assert.equal(limitsFrom({ RELAY_MAX_GUESTS: '5', RELAY_MAX_MESSAGE: 'lots' }).guests, 5);
    assert.equal(limitsFrom({ RELAY_MAX_MESSAGE: 'lots' }).message, DEFAULT_LIMITS.message);
    assert.deepEqual(untag(tag('g12', new Uint8Array([7, 8]))), { id: 'g12', data: new Uint8Array([7, 8]) });
    assert.equal(untag(new Uint8Array([5, 1])), null);
  });

  it('a host claims its room with the token; guests and the host hear of each other; data goes where it is sent', async () => {
    const r = makeRoom(await roomOf(token));
    const early = /** @type {any} */ (r.join('guest'));
    assert.deepEqual(said(early), [{ t: 'welcome', guest: early.meta.id, host: false, limits: { message: 4194304, guests: 32, idle: 600 } }]);
    // Data with no host here is not kept: the guest is told.
    await message(r.room, early, new Uint8Array([1]));
    assert.equal(said(early).at(-1).code, 'no-host');

    const host = /** @type {any} */ (r.join('host'));
    assert.deepEqual(said(host), []);
    await message(r.room, host, JSON.stringify({ t: 'claim', token }));
    assert.deepEqual(said(host), [{ t: 'claimed', room: r.room.room, guests: [early.meta.id], limits: { message: 4194304, guests: 32, idle: 600 } }]);
    assert.deepEqual(said(early).at(-1), { t: 'host', here: true });

    const late = /** @type {any} */ (r.join('guest'));
    assert.equal(said(late)[0].host, true);
    assert.deepEqual(said(host).at(-1), { t: 'joined', guest: late.meta.id });

    // A guest's data reaches the host with the guest's id before it; the host's reaches that guest, or all.
    await message(r.room, late, new Uint8Array([9, 9]));
    assert.deepEqual(host.got.at(-1), tag(late.meta.id, new Uint8Array([9, 9])));
    await message(r.room, host, tag(late.meta.id, new Uint8Array([4])));
    assert.deepEqual(late.got.at(-1), new Uint8Array([4]));
    assert.equal(early.got.filter((/** @type {unknown} */ g) => g instanceof Uint8Array).length, 0);
    await message(r.room, host, tag('*', new Uint8Array([5])));
    assert.deepEqual([early.got.at(-1), late.got.at(-1)], [new Uint8Array([5]), new Uint8Array([5])]);
    await message(r.room, host, tag('gnobody', new Uint8Array([5])));
    assert.equal(said(host).at(-1).code, 'no-guest');

    // "ping" is answered with "pong", by either.
    await message(r.room, late, 'ping');
    assert.equal(late.got.at(-1), 'pong');

    // A guest leaves: the host hears. The host goes: the guests hear.
    late.close(1000, 'bye');
    assert.deepEqual(said(host).at(-1), { t: 'left', guest: late.meta.id });
    host.close(1006, '');
    assert.deepEqual(said(early).at(-1), { t: 'host', here: false });
  });

  it('a wrong token is refused; a second connection of the host takes the room from the first', async () => {
    const r = makeRoom(await roomOf(token));
    const g = /** @type {any} */ (r.join('guest'));
    const thief = /** @type {any} */ (r.join('host'));
    await message(r.room, thief, JSON.stringify({ t: 'claim', token: base64url(crypto.getRandomValues(new Uint8Array(32))) }));
    assert.deepEqual(thief.shut, [CLOSE.claim, 'bad-token']);
    const unclaimed = /** @type {any} */ (r.join('host'));
    await message(r.room, unclaimed, new Uint8Array([1]));
    assert.deepEqual(unclaimed.shut, [CLOSE.claim, 'claim-first']);
    const one = /** @type {any} */ (r.join('host'));
    await message(r.room, one, JSON.stringify({ t: 'claim', token }));
    const two = /** @type {any} */ (r.join('host'));
    await message(r.room, two, JSON.stringify({ t: 'claim', token }));
    assert.deepEqual(one.shut, [CLOSE.replaced, 'replaced']);
    assert.equal(two.meta.claimed, true);
    // The guest was not told the host went: the room had a host all along.
    assert.equal(said(g).filter((m) => m.t === 'host' && m.here === false).length, 0);
    await message(r.room, g, new Uint8Array([3]));
    assert.deepEqual(two.got.at(-1), tag(g.meta.id, new Uint8Array([3])));
  });

  it('the host can send a guest away, or end the room for everyone', async () => {
    const r = makeRoom(await roomOf(token));
    const host = /** @type {any} */ (r.join('host'));
    await message(r.room, host, JSON.stringify({ t: 'claim', token }));
    const a = /** @type {any} */ (r.join('guest'));
    const b = /** @type {any} */ (r.join('guest'));
    await message(r.room, host, JSON.stringify({ t: 'kick', guest: a.meta.id }));
    assert.deepEqual(a.shut, [CLOSE.kicked, 'kicked']);
    assert.equal(b.shut, null);
    await message(r.room, host, JSON.stringify({ t: 'end' }));
    assert.deepEqual(b.shut, [CLOSE.ended, 'ended']);
    assert.deepEqual(host.shut, [1000, 'ended']);
    // A guest's control message is not obeyed.
    const r2 = makeRoom(await roomOf(token));
    const g = /** @type {any} */ (r2.join('guest'));
    await message(r2.room, g, JSON.stringify({ t: 'end' }));
    assert.equal(said(g).at(-1).code, 'unknown');
  });

  it('keeps to its limits: guests, message size, rates, idle lines and unclaimed hosts', async () => {
    const limits = { ...DEFAULT_LIMITS, guests: 2, message: 100, messages: 5, connects: 3, idle: 60, claim: 10 };
    const r = makeRoom(await roomOf(token), limits);
    r.join('guest', '10.0.0.2');
    r.join('guest', '10.0.0.2');
    const third = /** @type {any} */ (r.join('guest', '10.0.0.2'));
    assert.deepEqual(third.shut, [CLOSE.full, 'full']);
    const refused = /** @type {any} */ (r.join('guest', '10.0.0.2'));
    assert.equal(refused.refused.status, 429);
    // Another address may still come in.
    const host = /** @type {any} */ (r.join('host', '10.0.0.3'));
    await message(r.room, host, new Uint8Array(101));
    assert.deepEqual(host.shut, [CLOSE.tooBig, 'too-big']);

    const r2 = makeRoom(await roomOf(token), limits);
    const g = /** @type {any} */ (r2.join('guest'));
    for (let i = 0; i < 5; i++) await message(r2.room, g, 'ping');
    assert.equal(g.shut, null);
    await message(r2.room, g, 'ping');
    assert.deepEqual(g.shut, [CLOSE.rate, 'slow-down']);

    const r3 = makeRoom(await roomOf(token), limits);
    const quiet = /** @type {any} */ (r3.join('guest'));
    const chatty = /** @type {any} */ (r3.join('guest', '10.0.0.9'));
    const lazyHost = /** @type {any} */ (r3.join('host'));
    r3.tick(9_000);
    assert.equal(sweep(r3.room), 1_000_000 + 10_000);
    r3.tick(2_000);
    await message(r3.room, chatty, 'ping');
    sweep(r3.room);
    assert.deepEqual(lazyHost.shut, [CLOSE.claim, 'claim-first']);
    r3.tick(50_000);
    sweep(r3.room);
    assert.deepEqual(quiet.shut, [CLOSE.idle, 'idle']);
    assert.equal(chatty.shut, null);
    // A ping Cloudflare answered by itself counts as heard.
    chatty.pinged = r3.room.now();
    r3.tick(50_000);
    sweep(r3.room);
    assert.equal(chatty.shut, null);
  });
});
