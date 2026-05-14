Server-side TZ change suggestion tracking — share the decision across interfaces

## Overview

Today each browser independently detects timezone mismatch on bootstrap (`Intl.DateTimeFormat().resolvedOptions().timeZone` vs the cached `settings_bundle.timezone`) and tracks dismissal in `localStorage`. Two browsers therefore prompt independently. The fix: persist the dismissal decision in the user settings on the server, so once any client records "user dismissed change to X" the other clients skip the prompt. The accept path already converges naturally (settings TZ updates → other clients see no mismatch → don't prompt). Additionally, when a web client accepts the TZ change, send a Telegram confirmation through the existing notifier so the user has a record in chat that the change took effect.

## First: confirm the user's impression

- "Every interface detects TZ change independently" — PARTIALLY TRUE. Web browsers do auto-detect on bootstrap and ask. The Telegram bot does NOT auto-detect — it only asks when the user runs `/tz` and shares location (`internal/bot/tz_commands.go:18-120`). So the "TG asks duplicate" framing is off; the duplicate-prompt pain is between browsers.
- "Mobile web asks, then desktop web asks again" — CONFIRMED. `localStorage` is per-browser, so the `tz_prompt_dismissed` flag in mobile does not suppress desktop (`web/static/js/features/bootstrap.js:36-52`).
- "What happens if I agree both times" — Already SAFE today. The domain service `tzupdate.UpdateTimezone` holds a global mutex (`internal/domain/tzupdate/service.go:84`), the second call captures `oldTZ = newTZ` and short-circuits, and the planner's 24h hash dedup plus the UNIQUE index `idx_tz_plan_hash` reject duplicate plans even if races happen. Settings TZ converges atomically; no double plan is created. The annoyance is the second prompt, not data corruption.

## Context

- Files involved:
  - `web/static/js/features/bootstrap.js` (`maybeUpdateTimezone` — detect + prompt + dismiss)
  - `web/static/js/tests/bootstrap.tz-prompt-nonblocking.test.js` (existing dismissal tests)
  - `internal/domain/tzupdate/service.go` (TZ commit path; the `SettingsStore` interface)
  - `internal/store/settings/repo.go` (settings persistence; will gain a `dismissed_tz_suggestion` column)
  - `internal/store/migrations/063_add_dismissed_tz_suggestion.sql` (new)
  - `internal/server/settings_handlers.go` (settings bundle response + new dismiss endpoint + Telegram confirmation on accept)
  - `internal/server/server.go` (existing `notify` helper, `notifiers []notifier.Notifier`)
  - `internal/server/mcp_coverage_exempt.go` (mark new endpoint as UI/settings exempt)
  - `internal/domain/tzsuggestion/service.go` (new — decision helpers `ShouldPrompt`, `RecordDismissal`)
  - `cmd/bot/main.go` and `cmd/mcptool/main.go` (wire the new service)
- Related patterns:
  - Domain service pattern is mandatory — bot and HTTP handlers must call `internal/domain/*`, not the store directly (CLAUDE.md rule 1).
  - Migrations are append-only (rule 2); add `063_*.sql`.
  - Settings bundle is the channel for any frontend-visible setting; extending it is the simplest "share decision across browsers" wire.
  - `internal/notifier.Notifier` already abstracts Telegram + WebPush; the server's `notify` helper fans out across configured channels.
- Dependencies: none new.

## Development Approach

- Complete each task fully before moving to the next.
- Testing policy: integration tests ONLY. Add an integration test only when a task introduces new externally-observable behavior (the new endpoint, the cross-client suppression, and the Telegram confirmation on web-acceptance).
- Keep the bot's `/tz` flow untouched — it does not auto-prompt today; this change is web-bootstrap focused but the domain service stays transport-neutral so a future bot auto-detect can plug in.
- On web-accepted TZ change, fire a best-effort Telegram confirmation via the existing notifier; never send anything on decline.

## Implementation Steps

### Task 1: Persist the dismissal in user settings

Files:
- Create: `internal/store/migrations/063_add_dismissed_tz_suggestion.sql`
- Modify: `internal/store/settings/repo.go`

- [x] Add migration `063_add_dismissed_tz_suggestion.sql` adding `dismissed_tz_suggestion TEXT NOT NULL DEFAULT ''` to `user_settings` (or whichever table holds the per-user timezone today).
- [x] Extend the settings repo with `GetDismissedTZSuggestion() (string, error)` and `SetDismissedTZSuggestion(tz string) error`.
- [x] Ensure the existing `RecordTimezone(tz)` clears `dismissed_tz_suggestion` (in the same write/transaction) so that the next genuine TZ change is prompted normally.

### Task 2: Add a tzsuggestion domain service

Files:
- Create: `internal/domain/tzsuggestion/service.go`

- [x] Define `Service` with two methods:
  - `ShouldPrompt(ctx, detectedTZ string) (bool, reason string, err error)` — returns `false` if detected matches current TZ, if detected matches `dismissed_tz_suggestion`, or if there is an active (`PENDING_APPROVAL`/`NOTIFIED`/`APPROVED`) plan whose `new_tz == detectedTZ`. Otherwise `true`.
  - `RecordDismissal(ctx, detectedTZ string) error` — writes `dismissed_tz_suggestion = detectedTZ`. Validate `detectedTZ` with `time.LoadLocation`.
- [x] Constructor takes the settings repo and the existing `PlanBaselineStore`-style accessor; keep deps minimal so cmd/bot, cmd/mcptool, and cmd/seeddemo wiring stays simple.

### Task 3: Expose the dismissal decision via HTTP

Files:
- Modify: `internal/server/settings_handlers.go`
- Modify: `internal/server/mcp_coverage_exempt.go`

- [x] Include `dismissed_tz_suggestion` in the `settings_bundle` GET response so bootstrap can self-evaluate without an extra round-trip.
- [x] Add `POST /api/tz-suggestion/dismiss` body `{ "detected_tz": "..." }` that delegates to `tzsuggestion.Service.RecordDismissal`. 400 on invalid TZ. Do NOT trigger any notification on this path.
- [x] Register the new route in `mcpCoverageExempt` with reason "UI/settings — TZ prompt dismissal".
- [x] Add an integration test that POSTs the dismiss endpoint, fetches the settings bundle, and asserts `dismissed_tz_suggestion` is updated and is cleared when `POST /api/settings` records a new TZ.

### Task 4: Send Telegram confirmation when web accepts a TZ change

Files:
- Modify: `internal/server/settings_handlers.go`

- [x] In the existing `handleUpdateSettings` TZ-change branch, after `s.tzUpdater.UpdateTimezone` returns success AND when the new TZ differs from the old (skip no-op writes), fire a best-effort notification through the existing `s.notify(ctx, notifier.Notification{...})` helper.
- [x] Message body: short confirmation like `"Timezone updated to <NEW_TZ>."` plus, when `planCreated == true`, a one-line "I sent a separate transition plan you can review" hint. No action buttons — this is informational only; the existing tz_plan_notifier still owns plan approval prompts.
- [x] Run the notify call asynchronously (it already is via `s.notify`'s goroutine fanout) and swallow `notifier.ErrNoDeliveryChannel` silently so web-only deployments are unaffected.
- [x] Decline path (`POST /api/tz-suggestion/dismiss` from Task 3) must NOT call `notify`.
- [x] Add an integration test that uses a fake notifier, POSTs `/api/settings` with a new TZ, and asserts exactly one notification was sent with the new TZ in the text; and a second case posting `/api/tz-suggestion/dismiss` that asserts zero notifications were sent.

### Task 5: Rework the web bootstrap to use the server decision

Files:
- Modify: `web/static/js/features/bootstrap.js`
- Modify: `web/static/js/tests/bootstrap.tz-prompt-nonblocking.test.js` (existing tests will need updating to the new flow)

- [x] Replace the `localStorage.getItem('tz_prompt_dismissed')` check with a check against `settings_bundle.dismissed_tz_suggestion`. If `detectedTz === dismissed_tz_suggestion`, skip the prompt.
- [x] On user cancel, POST to `/api/tz-suggestion/dismiss` with `{ detected_tz }` instead of writing to `localStorage`. Best-effort; swallow errors but log.
- [x] On user accept, keep the existing `POST /api/settings` call — server-side `RecordTimezone` will clear the dismissed flag automatically. Remove the `localStorage.removeItem` and `localStorage.setItem` calls.
- [x] Drop the `tz_prompt_dismissed` localStorage key entirely (no migration needed — it is per-browser ephemeral).
- [x] Add a Vitest integration case: bootstrap with `settings_bundle.dismissed_tz_suggestion === detectedTz` does not call `safeConfirm`. A second case: cancel triggers a `POST /api/tz-suggestion/dismiss` with the right body.

### Task 6: Wire the new service in cmd entry points

Files:
- Modify: `cmd/bot/main.go`
- Modify: `cmd/mcptool/main.go` (if it constructs the HTTP server)
- Modify: `cmd/seeddemo/main.go` (only if it wires settings handlers — likely not)

- [x] Construct the `tzsuggestion.Service` alongside the existing `tzupdate.Service` and pass it into the HTTP server constructor.
- [x] No bot changes to `/tz` — that flow remains an explicit user-initiated path.

### Task 7: Verify acceptance criteria

- [x] `go test ./...` — must pass, including new integration tests from Task 3 and Task 4 and the updated Vitest cases from Task 5.
- [x] `pnpm test` — must pass.
- [x] `go vet ./...` and the project's standard lint pass.

### Task 8: Update documentation

- [x] Add a short paragraph to `docs/architecture.md` (or the TZ-related section if one exists) describing the cross-client dismissal flow: "TZ suggestion dismissal is persisted in `user_settings.dismissed_tz_suggestion`; the bootstrap consults the settings bundle before prompting, so dismissing in one browser silences other clients until the detected TZ changes or the user explicitly updates settings. A successful web-initiated TZ change also fires a Telegram confirmation through the existing notifier; decline does not."
- [x] No CLAUDE.md update needed — no new internal pattern; this is a feature addition, not a rule change.
