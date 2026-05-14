# Panic-recovery middleware + LowStockChecker TZ/race fix

## Overview

Two small, independent changes from the
[2026-05-13 Go review](../2026-05-13-go-code-review.md), bundled because
they're each a few hours and neither conflicts with the in-flight
`store.Store` split (they touch `internal/server/server.go` and
`internal/scheduler/low_stock.go`, not `internal/store/`).

**1. Panic-recovery middleware (review §7).** Today any nil-deref,
out-of-bounds, or `interface conversion` panic in any HTTP handler crashes
the entire binary — server, scheduler, and bot all share one process.
`internal/server/server.go` does not wrap handlers in a recovery
middleware, and `cmd/bot/main.go:279` calls `Server.ListenAndServe()`
with no process-level recovery either. Adding ~20 lines of middleware in
the outermost layer of `Server.Routes()` prevents this entire class of
outage.

**2. LowStockChecker timezone + data race (review §4.1, §4.2).**
`internal/scheduler/low_stock.go` is the only checker in the package that
does **not** load the user's stored timezone before deciding whether to
fire — it compares `now.Hour() != 11` against server-local time
(line 28). For a user in `America/Los_Angeles` running on a UTC server,
"daily 11 AM low-stock warning" fires at 4 AM PT. Same checker also
reads/writes `lastCheck` (lines 33, 48, 76) with no lock, so concurrent
firings can both pass the date guard and double-notify. Both bugs exist
because this file diverged from the pattern that
`bp_reminders.go:49-67`, `weight_reminders.go`, `workout.go:75-90` and
`medication.go:67-77` all follow correctly.

**Out of scope** (deferred to follow-on plans):
- §4.3 `NotifyHelper` unbounded goroutines / per-notifier timeouts
- §4.4 DST cross-boundary tests
- §11 generic reminder-checker base class (better tackled after the
  store split lands so each checker depends on a narrow store interface)

## Context (from discovery)

- `internal/scheduler/low_stock.go` — 79 lines, the only file changed for
  task 2. The `MedicationStore` interface it depends on already exposes
  `GetCurrentTimezone() (string, error)` via
  `internal/scheduler/medication.go:30`, so no interface change is
  needed.
- `internal/scheduler/bp_reminders.go:49-67` is the canonical
  TZ-loading pattern to copy: load via `GetCurrentTimezone()`, log a
  warning and fall back to server TZ on error or invalid string,
  otherwise call `now = now.In(userLoc)`.
- `internal/server/server.go:378-584` is `Server.Routes()`. The current
  outermost wrapper is `securityHeadersMiddleware(mux)` at line 583.
  Panic recovery should sit *outside* that so it also catches panics
  inside other middlewares.
- `cmd/bot/main.go:276-279` is the only caller of `srv.Routes()`; no
  test wires routes directly.
- `internal/scheduler/low_stock_bench_test.go` shows the established
  mock pattern (`mockMedStoreForBench` embeds `MedicationStore` and
  overrides only the methods used). Reuse for new tests.
- No existing panic-recovery code anywhere in `internal/server/` or
  `cmd/bot/` (grep for `recover()` returns no hits).

## Development Approach

- **Testing approach**: Regular (code first, then tests) — matches the
  project's existing test style.
- Both tasks are small enough to be one commit each; ship as one PR.
- Run `go test ./...` after each task; nothing else needs changing.
- The store-split refactor is in flight on a separate branch; both
  files in this plan are outside its blast radius, so merge order
  doesn't matter.

## Testing Strategy

- **Unit tests**: required for both tasks.
- **No e2e impact**: this plan touches only Go server middleware and a
  scheduler internal — no frontend changes, no API surface changes.
- **Race detector**: task 2's race fix should be verified with
  `go test -race ./internal/scheduler/...`.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document blockers with ⚠️ prefix.

## Implementation Steps

### Task 1: Panic-recovery middleware

