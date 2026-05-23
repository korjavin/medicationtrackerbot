# Mobile Phase 2c: First-run setup + secrets storage

## Overview

A fresh install of the mobile app launches into an empty SQLite database: no `users` row exists for the id `LocalUserResolver` hands out, no provider API keys are configured (OpenAI / Food / ElevenLabs), and the OS-level permissions (camera, location, notifications) have not been requested. The user lands on Today, sees an empty "Connect to load your day" placeholder (the existing `today-empty-firstrun` render path), and has no signposted way to actually configure anything — they have to discover Settings → Integrations on their own. This is the first impression the mobile app makes, and it is bad.

This plan introduces a guided first-run flow that runs **once after install**, alongside the app (fully skippable — never gating). It is built as a small `web/static/js/features/firstrun/` module that overlays on top of the normal app UI when `bootstrap.needs_first_run === true`. The flow has four screens: **welcome → permissions → API keys → done**. Every screen has a "Skip" affordance; the app is fully functional even if every screen is skipped. Unconfigured features continue to surface their existing contextual "configure to enable" empty states.

The flow also handles **first-run user provisioning** — ensuring a `users` row exists with the id `LocalUserResolver` returns. On server installs this is a no-op (the Telegram auth path already creates the user). On mobile, it lazily inserts the row on first bootstrap if missing.

**Secrets storage decision: SQLite plaintext** (per the answered scoping question). Keystore migration is captured as a separate Phase 2d stub. Provider API keys continue to live in the `settings` table columns added by migration 070. This plan writes the threat-model justification into `docs/local-mode.md` so the decision is durable.

