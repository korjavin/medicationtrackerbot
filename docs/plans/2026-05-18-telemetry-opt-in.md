# Implicit Opt-In Telemetry — Full v1

## Overview

Implement the implicit opt-in fleet telemetry described in [docs/implicit-opt-in-telemetry-architecture.md](../implicit-opt-in-telemetry-architecture.md) and the public-facing [TELEMETRY.md](../../TELEMETRY.md).

**What it does**: when a self-hoster sets `TELEMETRY_ENABLED=true` and `TELEMETRY_ENDPOINT=https://...`, the Go server begins reporting anonymous, allowlisted events (screen views, feature usage, bot/MCP/scheduler/SSE actions, HTTP route counts, deployment) to the maintainer's Vince instance. Events are proxied through the Go backend; the browser never talks to the central server directly.

**Why it matters**: the maintainer currently has zero visibility into fleet behavior. Without it, every feature decision is guesswork. The design satisfies single-user-self-hosted GDPR posture (operator is the data subject and consents via env var) and ships with hard guarantees: HTTPS-only endpoint, no PHI, no domain/IP leakage, no service-worker emission, fire-and-forget with bounded buffer, crashloop-safe deployment dedup.

**Scope**: Full v1 — backend reporter + handler + middleware + all transport-layer integration hooks + installer change + frontend module + bootstrap flag + emission hooks across feature modules.

## Context (from discovery)

Design and conversation history have established:

**Files/components involved:**

- New package: `internal/telemetry/` (reporter + tests)
- New files: `internal/server/telemetry_handler.go`, `internal/server/telemetry_middleware.go`
- New file: `web/static/js/features/telemetry.js`
- Migration: `internal/store/migrations/` (new file for `telemetry_meta` keys)
- Modified: `internal/store/settings/` (lazy instance-ID persistence + deployment dedup)
- Modified: `cmd/bot/main.go` (wire reporter)
- Modified: `internal/server/mcp_coverage_exempt.go` (exempt `/api/telemetry/event`)
- Modified: `internal/bot/*_callbacks.go` (emit `bot_action`)
- Modified: `internal/server/*_handler.go` write handlers (emit `feature_used`)
- Modified: `internal/scheduler/*.go` (emit `scheduler_action`)
- Modified: `internal/mcp/executor/` or `internal/mcp/proxy/` (emit `mcp_call`)
- Modified: `internal/server/` SSE handler (emit `sse_event`)
- Modified: `/api/bootstrap` handler (expose `telemetry_enabled` flag)
- Modified: web frontend feature modules (call `window.trackScreenView` / `window.trackFeatureUsed`)
- Modified: `docs/installer.md` (generate `TELEMETRY_INSTANCE_ID` at install)

**Related patterns found:**

- Domain service pattern (CLAUDE.md §1): emission MUST live at transport layer (bot callbacks / HTTP handlers), not in domain services — domain can't see the transport, so emission there collapses the bot-vs-web split.
- Per-feature store repos (CLAUDE.md): each `internal/store/<feature>/` has its own `Repo` struct. Instance ID + deployment dedup belong in `internal/store/settings/` since they're per-instance singletons, not per-user.
- MCP coverage policy (CLAUDE.md): every new route MUST be in registry OR `mcpCoverageExempt`. `POST /api/telemetry/event` is exempt (no user-actionable semantics).
- `log/slog` with contextual args (CLAUDE.md §5).
- Frontend tests are integration-first (CLAUDE.md §8): backend tests are unit-per-package.
- Frontend write handlers use `DataStore.applyOptimistic` (CLAUDE.md §9) — telemetry emission goes alongside, not inside, the optimistic path. Emit on the commit branch, not the optimistic-paint branch.

**Dependencies identified:**

- Vince site `telemetry.example.com` registered in maintainer's Vince admin (manual, Post-Completion)
- Vince Goals configured for each custom event name (manual, Post-Completion)
- Vince retention set to 2 years (manual, Post-Completion)

## Development Approach

- **Testing approach**: Regular (tests alongside code in same task).
- Complete each task fully before moving to the next.
- Make small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task.
- **CRITICAL: all tests must pass before starting next task.**
- **CRITICAL: update this plan file when scope changes during implementation.**
- Run tests after each change.
- Maintain backward compatibility — telemetry must default off and be a no-op when off.

