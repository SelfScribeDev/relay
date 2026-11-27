# Selfscribe relay

A small server that lets Selfscribe apps reach each other when they are not on the same
network. Share a document live, send the link, and the people you send it to write in it with
you from anywhere, in the web app or the desktop app.

The relay passes messages between the person who shares (the *host*) and the people who join
(the *guests*). Everything is encrypted in the apps before it leaves, with a key that is in the
link you send and never reaches the relay. The relay stores nothing.

Run it free on Cloudflare, or on a server you rent. Either takes about ten minutes. Then put
its address in Selfscribe under **Settings › Sync › Relay** and press **Test**.

Get it with:

```
git clone https://github.com/SelfScribeDev/relay.git selfscribe-relay
cd selfscribe-relay
```

## What the relay can see, and what it cannot

| It sees | It cannot see |
|---|---|
| The IP addresses of the host and the guests | The document, its title, or anything anyone types |
| A room id: random letters, new with each share | The names people join with |
| When each one connects, and for how long | The pictures and data files the document names |
| How many messages pass, how big, and to which guest | The key, which stays in the link's `#` part |

- **It cannot change a message** without the apps noticing. Each message is sealed with
  AES-GCM, so a changed or forged one is thrown away.
- **It can drop or delay messages**, or stop answering. The apps then say the session
  ended, or reconnect when they can.
- **It keeps nothing.** A room exists while someone is connected to it. Nothing is written to
  disk, and on Cloudflare nothing goes into the Durable Object's storage.
- **Only the host can be the host.** A room's id is a hash of a token only the host's app
  holds. A guest, or anyone who learns the link, cannot take the room over.

The link itself is the key to the document: anyone who has it can join while you share. Send
it the way you would send the document. Each new share has a new link.

## Limits

