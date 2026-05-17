# SSE as Primary Channel for `/api/changes`

## Overview

The 30s polling on `GET /api/changes?since=` is the source of the cross-device / agent-driven update lag (a write on device A or via MCP is invisible on device B until the next poll). The original decision in `docs/technical-decisions.md:3` rejected SSE because of `RST_STREAM` noise behind HTTP/2 reverse proxies — but **the user controls the Traefik proxy** in this deployment, and modern Chromium handles clean stream closes without surfacing `ERR_HTTP2_PROTOCOL_ERROR`. The rationale that drove the original rejection no longer applies.

Surprising discovery during planning: **SSE is already ~90% implemented and intentionally disabled.** A working server handler exists at `internal/server/changes_handlers.go:98` (`handleChangesStream`, registered at `internal/server/server.go:677`) and a full EventSource client with exponential backoff lives at `web/static/js/data-store.js:540` (`startChangeStream`). The client just bypasses SSE in `data-store.js:596 startChangePolling()` with a comment citing the original rationale.

So this plan is mostly: **flip the default, replace the per-stream 5s table-polling loop with a process-wide broker, configure Traefik, document the residual deploy-time `RST_STREAM` as expected.**

This is independent of `docs/plans/2026-05-17-optimistic-write-updates.md` — that plan removes same-device latency; this plan removes cross-device / agent-driven latency.

## Goal

After a write completes on the server (regardless of which client or which transport initiated it), connected SSE subscribers receive a notification within ~50ms instead of up-to-30s. Polling remains the fallback when SSE fails to establish or repeatedly disconnects.

## Approach

1. **Server: add a process-wide broker.** Replace the per-stream 5s `change_events` table tail with `Subscribe(ctx) <-chan int64`, `Notify(cursor int64)`. Tap the broker at the HTTP-handler middleware layer on successful non-GET responses (single point, no per-handler instrumentation). Handler `select`s on subscription channel + keepalive ticker + `r.Context().Done()`.
2. **Server: graceful shutdown.** `hub.CloseAll()` runs in `Server.Shutdown` before the listener closes — handlers see channel close, return cleanly, clients see `onerror` and reconnect after restart.
3. **Client: flip the default.** `startChangePolling()` tries SSE first; falls back to polling on 3 consecutive `onerror` within 30s (existing `CHANGE_STREAM_AUTH_PROBE_ERRORS` threshold is already wired). Once fallen back, stay on polling for the rest of the session.
4. **Auth: reuse the existing `?initData=` query-param path.** Telegram `initData` is HMAC-validated server-side in `internal/server/auth.go:211-217` and `web/static/js/data-store.js:531-538` already builds the SSE URL with `initData` as a query param. EventSource's "no custom headers" constraint is already solved.
5. **Traefik: add labels for `/api/changes/stream`** — disable response buffering, set long idle timeout, keep HTTP/2.
6. **Docs: revise `docs/technical-decisions.md`** to flip the SSE-vs-polling stance.

## Context (from discovery)

- **Existing server handler**: `internal/server/changes_handlers.go:98 handleChangesStream` — registered at `internal/server/server.go:677`, has 40-slot semaphore (`changeStreamSem`), 5s ticker + `: keepalive` comments, 10-min `changeStreamMaxSessionAge` recycle, already sets `X-Accel-Buffering: no` (line 121).
- **Existing client**: `web/static/js/data-store.js:540 startChangeStream` — full EventSource with `onopen` / `onmessage` / `onerror`, exponential backoff, builds URL with `?initData=…` at lines 531-538.
- **Dead path**: `data-store.js:596 startChangePolling` explicitly bypasses SSE with a comment citing `docs/technical-decisions.md:5`, calls only `startChangePollInterval()`.
- **Auth model**: `internal/server/auth.go:211-217` accepts `X-Telegram-Init-Data` header OR `?initData=` query param. HMAC + ~24h freshness window baked into Telegram's signing; query-param leakage risk is bounded.
- **Change events**: populated by SQL triggers (migration 027). `internal/store/settings/repo.go ListChangedTagsSince(cursor)` is the read path used by both the polling handler and the SSE handler's initial-state send.
- **Apply path on the client**: `data-store.js:382 applyChangesPayload` is shared between polling (line 477) and SSE (line 559). Both funnel into `requestTabRefresh()` and `invalidateTags()`. No new client-side apply path needed.
- **Existing semaphore**: 40 slots process-wide; for a single household (~3 devices × ~3 tabs = 9 slots) this is fine. Configurable via env if it ever becomes contentious.

