# Suppress "New data" banner for own writes via client-id source tagging

## Overview

When the user logs food (or any health metric) from the web app, the "New data is available." banner sometimes appears even though the user themselves originated the write. The current suppression mechanism is purely timing-based (a 5s `lastOwnWriteAt` window on the frontend), with no source attribution on the backend. When SSE delivery is delayed beyond that window — or when secondary cache invalidations race ahead of the marker — the banner surfaces for the user's own action and irritates them.

This plan plumbs a per-client identifier end-to-end so the frontend can deterministically recognise echoes of its own writes:

- Frontend mints a stable `clientId` (UUID, persisted to localStorage) per browser/session.
- Every non-GET API call carries `X-Client-ID: <uuid>`.
- After a successful write, the backend's `notifyOnWriteMiddleware` extracts the header and passes it through `changesBroker.Notify(cursor, clientID)`.
- SSE subscribers receive the latest source `clientID` alongside the cursor and emit it in the SSE JSON payload (`source_client_id`).
- The frontend's `applyChangesPayload` compares `source_client_id` against its own `clientId` — if equal, the change is classified as `self-echo` and the banner is skipped (timing window stays as fallback for the polling path and pre-clientId connections).

## Context (from discovery)

**Files involved (banner / change-event flow):**
- `web/static/js/app.js:1632-1733` — banner DOM, `requestTabRefresh()` (source dispatch: `optimistic*` reloads, `self-echo` reloads-or-drops, anything else gates on `isSafeToAutoRefresh()` and shows banner at line 1722).
- `web/static/js/data-store.js:56-65` — `lastOwnWriteAt` + `SELF_ECHO_WINDOW_MS=5000`.
- `web/static/js/data-store.js:582-584` — `recordOwnWrite()`.
- `web/static/js/data-store.js:586-613` — `applyChangesPayload()` (where source is classified `self-echo` vs `changes`).
- `web/static/js/data-store.js:615-628` — `requestTabRefresh()` dispatcher.
- `web/static/js/data-store.js:752-758` — `buildChangesStreamURL()` (already attaches `initData` query param).
- `web/static/js/data-store.js:721-731` — `advanceCursorSilently()` (fires `GET /api/changes` after every write, fire-and-forget).
- `web/static/js/core/api.js:117-129` — `apiCallDirect` calls `recordOwnWrite()` + `advanceCursorSilently()` after non-GET responses.
- `web/static/js/sync.js:865-910` — `offlineAwareApiCall` (delegates writes to `apiCallDirect`).
- `web/static/js/features/food/log.js:378-493` — `saveFoodLog()` (calls `applyOptimistic` twice with `['food']` tag, then `apiCall` POST/PUT, then `commit(null)` + `invalidateTags(['food'])` + `loadFoodLogs()`/`loadToday()`).
- `internal/server/changes_handlers.go:115-240` — SSE handler; payload is currently `{cursor, changed_tags}`.
- `internal/server/changes_broker.go:25-89` — `ChangeBroker.Subscribe/Notify` (channel of `int64` cursor).
- `internal/server/changes_broker.go:150-174` — `notifyOnWriteMiddleware` (post-write hook that calls `Notify`).
- `internal/store/migrations/027_add_change_events.sql` — `change_events(id, tag, created_at)` table + per-table INSERT triggers; **no client_id column anywhere today**.

**Related patterns:**
- `initData` is already passed as a query param on the SSE connect URL (`buildChangesStreamURL`) — we'll reuse that pattern for `client_id`.
- Frontend persists state in localStorage (e.g., `wg.*` keys, change cursor) — we'll add `wg.clientId` there.
- `apiCallDirect` already adds headers (Telegram `initData`, etc.) — we'll add `X-Client-ID` alongside.
- The SSE broker today only fans out a single `int64` cursor. The signature changes to a tuple — broker subscribers carry the latest source `clientID` for the most recent notification.

**Dependencies:**
- `crypto/uuid` browser API for client ID generation (well supported on modern browsers + the in-app WebView).
- No new server packages required.

## Development Approach

