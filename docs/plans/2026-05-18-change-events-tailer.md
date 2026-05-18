# Change-Events Tailer for Broker Notify

## Overview

Eliminate the up-to-30s latency for Telegram-bot writes (and any other write path that bypasses the HTTP `notifyOnWriteMiddleware`) by adding a process-wide tailer goroutine that polls `SELECT MAX(id) FROM change_events` every ~200ms and calls `broker.Notify(cursor)` when the cursor advances.

Today, `internal/server/changes_broker.go:142 notifyOnWriteMiddleware` fans out broker notifications on successful 2xx non-GET HTTP responses. This covers web UI and MCP writes (top-level tools + `/internal/mcp/bridge` which dispatches through `s.internalMux = notifyOnWriteMiddleware(apiMux)`). But **Telegram bot callbacks call domain services directly**, in-process, without going through HTTP — so the broker never gets notified for those writes. Connected SSE clients only learn about them via the 30s backstop ticker `changeStreamCursorCheckInterval` in `internal/server/changes_handlers.go:182`.

The SQL triggers from migration 027 already write to `change_events` on every INSERT/UPDATE in the watched tables, regardless of which Go code path triggered the write. A tailer reading that single source of truth catches all writes uniformly.

This plan is the natural follow-up to `docs/plans/completed/2026-05-17-sse-changes-stream.md`.

## Goal

Sub-second propagation for Telegram-initiated writes (BP entry, weight, medication confirm via bot callback, etc.) to all connected SSE clients — matching the ~50ms latency that HTTP/MCP writes already achieve.

## Approach

Single goroutine living next to the broker in `internal/server/changes_broker.go` (or a new sibling file `changes_tailer.go`):

1. On `Server.New`, after `changesBroker` is constructed, start the tailer with a context derived from the server's lifetime.
2. Every `changeTailerInterval` (default **200ms**), call `s.changes.GetLatestChangeCursor(ctx)`.
3. If the returned cursor is greater than the last-observed cursor, call `s.changesBroker.Notify(cursor)` and update the last-observed cursor.
4. On `Server.Shutdown`, cancel the tailer's context so the goroutine exits cleanly (alongside the existing `s.changesBroker.CloseAll()` call).

Idempotency: when both the HTTP middleware and the tailer fire `Notify` for the same cursor advance within a tick window, broker subscribers wake an extra time but observe the same cursor — `applyChangesPayload` on the client treats the empty-tags case as a no-op (`changes_handlers.go:197-199`).

## Context (from discovery)

- **Broker**: `internal/server/changes_broker.go` — `ChangeBroker.Notify(cursor int64)` is non-blocking, drop-on-full-channel. Already exposes everything the tailer needs.
- **Cursor source of truth**: `internal/store/settings/repo.go:210 GetLatestChangeCursor(ctx)` returns the highest `change_events.id`, or 0 when empty. Returns `int64, error`. Lightweight single-row indexed SELECT. Already used by the HTTP middleware and the per-stream backstop.
- **Existing HTTP middleware**: `internal/server/changes_broker.go:142 notifyOnWriteMiddleware` — pattern to mirror for the GET-cursor + Notify call shape.
- **Server lifecycle**: `internal/server/server.go` constructs `changesBroker` at line 236; `Shutdown` calls `s.changesBroker.CloseAll()`. The tailer's context-cancel needs to be invoked next to that.
- **Per-stream backstop**: `internal/server/changes_handlers.go:25 changeStreamCursorCheckInterval = 30 * time.Second` — this ticker per open SSE connection. Once the tailer is in place, this backstop is largely redundant; covered in Task 4.
- **No new store changes needed**: the SQL triggers from migration 027 already populate `change_events` on writes to the watched tables.
- **MCP bridge**: `internal/server/mcp_bridge.go:254 handleMCPBridge` dispatches through `s.internalMux` (wrapped), so its writes already notify. Confirmed earlier in the parent conversation — no change needed.

## Development Approach

- **Testing approach**: Regular (code first, then tests). Pattern follows the existing broker tests in `internal/server/changes_broker_test.go` and the SSE handler tests in `internal/server/changes_handlers_test.go`.
- **CRITICAL: every task MUST include new/updated tests** covering: tailer fires Notify on cursor advance, tailer is silent when cursor doesn't advance, context-cancel exits the goroutine cleanly.
- **CRITICAL: all tests must pass before starting next task**.
- Pure-server change; no frontend touchpoint. No new dependencies, no new env vars (interval is a typed constant; can be made tunable later if needed).
- Maintain backward compatibility — broker callers and SSE handler API unchanged; tailer is purely additive.

