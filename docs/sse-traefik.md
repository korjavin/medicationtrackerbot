# SSE behind Traefik — configuration notes

`/api/changes/stream` is a Server-Sent Events endpoint. The default Traefik
configuration that fronts the rest of the API is fine for short-lived
request/response traffic but mis-handles SSE in two ways:

1. **Response buffering** can hold individual event frames until the buffer
   fills, breaking the "real-time" guarantee the client relies on.
2. **Default idle / read timeouts** (60s in most stock Traefik configs) close
   the long-lived stream prematurely, forcing the EventSource to reconnect on
   every timeout tick.

The two settings below address each issue. They are scoped to the
`/api/changes/stream` path so the rest of the API keeps Traefik's normal
buffering and timeout defaults.

## Required Traefik labels (Docker Compose)

Add these to the `medtracker` service in your production `docker-compose.yml`
alongside the existing `traefik.http.routers.medtracker-…` labels:

```yaml
labels:
  # ...existing medtracker router labels...

  # SSE-specific middleware: disable response buffering.
  - "traefik.http.middlewares.sse-nobuffer-${INSTANCE}.buffering.maxResponseBodyBytes=0"
  - "traefik.http.middlewares.sse-nobuffer-${INSTANCE}.buffering.memResponseBodyBytes=0"

  # SSE-specific router: higher priority than the default Host(...) router so
  # path-prefix matches first. PathPrefix(`/api/changes/stream`) plus the
  # same Host rule keeps everything else on the default router.
  - "traefik.http.routers.medtracker-sse-${INSTANCE}.rule=Host(`${DOMAIN}`) && PathPrefix(`/api/changes/stream`)"
  - "traefik.http.routers.medtracker-sse-${INSTANCE}.entrypoints=websecure"
  - "traefik.http.routers.medtracker-sse-${INSTANCE}.tls.certresolver=myresolver"
  - "traefik.http.routers.medtracker-sse-${INSTANCE}.middlewares=sse-nobuffer-${INSTANCE}@docker"
  - "traefik.http.routers.medtracker-sse-${INSTANCE}.service=medtracker-${INSTANCE}"
  - "traefik.http.routers.medtracker-sse-${INSTANCE}.priority=100"
```

## Required entry-point timeouts (`traefik.yml`)

The router-level middleware controls buffering, but the entry-point owns
read / write / idle timeouts. Setting both to `0` (unlimited) lets the
server's own 10-minute `changeStreamMaxSessionAge` recycle and 15-second
`: keepalive` comment drive the lifecycle:

```yaml
entryPoints:
  websecure:
    address: ":443"
    transport:
      respondingTimeouts:
        readTimeout: 0
        idleTimeout: 0
```

If your Traefik deployment serves other long-lived endpoints and you need a
non-zero idle timeout globally, set `idleTimeout` higher than the server's
15s keepalive (e.g. 5m) so SSE keepalives outlive it.

## Verification

After applying the labels and restarting Traefik:

```bash
curl -N "https://${DOMAIN}/api/changes/stream?initData=<valid-initData>"
```

Expected:

- HTTP `200`, `Content-Type: text/event-stream`
- `X-Accel-Buffering: no` header present (set by the Go handler)
- No `Content-Length` header (chunked transfer)
- `: keepalive` comment frames arrive every ~15s
- A real change event (e.g. POST a BP reading from another client) appears
  within ~50–100ms of the write completing

## Residual risks (expected behaviour, not bugs)

### `RST_STREAM` on deploy

When the Go process receives `SIGTERM`, `Server.Shutdown` runs
`changesBroker.CloseAll()` *before* the HTTP listener closes. Each in-flight
SSE handler sees its subscription channel close and returns cleanly — but
the underlying HTTP/2 stream still terminates with an `RST_STREAM` frame
that Chromium surfaces to the page as a single `onerror` event per client.
The client's EventSource auto-reconnects on the next backoff tick and the
server-side restart picks it up.

This is unavoidable for any HTTP/2 SSE stream that doesn't outlive the
process and is the same trade-off any WebSocket deployment makes at restart.
The user should expect one spurious "Reconnecting…" log line per active
client per deploy.

### `initData` exposure in Traefik access logs

EventSource cannot send custom headers, so the auth token (`initData`) is
passed as a query parameter (`/api/changes/stream?initData=…`). Traefik's
default access log format writes the full request URI, so `initData` ends
up in the access log on disk.

The leak is bounded:

- `initData` is HMAC-signed by Telegram with the bot token and only valid
  for ~24h (Telegram's freshness window enforced at
  `internal/server/auth.go`).
- Anyone with file-system access to the Traefik logs already has more
  privileged access than the token.

Recommended mitigations, in order of preference:

1. Disable URL query logging for `/api/changes/stream` (Traefik
   `accessLog.fields.headers.defaultMode=keep` plus a per-route override
   that drops the query string).
2. Run Traefik logs through a redaction filter (e.g. `fail2ban`-style
   regex) that strips `initData=[^&\s]+`.
3. Accept the bounded leak.

Do **not** "fix" this by switching auth schemes — the EventSource
no-custom-headers constraint forces query-param transport for any browser
client, and the existing HMAC validation in `internal/server/auth.go`
already protects against tampering or replay outside the freshness window.

## Why not Caddy / nginx / Cloudflare?

This document covers Traefik specifically because that is the project's
recommended reverse proxy (see `docs/installer.md`). Other proxies need
equivalent settings:

| Proxy        | Disable buffering                              | Long idle timeout                        |
|--------------|------------------------------------------------|------------------------------------------|
| nginx        | `proxy_buffering off;` in a `location` block   | `proxy_read_timeout 0;`                  |
| Caddy        | no buffering by default                        | `flush_interval -1` + `transport.http.read_timeout 0` |
| Cloudflare   | not configurable; SSE works but may time out at 100s idle on free tier; use keepalives |

The server already sets `X-Accel-Buffering: no` which nginx honours natively.