- **Testing approach: Regular (code first, then tests)** — per user choice. Implement the plumbing top-to-bottom (frontend → backend → SSE payload → frontend filter), then add unit + integration tests covering: header propagation, broker fan-out signature, SSE payload shape, self-echo classification by `source_client_id`, fallback to timing window when `source_client_id` is missing.
- Complete each task fully before moving on; tests live in the same task as the code they cover.
- **Every task ends with running `go test ./...` and `pnpm test` for any affected packages.**
- Maintain backward compatibility: the SSE payload's `source_client_id` is **optional**. Older frontend builds that don't send `X-Client-ID` (or `clientId` SSE param) should still work — they just keep the existing 5s timing-window fallback.
- Keep the existing `lastOwnWriteAt` mechanism as the fallback for the polling path (`GET /api/changes?since=N`) and the initial SSE connect flush — neither carries per-event source.

## Testing Strategy

- **Unit tests**:
  - Go: `internal/server/changes_broker_test.go` — new `Notify(cursor, sourceClientID)` signature; subscriber channel type carries both fields; concurrent fan-out preserves source attribution.
  - Go: `internal/server/changes_handlers_test.go` — SSE payload includes `source_client_id` when broker notification carries one; omits the field (or empty string) otherwise.
  - Go: middleware test — `X-Client-ID` header on a write request flows through `notifyOnWriteMiddleware` into `Notify`.
  - JS: `web/static/js/tests/data-store.unit.test.js` — `applyChangesPayload` with matching `source_client_id` → `source='self-echo'`; mismatched → `source='changes'`; missing → falls back to timing window.
  - JS: new test (e.g., `core.api.client-id.test.js`) — `apiCallDirect` adds `X-Client-ID` header on non-GET; clientId is stable across calls within the same session.
  - JS: `data-store.unit.test.js` — `buildChangesStreamURL` includes `clientId` query param.
