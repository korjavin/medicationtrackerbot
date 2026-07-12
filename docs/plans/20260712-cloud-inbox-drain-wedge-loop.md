# Cloud inbox drain: stop the 160MB re-fetch loop on a wedged/backlogged account (bd med-eas.51)

## Overview

**Problem (P0, self-inflicted DoS, bricks the account).** In cloud mode the web app
polls `GET /api/inbox` (`web/cloud/js/inbox.js` → `listInboxEvents`) every 5s and on
every page open. That endpoint returns the FULL un-acked sealed backlog — the server
caps it at 200 events by COUNT (`maxInboxDrainBatch`, `internal/cloudserver/inbox.go`)
but has **no byte cap**, so a backlog of stale sealed `.nxk` vitals is ~160MB per
response. An event is only acked (`DELETE /api/inbox/{id}`) AFTER `apply()` + `flush()`
(`flushConfirmed`, `web/cloud/js/sync.js`) confirms its ops reached the sync log. When
ops can't confirm — sync is WEDGED (`syncWedged`, med-0ol.7) or a permanent ops-400 —
`flush()` returns false, nothing acks, and the drain re-fetches the entire 160MB on the
next tight poll. Forever. The account is bricked and burns ~160MB per open.

**Confirmed root cause of the ops-400 (code-verified during planning).**
`POST /api/sync/ops` returns `400 "op field too large or missing"` when any single op's
ciphertext exceeds `maxOpCTLen = 64<<10` (64 KiB) in `internal/cloudserver/sync.go`
`PostOps`. A large Mi Band `.nxk` vitals record produced by the inbox import
(`web/cloud/js/inbox-apply.js` `vitals_import`) trips this permanent 400. `flushPending`
counts it against `WRITE_ERROR_BUDGET` (3 consecutive permanent 4xx) and then sets
`syncWedged`. Once wedged, `flushConfirmed` returns false immediately, so the inbox
event never acks → the re-fetch loop. So the 400 is the *trigger*; the *loop* is the
inbox drain ignoring the wedge state and having no byte cap and no recovery path.