| Limit | Cloudflare | Your own server |
|---|---|---|
| Largest message (the apps split bigger ones) | 1 MiB | 4 MiB |
| Guests in one document at once | 32 | 32 |
| A silent connection is closed after (the apps say "ping" twice a minute) | 10 minutes | 10 minutes |
| New connections from one address | 60 a minute, per room | 60 a minute |
| Messages from one connection (a host's allowance grows with its guests) | 1200 a minute | 1200 a minute |
| Open connections | no limit of the relay's | 2000, and 100 from one address |

Change them with the settings below.

## What it costs

- **Cloudflare**: free for most people. The relay runs on the Workers free plan, which has a
  daily allowance of requests and of Durable Object time (at the time of writing, 100,000
  requests a day). A WebSocket message counts as a twentieth of a request, and a room
  where no one is typing sleeps and costs nothing. A few people writing for a few hours a day
  stays well inside it. Cloudflare's pricing pages have the current numbers.
- **Your own server**: the smallest VPS there is (512 MB of memory) is plenty. The relay uses
  about 50 MB of memory and almost no processor. What it carries is what people type, plus
  the pictures and data files the document names, once each.

## Run it on Cloudflare (free)

You need a Cloudflare account (free) and Node.js on your computer, for `npx`.

1. In the relay's folder (the clone above), sign in to Cloudflare. A browser window asks you
   to allow it:

   ```
   npx wrangler login
   ```

2. Deploy:

   ```
   npx wrangler deploy
   ```

   It prints the relay's address, such as `https://selfscribe-relay.YOUR-NAME.workers.dev`.
   The first deploy may ask you to pick a `workers.dev` name for your account.

3. Check it: open `https://selfscribe-relay.YOUR-NAME.workers.dev/v1/health`. It shows the
   relay's version and limits.

4. In Selfscribe, open **Settings › Sync**, put the address under **Relay**, press **Test**,
   then **Save**.

**Your own address.** To use `relay.example.com` instead of `workers.dev`, the domain must be
on the same Cloudflare account. In `wrangler.toml`, remove the `#` before the `routes` line,
put your name in it, and deploy again.

**More.** The settings are the `[vars]` in `wrangler.toml`. A limit on new connections from one
address across all rooms needs Cloudflare's Rate Limiting binding: remove the `#`s of the
`[[ratelimits]]` block (it needs a recent wrangler). `npx wrangler tail` shows the relay's
requests as they come.

## Run it on a server of your own

The relay is one program with nothing to install: Node.js 20 or newer. It speaks plain HTTP
and WebSocket on port 8787. Put [Caddy](https://caddyserver.com) in front of it for
`https://` and `wss://`: Caddy gets and renews the certificate by itself. Browsers need that:
a web page served over https cannot reach a relay at a plain `http://` address.

### From a fresh Ubuntu server

These steps are for Ubuntu 24.04, as root or with `sudo`. You need a name for the relay, such
as `relay.example.com`, whose DNS (an A record) points at the server's address.

1. Node.js (Ubuntu's own is too old), git and Caddy:

   ```
   apt update && apt install -y curl ca-certificates git caddy
   curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
   apt install -y nodejs
   ```

2. The relay, as a user of its own:

   ```
   git clone https://github.com/SelfScribeDev/relay.git /root/selfscribe-relay
   useradd --system --home /opt/selfscribe-relay --shell /usr/sbin/nologin selfscribe-relay
   mkdir -p /opt/selfscribe-relay
   cp -r /root/selfscribe-relay/src /root/selfscribe-relay/package.json /opt/selfscribe-relay/
   cp /root/selfscribe-relay/deploy/selfscribe-relay.service /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now selfscribe-relay
   ```

3. Caddy, for https. Put your name in the Caddyfile, then:

   ```
   cp /root/selfscribe-relay/deploy/Caddyfile /etc/caddy/Caddyfile
   nano /etc/caddy/Caddyfile
   systemctl reload caddy
   ```

4. The firewall: SSH, and the web ports for Caddy. Port 8787 stays closed, since only Caddy
   talks to the relay.

   ```
   ufw allow OpenSSH
   ufw allow 80,443/tcp
   ufw enable
   ```

5. Check it: `curl https://relay.example.com/v1/health`. Then put `https://relay.example.com`
   in Selfscribe under **Settings › Sync › Relay**.

`journalctl -u selfscribe-relay` shows what it said. To update it:

```
cd /root/selfscribe-relay && git pull
cp -r src package.json /opt/selfscribe-relay/
systemctl restart selfscribe-relay
```

### With Docker

In the relay's folder (the clone above):

```
docker build -t selfscribe-relay .
docker run -d --name selfscribe-relay --restart unless-stopped -p 127.0.0.1:8787:8787 -e TRUST_PROXY=1 selfscribe-relay
```

Then Caddy in front of it, as in step 3 above.

### On your own network, without https

`node src/node.js` on any computer with Node.js 20 or newer. The desktop app reaches it at
`http://ADDRESS:8787`. The web app reaches it only from the same computer
(`http://localhost:8787`) or through https.

### Settings

Environment variables for the Node server; the same names, without `PORT`, `HOST` and
`TRUST_PROXY`, go in `[vars]` on Cloudflare.

| Setting | Default | What it does |
|---|---|---|
| `PORT` | `8787` | The port it listens on |
| `HOST` | `0.0.0.0` | The address it listens on; `127.0.0.1` behind Caddy on the same server |
| `TRUST_PROXY` | off | `1`: the client's address is the first of `X-Forwarded-For`, for a relay behind a proxy |
| `RELAY_MAX_MESSAGE` | `4194304` (Cloudflare `1048576`) | The largest message, in bytes |
| `RELAY_MAX_GUESTS` | `32` | Guests in one room |
| `RELAY_IDLE_SECONDS` | `600` | A connection silent this long is closed |
| `RELAY_CLAIM_SECONDS` | `10` | A host has this long to claim its room |
| `RELAY_CONNECTS_PER_MINUTE` | `60` | New connections from one address |
| `RELAY_MESSAGES_PER_MINUTE` | `1200` | Messages from one connection |
| `RELAY_BYTES_PER_MINUTE` | `67108864` | Bytes from one connection |
| `RELAY_MAX_CONNECTIONS` | `2000` | Open connections in all (Node only) |

## How it works

- `src/core.js`: the rooms. Who may come in, what a claim needs, where each message goes,
  and what closes a connection. Both servers use it.
- `src/node.js`: the server for your own machine. HTTP from Node, and a WebSocket of its own
  (`src/frames.js`, RFC 6455).
- `src/worker.ts`: the Cloudflare Worker, and a Durable Object for each room. Its WebSockets
  hibernate, so a quiet room costs nothing, and Cloudflare answers the apps' pings itself.
- [PROTOCOL.md](PROTOCOL.md): the protocol, for anyone who writes another relay or another
  app, and the plan for folder sync through the relay.

## Develop

```
node --test                 # the tests (Node 22.18 or newer: some are TypeScript)
npx tsc -p tsconfig.json    # the types, if TypeScript is at hand
```

The tests cover the rooms, the WebSocket frames, the Node server over real sockets, the
Worker with Cloudflare's runtime stood in for, and, inside the Selfscribe repository, the
app's own end of a session against the running server.

## License

MIT. See [LICENSE](LICENSE).
