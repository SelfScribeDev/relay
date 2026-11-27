// @ts-check
// A WebSocket client over a bare TCP socket, for the tests: it says exactly which frames go out
// (masked, in fragments, broken on purpose) and records every frame that comes back.

import { connect } from 'node:net';
import { encodeFrame, FrameReader, OP, closePayload } from '../src/frames.js';

/** @typedef {import('../src/frames.js').FrameEvent} FrameEvent */

/**
 * @typedef {object} RawClient
 * @property {number} status                    The handshake's HTTP status.
 * @property {string} head                      The handshake's response head.
 * @property {FrameEvent[]} events              Every frame from the server, in order.
 * @property {(test: (e: FrameEvent) => boolean, ms?: number) => Promise<FrameEvent>} next  The first frame (from the start) that passes, waiting for it.
 * @property {(type: FrameEvent['type'], ms?: number) => Promise<FrameEvent>} nextOf
 * @property {(op: number, payload: Uint8Array, fin?: boolean) => void} frame  Sends a masked frame.
 * @property {(text: string) => void} text
 * @property {(bytes: Uint8Array) => void} binary
 * @property {(bytes: Uint8Array) => void} raw  Sends bytes as they are.
 * @property {(code?: number) => void} close
 * @property {Promise<void>} ended             Resolves when the TCP line is shut.
 * @property {() => void} destroy
 */

const mask = () => crypto.getRandomValues(new Uint8Array(4));

/**
 * @param {number} port @param {string} path
 * @param {{ headers?: Record<string, string>; version?: string }} [o]
 * @returns {Promise<RawClient>}
 */
export async function rawClient(port, path, o = {}) {
  const socket = connect(port, '127.0.0.1');
  await new Promise((ok, fail) => {
    socket.once('connect', () => ok(undefined));
    socket.on('error', fail);
  });
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const extra = Object.entries(o.headers ?? {}).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: ${o.version ?? '13'}\r\n${extra}\r\n`);
  const reader = new FrameReader({ maxMessage: 64 * 1024 * 1024, masked: false });
  /** @type {FrameEvent[]} */
  const events = [];
  /** @type {(() => void)[]} */
  const wake = [];
  let head = '';
  let headDone = false;
  let closedSent = false;
  /** @type {(v: void) => void} */
  let endedNow = () => undefined;
  const ended = new Promise((r) => (endedNow = r));
  /** @type {(v: void) => void} */
  let headNow = () => undefined;
  const gotHead = new Promise((r) => (headNow = r));
  socket.on('data', (chunk) => {
    let bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (!headDone) {
      const text = head + new TextDecoder('latin1').decode(bytes);
      const end = text.indexOf('\r\n\r\n');
      if (end < 0) {
        head = text;
        return;
      }
      head = text.slice(0, end);
      headDone = true;
      headNow();
      bytes = bytes.subarray(bytes.byteLength - (text.length - end - 4));
    }
    for (const e of reader.push(bytes)) {
      events.push(e);
      // As a browser does: the server's close is answered with one.
      if (e.type === 'close' && !closedSent) {
        closedSent = true;
        socket.write(encodeFrame(OP.close, closePayload(e.code === 1005 ? 1000 : e.code), { mask: mask() }));
      }
    }
    for (const w of wake.splice(0)) w();
  });
  socket.on('close', () => {
    headNow();
    endedNow();
    for (const w of wake.splice(0)) w();
  });
  await gotHead;
  const status = Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0);

  /** @type {RawClient['next']} */
  const next = (test, ms = 3000) =>
    new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`no such frame in ${ms} ms; had ${JSON.stringify(events.map((e) => (e.type === 'text' ? e.data : e.type)))}`)), ms);
      const look = () => {
        const e = events.find(test);
        if (e) {
          clearTimeout(timer);
          ok(e);
        } else wake.push(look);
      };
      look();
    });

  return {
    status,
    head,
    events,
    next,
    nextOf: (type, ms) => next((e) => e.type === type, ms),
    frame: (op, payload, fin = true) => socket.write(encodeFrame(op, payload, { mask: mask(), fin })),
    text: (text) => socket.write(encodeFrame(OP.text, new TextEncoder().encode(text), { mask: mask() })),
    binary: (bytes) => socket.write(encodeFrame(OP.binary, bytes, { mask: mask() })),
    raw: (bytes) => socket.write(bytes),
    close: (code = 1000) => {
      if (closedSent) return;
      closedSent = true;
      socket.write(encodeFrame(OP.close, closePayload(code), { mask: mask() }));
    },
    ended,
    destroy: () => socket.destroy(),
  };
}

/** The JSON of a text frame, or null. @param {FrameEvent} e */
export function json(e) {
  if (e.type !== 'text') return null;
  try {
    return JSON.parse(e.data);
  } catch {
    return null;
  }
}

/** A frame that is JSON with this `t`. @param {string} t @param {Record<string, unknown>} [also] */
export function said(t, also = {}) {
  /** @param {FrameEvent} e */
  return (e) => {
    const m = json(e);
    return m !== null && m.t === t && Object.entries(also).every(([k, v]) => m[k] === v);
  };
}
