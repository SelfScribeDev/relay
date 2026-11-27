// @ts-check
// The Node server over real sockets: its pages and health check, the WebSocket handshake,
// frames in fragments, pings, the closing handshake, and what makes it close a line.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startRelay } from '../src/node.js';
import { base64url, roomOf, tag } from '../src/core.js';
import { OP } from '../src/frames.js';
import { json, rawClient, said } from '../test-support/ws-client.js';

/** @type {Awaited<ReturnType<typeof startRelay>>} */
let relay;
let base = '';
const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
let room = '';

before(async () => {
  relay = await startRelay({ port: 0, host: '127.0.0.1', limits: { message: 64 * 1024 } });
  base = `http://127.0.0.1:${relay.port}`;
  room = await roomOf(token);
});
after(() => relay.close());

describe('the Node server', () => {
  it('answers its health check and its pages, to anyone', async () => {
    const res = await fetch(`${base}/v1/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await res.json(), { name: 'selfscribe-relay', version: '1.0.0', protocol: 1, platform: 'node', limits: { message: 65536, guests: 32, idle: 600 } });
    const pre = await fetch(`${base}/v1/health`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
    const invite = await fetch(`${base}/live/${room}`);
    assert.equal(invite.status, 200);
    assert.match(invite.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.match(await invite.text(), /Join a live document/);
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/nothing`)).status, 404);
    assert.equal((await fetch(`${base}/v1/rooms/${room}/host`)).status, 426);
  });

  it('shakes hands as RFC 6455 says, and refuses what is not a WebSocket of this relay', async () => {
    const ok = await rawClient(relay.port, `/v1/rooms/${room}/guest`);
    assert.equal(ok.status, 101);
    const key = /sec-websocket-accept: (\S+)/i.exec(ok.head)?.[1];
    assert.ok(key);
    ok.destroy();
    // The accept key is SHA-1 of the client's key and the GUID: checked against node:crypto.
    assert.equal(createHash('sha1').update('dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    assert.equal((await rawClient(relay.port, `/v1/rooms/${room}/guest`, { version: '8' })).status, 400);
    assert.equal((await rawClient(relay.port, '/v1/rooms/short/guest')).status, 404);
  });

  it('carries a claim in fragments, data both ways, pings and pongs, and closes cleanly', async () => {
    const host = await rawClient(relay.port, `/v1/rooms/${room}/host`);
    const claim = new TextEncoder().encode(JSON.stringify({ t: 'claim', token }));
    host.frame(OP.text, claim.subarray(0, 10), false);
    host.frame(OP.ping, new Uint8Array([7]));
    host.frame(OP.continuation, claim.subarray(10));
    const pong = await host.nextOf('pong');
    assert.deepEqual(pong.type === 'pong' ? [...pong.data] : null, [7]);
    const claimed = json(await host.next(said('claimed')));
    assert.equal(claimed.room, room);

    const guest = await rawClient(relay.port, `/v1/rooms/${room}/guest`);
    const welcome = json(await guest.next(said('welcome')));
    assert.equal(welcome.host, true);
    const joined = json(await host.next(said('joined')));
    assert.equal(joined.guest, welcome.guest);

    guest.binary(new Uint8Array([1, 2, 3]));
    const got = /** @type {any} */ (await host.nextOf('binary'));
    assert.deepEqual(got.data, tag(welcome.guest, new Uint8Array([1, 2, 3])));
    host.binary(tag(welcome.guest, new Uint8Array(30_000).fill(5)));
    const back = /** @type {any} */ (await guest.nextOf('binary'));
    assert.equal(back.data.length, 30_000);
    guest.text('ping');
    await guest.next((e) => e.type === 'text' && e.data === 'pong');

    // The guest closes: the server answers with the same code, then shuts the line.
    guest.close(1000);
    const echo = /** @type {any} */ (await guest.nextOf('close'));
    assert.equal(echo.code, 1000);
    await guest.ended;
    await host.next(said('left'));

    // The host ends the room.
    host.text(JSON.stringify({ t: 'end' }));
    const end = /** @type {any} */ (await host.nextOf('close'));
    assert.equal(end.code, 1000);
    host.close(1000);
    await host.ended;
  });

  it('closes a line that breaks the protocol, or sends too much at once', async () => {
    const big = await rawClient(relay.port, `/v1/rooms/${room}/guest`);
    big.binary(new Uint8Array(64 * 1024 + 1));
    assert.equal((/** @type {any} */ (await big.nextOf('close'))).code, 1009);
    await big.ended;

    const bare = await rawClient(relay.port, `/v1/rooms/${room}/guest`);
    // An unmasked frame from a client.
    bare.raw(new Uint8Array([0x82, 0x01, 0x00]));
    assert.equal((/** @type {any} */ (await bare.nextOf('close'))).code, 1002);
    await bare.ended;

    const liar = await rawClient(relay.port, `/v1/rooms/${room}/host`);
    liar.text(JSON.stringify({ t: 'claim', token: base64url(crypto.getRandomValues(new Uint8Array(32))) }));
    assert.equal(json(await liar.next(said('error'))).code, 'bad-token');
    assert.equal((/** @type {any} */ (await liar.nextOf('close'))).code, 4003);
  });

  it('says goodbye to every line when it stops', async () => {
    const other = await startRelay({ port: 0, host: '127.0.0.1' });
    const g = await rawClient(other.port, `/v1/rooms/${room}/guest`);
    await g.next(said('welcome'));
    assert.equal(other.rooms(), 1);
    await other.close();
    assert.equal((/** @type {any} */ (await g.nextOf('close'))).code, 1001);
  });
});