## Testing Strategy

- **Backend unit tests**: per-package Go tests; one test file per new file. Use `httptest` for outbound-shape assertions. Use in-memory SQLite for store tests.
- **Frontend tests** (Vitest + jsdom): integration-first via `tests/helpers/frontend-harness.js` — extend the owning feature suite for emission hooks; new pure unit tests only for `telemetry.js` itself.
- **Architecture guard tests**: new `window.trackScreenView` / `window.trackFeatureUsed` globals MUST have entries in `tests/architecture.globals.test.js`.
- **MCP coverage guard test**: `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` already enforces this; the exempt entry added in Task 5 satisfies it.
- **No service-worker telemetry**: a test must assert `web/static/sw.js` does NOT import or call telemetry.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.
- Update plan if implementation deviates from original scope.
- Keep plan in sync with actual work done.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): tasks achievable within this codebase.
- **Post-Completion** (no checkboxes): Vince admin setup, manual smoke test against real Vince, retention configuration.

## Implementation Steps

### Task 1: Telemetry package skeleton + disabled path

- [ ] create `internal/telemetry/` directory with `reporter.go`
- [ ] define `Event{Name, URL, Props}` and `Config{Enabled, Endpoint, InstanceID, Version, Domain}` types
- [ ] define `Reporter` struct (no `syntheticIP` field — Option A drops the XFF trick)
- [ ] implement `NewReporter(cfg, store)` — validates endpoint (`https://` only, hard-fail on plaintext or empty), returns no-op reporter when `Enabled=false`
- [ ] implement no-op `Track(name, props)` and `Shutdown(ctx)`
- [ ] write `TestReporterIsNoOpWhenDisabled` — asserts zero outbound HTTP via `httptest` round-tripper that records calls
- [ ] write `TestReporterRefusesPlaintextEndpoint`, `TestReporterRefusesMissingEndpoint`
- [ ] run `go test ./internal/telemetry/...` — must pass before Task 2

### Task 2: Reporter enabled path — buffer, flush loop, outbound HTTP

- [ ] add bounded `chan Event` (depth 256); `Track` uses `select { case ch <- e: default: }` — drops on full buffer
- [ ] add flush loop (every 5s or when buffer reaches 50) inside a goroutine started by `NewReporter` when enabled
- [ ] implement outbound HTTP POST to `${endpoint}/api/event` with body `{name, url, domain, props}` per the event contract in `docs/implicit-opt-in-telemetry-architecture.md`
- [ ] set `User-Agent: medtracker/<version>`; do NOT set `X-Forwarded-For` (Option A)
- [ ] always tag every outbound event with `props.instance = <hex>` and `props.schema = "1"`
- [ ] implement `Shutdown(ctx)` — drains remaining buffer up to context deadline, then closes channel
- [ ] write `TestOutboundHeadersStripped` — asserts no Referer, no real browser UA, no real client IP, no X-Forwarded-For in outbound request
- [ ] write `TestNoXForwardedFor` (explicit, separate from the above for clarity)
- [ ] write `TestBufferDropsOnOverflow` — fill buffer + send N more; assert no block, no panic, drops counted
- [ ] write `TestShutdownDrainsBuffer` — populate buffer, call Shutdown, assert all events sent within deadline
- [ ] run `go test ./internal/telemetry/...` — must pass before Task 3

### Task 3: Instance ID resolution + settings persistence

- [ ] create migration `internal/store/migrations/<next>_telemetry_meta.sql` adding singleton-row table or keys for `telemetry_instance_id`, `telemetry_last_deployment_event_unix`, `telemetry_last_deployment_event_version`
- [ ] extend `internal/store/settings/` with `GetTelemetryInstanceID(ctx) (string, error)` and `SetTelemetryInstanceID(ctx, id) error`
- [ ] define `InstanceMetaStore` interface in `internal/telemetry/` with the minimal methods Reporter needs (not the whole store)
- [ ] in `NewReporter`: resolve instance ID via env var (`TELEMETRY_INSTANCE_ID`) → settings → `crypto/rand`-generate + persist
- [ ] write `TestInstanceIDFromEnv` — env set, settings empty, returns env value
- [ ] write `TestInstanceIDFromSettings` — env unset, settings populated, returns settings value
- [ ] write `TestInstanceIDGeneratedAndPersisted` — env unset, settings empty: generates, persists, second `NewReporter` reads the same ID
- [ ] run `go test ./internal/telemetry/... ./internal/store/settings/...` — must pass before Task 4

