# Mobile Onboarding: Skip Telegram Login + Surface Firstrun on Fresh Install

## Overview

On the Capacitor APK, launching the app currently lands on the "Login to Med Tracker" screen with a Telegram Login Widget. That screen is meaningless on the mobile build:

- The mobile binary uses `LocalUserResolver` (`//go:build mobile`) — every request resolves to a fixed local user; HTTP-level auth is intentionally absent.
- There is no Telegram bot, no `BOT_USERNAME` configured, no OIDC.
- The Phase 2c firstrun overlay (welcome → permissions → integrations → done) is already shipped at `web/static/js/features/firstrun/`, but it mounts from `applyBootstrapPayload` — which the login screen short-circuits ahead of.

The proximate cause: `internal/server/auth.go:213` `handleAuthStatus` only branches `authenticated:true` for `s.demoMode`. The mobile build has no demo flag and no cookie, so it returns `authenticated:false`, and `web/static/js/app.js:288+` renders the login screen.

There is also a second gap: even after the login screen is bypassed, `internal/server/settings_handlers.go:383-387` graceful-degrades a missing settings row to `firstRunComplete = true`, suppressing the firstrun overlay on a truly fresh install (empty DB, no settings singleton row yet).

This plan fixes both: a fresh-install mobile launch should go straight from app boot → bootstrap fetch → firstrun overlay (welcome screen), with **zero** Telegram UI rendered at any point.

## Context (from discovery)

### Files/components involved

**Server (Go)**
- `internal/server/auth.go:213` (`handleAuthStatus`) — current: returns `authenticated:false` on mobile (no cookie, no demo). Needs a mobile-build branch.
- `internal/server/settings_handlers.go:383-387` (`handleBootstrap`) — current: missing settings row → `firstRunComplete = true` (wrong default for a fresh mobile install).
- `internal/server/auth.go` build-tag siblings: `resolver_telegram.go` (server build) vs `resolver_local.go` (mobile build). The "is this mobile" signal at the handler layer should follow the same `//go:build mobile` split rather than a runtime probe.
- `internal/store/settings/repo.go` — `GetFirstRunComplete(ctx)` accessor. May need a "missing-row → return (false, nil)" change OR the singleton row should be inserted lazily on first read.

**Frontend (JS)**
- `web/static/js/app.js:99-364` (`checkAuth()` + login-screen rendering at 278-350). The Telegram widget builder at 332-352 is gated on `BOT_USERNAME`; on mobile that env var is empty, so we'd see "Use the Telegram app to open the bot and launch the web app." — still wrong, still mentions Telegram.
- `web/static/js/features/auth-bootstrap.js:289-301` — calls `window.WGFirstRun.mount({ needs_first_run })`. This is the entry point we want to reach on every mobile launch.
- `web/static/js/features/firstrun/index.js:184-216` — `mount(payload)` reads `needs_first_run` from the payload or `window.__MEDTRACKER_BOOTSTRAP__.needs_first_run`. No changes needed here.
- `web/static/js/core/native-bootstrap.js:21-30` — sets `window.__MEDTRACKER_BOOTSTRAP__.apiBase` when `window.MedtrackerNative.apiBase()` is callable. This is the "I'm in the embedded shell" signal the frontend uses to skip the auth probe.

**Tests**
- `internal/server/auth_test.go` — existing `TestHandleAuthStatus_DemoModeReportsAuthenticated` / `TestHandleAuthStatus_DemoModeOffNoCookieReportsUnauthenticated`. Add a mobile-build variant.
- `internal/server/settings_handlers_test.go` — existing `TestBootstrap_NeedsFirstRunFlag`. Add a "no settings row → needs_first_run=true" case.
- `web/static/js/tests/app.auth-check.test.js:103-128` — existing test for login-screen render. Add a case asserting the login screen does NOT render when `window.__MEDTRACKER_BOOTSTRAP__.apiBase` is set.

**Docs**
- `docs/local-mode.md` — capture the new mobile-build auth contract (no cookie, no login screen) and the firstrun behaviour on fresh install.
- `docs/architecture.md` § Auth — same.
- `CLAUDE.md` — extend rule #11 ("mobile WebView must not load Telegram remotely") so it also covers the login-UI surface.

### Related patterns