- [x] add `panicRecover` middleware in `internal/server/server.go`
  (next to `securityHeadersMiddleware`); on `recover()` it logs via
  `slog.Error` with `error`, `path`, `method`, and `stack`
  (`debug.Stack()`), then writes `http.StatusInternalServerError` —
  but only if no bytes have been written yet (track via a thin
  `responseWriter` wrapper or `http.NewResponseController`-style flag,
  to avoid corrupting an already-streaming response like
  `/api/changes/stream`)
- [x] wrap the `Server.Routes()` return value: replace
  `return securityHeadersMiddleware(mux)` with
  `return panicRecover(securityHeadersMiddleware(mux))` so the recover
  is the outermost layer (catches panics in security headers and
  rate-limit middleware too)
- [x] add `runtime/debug` to imports as needed
- [x] write unit test in `internal/server/panic_recover_test.go`:
  handler that panics → response is 500, body is non-empty, no goroutine
  crash; assert via `httptest.NewRecorder` and a deliberate
  `panic("boom")` handler mounted on a tiny `http.ServeMux`
- [x] write unit test for the "already-streamed" case: handler writes
  `w.WriteHeader(200)` and some bytes, then panics → status stays 200,
  body contains the partial write, recover still logs without trying to
  re-write headers
- [x] run `go test ./internal/server/...` — must pass before task 2

### Task 2: LowStockChecker TZ + race fix

- [x] add `sync.Mutex` field `mu` to `LowStockChecker` in
  `internal/scheduler/low_stock.go`; guard `lastCheck` read at line 33
  and writes at lines 48, 76 (taking the lock for the entire
  read-decide-write critical section)
- [x] load user timezone at the top of `Check()` using the
  `bp_reminders.go:49-67` pattern: call
  `c.store.GetCurrentTimezone()`, on success+non-empty parse with
  `time.LoadLocation`, on either error log a warning and fall back to
  server TZ; then call `now = now.In(userLoc)` once and use that `now`
  consistently for both the `now.Hour() != 11` guard and the date
  comparison
- [x] when assigning `c.lastCheck` (currently lines 48 and 76), use the
  TZ-adjusted `now` value (not `time.Now()`), so the next-day comparison
  is computed in a consistent zone
- [x] write `internal/scheduler/low_stock_test.go` covering:
  - fires at 11:00 user-TZ when server is in a different zone (regression
    test for §4.1) — inject `now` returning 19:00 UTC, set store TZ to
    `America/Los_Angeles`, assert `GetMedicationsLowOnStock` was called
  - skips outside the 11 AM window in user TZ — same setup, `now`
    returning 18:00 UTC (10 AM PT), assert `GetMedicationsLowOnStock`
    was NOT called
  - skips when already checked today (date guard works in user TZ)
  - empty-meds path still updates `lastCheck` (preserves existing
    behavior)
  - invalid TZ string falls back to server TZ without panicking
- [x] write race test or add `-race` assertion: spawn 50 concurrent
  `Check()` calls and assert no race detector hit, and that
  `GetMedicationsLowOnStock` is called at most once (regression test
  for §4.2). Mock store should count invocations atomically.
- [x] update `internal/scheduler/low_stock_bench_test.go` if the
  `LowStockChecker` literal in it needs the new field — added a
  `GetCurrentTimezone()` mock method since the bench mock embeds a nil
  `MedicationStore` and the new TZ load path would otherwise panic
- [x] run `go test -race ./internal/scheduler/...` — passes for new
  low_stock tests; a pre-existing race in `TestWorkoutCheckerScenarios`
  (unrelated to this task — `MockNotifier.Send` in `medication_test.go`)
  remains, but that is outside Task 2's scope and was present before
  this change

### Task 3: Verify acceptance

