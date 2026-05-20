# Local-only mode foundation: build tags + Capacitor spike

## Overview

Lay the Go-side groundwork to compile this codebase into a "local-only mode" mobile app via Capacitor, and prove the wrapping works with a minimal spike. The goal is a build-tag boundary (`//go:build mobile`) that strips Telegram bot / MCP / web-push / OIDC / external auth out of the binary, replaces the scheduler's web-push sink with one that hands reminders to the frontend (where Capacitor's `LocalNotifications` plugin schedules them natively), and replaces env-var configuration with a Settings table read at startup. The Capacitor spike wraps `web/static/` and points the webview at the existing deployed server (not the embedded Go binary yet) — proving the wrapper works before committing to native plugin work.

Three properties drop out by construction:
- **Domain services are reused unchanged.** `internal/domain/*`, `internal/store/*`, HTTP handlers, frontend code — none of these get tagged. The mobile app becomes a third transport (localhost HTTP) sitting next to web and Telegram, with no duplicated business logic.
- **The server build is unchanged behaviorally.** Every refactor (Config struct, scheduler sink interface, settings-as-config fallback) is a no-op on master before the mobile build tag exists. Server users see no regression; the new settings UI is a quality-of-life add.
- **The mobile build doesn't block on Capacitor work.** Phases 1–7 land a working `go build -tags mobile ./...` regardless of whether the Capacitor spike (Phase 8) succeeds. Steps are independently shippable.

Out of scope: embedding the Go binary inside Capacitor (deferred until the spike validates wrapping works), Camera/Barcode/Geolocation native plugin abstractions (deferred to Phase 2 plan), Apple/Google store submission, push notification scheduling from Go on mobile (the sink returns reminders; the JS bridge to `LocalNotifications` is Phase 2).

## Context (from discovery)

**Files/components involved:**
- `cmd/bot/main.go` — env reads at lines 35–263 (DB_PATH, TELEGRAM_BOT_TOKEN, OPENAI_*, VAPID_*, OIDC/Google, MCP_AUDIT_SECRET, etc.)
- `internal/ai/openai.go` — already env-free; takes `(apiKey, apiURL, model)`. Clean swap target.
- `internal/server/elevenlabs_handlers.go:35-36,102` — reads `ELEVENLABS_*` at request time (must migrate)
- `internal/store/food/openfoodfacts_api.go:29-43` — reads `FOOD_*` at request time (must migrate)
- `internal/server/server.go:203-1005` — env reads, mostly startup-time (auth/OIDC/domain config)
- `internal/scheduler/` — current web-push reminder scheduler; needs `ReminderSink` interface extraction
- `internal/server/server.go` (auth section) + Telegram `initData` parsing — needs `UserResolver` abstraction so mobile build can substitute a fixed-local-user impl
- `internal/store/settings/repo.go` — global singleton-row Repo; the right home for new config keys (openai_*, food_*, elevenlabs_*)
- `.github/workflows/golangci-lint.yml`, `frontend-tests.yml` — need a `-tags mobile` matrix entry
- `go.mod` — already uses `modernc.org/sqlite v1.42.2` (no CGO). Mobile cross-compile path is clear.

