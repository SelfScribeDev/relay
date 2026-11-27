# The Selfscribe relay protocol, version 1

A relay passes messages between the apps in a *room*: one *host*, and any number of
*guests*. A guest's message goes to the host, and the host's go to one guest or to all of
them. The relay does not read what the messages say; the apps encrypt them end to end. So the
protocol is the same whatever the apps do with it: a live document today, a folder kept in
step tomorrow. In both, the host answers questions.

This file is for anyone who writes another relay, or another app that uses one. The relay in
this folder (`src/core.js`) is the reference.

## Rooms and the host's token

A room's id is 22 characters of base64url (RFC 4648 §5, no padding): the first 16 bytes of
SHA-256 over the UTF-8 of `selfscribe-relay/1 room ` followed by the host's token.

```
room = base64url(SHA-256("selfscribe-relay/1 room " + token)[0..16])
```

The token is 32 random bytes in base64url (the relay takes 32 to 128 characters of
`A–Z a–z 0–9 - _`). Only the host's app has it. To be a room's host, a connection presents a
token whose room is that room. So:

- a guest, or anyone who has the room's id, cannot become its host;
- the relay keeps nothing to check a claim, and a room is the same after a restart, on
  another relay, or months later (a device that hosts its folder keeps one token);
- the relay learns the token when the host claims, and could pose as the host. It still
  cannot read or write the apps' messages, which need a key it never sees.

## Addresses

| Request | What it is |
|---|---|
| `GET /v1/health` | JSON: `{"name":"selfscribe-relay","version":"1.0.0","protocol":1,"platform":"node","limits":{"message":4194304,"guests":32,"idle":600}}`; `platform` is `cloudflare` there |
| `GET /v1/rooms/{room}/host` | A WebSocket for the room's host |
| `GET /v1/rooms/{room}/guest` | A WebSocket for a guest |
| `GET /live/{room}` | A page that tells a person how to join with the link they opened; the key in the link's `#` part never reaches it |
| `GET /` | A page that says what this is |
| `OPTIONS` (any) | CORS preflight |

Every answer allows any origin (`Access-Control-Allow-Origin: *`): what passes is encrypted,
so it does not matter which page asks. A WebSocket handshake that is refused gets an HTTP
status: `400` (not a WebSocket handshake), `404` (no such room address), `409` (too many hosts
connecting to one room), `429` (too many new connections from this address), `503` (the relay
is full).

## On a connection

Text frames carry the relay's own messages, as JSON objects with a `t`, and the word `ping`.
Binary frames carry the apps' data. Each message, text or binary, may be at most
`limits.message` bytes; an app splits a bigger one (see "Parts" below).

**Keeping a line open.** Send `ping` (the text, not a WebSocket ping frame) at least every
`limits.idle / 2` seconds; the relay answers `pong`. A connection that sends nothing for
`limits.idle` seconds is closed. On Cloudflare the runtime answers `ping` without waking the
room, so a quiet session costs nothing.

### A guest

1. Connects to `/v1/rooms/{room}/guest`.
2. Gets `{"t":"welcome","guest":"g…","host":true|false,"limits":{…}}`: its id in the room, and
   whether the host is connected.
3. Sends binary frames. Each goes to the host. With no host connected, the relay drops it and
   answers `{"t":"error","code":"no-host"}`.
4. Gets binary frames: the host's messages for it, or for every guest.
5. Hears `{"t":"host","here":true|false}` when the host comes or goes.

A guest sends nothing but data and `ping`.

### The host

1. Connects to `/v1/rooms/{room}/host`.
2. Sends `{"t":"claim","token":"…"}` within `claim` seconds (10). Before the claim it may send
   nothing else.
3. Gets `{"t":"claimed","room":"…","guests":["g…",…],"limits":{…}}`. A token that does not
   open the room gets `{"t":"error","code":"bad-token"}` and close code 4003.
4. Hears `{"t":"joined","guest":"g…"}` and `{"t":"left","guest":"g…"}`.
5. Gets each guest's data as a binary frame that starts with the guest's id: one byte, the
   id's length; then the id in ASCII; then the guest's bytes as they were sent.
6. Sends binary frames in the same shape: the id of the guest it is for, or `*` for every
   guest, then the bytes. A guest that is not connected gets nothing, and the host hears
   `{"t":"error","code":"no-guest","guest":"g…"}`.
7. May send `{"t":"kick","guest":"g…"}`, which closes that guest's connection (4009), and
   `{"t":"end"}`, which closes every guest's (4000) and then its own.