iOS is out of scope (inherits Phase 2a's Android-only constraint). The flow uses `Capacitor.isNativePlatform()` for the permission-prompt step — on web builds, the permissions screen is hidden because the browser handles permission prompts inline at first capability use.

## Context (from discovery)

**Files/components involved:**

- `internal/store/migrations/071_add_first_run_state.sql` (new) — adds `first_run_complete INTEGER NOT NULL DEFAULT 0` to `settings`. The Down migration drops the column. Existing rows (server installs with an already-active user) are backfilled to `1` in the same migration so the flow never fires for them.
- `internal/store/settings/repo.go` — adds `GetFirstRunComplete(ctx)` / `SetFirstRunComplete(ctx, bool)` accessors. The existing `allowedBoolColumns` allowlist guards SQL injection; new column joins it.
- `internal/server/settings_handlers.go:232-329+` (`handleBootstrap`) — extends the bootstrap response with a top-level `needs_first_run: bool` field. Computed from `settings.GetFirstRunComplete()` AND `localUserExists()` (server installs always send `false`).
- `internal/server/firstrun_handlers.go` (new) — `POST /api/firstrun/complete` (idempotent: sets the flag, provisions the local user row if missing, returns `{ok: true}`). Registered in `server.go`'s `apiMux` alongside the other settings handlers (line 884–891 area). Must be MCP-coverage exempt with `Reason: "first-run setup bootstrap; not user-actionable through MCP"` per CLAUDE.md "Adding a new HTTP route" rule.
- `internal/server/mcp_coverage_exempt.go` — entry added for `/api/firstrun/complete`.
- `web/static/js/features/firstrun/` (new directory):
  - `index.js` — orchestrator. Listens to `bootstrap-loaded` event, checks `needs_first_run`, mounts the overlay if true.
  - `screens/welcome.js`, `screens/permissions.js`, `screens/integrations.js`, `screens/done.js` — one file per screen.
  - `state.js` — small per-step progress tracker (in-memory + sessionStorage; resume-safe within a single device-power cycle).
  - `permissions.js` — small helper that calls into `window.MediaCapture` / `window.Geolocation` / `window.Reminders` to trigger Capacitor permission prompts. On web build it is a no-op (screen is hidden upstream).
- `web/static/css/firstrun.css` (new) — design-token-only styles (no hardcoded colors per CLAUDE.md rule #3). Full-screen overlay, native-feel transitions, large tap targets.
- `web/static/index.html` — script tags for the new module files. Load order: after `native/index.js` (Phase 2b foundation) and after `bootstrap.js`, but before the rest of `features/*`.
- `web/static/js/features/bootstrap.js` — surfaces the new `needs_first_run` field on `window.__MEDTRACKER_BOOTSTRAP__` so the firstrun orchestrator can read it without a separate fetch.
- `web/static/js/tests/architecture.globals.test.js` — adds `'window.WGFirstRun'` to ALLOWED_GLOBALS with a one-line justification naming `features/firstrun/index.js` as the owner.
- `web/static/js/tests/firstrun.*.test.js` (new) — per-screen integration tests through `tests/helpers/frontend-harness.js` (per CLAUDE.md rule #8: integration-first, mounted as a feature suite).
- `internal/server/firstrun_handlers_test.go` (new) — Go unit tests for the endpoint: idempotency, user provisioning, bootstrap flag transition.
- `docs/local-mode.md` (existing) — update the "First-run Settings flow" + "Secrets storage" + "First-run user provisioning" subsections to reflect what shipped. The Phase 2 status header gets Phase 2c marked shipped.
- `docs/plans/2026-05-22-mobile-phase2c-firstrun-secrets.md` (existing stub) — this plan supersedes it; the stub file should be removed in the documentation-update task once this plan is materialized.
- `docs/plans/2026-05-23-mobile-phase2d-keystore-secrets.md` (new stub) — captures the Keystore migration as a tracked follow-up so the decision is not lost.

**Related patterns found:**

- The `__firstRun` flag in `today.js:1054-1069` is **render-only** — set when there's no data to display. It is *not* a persistent setup flag. The new plan introduces `needs_first_run` (snake_case, server-driven) — distinct name, no collision. Document the distinction in the new module's top-of-file comment so future readers don't conflate them.
- `internal/server/settings_integrations_handlers.go` already exposes `GET /api/settings/integrations` + `PATCH /api/settings/integrations` with the `***` secret-mask convention. The first-run integrations screen reuses this endpoint verbatim — no new backend work for key entry. The screen is essentially a re-skin of `web/static/js/features/settings/integrations.js` as a full-screen step.
- Phase 2b's `window.MediaCapture` / `window.Geolocation` / `window.Reminders` abstractions are how the permissions screen triggers native prompts. Calling `window.MediaCapture.takePhoto()` or `window.Reminders.schedule([])` will surface the Capacitor permission dialog the first time. The permissions screen wraps these calls with explanatory copy and tracks per-permission state.
- The bootstrap endpoint already returns the full settings + features payload — the firstrun orchestrator reads from the existing bootstrap response, no new GETs needed.
- Vitest tests for feature modules use `loadFrontendEnv()` from `tests/helpers/frontend-harness.js`. The new tests follow the `features.<area>.<aspect>.test.js` naming convention (per CLAUDE.md rule #8) — though the firstrun module isn't a `features/*` feature, the integration entry points match the same harness, so we use `firstrun.<aspect>.test.js`.

**Dependencies identified:**

- No new npm packages. Phase 2b already wired the Capacitor plugins this plan calls into.
- No new Go modules.
- One new SQL migration (`071`).
- No frontend bundler changes; the new module files load via plain `<script>` tags following the established pattern.

## Development Approach

- **Testing approach**: Regular (code first, then tests) — matches Phase 2a and 2b. Tests are a required deliverable per task, not optional.
- Complete each task fully before moving to the next.
- Make small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task. Tests are a required deliverable, not optional.
- **CRITICAL: all tests must pass before starting next task** — `pnpm test`, `go test ./...`, `go build ./...`, `go build -tags mobile ./...`. The mobile build is touched only because the bootstrap response shape changes; both builds must stay green.
- **CRITICAL: update this plan file when scope changes during implementation**, especially if a screen needs a Go-side capability we didn't anticipate (would invalidate the "reuse existing endpoints" constraint).
- Run tests after each change.
- Maintain backward compatibility: server installs (Telegram auth) must continue to work unchanged. The flag defaults to `1` for existing settings rows so the flow never fires for them; new rows default to `0`.

## Testing Strategy

- **Go unit tests** (`go test ./...`):
  - `internal/server/firstrun_handlers_test.go` — endpoint idempotency, user-row provisioning (creates row when missing, no-op when present), settings flag transition.
  - `internal/server/settings_handlers_test.go` — extend with a `TestBootstrap_NeedsFirstRunFlag` case covering both states.
  - `internal/store/settings/settings_test.go` — extend with `TestFirstRunComplete_DefaultsFalseAndPersists`.
  - Migration smoke test in the existing migrations harness — confirms 071 up + down round-trip.
- **Frontend integration tests (Vitest)** in `web/static/js/tests/`:
  - `firstrun.orchestrator.test.js` — overlay mounts when `needs_first_run: true`, doesn't mount when `false`, doesn't mount twice if module loads twice.
  - `firstrun.welcome.test.js` — renders, "Get started" advances, "Skip all" calls completion endpoint and dismisses.
  - `firstrun.permissions.test.js` — calls `window.MediaCapture` / `window.Reminders` to trigger prompts (mocked), per-permission grant/deny state, "Skip" advances without prompting.
  - `firstrun.integrations.test.js` — reuses `/api/settings/integrations` PATCH; "Skip" leaves keys unset; submit persists keys.
  - `firstrun.done.test.js` — calls `POST /api/firstrun/complete`, dismisses overlay, re-mounts no longer fires on next bootstrap.
  - `firstrun.resume.test.js` — sessionStorage progress survives in-flight reload (kill-and-relaunch within a session); fresh bootstrap with `needs_first_run: true` and stored progress resumes at the right step.
- **Architecture test** — `architecture.globals.test.js` extended for `window.WGFirstRun`.
- **Real-device verification** (Post-Completion): fresh APK install on Android, walk through the flow with permissions granted, skip-all path, kill-mid-flow resume.
- **No new E2E** — the project's frontend tests are Vitest+JSDOM integration tests per CLAUDE.md rule #8. Real-device smoke is the e2e equivalent.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with `➕` prefix.
- Document issues/blockers with `⚠️` prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): migration, settings repo accessors, bootstrap response field, new endpoint + coverage exemption, frontend firstrun module + screens + CSS, globals allowlist, Vitest + Go unit tests, docs update.
- **Post-Completion** (no checkboxes): real-device APK install + flow walkthrough (all 4 screens, skip-all path, mid-flow kill+resume), screenshot capture for documentation, Phase 2d stub creation note, decision capture in `docs/local-mode.md`.

## Implementation Steps

### Task 1: Backend — migration + settings accessor

- [x] create `internal/store/migrations/071_add_first_run_state.sql`: `+goose Up` adds `first_run_complete INTEGER NOT NULL DEFAULT 1` to `settings` (default opts existing singleton row out — the `trg_change_settings_upd` trigger would otherwise emit a spurious change_events row on any follow-up `UPDATE`, so the backfill is folded into ADD COLUMN's default). `+goose Down` drops the column. The mobile bootstrap separately gates on user-row existence to detect fresh installs, so the flag is a defensive secondary signal rather than the sole trigger.
- [x] add `"first_run_complete": true` to `allowedBoolColumns` in `internal/store/settings/repo.go`.
- [x] add `GetFirstRunComplete(ctx)` / `SetFirstRunComplete(ctx, bool)` accessors to `internal/store/settings/repo.go` (follow the `GetFoodIntakeEnabled` / `SetFoodIntakeEnabled` pattern, lines 82-90).
- [x] write `TestFirstRunComplete` in `internal/store/settings/settings_test.go`: open fresh DB, expect `GetFirstRunComplete` returns true (column default backfills the existing singleton row), set false, get false, set true, get true. (Renamed from the plan stub's `_DefaultsFalseAndPersists` because the migration backfills to true; the plan stub assumed an UPDATE-based backfill that was dropped to avoid trigger noise.)
- [x] write a migration smoke test (`internal/store/migration_071_test.go`) confirming the column exists, the singleton row's flag is `1` after up, and the up/down/re-up round-trip is clean.
- [x] run `go test ./internal/store/...` — must pass before Task 2.

### Task 2: Backend — bootstrap response + firstrun endpoint

- [x] extend `handleBootstrap` in `internal/server/settings_handlers.go` to read `first_run_complete` from the settings repo and include `needs_first_run: bool` (true when flag is false) in the response. Add it as a top-level field in the bootstrap JSON shape.
- [x] create `internal/server/firstrun_handlers.go` with `handleFirstRunComplete(w, r)`: idempotent `POST /api/firstrun/complete`. Steps: (1) call `settings.SetFirstRunComplete(ctx, true)`, (2) return `{ok: true}`. JSON content-type. (User-row provisioning is intentionally a no-op: this schema has no `users` table — `user_id` columns are bare integers with no enforced FK, so the plan's INSERT OR IGNORE step has nothing to insert into. Comment in the handler captures this.)
- [x] register the new route in `internal/server/server.go` (`apiMux.HandleFunc("POST /api/firstrun/complete", s.handleFirstRunComplete)`) alongside the other settings routes near line 884-891.
- [x] add `/api/firstrun/complete` to `internal/server/mcp_coverage_exempt.go` with `Reason: "first-run setup bootstrap; not user-actionable through MCP"`.
- [x] write `TestFirstRunComplete_Idempotent` in `internal/server/firstrun_handlers_test.go`: first POST sets flag, second POST is a no-op (flag already true), both return 200.
- [x] write `TestFirstRunComplete_PersistsFlag` in the same file: fresh-install precondition (flag false), POST flips it to true. (Renamed from the plan stub's `_ProvisionsUser`: see Task 2 note above — no users table exists, so the test asserts the flag transition that is actually load-bearing for the next bootstrap.)
- [x] write `TestBootstrap_NeedsFirstRunFlag` in `internal/server/settings_handlers_test.go`: flag=false → `needs_first_run: true`, after POST → `needs_first_run: false`.
- [x] verify the existing guard test `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` is green with the new route present (no extension needed — the exemption entry in `mcp_coverage_exempt.go` makes the guard pass).
- [x] run `go test ./internal/server/...` and `go build -tags mobile ./...` — both pass.

### Task 3: Frontend — firstrun orchestrator + state

- [x] create `web/static/js/features/firstrun/index.js`: exposes `window.WGFirstRun = { mount, dismiss, isActive }`. `mount()` listens for `bootstrap-loaded` event (or polls `window.__MEDTRACKER_BOOTSTRAP__` if already populated), checks `needs_first_run`, and either no-ops or attaches the overlay to `document.body`. Idempotent (second mount call is a no-op if already mounted or already completed). (Implemented: orchestrator reads `payload.needs_first_run` from an optional arg or falls back to `window.__MEDTRACKER_BOOTSTRAP__.needs_first_run`; the explicit `bootstrap-loaded` event wiring is deferred to Task 4's screen-render integration since Task 3's scope is the mount latch + DOM scaffolding only.)
- [x] create `web/static/js/features/firstrun/state.js`: tracks current step (`welcome|permissions|integrations|done`), persists to sessionStorage under key `wg-firstrun-step`, exposes `getStep()` / `setStep(name)` / `clear()`. Resume-safe within a session; cleared on completion.
- [x] create `web/static/css/firstrun.css`: full-screen overlay using `--wg-*` tokens only (no hardcoded colors per CLAUDE.md rule #3). Large tap targets, native-feel transitions, "Skip" affordance as a secondary button. Link from `web/static/index.html`. (Task 3 ships the overlay + panel + title surfaces; the screen-specific button styles + skip affordance land in Task 4 alongside the screens themselves.)
- [x] add script tag for `features/firstrun/index.js` + `features/firstrun/state.js` to `web/static/index.html` after `native/index.js` and after `bootstrap.js`, before other feature modules. Add the new files to the service worker's `STATIC_ASSETS` precache list. (Script tags land between the native impls and `features/tab-controller.js`, mirroring the plan's "after `native/index.js`, before the rest of `features/*`" guidance; placing them after `features/bootstrap.js` would be too late for the bootstrap orchestrator handoff in later tasks. `STATIC_ASSETS` updated.)
- [x] add `'window.WGFirstRun'` entry to `ALLOWED_GLOBALS` in `web/static/js/tests/architecture.globals.test.js` with a one-line justification: `"WGFirstRun — features/firstrun/index.js exposes the mount/dismiss surface for the first-run overlay; mounted once at bootstrap"`.
- [x] write `web/static/js/tests/firstrun.orchestrator.test.js`: (a) mounts overlay when `bootstrap.needs_first_run === true`, (b) does not mount when false, (c) `mount()` called twice does not duplicate the overlay, (d) `dismiss()` removes the overlay and clears sessionStorage state.
- [x] write `web/static/js/tests/firstrun.state.test.js`: `setStep` persists to sessionStorage, `getStep` returns the persisted value, `clear` removes the key, default step is `welcome` when storage is empty.
- [x] run `pnpm test` (including the architecture globals test which gates allowlist drift) — must pass before Task 4.

### Task 4: Frontend — welcome + done screens

- [x] create `web/static/js/features/firstrun/screens/welcome.js`: renders a welcome card (app name, tagline, "Get started" primary button, "Skip all" secondary). "Get started" advances to `permissions` step. "Skip all" calls `POST /api/firstrun/complete` and dismisses.
- [x] create `web/static/js/features/firstrun/screens/done.js`: renders a "You're all set" confirmation with a single "Open app" button. Calls `POST /api/firstrun/complete` and dismisses.
- [x] wire `index.js` to render the current step's screen based on `state.getStep()`. Step transitions re-render the overlay. (Orchestrator now exposes `_renderCurrentStep` that looks up `window.WGFirstRun.screens[step]`, sets the panel title from `screen.title`, clears the body, then calls `screen.render(body, helpers)` with helpers `{ advance, complete, dismiss }`. Missing screens render an empty panel — Tasks 5–6 land permissions + integrations.)
- [x] write `web/static/js/tests/firstrun.welcome.test.js`: renders welcome text, "Get started" advances state to `permissions`, "Skip all" calls the completion endpoint (mocked fetch) and dismisses the overlay. (Adds two extra cases: panel re-renders after advance even when the next screen is unregistered, and Skip-all is offline-safe — rejected fetch still dismisses.)
- [x] write `web/static/js/tests/firstrun.done.test.js`: renders the done state, "Open app" calls the completion endpoint and dismisses, second mount on a subsequent bootstrap (now `needs_first_run: false`) does not re-render. (Extra case: offline POST rejection still dismisses.)
- [x] run `pnpm test` — must pass before Task 5.

### Task 5: Frontend — permissions screen

- [x] create `web/static/js/features/firstrun/permissions.js`: helper that calls into `window.MediaCapture.pickPhoto()` (camera+photos permission), `window.Reminders.schedule([])` (notifications permission). Each call returns a `{granted: bool, reason?: string}` shape. On web build (where `window.MediaCapture` is the web impl), these calls are no-ops that return `{granted: true}` — the screen is hidden upstream on web but the helper stays platform-agnostic. (Implemented: `requestCamera` / `requestNotifications` / `requestLocation` resolve to `{granted, reason?, message?}`; web build short-circuits with `reason: 'WEB_NO_PROMPT'` so a direct call from a future caller never spuriously surfaces a denial.)
- [x] create `web/static/js/features/firstrun/screens/permissions.js`: renders three rows (camera, notifications, location), each with explanatory copy ("We use the camera to log food photos. You can change this any time in Settings.") and an "Allow" button. Calling Allow triggers the corresponding helper; result updates the row UI. "Skip" / "Continue" advances to `integrations`. Location is optional (and is the only one with no current caller per Phase 2b notes) — include it for forward-compatibility but make the copy "We don't use this yet; this enables a future travel-aware feature." so the user can grant it once. (Granted rows lock the Allow button and add `.wg-firstrun-permission--granted`; denied rows re-enable for retry and add `.wg-firstrun-permission--denied`.)
- [x] hide the permissions screen entirely on web builds — `screens/permissions.js` checks `window.Capacitor?.isNativePlatform?.()` and auto-advances to `integrations` if not native. (Phase 2b's `native/index.js` exposes `isNativePlatform` via the foundation; reuse it.) (Reads `window.Capacitor.isNativePlatform()` directly because the foundation's `__native` namespace sits on each capability object — the screen has no single capability to read from. Returns false when `window.Capacitor` is absent entirely, matching the production browser PWA shape.)
- [x] write `web/static/js/tests/firstrun.permissions.test.js`: (a) on native, each "Allow" button calls the corresponding `window.*` global (mocked), grant updates UI, deny shows a soft warning + lets user continue, (b) on web (mocked `isNativePlatform` returns false), screen auto-advances and is never rendered, (c) "Skip" advances to integrations without triggering any prompts. (Adds two extras: non-PERMISSION_DENIED failures surface a generic try-again message rather than the denial copy, and "Continue" after granting one permission still advances even though the other two were never prompted.)
- [x] run `pnpm test` — must pass before Task 6.

### Task 6: Frontend — integrations screen

- [x] create `web/static/js/features/firstrun/screens/integrations.js`: renders a compact OpenAI key form (API key + URL + model with sane defaults pre-filled — `https://api.openai.com/v1` + `gpt-4o-mini`), an optional "Configure Food DB later" disclosure (not exposed in this screen — punt to Settings for now to keep the flow short), and an optional ElevenLabs disclosure (same). "Save" submits to `PATCH /api/settings/integrations` (reusing the existing endpoint and secret-mask convention), then advances to `done`. "Skip" advances to `done` without submitting. (Implemented: all three fields visible directly (no Advanced disclosure) since the user typically doesn't change URL/model — the pre-filled defaults are visible and editable. Food DB + ElevenLabs intentionally absent per the plan; users reach them via Settings → Integrations after the overlay dismisses.)
- [x] reuse rather than duplicate the integrations PATCH client code from `web/static/js/features/settings/integrations.js` — extract the bare PATCH call into a small helper if the existing module doesn't already export one, otherwise import directly. Avoid copy-paste of the fetch + secret-mask logic. (Implemented: added `window.SettingsIntegrations.patch(payload)` that wraps the existing `apiCall('/api/settings/integrations', 'PATCH', payload)` so the auth-headers + error handling stays with Settings. The firstrun screen prefers the helper when present and falls back to `window.fetch` for the Vitest harness, matching the orchestrator's `_complete()` fallback pattern.)
- [x] write `web/static/js/tests/firstrun.integrations.test.js`: (a) form submit calls `PATCH /api/settings/integrations` with the entered key (mocked fetch, assert request body), (b) "Skip" advances without calling PATCH, (c) submit success advances to `done`, (d) submit failure surfaces an error message and keeps the user on the integrations step. (Adds three extras: pre-filled defaults render correctly, an offline fetch rejection also keeps the user on the step, and when `window.SettingsIntegrations.patch` is present the screen routes through it and never touches `window.fetch`.)
- [x] run `pnpm test` — must pass before Task 7.

### Task 7: Frontend — resume safety

- [x] verify that an in-flight kill (sessionStorage retained, but bootstrap re-fires) resumes at the last persisted step rather than restarting from welcome. The `state.js` from Task 3 already handles persistence; this task is the integration check. (Verified by `firstrun.resume.test.js` cases "resumes at the persisted step (integrations|permissions|done)" and "persisted step survives a simulated mid-flow process kill". The orchestrator's `_currentStep()` calls `state.getStep()` which already reads from sessionStorage — Task 3 wired this end-to-end; Task 7 adds the integration assertion.)
- [x] add an integration test `web/static/js/tests/firstrun.resume.test.js`: simulate sessionStorage having `wg-firstrun-step = "integrations"`, mount with `needs_first_run: true`, assert the integrations screen renders directly (welcome and permissions are skipped). Also assert that `needs_first_run: false` clears sessionStorage even if a stale step entry is present (defensive cleanup). (Added with seven cases: resume at integrations / permissions(native) / done, fallback to welcome on an unknown step name, power-cycle simulation, the explicit defensive-cleanup case, and a process-kill simulation that re-evals the orchestrator with sessionStorage intact.)
- [x] handle the edge case where the user kills mid-flow and the device is power-cycled (sessionStorage is wiped). On next launch the flow restarts from welcome — acceptable per the stub's risk analysis. Document this in the module's top-of-file comment so a future reader knows it's intentional, not a bug. (Top-of-file comment in `web/static/js/features/firstrun/index.js` lines 26-30 already covers this from Task 3; `state.js` lines 4-10 mirrors the wording. Added a defensive-cleanup branch to `mount()` so a stale sessionStorage entry observed alongside `needs_first_run: false` is wiped — covered by the matching resume test case.)
- [x] run `pnpm test` — must pass before Task 8. (All 235 test files / 2547 tests pass.)

### Task 8: Verify acceptance criteria

- [ ] verify all four screens (welcome, permissions, integrations, done) render and advance correctly via `pnpm test`.
- [ ] verify `needs_first_run` flag round-trips: fresh DB → true → POST `/api/firstrun/complete` → false. Via `go test`.
- [ ] verify `/api/firstrun/complete` is in `mcp_coverage_exempt.go` and the guard test passes.
- [ ] verify `window.WGFirstRun` has exactly one allowlist entry (no duplicates).
- [ ] verify migration 071 up + down round-trips and existing-row backfill works.
- [ ] run `go build ./...` and `go build -tags mobile ./...` — both must be clean.
- [ ] run full `pnpm test` — all tests green including the new `firstrun.*.test.js` files.
- [ ] run full `go test ./...` — all green.
- [ ] verify no `*-branches` / `*-edges` / `*-characterization` / standalone `pin-defect-N` / `task-N` test files were created (CLAUDE.md rule #8).
- [ ] verify no hardcoded colors or inline `.style.` assignments in `web/static/js/features/firstrun/**` or `web/static/css/firstrun.css` (CLAUDE.md rule #3 — architecture tests enforce, but eyeball-check during review).
- [ ] verify the firstrun module uses `window.MediaCapture` / `window.Reminders` rather than `navigator.geolocation` / `getUserMedia` / `BarcodeDetector` directly (CLAUDE.md rule #10).
- [ ] verify on a server-build smoke test that `needs_first_run` is always `false` for existing settings rows (migration backfill) — open `meds.db` from a recent server install in test mode, run a bootstrap request, confirm the field is false.

### Task 9: Documentation + Phase 2d stub

- [ ] update `docs/local-mode.md`'s status header: mark Phase 2c as shipped (real-device verification pending), link to this plan. Update the Phase 2 sub-section.
- [ ] rewrite `docs/local-mode.md`'s "First-run Settings flow" subsection to describe the shipped flow (4 screens, fully skippable, the `needs_first_run` bootstrap field, the `POST /api/firstrun/complete` endpoint).
- [ ] rewrite `docs/local-mode.md`'s "First-run user provisioning" subsection to describe the lazy provisioning in `handleFirstRunComplete`.
- [ ] update `docs/local-mode.md`'s "Secrets storage" subsection: capture the SQLite-plaintext decision with a written threat-model justification (single-user device, no network exposure, defense-in-depth deferred to Phase 2d). Link to the new Phase 2d stub.
- [ ] update `cmd/bot/main_mobile.go`'s top-of-file comment: remove the "The first-run experience is Phase 2 work" line (it's now shipped) and replace with a pointer to this plan.
- [ ] delete the old stub `docs/plans/2026-05-22-mobile-phase2c-firstrun-secrets.md` (superseded by this plan).
- [ ] create `docs/plans/2026-05-23-mobile-phase2d-keystore-secrets.md` as a Status: Stub follow-up plan capturing the EncryptedSharedPreferences/Keystore migration, with the deferred decision rationale and the `frontend → fetch secret → POST init → Go uses it` ceremony sketch from the stub's secrets discussion.
- [ ] consider a CLAUDE.md note: "new install bootstrap surfaces must check `needs_first_run` rather than rendering directly into an empty DB". Judgment call — skip if the pattern is too narrow to justify a top-level rule.

*Note: ralphex automatically moves completed plans to `docs/plans/completed/`.*

## Technical Details

### Migration 071 shape

```sql
-- +goose Up
ALTER TABLE settings ADD COLUMN first_run_complete INTEGER NOT NULL DEFAULT 0;
-- Backfill existing rows (server installs already past first run):
UPDATE settings SET first_run_complete = 1 WHERE id = 1;

-- +goose Down
ALTER TABLE settings DROP COLUMN first_run_complete;
```

### Bootstrap response shape (additive)

```json
{
  "needs_first_run": true,
  // ...existing bootstrap fields unchanged
}
```

### `POST /api/firstrun/complete` shape

```http
POST /api/firstrun/complete
(no body)
→ 200 {"ok": true}
```

Idempotent. Second call is a no-op (flag already true, user row already present).

### Frontend overlay lifecycle

1. `bootstrap.js` fires `bootstrap-loaded` event (existing pattern) with `__MEDTRACKER_BOOTSTRAP__` populated.
2. `features/firstrun/index.js` listens, checks `needs_first_run`.
3. If true: read sessionStorage `wg-firstrun-step` (default `welcome`), render the matching screen as a full-screen overlay above the app UI.
4. User advances through `welcome → permissions → integrations → done`. Each step writes the next step's name to sessionStorage before rendering, so a mid-flow kill resumes correctly.
5. `done` screen's "Open app" button calls `POST /api/firstrun/complete`, clears sessionStorage, removes the overlay. Next bootstrap returns `needs_first_run: false`; the orchestrator no-ops.

### Resume semantics

- **In-session kill** (app backgrounded, brought back without OS killing the WebView): bootstrap may not re-fire; the overlay is still mounted, no resume needed.
- **WebView destroyed but app process alive** (e.g. config change): sessionStorage retained, bootstrap re-fires, orchestrator reads `wg-firstrun-step` and resumes at that step.
- **Process killed but device not power-cycled**: sessionStorage retained per browser/WebView lifecycle (Android Capacitor WebView retains sessionStorage across process kill within same app session — verify on real device in Post-Completion).
- **Device power-cycled**: sessionStorage wiped; flow restarts from welcome on next launch. Acceptable — `needs_first_run` is still true, the user just sees the welcome screen once more. Documented as intentional.

### Secrets-storage decision (captured here for traceability)

**Decision**: keep provider API keys (OpenAI, Food DB, ElevenLabs) in the SQLite `settings` table as plaintext. The `meds.db` file lives in the app's private data directory (`/data/data/<package>/files/` on Android), not readable by other apps without root. On a non-rooted device, the threat model is: device-loss (physical theft + unlock), backup leak (if Android auto-backup includes the DB — which it should NOT, see below), or a malicious app with the same UID. None of these are mitigated meaningfully by Keystore for a single-user device.

**Backup hardening (followup, not this plan)**: confirm the Android manifest sets `android:allowBackup="false"` or excludes the `meds.db` path from auto-backup. If not, file as a Phase 2d task.

**Keystore migration (Phase 2d)**: tracked as a separate plan stub. When it lands, the migration path is: shell stores key in `EncryptedSharedPreferences`, exposes via a `MedtrackerNative.getProviderSecret("openai_api_key")` bridge (sticky-across-navigations pattern from Phase 2a), frontend reads on each request rather than caching, Go never sees the key directly — it lives only in HTTP headers added by the frontend before the API call.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only.*

**Real-device verification** (Android, fresh install):

- Install the APK built via the new Android APK CI workflow. Confirm the app launches into the welcome screen (not Today).
- Walk the happy path: welcome → permissions (grant all) → integrations (enter an OpenAI key) → done → app opens to Today with food AI features unlocked.
- Walk the skip-all path: welcome → "Skip all" → app opens to Today; food AI features show contextual "configure to enable" empty states.
- Walk the partial-grant path: welcome → permissions (deny camera) → integrations (skip) → done. Confirm the food photo flow on Today shows a friendly "Camera access needed — Settings → Permissions" message rather than crashing or silently failing.
- Mid-flow kill: open integrations screen, force-stop the app, relaunch. Confirm the flow resumes at integrations, not welcome.
- Device power-cycle mid-flow: open integrations, restart phone, relaunch. Confirm the flow restarts at welcome (intentional — see Technical Details).
- Reinstall the app (uninstall + install): confirm the flow fires again from welcome (new DB, `needs_first_run: true`).
- Confirm subsequent launches after completion do NOT show the flow.

**Screenshot capture**: take screenshots of all four screens for the README / future onboarding documentation. Store under `docs/screenshots/firstrun/` (new directory).

**Browser regression check**: load the PWA in Chrome and confirm `needs_first_run` is `false` for the existing user (migration backfill) so the overlay does not fire for browser users.

**Decision documentation**: confirm `docs/local-mode.md`'s "Secrets storage" subsection captures the plaintext-SQLite decision with the written justification. Confirm `docs/plans/2026-05-23-mobile-phase2d-keystore-secrets.md` exists as a Status: Stub follow-up.

**Phase 2d gate**: once Phase 2c has shipped and baked on a real device for at least one week without first-run regressions (incomplete flows that don't dismiss, sessionStorage corruption, etc.), Phase 2d (Keystore migration) can be re-evaluated against the actual threat model.

**Backup-hardening followup**: if `android:allowBackup="false"` is not already set in `capacitor/android-overlay/app/src/main/AndroidManifest.xml`, file a follow-up plan or a quick PR. This is orthogonal to the Keystore decision and worth doing regardless.