- **Build-tag split for auth surface** is already established: `resolver_telegram.go` (no tag, server) + `resolver_local.go` (`//go:build mobile`). The right place for the `/auth/status` mobile branch is the **same pattern**, not a runtime `s.localMode` flag.
- **Embedded-shell detection on the frontend** is already established in `web/static/js/core/messenger-adapter.js:298` (added in PR #354): `window.MedtrackerNative || window.__MEDTRACKER_BOOTSTRAP__`. We mirror that check in `app.js`'s `checkAuth()` instead of inventing a new signal.
- **`applyBootstrapPayload` is the firstrun-mount path**. The plan is "make sure the mobile build always reaches `applyBootstrapPayload`", not "rewrite firstrun mounting."

### Constraints

- **No new env vars.** The mobile vs server split must come from `//go:build mobile`, not a runtime flag.
- **Server build must be unchanged.** `/auth/status` behaviour on the server build is correct (cookie / OIDC / demo). The mobile branch is purely additive.
- **YAGNI on a "mobile login provider" abstraction.** The right answer is "no auth screen on mobile, ever" — don't design for a hypothetical future where mobile might gain accounts.

## Development Approach

- **Testing approach**: Regular (code first, then tests). The fix is small (one Go branch, one frontend guard, one settings-row default), and each piece is exercised by a clearly-shaped unit test once it's written. Empirical verification on the emulator is the final gate.
- Complete each task fully before moving to the next.
- **CRITICAL: every task MUST include new/updated tests** — Go unit tests for server changes, Vitest cases for frontend changes, an architecture test for "no Telegram strings in the rendered login-skip path."
- **CRITICAL: all tests must pass before starting next task.**
- **CRITICAL: update this plan file when scope changes during implementation.**
- Run `pnpm test`, `go test ./...`, `go test -tags mobile ./...` at the verification step.

## Testing Strategy

- **Go unit tests** (server build): mobile-tagged variant of `handleAuthStatus` returns `authenticated:true, method:"local"` with no cookie. Mobile-tagged variant of `handleBootstrap` returns `needs_first_run:true` against a fresh DB with no settings row.
- **Go unit tests** (mobile tag): `go test -tags mobile ./internal/server` covers the mobile-only branches.
- **Frontend unit tests** (Vitest + jsdom): `checkAuth()` short-circuits the `/auth/status` probe AND the login-screen render when `window.__MEDTRACKER_BOOTSTRAP__.apiBase` is set. A new architecture test (`architecture.no-telegram-login-on-mobile.test.js`) asserts no path from the embedded-shell branch reaches the `loginContainer` / `tgScript` builders.
- **Manual emulator smoke test** (Post-Completion): fresh APK install → relaunch → first paint shows the firstrun welcome screen (not "Login to Med Tracker"); skipping all firstrun screens lands on Today; `adb logcat | grep -i telegram` shows nothing.

## Progress Tracking
- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): server code, frontend code, tests, docs — all runnable locally.
- **Post-Completion** (no checkboxes): emulator smoke test against the CI-built APK after the PR merges.

## Implementation Steps

### Task 1: Split `handleAuthStatus` along the `mobile` build tag

The cleanest fix is to mirror the pattern already used by `resolver_local.go` / `resolver_telegram.go`: move the mobile-specific behaviour into a build-tagged sibling. The shared file keeps the cookie/demo path; a new `auth_local.go` overrides on `//go:build mobile`.

- [x] move the cookie/demo body of `handleAuthStatus` out of `internal/server/auth.go` and into a small helper, OR (simpler) leave the body alone and split via a build-tagged hook function (`tryMobileAuthOverride(w http.ResponseWriter) bool`) called at the top of `handleAuthStatus`. The non-mobile hook returns `false`; the mobile hook writes `{authenticated:true, method:"local"}` and returns `true`.
- [x] add `internal/server/auth_mobile.go` (`//go:build mobile`) with the mobile hook implementation
- [x] add `internal/server/auth_server.go` (`//go:build !mobile`) with the no-op hook
- [x] write `internal/server/auth_mobile_test.go` (`//go:build mobile`) — `TestHandleAuthStatus_MobileBuildAlwaysAuthenticated`: a fresh request with no cookie returns `200` + JSON `{authenticated:true, method:"local"}`
- [x] write `internal/server/auth_server_test.go` (`//go:build !mobile`) sanity: moved existing `TestHandleAuthStatus_DemoMode*` cases and `TestAuthStatus` (from `server_handlers_test.go`) into this `!mobile`-gated file, since the mobile hook unconditionally overrides the cookie/demo path
- [x] run `go test ./...` AND `go test -tags mobile ./...` — both must pass before next task

### Task 2: Make `handleBootstrap` treat a missing settings row as "needs first run" on the mobile build

Today, `internal/server/settings_handlers.go:383-387` swallows `GetFirstRunComplete` errors and defaults to `firstRunComplete = true`. On a fresh mobile install with no settings row, that means the firstrun overlay never fires. The right default is `false` (= "needs first run") — at least on the mobile build, where there's no pre-existing user to migrate.

Two acceptable options, picking the lower-surface one:

