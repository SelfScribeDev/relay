// @ts-check
// WebSocket frames (RFC 6455 §5), for the Node server: no extensions, no subprotocols. Text,
// binary, continuation (a message in fragments), close, ping and pong. A client's frames must
// be masked and a server's must not (§5.1); a reader is made for one side or the other. Bytes
// only: nothing here touches a socket, so it is tested on its own and could serve a client.

export const OP = Object.freeze({ continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 });

/**
 * @typedef {{ type: 'text'; data: string }
 *   | { type: 'binary'; data: Uint8Array }
 *   | { type: 'ping'; data: Uint8Array }
 *   | { type: 'pong'; data: Uint8Array }
 *   | { type: 'close'; code: number; reason: string }
 *   | { type: 'error'; code: number; reason: string }} FrameEvent
 */

/**
 * One frame. `mask` (four bytes) is for a client's frames; a server's are sent bare.
 * @param {number} op @param {Uint8Array} payload @param {{ mask?: Uint8Array; fin?: boolean }} [o]
 */
export function encodeFrame(op, payload, o = {}) {
  const fin = o.fin ?? true;
  const mask = o.mask;
  const n = payload.byteLength;
  const extra = n < 126 ? 0 : n < 65536 ? 2 : 8;
  const head = 2 + extra + (mask ? 4 : 0);
  const out = new Uint8Array(head + n);
  out[0] = (fin ? 0x80 : 0) | (op & 0x0f);
  if (extra === 0) out[1] = n;
  else if (extra === 2) {
    out[1] = 126;
    out[2] = n >>> 8;
    out[3] = n & 0xff;
  } else {
    out[1] = 127;
    const view = new DataView(out.buffer);
    view.setUint32(2, Math.floor(n / 2 ** 32));
    view.setUint32(6, n >>> 0);
  }
  if (mask) {
    out[1] |= 0x80;
    out.set(mask.subarray(0, 4), 2 + extra);
    for (let i = 0; i < n; i++) out[head + i] = payload[i] ^ mask[i & 3];
  } else out.set(payload, head);
  return out;
}

/** The payload of a close frame: the code, then the reason in UTF-8, cut to fit 125 bytes. @param {number} code @param {string} [reason] */
export function closePayload(code, reason = '') {
  let words = new TextEncoder().encode(reason);
  if (words.byteLength > 123) words = words.subarray(0, 123);
  const out = new Uint8Array(2 + words.byteLength);
  out[0] = code >>> 8;
  out[1] = code & 0xff;
  out.set(words, 2);
  return out;
}

