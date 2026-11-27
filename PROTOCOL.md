# The Selfscribe relay protocol, version 1

A relay passes messages between the apps in a *room*: one *host*, and any number of
*guests*. A guest's message goes to the host, and the host's go to one guest or to all of
them. The relay does not read what the messages say; the apps encrypt them end to end. So the
protocol is the same whatever the apps do with it: a live document, or a folder kept in step
between your devices. In both, the host answers questions.

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

## Your other devices: a folder kept in step through the relay

What the Selfscribe app sends when it keeps a folder the same on two of your devices
(`apps/editor/src/features/sync/devices/` in the Selfscribe repository). The relay needs
nothing new for it. The same messages travel on the local network, as the body of a
`POST /device/v1` to the other device's own listener; the relay is the way when they are apart.

**The link.** Linking two devices makes one secret, 32 random bytes, carried by the QR code
(encrypted with the short code a person reads off the screen). Everything else comes from it
with HKDF-SHA-256 (no salt unless said):

| What | HKDF info | Size |
|---|---|---|
| The link's id | `selfscribe-device/1 id` | 12 bytes |
| The hello key (AES-256-GCM) | `selfscribe-device/1 hello` | 32 bytes |
| A device's room token | `selfscribe-device/1 room DEVICE` (its id) | 32 bytes, base64url |
| A session's question key | `selfscribe-device/1 ask ASKER`, salt: the two nonces | 32 bytes |
| A session's answer key | `selfscribe-device/1 answer ASKER`, salt: the two nonces | 32 bytes |

**Rooms.** Each device hosts a room of its own while the app is open: the room of its token
(`room = base64url(SHA-256("selfscribe-relay/1 room " + token)[0..16])`, as above). Both
devices can work out both tokens; nobody else can. To ask the other device, a device joins its
room as a guest. It keeps that guest line open, so the relay's `welcome` and `host` say when
the other device comes online.

**A message.** Binary, at most the relay's `limits.message` or in its parts (above):

| Bytes | What |
|---|---|
| 0 | `1`: a whole message |
| 1 | The kind: `H` hello, `W` welcome, `J` join, `K` joined, `Q` question, `A` answer, `X` refused |
| 2–13 | The link's id |
| 14–17 | A number the asker chose (big-endian), to match the answer to its question |
| H W J K: 18–29, then the rest | A random IV, then AES-GCM with the hello key; additional data: bytes 0–17 |
| Q A: 18–29, 30–37, then the rest | The session's id, the question's number (u64), then AES-GCM with the session's key for that way; the IV is 4 zero bytes and the question's number; additional data: bytes 0–37 |
| X: 18 | Why: 1 no such session, 2 not a link of this device, 3 busy |

What is sealed is `[u32 length][a header as JSON][bytes]`.

**A session.** The asker sends `H` with `{from, to, nonce, name, addresses, port, relay}`: its
id, the other's, 16 fresh random bytes, and where it can be reached. The other answers `W`
with its own nonce, `echo` (the asker's), `sid` (12 random bytes) and where it can be reached.
The two session keys come from both nonces, so a message recorded in one session opens in no
other; a hello played again gets a welcome to a session nobody but the link's devices has keys
for. Each question number is answered once, and one more than 1024 behind the highest is not
answered at all. A device that has forgotten a session (its app restarted) answers `X` 1, and
the asker says hello again.

**Joining.** The device that shows the QR code answers `J` for the link being made, and only
while its code is on screen: on its network, and in its room on the relay, which is already the
link's room (the token comes from the same secret and device). The joining device sends `J` (as
a hello, with the name of its folder); the other keeps the link and answers `K` with `ok`.

**The questions** (`op` in the header). One device of a link syncs it: the one that joined. It
runs the sync engine with the other device as its place
(`engine/crates/selfscribe-sync/src/bridge.rs`), so the engine, its merging and its "both
copies kept" are the same as for any sync location, and the link has one record of what both
had when they last agreed.

| Question | Answer |
|---|---|
| `begin` `{run}` | `{ok}`; `{ok:false, error:"busy"}` while another run holds the link (a run holds it two minutes past its last question) |
| `list` `{run}` | `{ok, entries: [[path, size, tag], …]}` |
| `read` `{run, path, at}` | `{ok, size, hash, at}` and up to 512 KiB of the file from `at`; the pieces after the first are of the same version, and the whole is checked against `hash` (SHA-256) |
| `write` `{run, path, at, size, hash}` and a piece | `{ok, entry}` with the last piece: the whole is checked, written beside the file and moved over it |
| `remove` `{run, path}` | `{ok}`: the file went to the folder's trash |
| `end` `{run, result}` | `{ok}`: the run is over; `result` is how it went, as the syncing device saw it |
| `sync` `{allowMany}` | `{ok, run}`: asked of the device that syncs, by the other one; its `end` comes later |

A failure is `{ok:false, error, message}`, `error` one of `not-found`, `auth`, `offline`,
`busy`, `other`. Only paths inside the linked folder are answered, never its trash or the
app's own record, and files up to 256 MiB.

**Both online.** A device answers while its app is open. A device that cannot reach the other
on its last addresses (for 1.2 seconds) nor in its room on the relay says so, and tries again
later. A relay that held encrypted changes for a device that is away would be a mailbox, which
this relay is not.

**Taking a device away.** Unlink it on both devices: the secret is forgotten, and its rooms
with it.