### Task 4: Deployment event dedup

- [ ] extend `internal/store/settings/` with `GetLastDeploymentEvent(ctx) (version string, ts int64, err error)` and `SetLastDeploymentEvent(ctx, version, ts) error`
- [ ] implement `Reporter.TrackDeployment(version, goVersion, osName)` — reads last event from settings; if `version != last.version` OR `now - last.ts >= 24h`, emit + persist; else no-op
- [ ] use `storedb.TimeToUnix` for the timestamp column (per CLAUDE.md "Time storage" convention) — INTEGER unix-seconds-UTC
- [ ] add the new dedup timestamp column to the dose-time-columns allowlist in `internal/store/store_time_invariants_test.go` only if it's user-facing dose-like; for telemetry meta it isn't, so verify the invariant test still passes without changes
- [ ] write `TestDeploymentDedupedSameVersionWithinDay` — two `TrackDeployment` calls; only first sends
- [ ] write `TestDeploymentSentOnVersionChange` — same instance, different version → sends
- [ ] write `TestDeploymentSentAfter24h` — mock clock, same version, 25h later → sends
- [ ] run `go test ./internal/telemetry/... ./internal/store/...` — must pass before Task 5

### Task 5: HTTP intake handler + MCP coverage exempt

- [ ] create `internal/server/telemetry_handler.go` with `POST /api/telemetry/event` handler
- [ ] define event-name allowlist: `pageview`, `http_request`, `feature_used`, `bot_action`, `mcp_call`, `scheduler_action`, `sse_event`, `deployment`
- [ ] define per-event-name prop-key allowlists matching the design doc
- [ ] reject unknown names and unknown prop keys with `400`; log with `slog` at info level
- [ ] return `204` always when valid (including when telemetry is disabled — indistinguishable to the client)
- [ ] when enabled: call `reporter.Track(name, props)` with the parsed event; rewrite `url` to the full synthetic `https://telemetry.example.com/<path>` form
- [ ] register the route in `cmd/bot/main.go` mux wiring (deferred to Task 12 for full wiring; here just the handler exists)
- [ ] add `"POST /api/telemetry/event"` entry to `internal/server/mcp_coverage_exempt.go` with reason "Telemetry intake; no user-actionable semantics; never readable by MCP"
- [ ] write `TestTelemetryHandlerAllowlist` — accepts known names, rejects unknown names, rejects unknown prop keys
- [ ] write `TestTelemetryHandlerReturns204WhenDisabled` — handler with no-op reporter returns 204 without forwarding
- [ ] run `go test ./internal/server/...` — must pass before Task 6

### Task 6: HTTP middleware (`http_request` emission)

- [ ] create `internal/server/telemetry_middleware.go` wrapping the API mux
- [ ] extract route pattern from the mux (use Go 1.22+ `Request.Pattern`, NOT `r.URL.Path`)
- [ ] bucket status: `2xx`/`4xx`/`5xx`; treat `0`/client-cancellation/write-timeout as the `0` bucket
- [ ] skip emission for `POST /api/telemetry/event` itself (feedback-loop guard)
- [ ] call `reporter.Track("http_request", {method, route, status})` from the middleware
- [ ] write `TestMiddlewareEmitsRoutePattern` — request to `/api/bp/42` registered as `/api/bp/{id}` pattern emits route=`/api/bp/{id}`, not `/api/bp/42`
- [ ] write `TestMiddlewareStatusBuckets` — table-driven: 200→`2xx`, 404→`4xx`, 503→`5xx`, write-timeout→`0`
- [ ] write `TestTelemetryHandlerDoesNotEmitForItself` — POST to `/api/telemetry/event` produces ZERO `http_request` emissions
- [ ] run `go test ./internal/server/...` — must pass before Task 7

