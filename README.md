# RDm — Remote Desktop Manager

Browser-based RDP, VNC, and RustDesk access to your AWS EC2 (and custom)
machines. RDP/VNC stream to the browser via
[Apache Guacamole](https://guacamole.apache.org/); RustDesk speaks its native
protocol directly (see [RustDesk support](#rustdesk-support)). Manage many
instances from one page: start/stop EC2, connect several at once in a grid,
share the clipboard across sessions, and see your month-to-date AWS spend.

## How it works

```
Browser (React SPA)  ──WebSocket──►  Backend (Express + guacamole-lite)  ──►  guacd (Docker)  ──RDP/VNC──►  EC2 / custom host
        │                                     │
        │                                     └── native RustDesk client (TCP, protobuf) ──Direct IP Access──► RustDesk agent (custom host, LAN only)
        └── REST /api/* ─────────────────────►┴── AWS SDK (EC2 list/start/stop, password, Cost Explorer), optional SSM tunnel
```

- **frontend/** — React 19 + Vite + Tailwind single-page app. Built to `frontend/dist`.
- **backend/** — Node/TypeScript Express server. Proxies the Guacamole WebSocket
  to `guacd`, speaks RustDesk's own wire protocol directly for RustDesk
  connections (`backend/src/rustdesk/`), exposes the REST API, and serves the
  built SPA. Stores custom (non-EC2) connections in a local SQLite file
  (`backend/rdm.sqlite`).
- **guacd** — the Guacamole daemon, run as a Docker container, that actually
  speaks RDP/VNC. Listens on `127.0.0.1:4822` (hard-coded in `backend/src/index.ts`).
  Not involved in RustDesk connections at all.

## Prerequisites

- **Node.js 18+** and npm.
- **Docker** (to run `guacd`).
- **An AWS account** and credentials with the permissions below. Provided via
  `backend/.env`, `~/.aws/credentials`, or an instance role (SDK default chain).
- **AWS CLI + Session Manager plugin** — only if you set `USE_SSM_TUNNEL=true`
  (to reach private instances without opening 3389).

> **macOS host?** Everything below works as-is. Install the prerequisites with
> Homebrew: `brew install node`, `brew install --cask docker` (Docker Desktop),
> and — for the optional SSM tunnel — `brew install awscli session-manager-plugin`.
> Start Docker Desktop before running the `docker run` command.

### Required IAM permissions

| Feature | Actions |
|---|---|
| List / start / stop instances | `ec2:DescribeInstances`, `ec2:StartInstances`, `ec2:StopInstances` |
| Change instance type (Instance Settings modal) | `ec2:DescribeInstanceTypes`, `ec2:DescribeInstanceTypeOfferings`, `ec2:ModifyInstanceAttribute` |
| Hourly / monthly cost in the type picker | `pricing:GetProducts` |
| Auto-fetch Windows password | `ec2:GetPasswordData` |
| Month-to-date bill (Settings modal) | `ce:GetCostAndUsage` |
| SSM tunnel (optional) | `ssm:StartSession` on `AWS-StartPortForwardingSession`; instances need the SSM agent + a role |

## Setup

1. **Clone and install**
   ```bash
   git clone <this-repo> rdm && cd rdm
   npm install
   (cd backend && npm install)
   (cd frontend && npm install)
   ```

2. **Start guacd**
   ```bash
   docker run -d --name guacd --restart unless-stopped -p 4822:4822 guacamole/guacd
   ```
   > Optional — larger clipboard: the stock image caps the clipboard at 256 KiB.
   > See [Bigger clipboard limit](#bigger-clipboard-limit-optional) to build an
   > image with a higher cap.

   The Settings modal shows whether guacd is reachable and can start, stop, or
   restart it — it runs `docker <action> guacd`, so the account running the
   backend needs Docker access (i.e. be in the `docker` group). Running guacd as
   a systemd unit instead? Set `GUACD_SERVICE_CMD="sudo -n systemctl"` in
   `backend/.env` and add a passwordless sudoers rule for those three commands.
   Set `GUACD_SERVICE=` (blank) to remove the buttons. The Start/Stop/Restart
   buttons are only reachable once signed in — see [Authentication](#authentication).

3. **Configure the backend**
   ```bash
   cp backend/.env.example backend/.env
   # then edit backend/.env — at minimum set GUAC_CRYPT_KEY (exactly 32 chars)
   # and your AWS credentials/region.
   ```
   Optionally drop your EC2 key pair's private key at **`backend/key.pem`**. When
   present, the backend decrypts each Windows instance's password automatically
   (`ec2:GetPasswordData` + RSA). Without it, it falls back to `RDP_PASSWORD`.

4. **Build the frontend**
   ```bash
   (cd frontend && npm run build)   # outputs frontend/dist
   ```

5. **Run the server** (serves the API *and* the built SPA)
   ```bash
   npm run start:backend            # listens on PORT (default 3010)
   ```

## Accessing the app

**No reverse proxy is required.** The SPA is built with a relative base and
derives its API/WebSocket URLs from wherever the page is served, so it works both
standalone and behind a path-stripping proxy — the same build, unchanged.

### Standalone (simplest)

After step 5, just open the backend directly:

```
http://localhost:3010/          # or http://<this-host-ip>:3010/
```

That's the whole deployment. To keep it running, use your process manager of
choice (`systemd`, `pm2`, `docker`, …) to run `npm run start:backend`.

> **HTTPS & the clipboard.** The browser [Clipboard API][clipboard-api] only
> works in a *secure context* — HTTPS, or `http://localhost`. Over a plain-HTTP
> **LAN IP** (`http://192.168.x.x:3010/`) device ↔ session copy/paste silently
> no-ops (session-to-session still works, over the WebSocket). Two options:
>
> - **Built-in TLS** — set `TLS_CERT` and `TLS_KEY` in `backend/.env` to a cert +
>   key and the server speaks HTTPS/WSS directly (no proxy). Generate a
>   self-signed pair (or use [mkcert](https://github.com/FiloSottile/mkcert) for
>   one your machines trust):
>   ```bash
>   openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
>     -keyout backend/tls.key -out backend/tls.crt \
>     -subj "/CN=$(hostname -I | awk '{print $1}')"
>   ```
>   Then open `https://<host>:3010/`. Browsers warn on a self-signed cert but
>   still grant secure-context status once you accept it.
> - Or just use `http://localhost:3010/` on the same machine.

### Behind a reverse proxy (optional)

To host it at a path alongside other apps, point a proxy at the backend and strip
the prefix. Example nginx serving it at `/rdm/` over HTTPS:

```nginx
server {
    listen 443 ssl;
    server_name your-host;
    ssl_certificate     /etc/ssl/certs/your-host.crt;   # or a Let's Encrypt cert
    ssl_certificate_key /etc/ssl/private/your-host.key;

    location /rdm/ {
        proxy_pass http://127.0.0.1:3010/;   # trailing slash strips the /rdm prefix
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # required for the WebSocket
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

The relative asset/API/WS paths resolve correctly through the stripped prefix, so
nothing in the build needs to know it's mounted at `/rdm/`. Use
[Let's Encrypt](https://certbot.eff.org/) for a trusted cert on a public host.

> Pinning the API/WS to a fixed origin (e.g. a separate API host)? Set
> `VITE_API_URL` / `VITE_WS_URL` at build time to override the derived paths.
>
> **Trusting `X-Forwarded-For`.** If you use [`TRUSTED_LAN_CIDRS`](#authentication)
> below, it's checked against the raw TCP connection by default — which, behind
> *any* reverse proxy, is always the proxy's own address (e.g. `127.0.0.1` for
> one on the same host), never the real client IP. Fixing that takes two
> changes together: (1) have the proxy forward the true client address in
> `X-Forwarded-For`, and (2) set `TRUST_PROXY` in `backend/.env` (e.g.
> `TRUST_PROXY=loopback` for a proxy on the same host) so the backend actually
> trusts that header coming from the proxy. For nginx, (1) is
> `proxy_set_header X-Forwarded-For $remote_addr;` in the `location` block
> above; Caddy and Traefik set it automatically; check your proxy's docs for
> the equivalent otherwise. Do only one of the two and logins either all look
> like they're from `127.0.0.1` (matches or misses your LAN ranges depending
> on what's configured) or, if you set `TRUST_PROXY` without actually
> forwarding a trustworthy header, become spoofable — a client could set its
> own `X-Forwarded-For` and impersonate a LAN address. Only set `TRUST_PROXY`
> once (1) is genuinely in place.

## Authentication

The app requires signing in — there's one account, created the first time you
open it. Two independent pieces:

- **Password.** Always required. Set up on first run; changeable afterwards
  from **Settings → Security**.
- **Optional TOTP 2FA** (Google Authenticator, Authy, or similar), enabled
  from **Settings → Security** by scanning a QR code. When enabled, it's only
  asked for on logins arriving from **outside the trusted LAN** — e.g. over a
  WireGuard or Tailscale tunnel. Same-LAN logins always skip it, and if you
  never enable it, no login anywhere ever asks for it.

  "Trusted LAN" is `TRUSTED_LAN_CIDRS` in `backend/.env` — a comma-separated
  list of CIDRs, e.g. `192.168.1.0/24,127.0.0.1/32`. It's checked against the
  actual TCP source address, not `X-Forwarded-For` (see the reverse-proxy
  note above if you're behind one). Left blank, nothing is trusted, so 2FA
  (once enabled) is required from everywhere — the safe default. It's checked
  by exact subnet, not "is this a private IP", because a WireGuard/Tailscale
  interface commonly hands out addresses in RFC1918 ranges too — only you know
  which private range is actually your physical LAN.

  **Recovery:** if you lose the authenticator device, sign in from the LAN
  (2FA is never asked for there) and disable/re-enroll from Settings. There
  are no separate backup codes — the LAN itself is the recovery path.

- **Auto-logout on inactivity**, also in Settings — signs you out after N
  minutes with no mouse/keyboard activity on the page. Closing the tab counts
  the same as going idle (there's no separate "grace period" for a closed
  tab — the inactivity clock simply keeps running whether the page is open
  and idle or closed). Set to `0` to disable.

Session cookies last `SESSION_MAX_AGE_DAYS` (`backend/.env`, default 30) as a
hard ceiling regardless of activity.

## Usage

- **Sidebar** lists EC2 instances (green dot = running) and any custom RDP or
  VNC hosts you add with the **+** button. Start/stop EC2 inline; **Connect**
  opens a session.
- **Layouts** (top-right): single, horizontal scroll, 2×2, 4×4 grid. Sessions
  render at a fixed 1920×1080 and fill each 16:9 pane.
- **Click a pane** to control it — the focused pane gets a **yellow** highlight,
  and keyboard input (including Ctrl/Alt combos) is routed only to that pane.
- **Clipboard** is shared across all open sessions and your device (text only).
  Copy in one session and it's immediately pastable in every other session; text
  copied on your device is picked up while the tab has focus (and the instant it
  regains focus), so it's already in place when you go to paste.
  > **HTTPS is required for *device* clipboard sync.** Reading/writing your local
  > clipboard uses the browser [Clipboard API][clipboard-api], which browsers
  > only expose in a *secure context* (HTTPS, or `http://localhost`). Over plain
  > HTTP on a LAN IP (e.g. `http://192.168.x.x/`) the copy-to-device / paste-from-device
  > direction silently no-ops — session-to-session clipboard still works because
  > that goes over the Guacamole WebSocket. See [Accessing the app](#accessing-the-app)
  > for the built-in TLS option.
  >
  > **Chromium-only for device→session.** Reading your clipboard needs the
  > `clipboard-read` permission, which only Chromium-based browsers expose;
  > Firefox and Safari raise a "Paste" confirmation on every read instead, so
  > that direction stays off there. Session→session and session→device are
  > unaffected.

[clipboard-api]: https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API
- **Settings** (gear) has global display options and your **month-to-date AWS spend**.
- **Instance settings** (per-row gear) sets a custom name, RDP username and an
  optional saved password. For EC2 rows it also shows the **instance type** —
  click it to browse the types you can move to and resize the machine. Filter by
  name, vCPU count, memory or network tier; the table sorts by **vCPU, memory,
  network, or hourly cost** — the on-demand rate is quoted for the instance's own
  OS and region (compute only, excluding storage and data transfer). Without
  `pricing:GetProducts` the cost column reads `—` and everything else still
  works. The list is limited to types matching the instance's architecture *and*
  offered in its availability zone, so a resize can't leave you with a machine
  that won't start again. AWS only allows a resize while the instance is
  **stopped**.

## RustDesk support

RustDesk connections don't go through Guacamole/guacd at all — `backend/src/rustdesk/`
is a from-scratch Node/TypeScript implementation of RustDesk's own wire
protocol, built directly against the vendored `.proto` schema
(`backend/src/rustdesk/proto/message.proto`, from
[`rustdesk/hbb_common`](https://github.com/rustdesk/hbb_common)) rather than
wrapping the RustDesk client binary.

**Direct IP Access only.** It speaks straight to a RustDesk agent at
`<ip>:21118` — no rendezvous/relay server (`hbbs`/`hbbr`) involved, and no
NAT traversal. This mirrors what the real client does for this connection
mode: `is_direct_ip_access()` skips both the rendezvous handshake *and* the
NaCl/ECDH session-key exchange, so the connection is **unencrypted** on the
wire. That's an acceptable trade-off only because the target is expected to
be on the same trusted LAN the backend itself runs on — don't point this at
a host over the open internet.

**Pipeline:**
- `frameCodec.ts` / `protocol.ts` — hbb_common's variable-length length-prefix
  framing, and protobuf encode/decode via `protobufjs`.
- `client.ts` — the actual peer connection: login handshake (salted/challenged
  password hash), keepalive echo, mouse/keyboard/clipboard events, and cursor
  shape/position.
- `videoDecoder.ts` — the peer's video frames are bare libvpx VP9 (no
  container); each gets wrapped in a minimal synthesized IVF container and
  piped through `ffmpeg` to MJPEG, since browsers have no raw-VP9-elementary-stream
  decoder. In practice the only codec seen in the wild is VP9 — the codec a
  given agent build actually supports isn't something the client side can
  change.
- `sessionManager.ts` — bridges a browser WebSocket to a `client.ts` connection
  + decoder, mirroring guacamole-lite's own connect/token flow (`POST
  /api/connect` mints a short-lived session id; the actual protocol connection
  opens once the browser's WebSocket attaches).
- `frontend/src/RustDeskClient.tsx` — renders the incoming JPEG frames,
  forwards mouse/keyboard/clipboard input, and draws a synthetic cursor
  overlay (position tracked **locally** from the browser's own mouse events —
  the peer deliberately excludes whichever connection is currently driving
  the mouse from its position broadcasts, so relying on the server for that
  would never receive one; cursor bitmaps arrive zstd-compressed and are
  decompressed server-side before being handed to the browser as raw RGBA).

**Setup, per target machine:** RustDesk → Settings → Network → unlock (local
OS password) → enable **Direct IP Access**; Settings → Security → set a
**permanent password**. Then add a custom instance in rdm with protocol
**RustDesk**, that IP, and that password.

**Limitations:** no file transfer (Guacamole's RDP/VNC path doesn't have it
either — see [Notes & limitations](#notes--limitations) — and it's out of
scope here too), no audio, no relay/rendezvous (LAN/direct-reachable targets
only), and video is re-encoded to MJPEG rather than passed through natively —
fine for a remote-admin use case, not video-call-smooth.

## Development

```bash
npm start          # runs backend + `vite dev` together (concurrently)
```
Because Vite's dev server doesn't proxy the API by default, point the frontend at
the backend during dev by setting `VITE_API_URL` / `VITE_WS_URL` (or add a
`server.proxy` entry to `vite.config.ts`). For most changes it's simplest to
`npm run build` and use `npm run start:backend`.

## Bigger clipboard limit (optional)

`guacd`'s clipboard size is a compile-time constant (`GUAC_COMMON_CLIPBOARD_MAX_LENGTH`,
256 KiB). To raise it, build a custom image from the matching guacamole-server
source:

```bash
curl -fsSL -o gs.tar.gz \
  https://github.com/apache/guacamole-server/archive/refs/tags/1.6.0.tar.gz
tar xzf gs.tar.gz && cd guacamole-server-1.6.0
# raise the cap (keep it well under the 8 MiB thread stack — the RDP copy path
# allocates a buffer of this size on the stack). 6 MiB leaves ~2 MiB of headroom.
# (`sed -i.bak` works on both GNU/Linux and macOS/BSD sed; it leaves a .bak file.)
sed -i.bak 's/#define GUAC_COMMON_CLIPBOARD_MAX_LENGTH .*/#define GUAC_COMMON_CLIPBOARD_MAX_LENGTH 6291456/' \
  src/common/common/clipboard.h
docker build -t guacamole/guacd:1.6.0-clip6m \
  --build-arg GUACAMOLE_SERVER_OPTS="--disable-guaclog --enable-allow-freerdp-snapshots CPPFLAGS=-Wno-error=deprecated-declarations" .
```
Then run that tag instead of `guacamole/guacd` in step 2.

## Notes & limitations

- **File copy/paste is not supported** — Guacamole's clipboard is text-only.
  Transferring files would need RDP drive redirection or SFTP plus an upload UI.
- **OS-reserved key combos** (Ctrl+Alt+Del, the Super/Win key, and on Linux hosts
  Ctrl+Alt+arrows / F-keys or DE shortcuts) are grabbed by *your* OS/window
  manager before the browser sees them, so they can't be forwarded from the
  physical keyboard.
- Secrets live in `backend/.env`, `backend/key.pem`, and `backend/rdm.sqlite`
  (encrypted instance passwords, plus the account's password hash and TOTP
  secret) — keep them out of version control.