- **Option A** (chosen): teach the settings repo's `GetFirstRunComplete(ctx)` to lazily insert the singleton row if missing and return `(false, nil)`. The lazy-insert path is gated on no row existing — idempotent under concurrent first-time reads via `INSERT OR IGNORE`.
- **Option B** (rejected — touches the migrations file): add a migration that inserts the singleton settings row on schema apply. More invasive; would also affect server-build deployments and may conflict with existing `INSERT OR IGNORE` semantics in `migrations/071_*.sql`.

Steps:
- [x] modify `internal/store/settings/repo.go` `GetFirstRunComplete(ctx)`: when the SELECT returns `sql.ErrNoRows`, issue an `INSERT OR IGNORE INTO settings(id, first_run_complete) VALUES (1, 0)` and return `(false, nil)`
- [x] write `internal/store/settings/repo_test.go` case `TestGetFirstRunComplete_LazyInsertsRowOnFreshDB` — fresh DB → first call returns `(false, nil)` AND a settings row now exists with `first_run_complete = 0` (added to existing `settings_test.go`)
- [x] write the symmetric case `TestGetFirstRunComplete_HonoursExistingRow` — pre-existing row with `first_run_complete = 1` → returns `(true, nil)` AND does NOT overwrite
- [x] verify the existing `TestBootstrap_NeedsFirstRunFlag` in `internal/server/settings_handlers_test.go` still passes; added `TestBootstrap_NeedsFirstRunTrue_OnFreshDB` covering the migration-default path (needs_first_run=true on a brand-new DB with no explicit `SetFirstRunComplete` seed)
- [x] run `go test ./...` AND `go test -tags mobile ./...` — both passing

### Task 3: Frontend — short-circuit the login screen when running in the embedded shell

Defense in depth. Even with the server-side fix from Tasks 1-2, the frontend should never render the Telegram-shaped login UI on the embedded shell. Mirror the `messenger-adapter.js:298` pattern.

- [x] in `web/static/js/app.js` `checkAuth()`, immediately after the `MessengerAdapterReady` await, insert a branch: `if (window.__MEDTRACKER_BOOTSTRAP__?.apiBase) { ... }`. In that branch: skip the `/auth/status` probe, skip cached-cookie logic, fetch `/api/bootstrap` directly, call `applyBootstrapPayload(data)`, save auth state as `'local'`, return `true`.
- [x] verify the embedded-shell branch routes correctly through `applyBootstrapPayload` → `WGFirstRun.mount(...)` on a fresh install (the firstrun overlay should appear) — covered by case 1 of the new test (mocked `WGFirstRun.mount` is asserted to be called with `{ needs_first_run: true }`)
- [x] write `web/static/js/tests/app.embedded-shell-bypass.test.js` (new) — three cases:
  - case 1: `window.__MEDTRACKER_BOOTSTRAP__.apiBase` set + bootstrap returns `needs_first_run: true` → `WGFirstRun.mount` called with `{ needs_first_run: true }`, NO login container rendered
  - case 2: `window.__MEDTRACKER_BOOTSTRAP__.apiBase` set + bootstrap returns `needs_first_run: false` → app boots, NO login container rendered, Today is the landing
  - case 3: `window.__MEDTRACKER_BOOTSTRAP__` undefined → existing web/PWA path is unchanged (cached-auth + /auth/status + login fallback)
- [x] run `pnpm test` — must pass before next task (2578 passed)

### Task 4: Architecture guard — no Telegram strings reachable from the embedded-shell branch

A small string-grep test that documents the invariant. Mirrors the existing `architecture.no-telegram-in-html.test.js` style.

- [x] write `web/static/js/tests/architecture.mobile-no-telegram-login.test.js`:
  - read `web/static/js/app.js` source
  - confirm the embedded-shell branch added in Task 3 returns BEFORE any line containing `Login to Med Tracker`, `telegram-widget.js`, `login-tg-container`, or `BOT_USERNAME`
  - structural assertion (regex find of the branch + line-number comparison), not behavioural — keeps the rule durable across refactors
- [x] run `pnpm test` — must pass before next task (2579 passed)

### Task 5: Verify the existing firstrun integration tests still cover the mobile mount path

The Phase 2c tests at `web/static/js/tests/firstrun.*.test.js` exercise the orchestrator with an injected `window.__MEDTRACKER_BOOTSTRAP__`. After Tasks 1-3, the mobile launch path now reaches `WGFirstRun.mount(...)` with `needs_first_run: true` — which is what the existing tests already assume.

- [ ] read the existing `firstrun.resume.test.js`, `firstrun.permissions.test.js`, `firstrun.integrations.test.js` and confirm they still pass without changes
- [ ] if any test relied on `apiBase` being unset to short-circuit a check (unlikely), update it to use the new shape
- [ ] add a single new test `firstrun.mobile-end-to-end.test.js` that wires Task 3's `checkAuth()` embedded-shell branch into the firstrun orchestrator with a mocked `/api/bootstrap` returning `needs_first_run: true`, and asserts the welcome screen renders
- [ ] run `pnpm test` — must pass before next task