### Task 7: Bot callback emission (`bot_action`)

- [ ] add `Reporter` dependency to bot callback handlers in `internal/bot/*_callbacks.go` (constructor injection via existing `Bot` struct)
- [ ] after each successful domain-service call in a callback, emit `bot_action` with the appropriate `action` value
- [ ] explicit allowlist of `action` values: `med_confirmed`, `med_skipped`, `bp_logged`, `weight_logged`, `workout_started`, `workout_completed`, `reminder_snoozed`, `reminder_blocked`, `food_logged`, `diary_note_created`
- [ ] do NOT emit on failure (telemetry tracks user-meaningful completed actions)
- [ ] write `TestBotCallbackEmitsBotAction` for each callback — table-driven across all action values; uses a recording test reporter
- [ ] write `TestBotCallbackNoEmitOnDomainError` — domain service returns error, reporter receives nothing
- [ ] run `go test ./internal/bot/...` — must pass before Task 8

### Task 8: Scheduler emission (`scheduler_action`)

- [ ] add `Reporter` dependency to scheduler types in `internal/scheduler/` (constructor injection)
- [ ] in each fire-point (med reminders, BP reminders, weight reminders, workout reminders, tz transition steps): emit `scheduler_action` with the appropriate `action` value
- [ ] action allowlist: `med_reminder_fired`, `bp_reminder_fired`, `weight_reminder_fired`, `workout_reminder_fired`, `tz_transition_step_fired`
- [ ] write `TestSchedulerEmitsActionOnFire` for each fire-point — recording reporter asserts the right `action` value
- [ ] run `go test ./internal/scheduler/...` — must pass before Task 9

### Task 9: SSE emission (`sse_event`)

- [ ] add `Reporter` dependency to the SSE changes-stream handler
- [ ] emit `sse_event` with `kind="connect"` on stream open, `kind="disconnect"` on clean close, `kind="rst_stream"` on RST/cancellation
- [ ] no durations, no client IPs, no stream IDs in props
- [ ] write `TestSSEEmitsConnectAndDisconnect` — opens + closes SSE in test, asserts both events
- [ ] write `TestSSEEmitsRSTOnAbruptClose` — close mid-stream, assert `rst_stream`
- [ ] run `go test ./internal/server/...` — must pass before Task 10

### Task 10: MCP executor emission (`mcp_call`)

- [ ] add `Reporter` dependency to `internal/mcp/proxy/` (the hook point per the design — every script call passes through the proxy)
- [ ] emit `mcp_call` with `operation` (registry slug) and `status` (`2xx`/`4xx`/`5xx`) once per registry-operation invocation
- [ ] op allowlist is the registry's existing closed set — no separate allowlist needed; reuse `registry.AllOperationSlugs()` or equivalent
- [ ] write `TestMCPProxyEmitsCallEvent` — invoke a registry op via the proxy in test, recording reporter asserts the right `operation` + `status`
- [ ] write `TestMCPProxyEmitsStatusBucket` — 4xx response from underlying handler → `mcp_call` carries `status=4xx`
- [ ] run `go test ./internal/mcp/...` — must pass before Task 11

### Task 11: HTTP write-handler emission (`feature_used`)