**Fix.** Five coupled changes, smallest set that stops the loop and lets the account
recover, reusing med-0ol.7's `syncWedged`/`resetLocalSync` and sync's byte-batching:
1. Pause the inbox drain (before it even fetches) when sync is wedged.
2. Abort the drain early on the first `flush()==false`, and back off the poll interval.
3. Byte-cap `GET /api/inbox` so one response is never 160MB (mirror sync's ≤1 MiB batch).
4. Let the existing reset / un-wedge escape hatch also clear the poison server-side
   inbox backlog, so a permanently-unappliable sealed `.nxk` can't wedge forever.
5. Confirm + document the backlog is stale Telegram/`.nxk` seals; file a follow-up for
   the deeper "don't seal a huge Mi Band `.nxk` into the per-message mailbox" redesign.

## Context (from discovery)

- **`web/cloud/js/inbox.js`** — `drainInbox` (fetch-all → apply → flush → ack loop),
  `listInboxEvents` (`GET /api/inbox`), `startInboxPolling` (fixed `INBOX_POLL_MS=5000`
  `setInterval`, drains on visible + on visibilitychange). This is where #1/#2 land.
- **`web/cloud/js/sync.js`** — `syncWedged` meta flag (set after `WRITE_ERROR_BUDGET=3`
  consecutive permanent 4xx in `flushPending`), `flushConfirmed(ctx)` (the drain's ack
  barrier — already returns false when wedged, line ~809), `resetLocalSync(ctx)` (wipes
  local records/pending/sync_meta, clears `syncWedged`, re-bootstraps), `getSyncStatus`
  (`.wedged`), and the `FLUSH_MAX_BODY_BYTES = 900*1024` byte-batching pattern in
  `flushPending` (the ≤1 MiB chunking to reuse for #3's shape).
- **`internal/cloudserver/inbox.go`** — `ListInbox` handler + `maxInboxDrainBatch=200`
  count cap (no byte cap). `InboxAPI.RegisterRoutes`. `AckInboxEvent` / `DeleteInboxEvent`
  pattern to mirror for a clear-all route. This is where #3 and the server side of #4 land.
- **`internal/cloudstore/inbox.go`** — `ListInboxEvents` (`SELECT ... ORDER BY id LIMIT ?`),
  `DeleteInboxEvent`. Add a clear-all-for-account store method here for #4.
- **`web/cloud/js/cloud-boot.js`** — wires `ensureInboxKey`/`drainInbox`/
  `startInboxPolling` after unlock (~line 295) and exposes `resetLocalSync()` (~line 163).
  The reset wrapper is where the client calls the new server clear (#4).
- **`internal/cloudserver/telegram.go`** — `POST /api/telegram/reset` (`Reset` handler,
  line ~1470) is the reference pattern for a session-scoped account-mutating cloud route.
- **Tests**: `web/cloud/js/tests/inbox.test.js` (drain + polling suite — extend here),
  `web/cloud/js/tests/sync.test.js` (wedge/reset suite), `internal/cloudserver/inbox_test.go`
  (Go handler tests — add byte-cap + clear-all cases).
- **No MCP-coverage guard applies**: `internal/cloudserver` has its own mux
  (`cmd/cloud`), not the `internal/server` mux the MCP-coverage test guards. A new
  cloudserver route needs no registry/exempt entry.

## Development Approach
- **Testing approach**: NO unit tests. Integration tests only where they guard a real
  boundary. Here that means: extend the existing `inbox.test.js` drain suite (drain
  pauses when wedged; aborts + signals backoff on flush-false; healthy small-event drain
  still works) and the Go `inbox_test.go` (byte-capped page; clear-all route). These are
  real boundaries (the drain protocol correctness + the HTTP contract).
- Complete each task fully before the next. Small focused changes.
- **CRITICAL**: an added integration test must pass before starting the next task.
- **CRITICAL**: update this plan if scope changes.
- Preserve drain-protocol correctness: ack STRICTLY after flush; at-least-once +
  idempotent; deterministic ids; NEVER ack an un-flushed event. Byte-cap must not corrupt
  ordering (`ORDER BY id`; client already sorts by `at_unix`). No hardcoded colors / inline
  styles in any recovery UI. `log/slog` server-side.

## Testing Strategy
- **Unit tests**: none.
- **Integration tests**: extend `web/cloud/js/tests/inbox.test.js` and
  `internal/cloudserver/inbox_test.go` only. No new files unless a suite genuinely lacks
  an entry point.
- **E2E tests**: none (no existing cloud e2e suite to reuse).

## Progress Tracking
- Mark completed items `[x]` immediately.
- ➕ for newly discovered tasks, ⚠️ for blockers.
- Keep this plan in sync with actual work.

## Implementation Steps

### Task 1: Pause the inbox drain when sync is wedged (stops the 160MB loop)
- [ ] In `web/cloud/js/inbox.js` `drainInbox`, BEFORE calling `listInboxEvents` (before the
      `GET /api/inbox`), check the sync-wedge state and return early without fetching when
      wedged. Reuse the existing signal — import a small wedge check from `sync.js`
      (e.g. `getSyncStatus(ctx).wedged`, or add a tiny exported `isSyncWedged(ctx)` helper
      that reads the same `syncWedged` meta `flushPending` reads) rather than inventing a
      new state. Return a shaped result like `{ applied: 0, failed: 0, wedged: true }`.
- [ ] Ensure the pause is checked inside the existing single-drain guard so a wedged
      account performs ZERO `GET /api/inbox` fetches per poll (the key win — no 160MB).
- [ ] The pause must self-resolve: once sync recovers (`resetLocalSync` clears `syncWedged`,
      or the streak resets), the next tick drains normally. No new persisted flag — derive
      purely from the existing `syncWedged` meta so recovery is automatic.

### Task 2: Abort-early on flush-false + back off the poll interval
- [ ] In `drainInbox`, when `flush()` returns false for the FIRST event of a drain, STOP
      the drain (do not continue applying/acking the rest — replace the current per-event
      `continue` with a `break` on first-event flush-false) and return a result flagging
      no-progress (e.g. `{ applied, failed, stalled: true }`). Keep the current
      leave-queued behaviour (never ack) intact. A later event failing after earlier
      successes keeps the existing continue behaviour — only the leading flush-false aborts.
- [ ] In `startInboxPolling`, back off the visible-tab poll when a tick reports
      `wedged`/`stalled` (no progress): track consecutive no-progress ticks and skip an
      increasing number of intervals (simple exponential-ish gate on the existing timer —
      do NOT spin up a second timer). Reset the backoff to the normal interval the moment a
      tick makes progress (`applied > 0`) or the mailbox is empty.
- [ ] Keep `drain-on-becoming-visible` responsive: a manual visibility trigger may bypass
      the backoff gate once (user opened the tab expecting fresh data), but still honours
      the wedge pause from Task 1.
- [ ] Integration test (`web/cloud/js/tests/inbox.test.js`): (a) drain PAUSES with zero
      `GET /api/inbox` calls when wedged; (b) drain ABORTS after the first flush-false
      (only the first event applied, none acked) and signals stalled; (c) polling backs off
      after consecutive stalls and resumes on progress; (d) a HEALTHY small-event drain
      (flush true) still applies + acks every event. Must pass before Task 3.

### Task 3: Byte-cap `GET /api/inbox` so one response is never 160MB
- [ ] In `internal/cloudserver/inbox.go` `ListInbox`, add a response BYTE budget alongside
      the existing `maxInboxDrainBatch=200` count cap: accumulate each event's `CT` byte
      length and stop adding events once the budget is reached, ALWAYS including at least
      one event so the drain can still make progress (mirror sync's
      `FLUSH_MAX_BODY_BYTES`/≤1 MiB "always send at least one" shape). Pick a budget in the
      ≤1 MiB range consistent with the sync path; name it a `const` next to
      `maxInboxDrainBatch` with a comment. Preserve `ORDER BY id` ordering — trim from the
      tail only, never reorder.
- [ ] The client already acks each event individually and re-drains, so paging through
      byte-bounded chunks needs no client change beyond Tasks 1/2. Confirm `listInboxEvents`
      handles a partial page correctly (it already does — it opens whatever `events` the
      response carries).
- [ ] Integration test (`internal/cloudserver/inbox_test.go`, `TZ=UTC`): seed several
      large events exceeding the byte budget; assert `GET /api/inbox` returns a byte-bounded
      prefix (fewer than all, ≥1, in id order), and that acking the returned ids then
      re-fetching returns the next chunk. Must pass before Task 4.

### Task 4: Let reset / un-wedge clear the poison inbox backlog
- [ ] Add a store method `ClearInboxEvents(ctx, accountID) (int64, error)` in
      `internal/cloudstore/inbox.go` (`DELETE FROM inbox_events WHERE account_id = ?`,
      return rows affected), mirroring `DeleteInboxEvent`.
- [ ] Add `DELETE /api/inbox` to `InboxAPI` (`internal/cloudserver/inbox.go`,
      `RegisterRoutes` + a `ClearInbox` handler) — session-scoped to the caller's account,
      `log/slog` the count cleared, return the count as JSON. Follow the `AckInboxEvent` /
      `POST /api/telegram/reset` shape. Extend the `inboxStore` interface with the new
      store method.
- [ ] Client: in `web/cloud/js/inbox.js` add an exported `clearInbox({ fetchImpl })` that
      calls `DELETE /api/inbox`. Wire it into the existing recovery affordance: the
      `resetLocalSync()` wrapper in `web/cloud/js/cloud-boot.js` (which un-wedges sync)
      should ALSO clear the server inbox backlog, so the one "Reset local sync" action the
      user already has un-wedges sync AND drops the poison sealed events. Order it so a
      failure to clear the inbox does not abort the local reset (best-effort, logged) — the
      account must still recover locally even if the network clear fails.
- [ ] Document (in the code comment + docs, Task 6) that clearing the inbox DISCARDS any
      un-applied sealed events (same "discards un-synced local writes" semantics
      `resetLocalSync` already carries) — this is the escape hatch, acceptable for recovery.
- [ ] Integration test (`internal/cloudserver/inbox_test.go`): seed events, `DELETE
      /api/inbox`, assert the account's inbox is empty and the count is returned; assert an
      event belonging to ANOTHER account is untouched (account scoping).

### Task 5: Confirm + document the backlog source; file the redesign follow-up
- [ ] Confirm (from the code path, `web/cloud/js/inbox-apply.js` `vitals_import` +
      `internal/cloudserver/telegram.go` `sealNXKDocument`) that the huge backlog is stale
      sealed Telegram `.nxk` vitals events, and that a single large Mi Band `.nxk` produces
      a record whose CT can exceed `maxOpCTLen` (64 KiB) — the ops-400 trigger. Record the
      finding in the plan (this file) and in `docs/cloud-mode.md` (drain-protocol section):
      the wedge-pause + byte-cap + inbox-clear recovery, and the ops-400 cause.
- [ ] Note in docs that sealing a large Mi Band `.nxk` vitals import into the per-message
      sealed mailbox as one giant event is questionable (it is what makes a single event
      huge and its ops un-flushable); a deeper redesign (chunk the vitals import into
      sub-`maxOpCTLen` records, or a distinct bulk path that doesn't go through the
      per-message inbox) is a FOLLOW-UP, not this bead. File a bd follow-up issue for it
      (record the id in this plan). Do NOT scope-creep the redesign into this fix.

### Task 6: Verify acceptance criteria
- [ ] Verify all Overview requirements are implemented: wedged account performs zero
      `GET /api/inbox` fetches; drain aborts + backs off on flush-false; `/api/inbox`
      byte-bounded; reset clears the poison backlog; healthy small-event drain still works.
- [ ] Run `npx vitest run` — must pass (esp. `inbox.test.js`, `sync.test.js`, and the
      cloud architecture guards for no-hardcoded-colors / globals if any UI changed).
- [ ] Run `go build ./... && go build -tags mobile ./...` — must pass.
- [ ] Run `TZ=UTC go test ./internal/cloudserver/...` — must pass (byte-cap + clear-all).
- [ ] Run any repo linter — fix all issues.

## Technical Details
- **Wedge signal reuse**: `syncWedged` is a `sync_meta` field read by `flushPending`
  (`if ((await readMeta()).syncWedged) return false`) and surfaced by `getSyncStatus` as
  `.wedged`. Task 1 reads the SAME field — no new state, so `resetLocalSync` (which already
  clears `syncWedged`) automatically un-pauses the drain.
- **Byte-cap shape**: copy the `flushPending` idiom — accumulate `bodyBytes`, `break`
  before exceeding the budget, but "always include at least one" so a single over-budget
  event still makes progress (that single-huge-event case is the Task 5 follow-up, not
  solved by the cap).
- **Backoff**: derive from consecutive no-progress ticks; gate the existing
  `setInterval` tick (skip N ticks) rather than reschedule — keeps teardown/stop() simple.
- **Clear route**: `DELETE /api/inbox`, session-scoped, returns `{cleared: <count>}`.
  Best-effort from the client reset path — local recovery must not depend on it.

## Post-Completion
*No checkboxes — informational.*

**Manual verification**:
- On a real wedged/backlogged account: open the app, confirm DevTools shows NO repeated
  160MB `GET /api/inbox` (drain paused); run "Reset local sync" and confirm the backlog is
  cleared and the account is usable; confirm a fresh Telegram `/bp` still lands within
  seconds on a healthy account.

**External / follow-up**:
- bd follow-up issue (id recorded in Task 5): redesign the bulk Mi Band `.nxk` vitals
  import so it does not seal a single >64 KiB event into the per-message mailbox.