**Related patterns found:**
- Domain service pattern is already strictly enforced (`internal/domain/*` + tests). The third "transport" (mobile localhost) needs no new pattern — it reuses the existing HTTP transport unchanged.
- Build-tag paired files (`foo_server.go` // `foo_mobile.go`) keep diffs surgical; CI matrix catches drift.
- Settings repo is global/singleton, not per-user — matches a single-user mobile install.
- MCP coverage guard (`TestMCPCoverage_AllRoutesEitherRegisteredOrExempt`) will require new settings-config routes to be registered or exempted.

**Dependencies identified:**
- `modernc.org/sqlite` (pure Go, already in tree)
- Capacitor 6.x for the spike: `@capacitor/core`, `@capacitor/cli`, `@capacitor/ios`, `@capacitor/android`
- No new Go dependencies expected for Phase 1.

## Development Approach

- **Testing approach**: Regular (code first, then tests). Matches the repo's pattern; the refactor-heavy nature of Tasks 1–6 makes TDD slower without enough payoff.
- Complete each task fully before moving to the next.
- Make small, focused changes — each task is one logical unit.
- **CRITICAL: every task MUST include new/updated tests.** Tests are not optional; they are required deliverables.
- **CRITICAL: all tests must pass before starting next task** — both `go test ./...` and `go build -tags mobile ./...` (once Task 6 introduces the tag).
- **CRITICAL: update this plan file when scope changes during implementation.**
- Run tests after each change.
- Maintain server-mode backward compatibility — no behavioral change for existing deployments.

## Testing Strategy

- **Unit tests**: required for every task per repo convention (Go std `testing`, table-driven where natural).
- **Integration tests**: Settings UI handlers go through the existing HTTP handler test pattern (`internal/server/*_test.go`). Frontend changes for the Settings UI section use Vitest via `tests/helpers/frontend-harness.js` (integration-first, per CLAUDE.md rule 8).
- **Build-tag test**: after Task 6, every CI run must `go build -tags mobile ./...` cleanly. After Task 7, the matrix runs it automatically.
- **No new e2e tests**: this project does not use Playwright/Cypress.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with `➕` prefix.
- Document issues/blockers with `⚠️` prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): Go refactors, Settings UI, build-tag files, CI matrix, Capacitor spike scaffold — all in this repo.
- **Post-Completion** (no checkboxes): on-device testing of the Capacitor spike in iOS Simulator / Android emulator; deciding whether to proceed with Phase 2 (embed Go binary + native plugin abstractions).

## Implementation Steps

### Task 1: Extract `internal/config` package with `Config` struct
- [x] create `internal/config/config.go` with a `Config` struct holding all current env-derived values: `DBPath`, `Port`, `SessionSecret`, `TelegramBotToken`, `AllowedUserID`, `OpenAI` (sub-struct: `APIKey`, `URL`, `Model`, `VisionAPIKey`, `VisionURL`, `VisionModel`), `Food` (sub-struct: `APIKey`, `URL`, `Domain`), `ElevenLabs` (sub-struct: `APIKey`, `AgentID`), `VAPID` (sub-struct), `OIDC` (sub-struct), `MCP` (sub-struct), `ExternalWorkoutAPIKey`, `AppDomain`.
- [x] add `LoadFromEnv() (*Config, error)` that performs the same env reads currently in `cmd/bot/main.go:35-263` (preserve exact semantics — including `TELEGRAM_API_ENDPOINT`, `POCKET_ID_*` fallback paths, `DOMAIN`/`APP_DOMAIN` ordering).
- [x] refactor `cmd/bot/main.go` to call `LoadFromEnv()` once and pass `Config` (or relevant sub-structs) into wiring functions — no behavioral change.
- [x] migrate `internal/server/elevenlabs_handlers.go:35-36,102` to read `ElevenLabs` from an injected `*Config` (or a narrower `ElevenLabsConfig`-style interface) instead of `os.Getenv`. Same for `internal/store/food/openfoodfacts_api.go:29-43`.
- [x] write tests in `internal/config/config_test.go` for `LoadFromEnv` — table-driven cases covering all env vars, fallback paths (`OIDC_*` falling back to `POCKET_ID_*`), and missing/empty handling.
- [x] write tests for the elevenlabs and food handlers verifying they use the injected config (table-driven: configured vs unconfigured).
- [x] run `go test ./...` — must pass before Task 2.

### Task 2: Add user-configurable keys to `settings` repo + env-or-settings merge
- [ ] add migration in `internal/store/migrations/` introducing config rows in the singleton settings table for: `openai_api_key`, `openai_url`, `openai_model`, `openai_vision_api_key`, `openai_vision_url`, `openai_vision_model`, `food_api_key`, `food_url`, `food_domain`, `elevenlabs_api_key`, `elevenlabs_agent_id`. Default all to NULL/empty.
- [ ] add Getter/Setter methods on `internal/store/settings/repo.go` for each key group (e.g. `GetOpenAIConfig(ctx) (OpenAIConfig, error)`, `SetOpenAIConfig(ctx, OpenAIConfig) error`). Keep types defined in `internal/config` to avoid an import cycle — settings repo returns plain strings, `Config` does the assembly.
- [ ] add `internal/config.LoadFromSettings(ctx, settingsRepo) (*Config, error)` that reads the user-configurable subset from settings.
- [ ] add `internal/config.Merge(env *Config, fromSettings *Config) *Config` — env wins when set, else settings, else zero-value. Document the precedence in a package comment.
- [ ] wire the merge into `cmd/bot/main.go` after settings repo is constructed: `cfg = config.Merge(envCfg, settingsCfg)`.
- [ ] write tests for the new settings methods (round-trip, empty handling).
- [ ] write tests for `Merge` — table-driven covering env-only, settings-only, both-present (env wins), neither.
- [ ] run `go test ./...` — must pass before Task 3.