- [ ] in each `internal/server/*_handler.go` write handler (BP create, weight create, med confirm/skip via web, food add, workout actions, diary create), emit `feature_used` after a successful domain-service call
- [ ] reuse the same `action` values as `bot_action` where the action exists on both surfaces (so the dashboard can compare apples-to-apples)
- [ ] do NOT emit `feature_used` from HTTP READ handlers (they're already counted via `http_request` middleware)
- [ ] do NOT emit on domain-service error (telemetry tracks completed actions)
- [ ] write `TestHTTPWriteHandlerEmitsFeatureUsed` table-driven across all write handlers
- [ ] write `TestHTTPReadHandlerDoesNotEmitFeatureUsed` — sanity check
- [ ] run `go test ./internal/server/...` — must pass before Task 12

### Task 12: Wire reporter into `cmd/bot/main.go` + startup deployment event

- [ ] read `TELEMETRY_ENABLED`, `TELEMETRY_ENDPOINT`, `TELEMETRY_INSTANCE_ID` env vars at startup
- [ ] construct `telemetry.Reporter` via `NewReporter(cfg, settingsRepo)` once; inject the same instance into bot, scheduler, HTTP server, MCP proxy
- [ ] register `POST /api/telemetry/event` on the API mux; wrap the mux with the telemetry middleware
- [ ] after server starts, call `reporter.TrackDeployment(version, runtime.Version(), runtime.GOOS)` once
- [ ] on graceful shutdown, call `reporter.Shutdown(ctx)` before closing the DB
- [ ] write `TestCmdBotWiringNoOpWhenDisabled` — boot with `TELEMETRY_ENABLED=false`, assert zero outbound HTTP calls during a full lifecycle (bot callback + scheduler fire + HTTP request)
- [ ] write `TestCmdBotWiringEmitsDeploymentOnStartup` — boot with telemetry enabled and a fake Vince server, assert `deployment` event arrives within 10s
- [ ] run `go test ./cmd/bot/...` — must pass before Task 13

### Task 13: Installer change — provision `TELEMETRY_INSTANCE_ID` at install

- [ ] update [docs/installer.md](../installer.md) — add a step to generate `TELEMETRY_INSTANCE_ID=$(openssl rand -hex 8)` and write it to `.env`
- [ ] do NOT default `TELEMETRY_ENABLED=true` — opt-in stays implicit
- [ ] write `TestInstallerProvisionsInstanceID` if installer is testable (otherwise document in Post-Completion for manual verification)
- [ ] run any installer tests — must pass before Task 14

### Task 14: Bootstrap flag (`telemetry_enabled`)

- [ ] add `telemetry_enabled bool` to the `/api/bootstrap` response struct
- [ ] populate from `Reporter.Enabled()` (new public accessor on Reporter)
- [ ] do NOT expose endpoint, instance ID, or any other telemetry config to the browser
- [ ] write `TestBootstrapExposesTelemetryFlag` — both enabled and disabled cases
- [ ] write `TestBootstrapDoesNotExposeTelemetrySecrets` — endpoint, instance ID never present in response body
- [ ] run `go test ./internal/server/...` — must pass before Task 15

### Task 15: Frontend `telemetry.js` module

- [ ] create `web/static/js/features/telemetry.js`
- [ ] define `window.trackScreenView(screen)` — sends `{name: "pageview", url: "/screen/<screen>", props: {screen}}` via `navigator.sendBeacon('/api/telemetry/event', ...)`
- [ ] define `window.trackFeatureUsed(action)` — sends `{name: "feature_used", props: {action}}` via sendBeacon
- [ ] both functions silent-no-op if `window.bootstrap?.telemetry_enabled !== true`
- [ ] add the two new globals to `tests/architecture.globals.test.js` allowlist with justification
- [ ] modify `web/static/js/features/bootstrap.js` (or equivalent) to conditionally load `telemetry.js` only when `bootstrap.telemetry_enabled === true`
- [ ] verify service worker (`web/static/sw.js`) does NOT import or call `telemetry.js`
- [ ] write Vitest unit test for `telemetry.js`: pageview shape, feature_used shape, no-op when disabled, sendBeacon called once per call
- [ ] write `TestServiceWorkerHasNoTelemetryImports` (grep-based in arch test) — sw.js source contains no reference to `trackScreenView`, `trackFeatureUsed`, or `/api/telemetry/event`
- [ ] run `pnpm test` — must pass before Task 16

### Task 16: Frontend emission hooks across feature modules

- [ ] hook `window.trackScreenView(screen)` calls into the navigation/section-switch code path (bottom nav handler — see CLAUDE.md §6); call with the `screen` id (`today`, `bp`, `food`, `meds`, `health`, `workouts`, `weight`, `settings`)
- [ ] hook `window.trackFeatureUsed(action)` into the *commit* branch of each `DataStore.applyOptimistic` write (NOT the optimistic-paint branch) for: `bp_logged`, `weight_logged`, `med_confirmed`, `med_skipped`, `food_manual`, `food_photo`, `food_barcode`, `workout_started`, `workout_completed`, `diary_note_created`
- [ ] do NOT emit on rollback (rollback means the action didn't actually happen)
- [ ] write Vitest integration tests in each owning feature suite (per CLAUDE.md §8) asserting the emission fires on commit and does NOT fire on rollback
- [ ] run `pnpm test` — must pass before Task 17

### Task 17: Verify acceptance criteria

- [ ] verify all design-doc events flow end-to-end against a local fake Vince (custom `httptest.Server`) — one integration test under `internal/telemetry/integration_test.go` that exercises every event name
- [ ] verify `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` still passes
- [ ] verify `TestDoseTimeColumnsAreInteger` still passes (our telemetry timestamp column is in `settings`, not an `intake_log`-shaped table, so should be unaffected — confirm)
- [ ] run `go test ./...` — full backend suite
- [ ] run `pnpm test` — full frontend suite
- [ ] run linter (`go vet ./...`, plus whatever the project uses) — fix all issues
- [ ] verify boot with `TELEMETRY_ENABLED=false` produces zero outbound HTTP to any telemetry endpoint (run `go run ./cmd/bot` with a wrapping HTTP proxy that fails on unexpected hosts, if practical; otherwise documented manual verification)

## Technical Details

### Event contract (recap from architecture doc)

```json
{
  "name": "pageview" | "http_request" | "feature_used" | "bot_action" | "mcp_call" | "scheduler_action" | "sse_event" | "deployment",
  "url":  "https://telemetry.example.com/<path-shaped>",
  "domain": "telemetry.example.com",
  "props": {
    "instance": "<install-time hex>",
    "schema": "1",
    "<event-specific-keys>": "..."
  }
}
```

Outbound headers: `Content-Type: application/json`, `User-Agent: medtracker/<version>`. **No `X-Forwarded-For`.**

### Time storage

The new deployment-dedup timestamp column is `INTEGER` unix-seconds-UTC, per CLAUDE.md "Time storage." Lives in the `settings` package, not `intake_log`-shaped, so does NOT need adding to the `dose-time-columns` allowlist in `store_time_invariants_test.go`.

### Domain-service rule

Domain services in `internal/domain/` are forbidden from emitting telemetry. Emission lives at the transport boundary: `internal/bot/*` for `bot_action`, `internal/server/*` for `feature_used` and `http_request`, `internal/scheduler/*` for `scheduler_action`, `internal/mcp/proxy/` for `mcp_call`, the SSE handler for `sse_event`. This is what preserves the bot-vs-web split in the dashboard.

### MCP coverage

`POST /api/telemetry/event` is exempt (not registry-registered). Reason text in `mcp_coverage_exempt.go` must say: "Telemetry intake; no user-actionable semantics; never readable by MCP."

## Post-Completion

*Items requiring manual intervention or external systems.*

**Maintainer-side Vince setup** (one-time, on the central Vince host):

- Register `telemetry.example.com` (the synthetic site domain — substitute the actual domain) as a site in Vince admin. Without this, Vince returns `202` but discards events (`x-plausible-dropped: 1`).
- Configure each custom event name (`http_request`, `feature_used`, `bot_action`, `mcp_call`, `scheduler_action`, `sse_event`, `deployment`) as a Goal so it appears in the "Top events" panel.
- Set Vince's retention to 2 years (Pebble retention setting or periodic prune job) to match the public commitment in TELEMETRY.md.

**Manual smoke test against the real Vince**:

- Boot the bot locally with `TELEMETRY_ENABLED=true TELEMETRY_ENDPOINT=https://<real-vince-host>`.
- Navigate to a few screens, log a BP reading via web and via bot, fire a scheduler event manually.
- Confirm events arrive in the Vince dashboard within ~10s; confirm `pageview` lands in Top Pages, `bot_action` and `feature_used` separately in Top events.
- Confirm with `TELEMETRY_ENABLED=false` that no outbound HTTP calls are made (use `tcpdump` or a wrapping proxy).

**External / privacy review**:

- Self-review the final wire shape against the "What Is NEVER Collected" table in TELEMETRY.md before shipping the first release with this code.
