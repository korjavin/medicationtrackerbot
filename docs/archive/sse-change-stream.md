# ARCHIVED — the SSE change stream and `X-Client-ID` attribution

> **ARCHIVED.** These two decisions describe `/api/changes/stream` and the
> `ChangeBroker` fan-out, which exist only in the Telegram-bot / Go-server
> code (`internal/server`). **Cloud mode has no change stream at all** — no
> SSE, no poller; repaint is optimistic-write plus pull-then-`invalidateTags`.
> Kept for history; not normative.
>
> Still-current frontend decisions (offline writes, 5xx-as-offline, the
> write-ahead queue, vanilla JS) stayed behind in
> [docs/technical-decisions.md](../technical-decisions.md).

---

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
`changesBroker.Notify(cursor, "")` whenever the cursor advances (the empty
source string is intentional — tailer-driven writes have no originating
client). Because the SQL
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

### Source attribution via `X-Client-ID`

Each browser mints a stable `clientId` (UUIDv4, persisted to
`localStorage['wg.clientId']`) on first load and sends it as `X-Client-ID`
on every non-GET request. `notifyOnWriteMiddleware` reads the header,
sanitises it (printable ASCII, ≤64 chars), and passes it through to
`changesBroker.Notify(cursor, sourceClientID)`. Subscribers fan out a
`ChangeEvent{Cursor, SourceClientID}` and the SSE handler emits
`source_client_id` on the live payload (`omitempty` — initial flush and
tailer-driven notifications without an HTTP source omit the field). The
frontend's `applyChangesPayload` classifies a change as `self-echo` iff
`source_client_id === DataStore.getClientId()`, suppressing the "New data
is available." banner deterministically regardless of SSE delivery
latency. The frontend falls back to the existing 5s `lastOwnWriteAt`
timing window when the deterministic match does not apply — either
`source_client_id` is absent (older server, initial flush, polling
fallback, scheduler/bot writes) **or** present-but-mismatched. The
present-but-mismatched fallback exists because the middleware's
`MAX(change_events.id)` read happens *after* the handler returns, so a
concurrent foreign commit can be absorbed into the same broker frame and
tagged with the foreign source; without the fallback our own write inside
that mixed frame would mis-classify as a foreign banner. The trade-off is
that a legitimate cross-source banner landing within 5s of our own write
is occasionally false-suppressed — tag invalidation still refreshes data,
only the banner is skipped. The symmetric race also remains uncovered:
when our own middleware "wins" the cursor-lookup race and absorbs a
concurrent foreign commit, the broker frame is tagged with **our** source
but its `changed_tags` include the foreign write. The frontend then takes
the deterministic self-echo branch and suppresses the foreign banner —
data still refreshes via tag invalidation, but the user is not notified
of the cross-source change. The SSE-side `cursor == ev.Cursor` guard in
`changes_handlers.go` only catches the case where a *later* write slipped
in between broker fan-out and the SQL read; it cannot detect that the
broker event's cursor already absorbed a foreign commit at middleware
time. Closing both directions would require per-row source attribution on
`change_events` (a new column threaded through the migration 027
triggers); that's deliberately out of scope for the current design.

The mechanism is otherwise purely additive: older frontends without
`X-Client-ID` and older servers without `source_client_id` interoperate
cleanly via the timing fallback.