## Testing Strategy

- **Unit tests** (Go): `internal/server/changes_tailer_test.go` (new file, or extend `changes_broker_test.go`):
  - `TestTailerNotifiesOnCursorAdvance`: subscribe a recorder, insert a row into `change_events`, assert the recorder receives a notify within ~3× `changeTailerInterval`.
  - `TestTailerSilentWithoutWrites`: subscribe a recorder, wait 3× interval without writing, assert zero notifications.
  - `TestTailerStopsOnContextCancel`: start the tailer, cancel context, assert the goroutine returns (use a small wait-group / `runtime.NumGoroutine` delta or a done-channel exposed for tests).
  - `TestTailerCoalescesNotifications`: write two rows in quick succession (both arriving within one tick), assert at most one notify per tick window (cursor monotonicity verified).
- **Integration test** (extend `changes_handlers_test.go`):
  - `TestStreamReceivesTelegramLikeWrite`: open an SSE recorder, write directly to the underlying store (simulating a domain-service write that bypasses the HTTP middleware), assert the recorder receives the change within ~3× `changeTailerInterval` (i.e. NOT the 30s backstop interval).

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): code changes, tests, docs
- **Post-Completion** (no checkboxes): manual verification on prod after deploy

## Implementation Steps

### Task 1: Add tailer in `internal/server/changes_broker.go`
- [x] add constant `changeTailerInterval = 200 * time.Millisecond` near the top of the file (with a short comment noting the trade-off: lower = less Telegram-write lag but more idle SELECTs; 200ms is well below "feels instant" threshold)
- [x] add method `(s *Server) runChangeTailer(ctx context.Context)` — loop on `time.NewTicker(changeTailerInterval)` with `select` on `ctx.Done()` and the ticker; track `lastCursor int64` local var; on tick, call `s.changes.GetLatestChangeCursor(ctx)` with a short per-call timeout (e.g. 2s via `context.WithTimeout`); on err, log via `slog.Warn` and continue (don't kill the goroutine); on `cursor > lastCursor`, call `s.changesBroker.Notify(cursor)` and update `lastCursor`
- [x] initialise `lastCursor` from a single pre-loop `GetLatestChangeCursor` so the tailer doesn't fire a spurious notify for pre-existing rows on startup
- [x] write `TestTailerNotifiesOnCursorAdvance`, `TestTailerSilentWithoutWrites`, `TestTailerStopsOnContextCancel`, `TestTailerCoalescesNotifications` in `internal/server/changes_tailer_test.go` (new file)
- [x] run `go test ./internal/server/...` — must pass before next task

### Task 2: Wire tailer into `Server` lifecycle
- [x] add `tailerCancel context.CancelFunc` and `tailerDone chan struct{}` fields to `Server` struct in `internal/server/server.go`
- [x] in `Server.New` (around line 236, after `changesBroker:   NewChangeBroker(),`), construct a `context.WithCancel(context.Background())`, store the cancel func on `s.tailerCancel`, and `go s.runChangeTailer(ctx)` with a deferred close of `s.tailerDone` inside the goroutine wrapper
- [x] in `Server.Shutdown`, call `s.tailerCancel()` BEFORE `s.changesBroker.CloseAll()` and wait on `<-s.tailerDone` (with a short timeout) so the tailer doesn't race against broker shutdown
- [x] add an integration test in `changes_handlers_test.go`: write directly to the store, assert an open SSE recorder receives the change within ~600ms (3× the interval) — NOT the 30s backstop
- [x] run `go test ./internal/server/...` — must pass before next task

### Task 3: Reduce the per-stream backstop ticker
- [ ] change `changeStreamCursorCheckInterval` in `internal/server/changes_handlers.go:25` from `30 * time.Second` to `5 * time.Minute` (defense-in-depth in case the tailer goroutine ever crashes silently; the comment on that constant should be updated to reflect its new role as a defense-in-depth check, not the primary latency bound)
- [ ] update the constant's doc comment to mention the tailer is the primary mechanism now
- [ ] update any existing test that asserts the 30s value (search: `grep -rn "30 \* time.Second" internal/server/`) to reflect the new value or assert behaviorally instead
- [ ] run `go test ./internal/server/...` — must pass before next task

### Task 4: Verify acceptance criteria
- [ ] grep `internal/server/` for any other place that mentions the 30s cursor-check rationale and update the comment
- [ ] run full Go test suite: `go test ./...`
- [ ] run `golangci-lint run ./...` — no new findings
- [ ] verify `go test -race ./internal/server/...` passes (tailer adds a new goroutine; ensure no races on `lastCursor` — it's a local var so should be clean, but `-race` catches any future regression)
- [ ] verify the tailer doesn't busy-spin in the empty-DB case (manual: run the bot locally with a fresh DB for a minute, watch CPU)

### Task 5: [Final] Update documentation
- [ ] add a paragraph to `docs/architecture.md` (in the scheduler/sync section, alongside the SSE notes from the previous plan) describing the tailer as the catch-all path: SQL triggers populate `change_events`, tailer fans out via broker
- [ ] update `docs/technical-decisions.md` — the post-SSE rationale section should now note: "writes that bypass HTTP (bot callbacks, scheduler materialisation) are caught by a 200ms tailer on `change_events`, not the per-stream 30s backstop"
- [ ] no CLAUDE.md change needed — this is a server-internal optimisation; doesn't affect the domain-service-pattern rule or any other contributor-facing convention

## Technical Details

### Tailer loop sketch

```go
const changeTailerInterval = 200 * time.Millisecond

func (s *Server) runChangeTailer(ctx context.Context) {
    defer close(s.tailerDone)

    initCtx, initCancel := context.WithTimeout(ctx, 2*time.Second)
    lastCursor, err := s.changes.GetLatestChangeCursor(initCtx)
    initCancel()
    if err != nil {
        slog.Warn("change tailer: initial cursor read failed", "error", err)
        // Start from 0 — first real tick will catch up.
    }

    ticker := time.NewTicker(changeTailerInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            qctx, qcancel := context.WithTimeout(ctx, 2*time.Second)
            cursor, err := s.changes.GetLatestChangeCursor(qctx)
            qcancel()
            if err != nil {
                slog.Warn("change tailer: cursor read failed", "error", err)
                continue
            }
            if cursor > lastCursor {
                s.changesBroker.Notify(cursor)
                lastCursor = cursor
            }
        }
    }
}
```

### Why 200ms

- Below human perception threshold for "instant" feedback
- ~5 queries/second under idle is negligible against SQLite's typical throughput
- Coalesces well: a burst of writes in a busy second still produces only ~5 broker notifications, each with the latest cursor
- If `change_events` is empty for a long stretch (cold session), the read returns immediately with `id IS NULL` → 0; no busy-wait, just a cheap indexed SELECT every 200ms

### Why not 100ms or 500ms

- 100ms doubles the idle query rate for marginal UX gain
- 500ms is the borderline where users start noticing "lag" on a same-window action; not worth the savings

### Idempotency contract

- Broker callers (HTTP middleware AND tailer) can race for the same cursor advance — broker `Notify` is non-blocking and idempotent
- Subscribers receive at most one wake per tick (channel buffer size 1; subsequent Notifies drop into the `default` arm of the non-blocking send)
- Each SSE handler reconciles via `ListChangedTagsSince(lastObserved)` on every wake, so duplicate wakes for the same cursor produce empty-tag responses (no client repaint)

### Backstop interaction

- The per-stream `changeStreamCursorCheckInterval` ticker remains as defense-in-depth
- Bumped from 30s to 5 min — if the tailer ever stalls (goroutine deadlock, runtime issue), the per-stream backstop still bounds worst-case latency at 5 minutes
- Removing it entirely is tempting but the cost (one indexed SELECT per stream per 5 min) is trivial and gives us cheap insurance

## Post-Completion

**Manual verification**:
- After deploy, log a BP reading via Telegram bot. Open web tab should update within ~1 second (vs ~30s today, ~50ms target).
- Log a workout via Telegram. Same expectation.
- Watch `sudo podman logs medtracker-` for any `slog.Warn` from the tailer (`"change tailer: cursor read failed"`) — should be quiet unless DB is under load.
- Optionally measure idle CPU before/after: a 200ms ticker with one SELECT should add well under 0.1% CPU on prod.

**External system updates**: none — pure server-internal change. No Traefik tweaks, no client behaviour change, no env vars.

## Risks / Open Questions

- **Idle DB query volume**: 5 queries/sec is well within SQLite's headroom but worth eyeing in `litestream` replication metrics for a day or two after deploy. If it shows up as noise in the WAL, bump the interval to 500ms.
- **Goroutine leak on Shutdown**: must ensure `tailerCancel` runs and `<-tailerDone` is waited on before broker close. Covered in Task 2.
- **Test flake risk**: tests that assert "within Nms" can be timing-sensitive in CI. Use `eventually`-style helpers (poll up to a generous timeout with short sleeps) rather than fixed `time.Sleep` waits.
- **Interaction with `litestream`**: the read-only SELECT MAX(id) shouldn't interfere with WAL replication, but worth confirming on prod for a day before declaring victory.