## Development Approach

- **Testing approach**: Regular (code first, then tests). Server tests live next to handlers; the new broker gets its own focused test file.
- **CRITICAL: every task MUST include new/updated tests** covering the broker fan-out, the handler integration, and the client fallback trigger.
- **CRITICAL: all tests must pass before starting next task**.
- Land the server broker + handler rewrite first (behind the existing `/api/changes/stream` route — no client behaviour change yet). Then flip the client default. Then add Traefik config + docs.
- The work touches 3 files in `internal/server/` + `web/static/js/data-store.js` + Traefik labels + docs. Small surface; one PR per task is reasonable.

## Testing Strategy

- **Unit tests** (Go, server-side):
  - `internal/server/changes_broker_test.go` — broker Subscribe/Unsubscribe/Notify fan-out, drop-on-full-channel semantics, CloseAll on shutdown.
  - `internal/server/changes_handlers_test.go` — keep existing `handleChanges` tests green; add `TestHandleChangesStreamFanout` (subscribe two recorders, write a change, both receive frame within 200ms), `TestHandleChangesStreamShutdown` (open stream, `hub.CloseAll()`, handler returns cleanly), `TestHandleChangesStreamUnauthorized` (no initData → 401 before any `text/event-stream` header).
- **Unit tests** (frontend): `web/static/js/tests/data-store.sse-fallback.test.js` (new — DataStore is in the pure-unit allowance per CLAUDE.md):
  - Stub `EventSource` global. Assert `startChangePolling` opens SSE first.
  - Simulate `onopen` then a message — poll interval is stopped, `invalidateTags` fires.
  - Simulate 3 consecutive `onerror` within the threshold window — poll interval starts, SSE is not retried again this session.
  - Simulate `EventSource === undefined` (older browser) — immediate poll fallback.
- **E2E tests**: project does not run Playwright/Cypress yet. Manual verification covers the cross-device flow (see Post-Completion).

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): server code, client code, tests, docs
- **Post-Completion** (no checkboxes): Traefik label deployment, multi-tab manual verification, access-log review for `initData` exposure

## Implementation Steps

### Task 1: Add broker in `internal/server/changes_broker.go`
- [x] new file with `ChangeBroker` struct: `subs map[chan int64]struct{}`, `sync.RWMutex`, `Subscribe(ctx) <-chan int64`, `Unsubscribe(ch)`, `Notify(cursor int64)`, `CloseAll()`
- [x] `Notify` fan-out is non-blocking — drop on full channel (cursor is monotonic; missed wake harmless because client reconciles via `ListChangedTagsSince(lastCursor)`)
- [x] `Subscribe` returns a buffered channel (size 1) and auto-removes on `ctx.Done()`
- [x] `CloseAll` closes all subscriber channels under write lock — used by graceful shutdown
- [x] write `internal/server/changes_broker_test.go` covering: single-subscriber notify delivery, multi-subscriber fan-out, drop-on-full-channel (no block), Unsubscribe removes from set, ctx cancel auto-unsubscribes, CloseAll closes channels
- [x] run `go test ./internal/server/...` — must pass before next task

### Task 2: Wire broker into `Server` + write-notify middleware
- [x] add `changes *ChangeBroker` field to `Server` struct in `internal/server/server.go`; construct in `New(...)` (named `changesBroker` to avoid collision with the existing `changes` ChangeStore field)
- [x] add `notifyOnWriteMiddleware` that wraps the API mux: on successful (2xx) non-GET response, call `s.changesBroker.Notify(latestCursor)` where `latestCursor` comes from `s.changes.GetLatestChangeCursor`
- [x] wire middleware around `apiMux` (wrapping the apiMux before storing in `s.internalMux`, so bridge writes also notify); auth middleware then wraps the notify-wrapped handler
- [x] add `s.changesBroker.CloseAll()` to `Server.Shutdown` so in-flight handlers exit cleanly (caller in `cmd/bot/main.go` is responsible for invoking `Server.Shutdown` before `http.Server.Shutdown`)
- [x] write test in `changes_handlers_test.go`: POST a write through the test server, assert a subscriber receives the cursor within 200ms (also added GET-skip and Shutdown-closes-subscribers tests)
- [x] run `go test ./internal/server/...` — must pass before next task