/** A close code one side may send (§7.4): not the reserved ones, nor ones no one has defined. @param {number} code */
export function sendableCode(code) {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** Reads frames from a stream of bytes, as they arrive in chunks of any size. */
export class FrameReader {
  /** @param {{ maxMessage: number; masked: boolean }} o `masked`: the frames come from a client. */
  constructor(o) {
    this.max = o.maxMessage;
    this.masked = o.masked;
    /** @type {Uint8Array[]} */
    this.chunks = [];
    this.length = 0;
    /** The fragments of a message so far, and its opcode (0 when none is under way). */
    /** @type {Uint8Array[]} */
    this.parts = [];
    this.partsLength = 0;
    this.partOp = 0;
    this.failed = false;
  }

  /**
   * Takes in bytes; returns the frames now complete. After an `error` it reads no more.
   * @param {Uint8Array} chunk
   * @returns {FrameEvent[]}
   */
  push(chunk) {
    if (this.failed || chunk.byteLength === 0) return [];
    this.chunks.push(chunk);
    this.length += chunk.byteLength;
    /** @type {FrameEvent[]} */
    const events = [];
    for (;;) {
      const e = this.next();
      if (e === null) break;
      if (e === 'more') continue;
      events.push(e);
      if (e.type === 'error') {
        this.failed = true;
        this.chunks = [];
        this.length = 0;
        break;
      }
    }
    return events;
  }

  /** The first `n` bytes, without taking them. @param {number} n */
  peek(n) {
    const first = this.chunks[0];
    if (first && first.byteLength >= n) return first.subarray(0, n);
    const out = new Uint8Array(n);
    let at = 0;
    for (const c of this.chunks) {
      const take = Math.min(c.byteLength, n - at);
      out.set(c.subarray(0, take), at);
      at += take;
      if (at === n) break;
    }
    return out;
  }

  /** Takes the first `n` bytes, as a copy of their own. @param {number} n */
  take(n) {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const c = /** @type {Uint8Array} */ (this.chunks[0]);
      const take = Math.min(c.byteLength, n - at);
      out.set(c.subarray(0, take), at);
      at += take;
      if (take === c.byteLength) this.chunks.shift();
      else this.chunks[0] = c.subarray(take);
    }
    this.length -= n;
    return out;
  }

  /**
   * The next frame: an event, 'more' for a fragment taken in, or null when its bytes have not
   * all arrived yet.
   * @returns {FrameEvent | 'more' | null}
   */
  next() {
    if (this.length < 2) return null;
    const two = this.peek(2);
    const b0 = /** @type {number} */ (two[0]);
    const b1 = /** @type {number} */ (two[1]);
    const fin = (b0 & 0x80) !== 0;
    const op = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    if ((b0 & 0x70) !== 0) return fault(1002, 'reserved bits set');
    if (masked !== this.masked) return fault(1002, this.masked ? 'a client must mask its frames' : 'a server does not mask its frames');
    const short = b1 & 0x7f;
    const headLength = 2 + (short === 126 ? 2 : short === 127 ? 8 : 0) + (masked ? 4 : 0);
    if (this.length < headLength) return null;
    const head = this.peek(headLength);
    let n = short;
    if (short === 126) n = ((/** @type {number} */ (head[2])) << 8) | /** @type {number} */ (head[3]);
    else if (short === 127) {
      const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
      const high = view.getUint32(2);
      if (high >= 0x200000) return fault(1009, 'message too big');
      n = high * 2 ** 32 + view.getUint32(6);
    }
    const control = op >= 8;
    if (control) {
      if (op > 10) return fault(1002, 'unknown opcode');
      if (!fin) return fault(1002, 'a control frame is never in fragments');
      if (n > 125) return fault(1002, 'a control frame carries at most 125 bytes');
    } else {
      if (op > 2) return fault(1002, 'unknown opcode');
      if (op === OP.continuation && this.partOp === 0) return fault(1002, 'a continuation with nothing to continue');
      if (op !== OP.continuation && this.partOp !== 0) return fault(1002, 'a new message inside a message in fragments');
      // Refused before its bytes are waited for: a frame that says it is too big is not read.
      if (this.partsLength + n > this.max) return fault(1009, 'message too big');
    }
    if (this.length < headLength + n) return null;
    this.take(headLength);
    const payload = this.take(n);
    if (masked) {
      const key = head.subarray(headLength - 4, headLength);
      for (let i = 0; i < n; i++) payload[i] ^= /** @type {number} */ (key[i & 3]);
    }
    if (control) return controlEvent(op, payload);
    if (!fin) {
      if (op !== OP.continuation) this.partOp = op;
      this.parts.push(payload);
      this.partsLength += n;
      return 'more';
    }
    const whole = this.partOp === 0 ? payload : join([...this.parts, payload], this.partsLength + n);
    const kind = this.partOp === 0 ? op : this.partOp;
    this.parts = [];
    this.partsLength = 0;
    this.partOp = 0;
    if (kind === OP.binary) return { type: 'binary', data: whole };
    try {
      return { type: 'text', data: strictUtf8.decode(whole) };
    } catch {
      return fault(1007, 'text that is not UTF-8');
    }
  }
}

/** @param {number} code @param {string} reason @returns {FrameEvent} */
function fault(code, reason) {
  return { type: 'error', code, reason };
}

/** @param {Uint8Array[]} parts @param {number} length */
function join(parts, length) {
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** @param {number} op @param {Uint8Array} payload @returns {FrameEvent} */
function controlEvent(op, payload) {
  if (op === OP.ping) return { type: 'ping', data: payload };
  if (op === OP.pong) return { type: 'pong', data: payload };
  if (payload.byteLength === 0) return { type: 'close', code: 1005, reason: '' };
  if (payload.byteLength === 1) return fault(1002, 'a close frame with half a code');
  const code = ((/** @type {number} */ (payload[0])) << 8) | /** @type {number} */ (payload[1]);
  if (!sendableCode(code)) return fault(1002, 'a close code no one may send');
  try {
    return { type: 'close', code, reason: strictUtf8.decode(payload.subarray(2)) };
  } catch {
    return fault(1007, 'a close reason that is not UTF-8');
  }
}