- **E2E tests**: project does not run Playwright/Cypress today (manual prod verification noted in Post-Completion).
- All tests must pass before next task. Lint via `go vet` and the Vitest run-default config (no separate lint config beyond what's already enforced).

## Progress Tracking

- Mark each checkbox `[x]` immediately on completion.
- Add ➕ for newly discovered tasks.
- Add ⚠️ for blockers.
- If scope shifts (e.g., we discover the broker needs more than a tuple), update this plan in-place before moving on.

## What Goes Where

- **Implementation Steps** below — code, tests, docs that can be completed in this repo.
- **Post-Completion** at the bottom — manual prod verification, multi-tab/cross-device sanity checks, deployment release notes.

## Implementation Steps

### Task 1: Mint and persist a stable client ID on the frontend
- [x] Add `getClientId()` to `web/static/js/data-store.js` (or a small new module loaded ahead of `data-store.js`): on first call, mint a UUID via `crypto.randomUUID()` (fallback to a hand-rolled v4 generator for older WebViews), persist to `localStorage['wg.clientId']`, return the cached value on subsequent calls. Expose as `window.DataStore.getClientId()`.
- [x] Ensure the ID survives `localStorage` clears gracefully (regenerate, log a debug line).
- [x] Write unit tests in `web/static/js/tests/data-store.client-id.test.js`: returns a valid UUID, is stable across calls, persists to localStorage, regenerates when localStorage is cleared.
- [x] Run `pnpm test` — must pass before next task.

### Task 2: Send `X-Client-ID` on non-GET API requests
- [x] In `web/static/js/core/api.js`, add `X-Client-ID: window.DataStore.getClientId()` to the `headers` object built for non-GET requests (placed beside the existing `initData` / auth header logic). Skip if `getClientId()` is unavailable (defensive).
- [x] Confirm `apiCallDirect` is the only code path that constructs write requests (verified: `offlineAwareApiCall` delegates to it).
- [x] Write unit tests in `web/static/js/tests/core.api.client-id.test.js`: POST/PUT/DELETE include `X-Client-ID`; GET does not include it; header value matches `getClientId()`.
- [x] Run `pnpm test` — must pass before next task.

### Task 3: Capture `X-Client-ID` in the write-notify middleware
- [x] In `internal/server/changes_broker.go`, change `func (b *ChangeBroker) Notify(cursor int64)` → `Notify(cursor int64, sourceClientID string)`. Update the subscriber channel type from `chan int64` to a small struct `type ChangeEvent struct { Cursor int64; SourceClientID string }` (channel of `chan ChangeEvent`).
- [x] Update `Subscribe` return type accordingly; update `CloseAll` and any other broker helpers.
- [x] In `notifyOnWriteMiddleware`, read `r.Header.Get("X-Client-ID")` (truncate / sanitise to e.g. 64 chars max; reject non-printable). Pass it to `s.changesBroker.Notify(cursor, clientID)`.
- [x] Update every other caller of `Notify` in the codebase (use grep) — most likely a single call site at line ~248 of `changes_broker.go`. Pass `""` when there's no source (e.g., scheduler-driven or internal writes).
- [x] Write tests in `internal/server/changes_broker_test.go`: `Notify(N, "abc")` delivers `{Cursor: N, SourceClientID: "abc"}` to subscribers; `Notify(N, "")` delivers an empty source; concurrent notifications preserve per-message attribution.
- [x] Write tests for the middleware: a POST with `X-Client-ID: foo` triggers `Notify` with `"foo"`; a POST without the header triggers `Notify` with `""`; oversized / non-printable values are sanitised.
- [x] Run `go test ./...` — must pass before next task.

### Task 4: Pass `clientId` from SSE subscribers and include `source_client_id` in the SSE payload
- [x] In `web/static/js/data-store.js` `buildChangesStreamURL`, add `params.set('clientId', this.getClientId())` (alongside the existing `initData` param).
- [x] In `internal/server/changes_handlers.go` `handleChangesStream`, read `clientId := r.URL.Query().Get("clientId")` at the top of the handler (sanitise as in Task 3).
- [x] When emitting the **initial flush** (after the initial `ListChangedTagsSince`), emit `{cursor, changed_tags}` without `source_client_id` (the initial flush has no broker notification driving it).
- [x] In the live broker-driven loop, when a `ChangeEvent{Cursor, SourceClientID}` arrives, query `ListChangedTagsSince` for the changed tags and emit `{cursor, changed_tags, source_client_id: <SourceClientID from event>}`. If `SourceClientID == ""`, omit the field (`omitempty` JSON tag) so older frontends parse cleanly.
- [x] Write tests in `internal/server/changes_handlers_test.go`: a single write with `X-Client-ID=foo` produces an SSE frame whose JSON parses to `{cursor, changed_tags: [...], source_client_id: "foo"}`; a write without the header omits the field; the initial flush omits the field.
- [x] Run `go test ./...` — must pass before next task.

### Task 5: Use `source_client_id` to classify self-echo in `applyChangesPayload`
- [x] In `web/static/js/data-store.js` `applyChangesPayload`, when `res.source_client_id` is a non-empty string, classify the source as `'self-echo'` iff `res.source_client_id === this.getClientId()`, else `'changes'`.
- [x] When `res.source_client_id` is absent or empty (older server, initial flush, polling), fall back to the existing `lastOwnWriteAt`-based check.
- [x] Document the precedence with a short comment block (one paragraph max) just above the new branch — `clientId`-based check first, timing window second.
- [x] Confirm `requestTabRefresh` and `app.js:requestTabRefresh` handle `self-echo` the way they do today — no changes needed there. (Double-check by reading lines 1693-1733.)
- [x] Write tests in `data-store.unit.test.js`: payload with `source_client_id == clientId` → invokes `requestTabRefresh` with `source='self-echo'`; payload with mismatched ID → `source='changes'`; payload with empty/missing field but within `lastOwnWriteAt` window → `source='self-echo'`; payload with empty field outside window → `source='changes'`.
- [x] Update `web/static/js/tests/app.refresh-dispatch.test.js` if it asserts on the old timing-only behaviour (extend, do not replace, the existing case). (No update needed: existing self-echo case asserts on the `source='self-echo'` label, which is source-classifier-agnostic.)
- [x] Run `pnpm test` — must pass before next task.

### Task 6: Wire end-to-end and verify with an integration-style frontend test
- [x] In a feature-level test (extend `web/static/js/tests/food.optimistic-write.test.js` if one exists, else add to the food feature suite per the integration-first rule in CLAUDE.md §8), simulate: user fires `saveFoodLog`; mock server returns a successful POST; mock SSE delivers a `{cursor, changed_tags: ['food'], source_client_id: <ownId>}` payload; assert the banner is **not** shown and `loadFoodLogs` ran exactly once via the optimistic path. (Added to `features.food-log.test.js`.)
- [x] Add a negative-case assertion: SSE delivers `{... source_client_id: 'someone-else'}` → with `!isSafeToAutoRefresh()`, the banner IS shown; with `isSafeToAutoRefresh()`, the page silently reloads.
- [x] Run `pnpm test` — must pass before next task.

### Task 7: Verify acceptance criteria
- [x] Re-read the Overview and confirm: banner is suppressed for own writes regardless of SSE delivery latency; cross-source writes still surface the banner; older clients (no `X-Client-ID`) still work via the timing fallback.
- [x] Run `go test ./...` end-to-end.
- [x] Run `pnpm test` end-to-end.
- [x] Run `go vet ./...`.
- [x] Confirm no new `window.*` global was added without an allowlist entry (CLAUDE.md §4). `DataStore.getClientId` is a method on the existing `window.DataStore` so no new global.
- [x] Confirm no hardcoded colours / inline `.style.` were introduced (CLAUDE.md §3) — this plan should not touch styling, but the architecture test will catch any drift.

### Task 8: Update documentation
- [x] Update `docs/technical-decisions.md`: add a short note under the SSE-first change stream section describing the `clientId` source-attribution mechanism (one paragraph).
- [x] Update `docs/frontend.md`: in the section that discusses optimistic writes / change events, mention `X-Client-ID` and `source_client_id` and the precedence with `lastOwnWriteAt`.
- [x] No README changes needed.

## Technical Details

**Data shapes**

- `X-Client-ID` HTTP header: a UUIDv4 string (36 chars). Sanitised server-side to printable ASCII, max 64 chars.
- `ChangeEvent` struct (Go): `{ Cursor int64; SourceClientID string }`. Channel type `chan ChangeEvent`.
- SSE JSON payload: `{ "cursor": int64, "changed_tags": []string, "source_client_id": string (optional, omitempty) }`.
- `localStorage['wg.clientId']`: string UUID. Read once, cached in module-scoped variable.

**Concurrency**

- `ChangeBroker.Notify` keeps its non-blocking semantics — slow subscribers drop the message (existing behaviour).
- The middleware reads the header before `next.ServeHTTP` returns control? Yes — `notifyOnWriteMiddleware` reads from `r.Header` after the handler runs; `r.Header` is still readable at that point (handler doesn't mutate it).

**Backward compatibility**

- Server with new code + older frontend: writes lack `X-Client-ID`, broker propagates `""`, SSE omits `source_client_id`, frontend falls back to timing window. Banner behaviour identical to today.
- Older server + new frontend: SSE payload omits `source_client_id`, frontend falls back to timing window. Frontend sends `X-Client-ID` header which the server ignores. No harm.

## Post-Completion

*Items requiring manual intervention — no checkboxes, informational only.*

**Manual verification on prod:**
- Open the web app in one tab, log food via the UI with a modal open mid-save. Confirm no banner.
- Open the web app in two **different browsers** (or one browser + one private window — `localStorage` is per-origin per-profile, so tabs sharing a profile share a `clientId` and won't see each other's writes as cross-source). Log food in browser A. Confirm browser B shows the banner.
- Log food via the Telegram bot. Confirm the open web app tab shows the banner (bot writes don't carry `X-Client-ID`, so the broker propagates `""` and the SSE frame omits `source_client_id`).
- Throttle network to 2G via DevTools and repeat the first test — banner must still be suppressed (was the previous timing-window failure mode).

**Release notes / deploy:**
- No migration to run.
- No env var to set.
- Bot/MCP write paths do not need `X-Client-ID` — they intentionally surface as cross-source writes to the open web app.