### Task 3: Rewrite `handleChangesStream` to use the broker
- [x] replace 5s ticker + `ListChangedTagsSince` polling loop in `internal/server/changes_handlers.go:98` with `select` on `hub.Subscribe(ctx)`, `time.After(15*time.Second)` keepalive, `r.Context().Done()`
- [x] preserve initial-state send after subscribing (avoid missing events between subscribe and first query)
- [x] preserve 10-min `changeStreamMaxSessionAge` forced recycle (lets aggressive Traefik idle timeouts coexist)
- [x] preserve 40-slot semaphore
- [x] preserve `X-Accel-Buffering: no`, no `Content-Length`, no `Connection: keep-alive` hop-by-hop header
- [x] add `TestHandleChangesStreamFanout`, `TestHandleChangesStreamShutdown`, `TestHandleChangesStreamUnauthorized` in `changes_handlers_test.go`
- [x] run `go test ./internal/server/...` — must pass before next task

### Task 4: Flip client default to SSE-first
- [x] modify `web/static/js/data-store.js:596 startChangePolling()`: call `startChangeStream()` first; only fall through to `startChangePollInterval()` on immediate failure or when `EventSource === undefined`
- [x] remove the misleading "SSE is broken" comment block citing the old rationale
- [x] add `changeStreamGaveUp` flag: after 3 consecutive `onerror` within 30s (use existing `CHANGE_STREAM_AUTH_PROBE_ERRORS = 3` at line 24), set the flag, switch to polling for the rest of the session
- [x] add an `if (changeStream) return;` early-exit at the top of `startChangePollInterval`'s tick callback to handle the race where polling fires between `startChangeStream` and `onopen`
- [x] write `web/static/js/tests/data-store.sse-fallback.test.js` covering SSE-first preference, fallback after 3 errors, no-EventSource fallback, applyChangesPayload runs on SSE message
- [x] run `pnpm test` — must pass before next task (only pre-existing TZ-flake `health.dexie-hydration.test.js > TZ-mismatch fallback` failed; verified it also fails on master)

### Task 5: Verify acceptance criteria
- [ ] verify `go test ./...` is green
- [ ] verify `pnpm test` is green
- [ ] verify architecture tests (no new `window.*` globals, no inline styles) — `pnpm test` covers these
- [ ] verify `internal/server/changes_handlers.go` no longer has the per-stream 5s polling loop
- [ ] verify `data-store.js` no longer cites the obsolete RST_STREAM rationale
- [ ] verify graceful shutdown: integration test or manual run of the server with an open stream, `kill -TERM` the process, confirm no panic in logs

### Task 6: Document Traefik configuration in repo
- [ ] add a new `docs/sse-traefik.md` (or extend `docs/environment.md` if a clear section exists) with the exact Traefik labels needed for `/api/changes/stream`: `sse-nobuffer` middleware (`buffering.maxResponseBodyBytes=0`, `memResponseBodyBytes=0`), router rule `PathPrefix(\`/api/changes/stream\`)` with `middlewares=sse-nobuffer@docker` and `priority=100`, entry-point `respondingTimeouts.readTimeout=0` and `idleTimeout=0` in `traefik.yml`
- [ ] note residual risk in the doc: deploy-time SIGTERM emits one `RST_STREAM` per active client; EventSource auto-reconnects silently
- [ ] note `initData` access-log exposure: bounded by Telegram's HMAC freshness window (~24h); recommend disabling URL query logging for `/api/changes/stream` or a Traefik log-redaction middleware
- [ ] revise `docs/technical-decisions.md:3` ("Why polling instead of SSE…") to reflect the new stance: SSE is primary, polling is fallback; the original RST_STREAM concern is mitigated by the broker-based clean-shutdown path

### Task 7: [Final] Update CLAUDE.md + architecture docs
- [ ] update `CLAUDE.md` or `docs/architecture.md` "scheduler / sync" section to describe the broker + SSE-first model
- [ ] cross-link from `docs/api.md` if `/api/changes/stream` is documented there
- [ ] add a one-line note in `docs/frontend.md` "data flow" section pointing to the SSE-first behaviour and the polling fallback trigger

## Technical Details

### Broker contract

```go
type ChangeBroker struct {
    mu   sync.RWMutex
    subs map[chan int64]struct{}
}

func (b *ChangeBroker) Subscribe(ctx context.Context) <-chan int64
func (b *ChangeBroker) Unsubscribe(ch chan int64)
func (b *ChangeBroker) Notify(cursor int64)  // non-blocking fan-out
func (b *ChangeBroker) CloseAll()             // graceful shutdown
```

- Channel buffer size 1: missed wakes are harmless because each handler queries `ListChangedTagsSince(lastCursor)` on every received wake, picking up everything since its last cursor.
- `Notify` runs under read lock with `select { case ch <- cursor: default: }` so a slow client doesn't block writes.