- [x] `go build ./...` clean
- [x] `go test ./...` clean (full suite)
- [x] `go test -race ./internal/scheduler/... ./internal/server/...`
  clean — new `TestLowStock*` and `TestPanicRecover*` tests pass under
  `-race`. The pre-existing race in `TestWorkoutCheckerScenarios`
  (`MockNotifier.Send` in `medication_test.go`) is unrelated to this
  plan and already noted in Task 2 line 150-152
- [x] `golangci-lint run ./...` (or whatever the project lint command
  is) — no new findings (ran `golangci-lint v2.10.1` per
  `.github/workflows/golangci-lint.yml`; touched packages
  `./internal/server/...` and `./internal/scheduler/...` report
  `0 issues`)
- [x] grep for `c.lastCheck = time.Now()` in
  `internal/scheduler/low_stock.go` returns zero results (proves the
  TZ-adjusted-now fix landed)
- [x] grep for `recover()` in `internal/server/server.go` returns one
  hit (the new middleware)

## Technical Details

### Panic-recovery middleware shape

```go
func panicRecover(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        wrapped := &recoverWriter{ResponseWriter: w}
        defer func() {
            if rec := recover(); rec != nil {
                slog.Error("panic recovered",
                    "error", rec,
                    "method", r.Method,
                    "path", r.URL.Path,
                    "stack", string(debug.Stack()),
                )
                if !wrapped.wroteHeader {
                    http.Error(w, "internal error", http.StatusInternalServerError)
                }
            }
        }()
        next.ServeHTTP(wrapped, r)
    })
}

type recoverWriter struct {
    http.ResponseWriter
    wroteHeader bool
}

func (w *recoverWriter) WriteHeader(code int) {
    w.wroteHeader = true
    w.ResponseWriter.WriteHeader(code)
}

func (w *recoverWriter) Write(b []byte) (int, error) {
    w.wroteHeader = true
    return w.ResponseWriter.Write(b)
}
```

The `recoverWriter` is necessary because `/api/changes/stream`
(`internal/server/server.go:544`) is an SSE endpoint that may panic
mid-stream — we must not try to write a 500 header after bytes have
already gone out.

### LowStockChecker fix shape

Replace lines 21-49 with:

```go
func (c *LowStockChecker) Check(_ context.Context) error {
    if c.now == nil {
        c.now = time.Now
    }

    // Load user timezone — same pattern as bp_reminders.go:49-67.
    userLoc := time.Local
    if tz, err := c.store.GetCurrentTimezone(); err != nil {
        slog.Warn("low_stock: failed to get user timezone, using system TZ", "error", err)
    } else if tz != "" {
        if loc, err := time.LoadLocation(tz); err != nil {
            slog.Warn("low_stock: invalid user timezone, using system TZ", "tz", tz, "error", err)
        } else {
            userLoc = loc
        }
    }

    now := c.now().In(userLoc)

    if now.Hour() != 11 {
        return nil
    }

    c.mu.Lock()
    defer c.mu.Unlock()

    if !c.lastCheck.IsZero() {
        last := c.lastCheck.In(userLoc)
        lastDate := time.Date(last.Year(), last.Month(), last.Day(), 0, 0, 0, 0, userLoc)
        todayDate := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, userLoc)
        if !lastDate.Before(todayDate) {
            return nil
        }
    }

    // ... existing meds query + notification ...

    c.lastCheck = now  // store TZ-adjusted now, not time.Now()
    return nil
}
```

Note `c.lastCheck = now` (the TZ-adjusted value) at both early-return
and end, replacing the two existing `c.lastCheck = time.Now()` calls.

## Post-Completion

**Manual verification** (optional, post-merge):
- After deploy, verify low-stock notification fires at 11:00 in the
  configured user TZ (not server TZ) by checking the next morning's
  notification timestamp against `users.timezone`.
- Trigger a deliberate panic in a dev build (e.g. `panic("test")` in
  any handler) and confirm the process stays up and a structured
  `panic recovered` log line appears.

**No external system updates needed** — pure server-side changes, no
schema migrations, no API surface changes, no frontend coordination.