### Task 6: Update documentation

- [ ] update `docs/local-mode.md` § "Auth boundary": explicitly state that the mobile build has no `/auth/status` probe failure — it always reports `authenticated:true` because `LocalUserResolver` already trusts the request
- [ ] update `docs/local-mode.md` § "First-run flow": document that a fresh install lands on the firstrun welcome screen, and that the settings row is lazy-inserted on first `GetFirstRunComplete`
- [ ] update `docs/architecture.md` § "Authentication": add a one-paragraph note about the build-tagged split + the embedded-shell frontend short-circuit
- [ ] update `CLAUDE.md` rule #11 to extend the Telegram-free guarantee to the auth UI surface, not just the script tag in `index.html`
- [ ] run all test suites one more time as a sanity check

### Task 7: Verify acceptance criteria
- [ ] verify `go test ./...` — passing
- [ ] verify `go test -tags mobile ./...` — passing
- [ ] verify `pnpm test` — passing
- [ ] verify the new architecture test (`architecture.mobile-no-telegram-login.test.js`) is in the passing set
- [ ] verify the new bootstrap → firstrun integration test (`firstrun.mobile-end-to-end.test.js`) is in the passing set
- [ ] verify no existing tests regressed
- [ ] verify all checkboxes in this plan are marked

### Task 8: [Final] Confirm on a freshly-built CI APK

The plan's success criterion is "fresh APK install → no Telegram UI → firstrun welcome screen visible." This task is the integration gate. Skipped if the agent doesn't have an emulator; the user runs it against the post-merge CI APK using `docs/android-emulator.md`.

- [ ] (agent-skippable, user-runnable) install the CI APK on a clean emulator after merge, observe the firstrun welcome screen on launch, confirm `adb logcat | grep -i telegram` is empty, walk through the firstrun flow, land on Today

## Technical Details

### Why a build-tagged hook instead of a runtime flag

The codebase already encodes "this is the mobile build" exclusively through the `//go:build mobile` tag (per `cmd/bot/main_{server,mobile}.go`, `internal/server/auth/resolver_{telegram,local}.go`, `internal/scheduler/sink_{webpush,localnotifications}.go`). Introducing an `s.localMode` runtime flag would split the convention across two mechanisms — one more place a future developer can forget. The hook pattern (one no-op + one mobile impl) keeps the convention uniform.

### Why lazy-insert the settings row instead of a migration

Migration `071_add_first_run_state.sql` already exists and is shipped. Adding a new migration that touches the same table for the same column would be churn for a problem that's surface-only on fresh mobile installs. The `INSERT OR IGNORE` from inside the repo accessor is idempotent, costs one extra round-trip on the first read of a fresh DB, and is invisible thereafter.

### Why frontend defense in depth

If the server-side fix from Task 1 ever regresses (e.g., the build tag is dropped, a refactor inverts the polarity), the user would see the Telegram login screen on mobile again. The frontend short-circuit at `checkAuth()` ensures that even with a broken server, the embedded-shell experience is correct. The architecture test in Task 4 documents this as an invariant.

### Why this isn't a bigger redesign

The user's instruction was "we don't need Telegram in mobile APK at all." The Phase 2c firstrun overlay already exists, already mounts from bootstrap, and already covers the welcome → permissions → integrations → done flow. The only missing piece is the auth gate ahead of it. This is a 3-file change, not a rewrite.

## Post-Completion

*Manual verification:*
- After merge: trigger the `android-apk.yml` workflow, download the artifact, install on a clean emulator (`adb shell pm clear com.korjavin.medtracker` first if reusing), launch.
- Confirm the welcome screen appears (firstrun overlay), no "Login to Med Tracker" string visible, `adb logcat | grep -iE "telegram|login"` empty.
- Walk through the firstrun flow (welcome → permissions → integrations → done), confirm the Today screen renders at the end.
- Confirm a relaunch lands on Today directly (firstrun is one-shot — gated by `first_run_complete = 1`).

*External system updates:*
- None — purely local changes. Server-build deployments are unaffected by Task 1 (the `!mobile` hook is a no-op) and unaffected by Task 2 (existing server installs already have a settings row from the post-Telegram-login provisioning path).

*Future work (out of scope):*
- A small "Welcome" splash before the firstrun overlay specifically for mobile (currently shares the welcome screen with web first-run). Tracked informally if QA finds the shared welcome feels off in the mobile context.
- Removing the `BOT_USERNAME` and OIDC paths from `app.js`'s login screen on the server build (cleanup; not required for this plan).