### Middleware insertion point

`notifyOnWriteMiddleware` wraps the existing `apiMux` after auth. Implementation sketch:

```go
func (s *Server) notifyOnWriteMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        rec := &statusRecorder{ResponseWriter: w, status: 200}
        next.ServeHTTP(rec, r)
        if r.Method != http.MethodGet && rec.status >= 200 && rec.status < 300 {
            if cursor, err := s.store.Settings.GetLatestChangeCursor(r.Context()); err == nil {
                s.changes.Notify(cursor)
            }
        }
    })
}
```

(Confirm `GetLatestChangeCursor` signature during implementation; it may be named differently.)

### Client fallback state machine

```
state: { sseAttempts: 0, sseGaveUp: false, errorsInWindow: 0, errorWindowStart: 0 }

startChangePolling():
  if state.sseGaveUp OR EventSource === undefined:
    startChangePollInterval()
    return
  startChangeStream()

onerror:
  now = Date.now()
  if now - state.errorWindowStart > 30000:
    state.errorWindowStart = now
    state.errorsInWindow = 0
  state.errorsInWindow += 1
  if state.errorsInWindow >= CHANGE_STREAM_AUTH_PROBE_ERRORS:  // 3
    state.sseGaveUp = true
    startChangePollInterval()
```

### Traefik labels (Docker Compose example)

```yaml
labels:
  - "traefik.http.routers.medtracker.entrypoints=websecure"
  - "traefik.http.routers.medtracker.tls=true"
  - "traefik.http.services.medtracker.loadbalancer.server.port=8080"

  - "traefik.http.middlewares.sse-nobuffer.buffering.maxResponseBodyBytes=0"
  - "traefik.http.middlewares.sse-nobuffer.buffering.memResponseBodyBytes=0"

  - "traefik.http.routers.medtracker-sse.rule=Host(`med.example.com`) && PathPrefix(`/api/changes/stream`)"
  - "traefik.http.routers.medtracker-sse.middlewares=sse-nobuffer@docker"
  - "traefik.http.routers.medtracker-sse.priority=100"
```

`traefik.yml` entry-point:

```yaml
entryPoints:
  websecure:
    address: ":443"
    transport:
      respondingTimeouts:
        readTimeout: 0
        idleTimeout: 0
```

## Post-Completion

**Deployment**:
- Apply the Traefik labels above to the production Compose file. Reload Traefik.
- Verify `curl -N https://med.example.com/api/changes/stream?initData=…` returns `text/event-stream` with frames arriving immediately (no buffering).

**Manual verification**:
- Open two tabs of the same user. Log a BP reading in tab A. Tab B's Today tile updates without a 30s wait.
- Trigger a write via MCP from Claude / agent context. Connected web UI updates within ~1s.
- DevTools Network panel on `/api/changes/stream`: `text/event-stream`, status 200, `X-Accel-Buffering: no`, no `Content-Length`, frames stream in real time.
- Stop the Go process mid-stream: client falls back to polling, reconnects after restart with one expected `onerror` per client.
- Revoke session (rotate bot token / clear initData): stream gets 401 on next reconnect, client stops retrying SSE.

**Access-log hygiene**:
- Confirm Traefik access logs either redact the `initData` query param for `/api/changes/stream` or are scoped to not log query strings for that route. The HMAC + Telegram's freshness window bound the leak risk to ~24h, but lower the surface where convenient.

**External system updates**: none — Traefik config is the only deploy-side change, and the user controls it.

## Risks / Open Questions

- **RST_STREAM at deploy time**: unavoidable on SIGTERM. Mitigated by `hub.CloseAll()` running before listener close — handlers exit cleanly, one spurious `onerror` per client per deploy, EventSource auto-reconnects. Document as expected.
- **`initData` in access logs**: bounded leak (Telegram HMAC freshness window). Recommend Traefik-side mitigation in Post-Completion; not a blocker.
- **Traefik `forwardingTimeouts.idleTimeout`**: must be `0` (unlimited) or > 30s to outlive the 15s keepalive comment. Verify in the user's actual Traefik config — if they have a tight global idle timeout, the per-route entry-point setting needs to override it.
- **Semaphore sizing**: 40 process-wide slots. Adequate for single-household use; consider env var (`CHANGES_STREAM_MAX_CONN`) if multi-tenancy ever happens. Out of scope here.
- **Cursor source-of-truth**: confirm whether `GetLatestChangeCursor` exists or if the middleware needs a different accessor on `store.Settings`. Resolve during Task 2.