### Task 3: Settings UI for AI / Food / Voice Agent providers
- [ ] add `GET /api/settings/integrations` and `PATCH /api/settings/integrations` handlers in `internal/server/` returning/accepting the OpenAI, Food, ElevenLabs config groups. Mask secret values on GET (return `***` for set, empty for unset).
- [ ] register the new routes in the MCP operation registry under `internal/mcp/registry/operations_settings.go` (or add to `mcp_coverage_exempt.go` with a `Reason: "user-editable integration settings, not a domain action"`).
- [ ] add a "Providers" or "Integrations" section to the frontend Settings screen (`web/static/js/features/settings/` — locate the existing settings entry point and follow its pattern). Fields: OpenAI API key / URL / model, Vision overrides (collapsible), Food DB API key / URL / domain, ElevenLabs API key / Agent ID.
- [ ] use `DataStore.applyOptimistic` for the save handler per CLAUDE.md rule 9.
- [ ] no inline `.style.` assignments, no hardcoded colors — use `--wg-*` tokens per CLAUDE.md rule 3.
- [ ] write Go handler tests in `internal/server/` (table-driven: GET masks secrets, PATCH persists, PATCH with invalid body returns 4xx).
- [ ] write Vitest integration test extending the existing settings feature suite (assert section renders, fields populate from API, save calls applyOptimistic).
- [ ] run `go test ./...` and `pnpm test` — must pass before Task 4.