A second connection that claims the room takes it over: the first is closed with 4001, and the
guests are not told the host went. That is a host whose line dropped, coming back before the
relay noticed.

### Close codes

| Code | Why |
|---|---|
| 1000 | A normal close, or the host's own after `end` |
| 1001 | The relay is stopping |
| 1002 | Something that is not this protocol, or not WebSocket |
| 1007 | Text that is not UTF-8 |
| 1009 | A message over `limits.message` |
| 4000 | The host ended the room |
| 4001 | Another connection of the host claimed the room |
| 4003 | No claim in time, a bad token, or data before the claim |
| 4008 | Silent for longer than `limits.idle` |
| 4009 | The host sent this guest away |
| 4029 | Too many messages or bytes: wait a few seconds, then connect again |
| 4030 | The room has as many guests as it takes |

Before closing for a reason of its own, the relay sends `{"t":"error","code":"…","message":"…"}`
with a sentence a person can read.

## What the relay keeps

Nothing that outlives the connections. A room exists while someone is connected to it. The
Node server holds its connections in memory. On Cloudflare each room is a Durable Object
whose sockets hibernate; each socket carries a small record (its role, id, address, whether it
claimed, when it was last heard), which goes when the socket closes. Rate limits are kept in
memory and forgotten.

## Selfscribe live over the relay

What the Selfscribe app puts in the data frames (`apps/editor/src/features/live/relayLine.ts`
in the Selfscribe repository).
A relay does not need any of this; another app that wants to join a Selfscribe session does.

**The link.** `https://RELAY/live/ROOM#KEY`. `KEY` is 32 random bytes in base64url: the
session's AES-256-GCM key. A browser never sends the part after `#`, so opening the link shows
the relay's join page without the relay seeing the key. The host keeps the token; it is not in
the link.

**A sealed message.** One byte `1`, a random 12-byte IV, then AES-GCM of the message as UTF-8
JSON, with additional data `selfscribe-live/1 ROOM ask` (guest to host) or
`selfscribe-live/1 ROOM answer` (host to guest). A message for the other way, or another room,
does not open.

**Parts.** A sealed message bigger than the relay's `limits.message` (less 64 bytes, for the
host's tag) is sent in parts: one byte `2`, a 4-byte message number, a 2-byte part number and a
2-byte count (big-endian), then that part of the sealed message. The receiver puts the parts of
one sender together, up to 8 MiB, and forgets unfinished ones after a minute.

**Questions and answers.** A guest sends `{"l":LINE,"n":N,"ask":ASK}`. `LINE` is random, one per
guest for the whole session, and `N` counts up. The host answers `{"l":LINE,"n":N,"answer":ANSWER}`
to the guest the question came from. `ASK` and `ANSWER` are the session's own messages
(`hello`, `push`, `pull`, `point`, `file`, `put`, `bye`; `transport.ts` in the app). The host
answers each `LINE` and `N` once.

**When a line drops.** Both ends connect again, soon at first and then less often. When a
guest hears that the host is there (`welcome` with `host:true`, or `host` with `here:true`), it
sends every question still waiting for an answer again, under new numbers. An answer to an old
number is let go. Each question the session asks is safe to answer twice.

## Next: a folder kept in step through the relay

Not built yet. The protocol needs nothing new for it; this is the plan for the apps.

- **Pairing.** On the computer that holds the folder, "Sync through your relay" makes a token
  (kept in the system's keychain, so the room is the same for months) and a key. Another of
  your devices is linked with a QR code, as Selfscribe already links a sync location: it gets
  the relay, the room and the key, never the token.
- **The questions.** The same request and answer as a live session, with the four operations
  of a sync location (`Place` in the Selfscribe repository's
  `engine/crates/selfscribe-sync/src/place.rs`): `list` (every
  file: path, size, hash, time), `read` (one file's bytes), `write` (a whole file, with the hash
  it is expected to replace) and `remove`. The syncing device uses them as one more kind of
  sync location, so the sync engine, its merging and its "both copies kept" are unchanged. Big
  files go in parts.
- **Both online.** The folder's computer answers while it is on. A device that syncs while it
  is off gets the relay's `no-host`, and the sync is tried again later, as for a server that
  cannot be reached. A relay that holds encrypted changes for a device that is away would be a
  mailbox, which this relay is not.
- **Taking a device away.** Make a new token and key: the old room is gone, and the devices
  still wanted are linked again.
