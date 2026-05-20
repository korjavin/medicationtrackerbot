# Technical Decisions

## Why SSE is primary and polling is the fallback

`/api/changes/stream` is a Server-Sent Events endpoint backed by a process-wide
`ChangeBroker` (`internal/server/changes_broker.go`). HTTP-level write traffic
is tapped by `notifyOnWriteMiddleware`: on a successful (2xx) non-GET response
it reads the latest cursor from the `change_events` table and fans it out to
every subscribed SSE handler within ~50ms. Connected clients on other devices
see the write almost immediately instead of waiting up to 30s for the next
poll tick.

Writes that bypass HTTP entirely — Telegram bot callbacks calling domain
services in-process, scheduler intake materialization, importer runs — are
caught by a process-wide tailer goroutine (`runChangeTailer`) that polls
`SELECT MAX(id) FROM change_events` every 200ms and fires
`changesBroker.Notify(cursor)` whenever the cursor advances. Because the SQL
triggers from migration 027 populate `change_events` on every watched-table
mutation regardless of caller, the tailer is the single catch-all path for
non-HTTP writes — no per-call-site instrumentation needed. The per-stream
cursor-check ticker remains as a 5-minute defense-in-depth backstop in case
the tailer goroutine ever stalls; it is no longer the primary latency bound
for bot/scheduler writes.

The original rejection of SSE — `RST_STREAM` noise on HTTP/2 reverse proxies
surfacing as `ERR_HTTP2_PROTOCOL_ERROR` and triggering spurious reconnect
loops — turned out to be a deploy-time only artifact, not a steady-state
problem. `Server.Shutdown` now calls `changesBroker.CloseAll()` before the
HTTP listener closes, so handlers exit cleanly and the only `RST_STREAM` a
client sees is a single one per deploy, after which EventSource silently
reconnects. Steady-state streaming is quiet.

Polling is kept as a fallback for two cases the client detects automatically:

1. The browser lacks `EventSource` (very old WebView).
2. The SSE channel produces 3 consecutive `onerror` events within 30s (proxy
   misconfiguration, network captive portal, etc.) — once this trips, the
   client switches to `GET /api/changes?since=` polling for the rest of the
   session and does not retry SSE.

The cursor-based polling endpoint and its 30s tick are unchanged so the
fallback path is exactly the same code the client used before. See
[sse-traefik.md](sse-traefik.md) for the required Traefik labels and the
residual `initData`-in-access-log caveat.

## Why only three endpoints support offline writes

Adding offline write support requires: IndexedDB schema, optimistic UI rendering, conflict resolution on sync, and error handling for rejected writes. We limit this to the three most time-sensitive health actions (BP readings, weight logs, medication confirmations) where missing a data point is worse than the implementation complexity. Other writes (editing medications, creating workouts) are infrequent and can wait for connectivity.

## Why 5xx responses are treated as "offline"

When the app runs behind Traefik (or any reverse proxy), `navigator.onLine` stays `true` even when the backend Go process is down — the browser has a TCP connection to Traefik, just not to the app. HTTP 502/503/504 from the proxy are functionally identical to being offline, so the SW and sync layer treat them the same way: serve cached responses for reads, queue writes locally.

The frontend read-resilience helper `cachedFetch` (`web/static/js/cached-fetch.js`) inherits this policy via `isServerError` from `sync.js`: a 5xx falls through to the same cached-with-`isStale`-flag branch as a true offline read, and a missing cache raises `OfflineNoCacheError` for the consumer to render an explicit empty state. See [frontend.md → Local-First Read Resilience](frontend.md#local-first-read-resilience) for the full behaviour matrix and per-section freshness windows.

## Why IndexedDB is a write-ahead queue, not a full replica

After successful sync, records are deleted from IndexedDB rather than kept as "synced" copies. This keeps the local store small and avoids the complexity of bidirectional sync and conflict resolution. The SW cache and `api_cache` in IndexedDB already provide read-only offline access to previously fetched data.

## Why vanilla JS instead of a framework

The app is single-user, self-hosted, and runs primarily inside Telegram's WebView. A framework would add bundle size and build complexity for little benefit. The four-layer local-first architecture (SW → IndexedDB → SyncManager → SWR DataStore) is straightforward to implement with vanilla JS and Dexie.js.

## Why a build tag for the mobile / local-only variant, not a runtime flag

The local-only (Capacitor) variant is selected at compile time via `//go:build mobile`, not via a `--mode=local` argv flag or env var. The choice:

- **Dead-path elimination.** The mobile build never compiles Telegram bot code, MCP server code, web-push, or OIDC. A stale config or misrouted call cannot accidentally wake the Telegram client inside the iOS sandbox — those packages aren't in the binary. Runtime flags would keep all that code in the binary and rely on `if cfg.Mobile { ... }` discipline to keep it dormant, which drifts.
- **Smaller binary.** Stripping bot/MCP/web-push/OIDC trims tens of MB before stripping symbols. App-store bundle size matters for mobile distribution.
- **Compile-time guarantee against drift.** If `internal/bot` accidentally references a mobile-only symbol (or vice versa), the build fails immediately. CI runs both `go build ./...` and `go build -tags mobile ./...`, so a PR that breaks either build fails before merge — the paired-files pattern (`foo_server.go` // `foo_mobile.go`) keeps the touch surface visible.
- **Tag surface stays small.** Only wiring seams are tagged: `cmd/bot/main_{server,mobile}.go`, `internal/scheduler/sink_{webpush,localnotifications}.go`, `internal/server/auth/resolver_{telegram,local}.go`. `internal/domain/*`, `internal/store/*`, HTTP handlers, and the frontend are tag-free and shared by both builds — the architectural property that "all transports share the domain service" extends naturally to mobile as a third transport.

See [local-mode.md](local-mode.md) for the full reasoning, the env-var categorization across the two builds, and the env→settings→default config-merge layering that lets mobile install with zero env vars while server deployments keep their current operator workflow.