### Task 4: Define `scheduler.ReminderSink` interface
- [ ] create `internal/scheduler/sink.go` with `type ReminderSink interface { Schedule(ctx, Reminder) error; Cancel(ctx, id string) error; ... }` — derive the method set from the existing web-push call sites in `internal/scheduler/`.
- [ ] refactor the existing web-push scheduling code into `internal/scheduler/sink_webpush.go` implementing `ReminderSink`. Keep it tag-free for now — Task 6 adds the `!mobile` tag.
- [ ] change scheduler constructors to take a `ReminderSink` parameter; `cmd/bot/main.go` constructs the `WebPushSink` and passes it in.
- [ ] write tests for `WebPushSink` (it's now isolatable) — table-driven covering schedule success, cancel, error propagation.
- [ ] write a fake `ReminderSink` in `internal/scheduler/sink_test.go` for use by scheduler tests; assert the scheduler calls `Schedule`/`Cancel` at the right points.
- [ ] run `go test ./...` — must pass before Task 5.

### Task 5: Define `UserResolver` abstraction for auth
- [ ] identify the current "who is the current user?" call sites (likely `internal/server/server.go` middleware around `initData` parsing and session/OIDC lookup). Document them inline in a comment in the new file.
- [ ] create `internal/server/auth/resolver.go` with `type UserResolver interface { Resolve(r *http.Request) (UserID, error) }` (or similar minimal contract — fit it to the existing auth middleware shape, don't invent new ceremony).
- [ ] refactor the existing auth middleware into a `TelegramOIDCResolver` implementing `UserResolver`. Keep it tag-free; Task 6 adds the `!mobile` tag.
- [ ] inject the resolver into the auth middleware via the existing server constructor.
- [ ] write tests for `TelegramOIDCResolver` covering each existing auth path (initData, session cookie, OIDC).
- [ ] write a fake `UserResolver` for handler tests if not already trivially constructable.
- [ ] run `go test ./...` — must pass before Task 6.

### Task 6: Add `//go:build mobile` paired files
- [ ] split `cmd/bot/main.go` into `main_server.go` (`//go:build !mobile`, current wiring) and `main_mobile.go` (`//go:build mobile`, skips bot init, MCP init, web-push init, OIDC init, ElevenLabs handlers if undesired on mobile). Mobile main constructs `LocalNotificationSink` (stub for now — exposes upcoming reminders via a new HTTP endpoint `GET /api/reminders/upcoming` for the JS bridge in Phase 2) and `LocalUserResolver` (fixed user ID 1 or read from a `--user-id` argv flag).
- [ ] create `internal/scheduler/sink_webpush.go` with `//go:build !mobile` (move existing impl) and `internal/scheduler/sink_localnotifications.go` with `//go:build mobile` (stub: returns upcoming reminders for HTTP retrieval rather than pushing).
- [ ] create `internal/server/auth/resolver_telegram.go` with `//go:build !mobile` (move existing `TelegramOIDCResolver`) and `internal/server/auth/resolver_local.go` with `//go:build mobile` (single-user resolver).
- [ ] tag any tests that depend on bot/MCP/web-push internals with `//go:build !mobile` to keep mobile test builds compiling (`go test -tags mobile ./...` should not fail on missing types).
- [ ] add `GET /api/reminders/upcoming` handler returning the next N reminders for the local-notifications JS bridge; register in MCP coverage (registry or exempt).
- [ ] verify locally: `go build ./...` (server) and `go build -tags mobile ./...` (mobile) both succeed.
- [ ] write tests for `LocalUserResolver` and the upcoming-reminders endpoint.
- [ ] write a mobile-tag test (`//go:build mobile`) asserting the mobile main's wiring is correct (or at minimum that the build compiles, which the build itself proves).
- [ ] run `go test ./...` and `go test -tags mobile ./...` — both must pass before Task 7.

### Task 7: CI matrix entry for `-tags mobile`
- [ ] add a matrix entry to `.github/workflows/golangci-lint.yml` (or a new `.github/workflows/go-mobile-build.yml` if cleaner) that runs `go build -tags mobile ./...` and `go test -tags mobile ./...`.
- [ ] verify the workflow runs green on a draft PR before merging.
- [ ] update the existing build/test workflow to also run the non-mobile path explicitly (no behavior change, but makes the matrix explicit).
- [ ] no new tests in this task — the CI run *is* the test.

### Task 8: Capacitor spike — wrap existing PWA, point at deployed server
- [ ] scaffold a `capacitor/` subdirectory at repo root: `npx @capacitor/cli init medtracker com.korjavin.medtracker`. Configure `webDir` to point at `../web/static` (or a built bundle).
- [ ] add `@capacitor/ios` and `@capacitor/android` platforms (`npx cap add ios`, `npx cap add android`). Add `capacitor/` to `.gitignore` for `node_modules/`, `ios/Pods/`, `android/build/`.
- [ ] in `capacitor/capacitor.config.ts`, set `server.url` to a local dev value (e.g. `http://localhost:8080`) with a comment explaining this is the spike configuration — production wiring (embedded Go) is Phase 2.
- [ ] add a top-level `capacitor/README.md` (small) with the build commands: `npx cap sync`, `npx cap open ios`, `npx cap open android`. Document how to point `server.url` at a running `go run ./cmd/bot` for local testing.
- [ ] verify the iOS Simulator build loads the PWA and that core features work (login flow may fail in spike — that's fine, document it as a known limitation for Phase 2).
- [ ] no Go test changes; the spike is a wrapper exercise.

### Task 9: Verify acceptance criteria
- [ ] verify `go build ./...` and `go build -tags mobile ./...` both succeed.
- [ ] verify `go test ./...` and `go test -tags mobile ./...` both pass.
- [ ] verify `pnpm test` passes.
- [ ] verify `golangci-lint run ./...` is clean.
- [ ] verify MCP coverage test (`TestMCPCoverage_AllRoutesEitherRegisteredOrExempt`) passes — every new route registered or exempt.
- [ ] verify the dose-time-columns invariant test still passes (we add no new dose-like columns, but sanity-check).
- [ ] verify the Settings UI section renders, accepts edits, and persists across reload — manual check via browser.
- [ ] verify the Capacitor spike loads the PWA in iOS Simulator pointing at `localhost:8080`.

### Task 10: [Final] Update documentation
- [ ] update `CLAUDE.md` with a brief mention of the `//go:build mobile` boundary and the env-or-settings config layering (one bullet each under "Critical Rules" or a new "Build modes" subsection), and link to `docs/local-mode.md`.
- [ ] update `docs/environment.md` to note that user-configurable keys (OpenAI, Food, ElevenLabs) now also read from the settings table as a fallback.
- [ ] update `docs/architecture.md` with a short subsection on the mobile build boundary and where the tagged files live; link to `docs/local-mode.md` for rationale.
- [ ] update `docs/local-mode.md` (already created with design rationale + Phase 2 hooks): flip the status banner from "Phase 1 in progress" to "Phase 1 complete", add concrete build/run commands for the mobile binary and the Capacitor spike, and update any sections where Phase 1 implementation revealed corrections to the original design notes.
- [ ] update `docs/technical-decisions.md` with the choice of build tags over runtime flags (compile-time guarantee, smaller binary, dead-path elimination), linking to `docs/local-mode.md` for the full reasoning.
- [ ] no test changes.

*Note: ralphex automatically moves completed plans to `docs/plans/completed/`*

## Technical Details

**Build tag boundary (final state after Task 6):**

```
cmd/bot/
  main_server.go              //go:build !mobile   wires bot + MCP + web-push + OIDC
  main_mobile.go              //go:build mobile    skips them; local user; reminder endpoint

internal/scheduler/
  sink.go                                          ReminderSink interface (tag-free)
  sink_webpush.go             //go:build !mobile   current behavior
  sink_localnotifications.go  //go:build mobile    returns upcoming reminders for JS bridge

internal/server/auth/
  resolver.go                                      UserResolver interface (tag-free)
  resolver_telegram.go        //go:build !mobile   initData + OIDC + session
  resolver_local.go           //go:build mobile    single fixed user

internal/config/
  config.go                                        Config struct + Merge (tag-free)
  config_test.go                                   covers LoadFromEnv + Merge

# everything else (internal/domain/*, internal/store/*, internal/server/* handlers,
# internal/ai, internal/rxnorm, web/static/*) stays tag-free.
```

**Config precedence (Task 2 `Merge`):**
1. Env var (server-mode operators' source of truth)
2. Settings table (user-edited via Settings UI; mobile's only source)
3. Built-in default (e.g. `https://api.openai.com/v1` for `OPENAI_URL`)

**Reminder bridging (Phase 2, sketched here for context):**
- Mobile build's `LocalNotificationSink` does not push at scheduling time. Instead, the scheduler writes upcoming reminders to a queue/table.
- New endpoint `GET /api/reminders/upcoming` returns next N reminders.
- The Capacitor app polls (or subscribes via change events) and hands each reminder to `@capacitor/local-notifications` to schedule natively. iOS/Android then fire the notification regardless of app state.
- Out of scope for this plan — only the sink interface and the upcoming-reminders endpoint are introduced now.

**Capacitor spike scope (Task 8):**
- Wraps `web/static/` as the webview source via `webDir` config OR uses `server.url` pointing at a running dev server.
- Does NOT embed the Go binary. That's Phase 2 (decide between `gomobile bind` and an embedded localhost HTTP server, address iOS background lifecycle).
- Does NOT add native plugin abstractions for camera/geolocation/barcode. Those are Phase 2.
- Goal: prove the wrapper builds and loads the PWA, so we know the foundational scaffolding is sound before investing in plugin work.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only.*

**Manual verification:**
- Open the Capacitor iOS spike in Xcode Simulator and walk through: login (may not work in spike; document limitation), Today view, BP entry, Food log. Note which features need native-plugin replacement in Phase 2 (camera, barcode, geolocation, local notifications).
- Verify the Android Studio build of the spike likewise.
- Confirm in a live server deployment that the Settings UI works for an admin user and that env-var precedence is preserved (env-set values override any settings-table values).

**External system updates:**
- Apple Developer account + Android keystore preparation if shipping app-store builds. Not in scope for this plan.
- Phase 2 plan creation after spike validates wrapping: covers `gomobile bind` vs embedded HTTP, native plugin JS abstractions (`MediaCapture`, `LocalNotifications`, `Geolocation`), in-app first-run Settings flow, iOS background-execution strategy for the scheduler.
