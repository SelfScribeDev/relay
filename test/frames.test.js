// @ts-check
// WebSocket frames (RFC 6455 §5) on their own: lengths of each size, masking, fragments,
// control frames between fragments, and what is refused.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closePayload, encodeFrame, FrameReader, OP } from '../src/frames.js';

const bytes = (/** @type {number} */ n, seed = 1) => new Uint8Array(n).map((_, i) => (i * 31 + seed) % 256);
const mask = new Uint8Array([0x37, 0xfa, 0x21, 0x3d]);
const client = () => new FrameReader({ maxMessage: 1 << 20, masked: true });

describe('frames', () => {
  it('matches the RFC’s own examples (§5.7)', () => {
    // A single-frame unmasked text message, and a masked one.
    assert.deepEqual([...encodeFrame(OP.text, new TextEncoder().encode('Hello'))], [0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    assert.deepEqual([...encodeFrame(OP.text, new TextEncoder().encode('Hello'), { mask })], [0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
    // 256 bytes and 64 KiB of binary: the 16-bit and the 64-bit length.
    assert.deepEqual([...encodeFrame(OP.binary, bytes(256)).subarray(0, 4)], [0x82, 0x7e, 0x01, 0x00]);
    assert.deepEqual([...encodeFrame(OP.binary, bytes(65536)).subarray(0, 10)], [0x82, 0x7f, 0, 0, 0, 0, 0, 1, 0, 0]);
    const server = new FrameReader({ maxMessage: 1 << 20, masked: false });
    assert.deepEqual(server.push(new Uint8Array([0x01, 0x03, 0x48, 0x65, 0x6c])), []);
    assert.deepEqual(server.push(new Uint8Array([0x80, 0x02, 0x6c, 0x6f])), [{ type: 'text', data: 'Hello' }]);
  });

  it('reads masked frames of every length, byte by byte or all at once', () => {
    for (const n of [0, 1, 125, 126, 127, 65535, 65536, 200_000]) {
      const data = bytes(n, n);
      const frame = encodeFrame(OP.binary, data, { mask });
      const whole = client().push(frame);
      assert.equal(whole.length, 1, `length ${n}`);
      assert.deepEqual(whole[0], { type: 'binary', data });
      if (n <= 300) {
        const r = client();
        /** @type {unknown[]} */
        const got = [];
        for (const b of frame) got.push(...r.push(new Uint8Array([b])));
        assert.deepEqual(got, [{ type: 'binary', data }], `length ${n}, byte by byte`);
      }
    }
  });

  it('puts a message in fragments together, with a ping between them', () => {
    const r = client();
    const words = new TextEncoder().encode('ferry at the quay, 9:40 — on time');
    const out = [
      ...r.push(encodeFrame(OP.text, words.subarray(0, 10), { mask, fin: false })),
      ...r.push(encodeFrame(OP.ping, new Uint8Array([1, 2]), { mask })),
      ...r.push(encodeFrame(OP.continuation, words.subarray(10, 20), { mask, fin: false })),
      ...r.push(encodeFrame(OP.continuation, words.subarray(20), { mask })),
    ];
    assert.deepEqual(out, [
      { type: 'ping', data: new Uint8Array([1, 2]) },
      { type: 'text', data: 'ferry at the quay, 9:40 — on time' },
    ]);
    // A UTF-8 character split across fragments is still one character.
    const euro = new TextEncoder().encode('€');
    const r2 = client();
    assert.deepEqual([...r2.push(encodeFrame(OP.text, euro.subarray(0, 1), { mask, fin: false })), ...r2.push(encodeFrame(OP.continuation, euro.subarray(1), { mask }))], [{ type: 'text', data: '€' }]);
  });

  it('reads close frames, and refuses what the protocol does not allow', () => {
    assert.deepEqual(client().push(encodeFrame(OP.close, closePayload(4000, 'ended'), { mask })), [{ type: 'close', code: 4000, reason: 'ended' }]);
    assert.deepEqual(client().push(encodeFrame(OP.close, new Uint8Array(0), { mask })), [{ type: 'close', code: 1005, reason: '' }]);
    /** @param {Uint8Array} frame */
    const code = (frame, max = 1 << 20) => {
      const e = new FrameReader({ maxMessage: max, masked: true }).push(frame)[0];
      return e?.type === 'error' ? e.code : `no error: ${JSON.stringify(e)}`;
    };
    assert.equal(code(encodeFrame(OP.text, new TextEncoder().encode('x'))), 1002, 'unmasked from a client');
    assert.equal(code(new Uint8Array([0xc1, 0x80, 0, 0, 0, 0])), 1002, 'a reserved bit');
    assert.equal(code(encodeFrame(3, new Uint8Array(0), { mask })), 1002, 'an unknown opcode');
    assert.equal(code(encodeFrame(OP.ping, bytes(126), { mask })), 1002, 'a long control frame');
    assert.equal(code(encodeFrame(OP.ping, new Uint8Array(0), { mask, fin: false })), 1002, 'a control frame in fragments');
    assert.equal(code(encodeFrame(OP.continuation, new Uint8Array(1), { mask })), 1002, 'a continuation of nothing');
    assert.equal(code(encodeFrame(OP.text, new Uint8Array([0xff, 0xfe]), { mask })), 1007, 'text that is not UTF-8');
    assert.equal(code(encodeFrame(OP.close, new Uint8Array([3]), { mask })), 1002, 'half a close code');
    assert.equal(code(encodeFrame(OP.close, closePayload(1006), { mask })), 1002, 'a code no one sends');
    // Too big is refused from the header, before the bytes are waited for.
    assert.equal(code(encodeFrame(OP.binary, bytes(2000), { mask }).subarray(0, 8), 1000), 1009);
    const r = new FrameReader({ maxMessage: 1500, masked: true });
    r.push(encodeFrame(OP.binary, bytes(1000), { mask, fin: false }));
    assert.equal(r.push(encodeFrame(OP.continuation, bytes(1000), { mask }))[0]?.type, 'error', 'fragments that add up to too much');
    // After an error nothing more is read.
    assert.deepEqual(r.push(encodeFrame(OP.text, new Uint8Array([0x61]), { mask })), []);
  });
});
