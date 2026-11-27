// @ts-check
// The Node relay on a random port, with the Selfscribe app's own line to it
// (apps/editor/src/features/live/relayLine.ts, over Node's WebSocket): a host and guests, each
// answered on its own, a big answer in parts, a wrong token, a room no one hosts, the relay
// restarting under a session, and the host ending it. Skipped when the relay is used on its
// own, outside the Selfscribe repository, or on a Node that cannot run TypeScript.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startRelay } from '../src/node.js';

const APP = new URL('../../apps/editor/src/features/live/relayLine.ts', import.meta.url);

/** @type {any} */
let line = null;
if (existsSync(APP)) {
  try {
    // A computed address: the type-check does not follow it into the app.
    line = await import(String(APP));
  } catch {
    line = null;
  }
}
const skip = line ? false : 'needs the Selfscribe app beside it, and Node 22.18 or newer';

/** @type {(() => unknown)[]} */
const closing = [];
after(async () => {
  for (const c of closing.splice(0).reverse()) await c();
});

const pause = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** A host that answers each question by itself: a welcome with the guest's name, a file, or a held pull. */
function answerer() {
  /** @type {((a: unknown) => void)[]} */
  const held = [];
  return {
    held,
    /** @param {any} msg */
    answer: async (msg) => {
      if (msg.t === 'hello') return { t: 'welcome', title: 'harbour.self', doc: `Hello, ${msg.name}`, version: 0, people: [] };
      if (msg.t === 'file') {
        let s = '';
        for (let i = 0; i < 300_000; i++) s += String.fromCharCode(i % 256);
        return { t: 'file', data: btoa(s) };
      }
      if (msg.t === 'pull') return new Promise((r) => held.push(r));
      return { t: 'ok' };
    },
  };
}

describe('the app’s line through the Node relay', { skip }, () => {
  it('a host and three guests: each is answered on its own, and a big answer comes in parts', async () => {
    const relay = await startRelay({ port: 0, host: '127.0.0.1', limits: { message: 64 * 1024 } });
    closing.push(() => relay.close());
    const base = `http://127.0.0.1:${relay.port}`;
    const invite = await line.newHostInvite(base);
    const host = line.relayHost(invite);
    closing.push(() => host.close());
    const a = answerer();
    host.serve(a.answer);
    await host.ready;
    const guests = ['Ana', 'Bo', 'Cy'].map(() => line.relayGuest(line.readInvite(host.link)));
    for (const g of guests) closing.push(() => g.close());
    // A pull held at the host does not hold up anyone's other questions.
    const waiting = guests[0].ask({ t: 'pull', client: 'ana', version: 0, caret: null });
    const hellos = await Promise.all(guests.map((g, i) => g.ask({ t: 'hello', client: `p${i}`, name: ['Ana', 'Bo', 'Cy'][i] })));
    assert.deepEqual(
      hellos.map((h) => h.doc),
      ['Hello, Ana', 'Hello, Bo', 'Hello, Cy'],
    );
    const file = await guests[1].ask({ t: 'file', client: 'p1', path: 'chart.png' });
    assert.equal(atob(file.data).length, 300_000);
    await pause(50);
    assert.equal(a.held.length, 1);
    a.held[0]?.({ t: 'news', version: 0, updates: [], people: [] });
    assert.deepEqual(await waiting, { t: 'news', version: 0, updates: [], people: [] });
  });

  it('a token that does not open the room is refused, and a room no one hosts is no session', async () => {
    const relay = await startRelay({ port: 0, host: '127.0.0.1' });
    closing.push(() => relay.close());
    const base = `http://127.0.0.1:${relay.port}`;
    const invite = await line.newHostInvite(base);
    const other = await line.newHostInvite(base);
    const thief = line.relayHost({ ...invite, token: other.token });
    await assert.rejects(thief.ready);
    thief.close();
    const lonely = line.relayGuest(invite, { hostWaitMs: 300 });
    const t0 = Date.now();
    assert.deepEqual(await lonely.ask({ t: 'hello', client: 'b', name: 'Bo' }), { t: 'closed' });
    assert.ok(Date.now() - t0 < 3000);
  });

  it('the relay restarts under a session: both ends connect again, and what waited is answered', async () => {
    let relay = await startRelay({ port: 0, host: '127.0.0.1' });
    const port = relay.port;
    const base = `http://127.0.0.1:${port}`;
    const invite = await line.newHostInvite(base);
    const host = line.relayHost(invite);
    const a = answerer();
    host.serve(a.answer);
    await host.ready;
    const guest = line.relayGuest(line.readInvite(host.link));
    assert.equal((await guest.ask({ t: 'hello', client: 'b', name: 'Bo' })).t, 'welcome');
    const waiting = guest.ask({ t: 'pull', client: 'b', version: 0, caret: null });
    for (let i = 0; i < 50 && a.held.length === 0; i++) await pause(20);
    assert.equal(a.held.length, 1);
    await relay.close();
    relay = await startRelay({ port, host: '127.0.0.1' });
    // The pull is asked again on the new lines; the host answers it there.
    for (let i = 0; i < 300 && a.held.length < 2; i++) await pause(20);
    assert.equal(a.held.length, 2);
    a.held[1]?.({ t: 'news', version: 1, updates: [], people: [] });
    assert.deepEqual(await waiting, { t: 'news', version: 1, updates: [], people: [] });
    assert.deepEqual(await guest.ask({ t: 'point', client: 'b', caret: null }), { t: 'ok' });

    // The host ends it: the guest's waiting question is answered "closed" at once.
    const last = guest.ask({ t: 'pull', client: 'b', version: 1, caret: null });
    for (let i = 0; i < 50 && a.held.length < 3; i++) await pause(20);
    const t0 = Date.now();
    host.close();
    assert.deepEqual(await last, { t: 'closed' });
    assert.ok(Date.now() - t0 < 2000);
    assert.deepEqual(await guest.ask({ t: 'point', client: 'b', caret: null }), { t: 'closed' });
    await relay.close();
  });
});
