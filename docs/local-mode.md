# Local-only mode (Capacitor mobile app)

Design context for the ongoing effort to compile this codebase into a mobile app via Capacitor. This doc captures the *why* behind decisions made during planning so future phases can be planned from a warm start, not by re-deriving from first principles. Living doc — update as Phase 2 lands.

Status: **Phase 2a in progress** on Android (embedded Go binary), **Phase 2b shipped** (native plugin JS abstractions), **Phase 2c shipped** (first-run overlay + plaintext-SQLite secrets decision; real-device verification still pending). Phase 1 (Go-side foundation + Capacitor dev-server spike) shipped — plan: `docs/plans/completed/2026-05-18-local-only-mode-foundation.md`. Phase 2a plan: `docs/plans/2026-05-22-mobile-phase2a-android-go-embedding.md`. Phase 2b plan: `docs/plans/2026-05-22-mobile-phase2b-native-plugins.md` (real-device verification still pending — see Post-Completion in the plan). Phase 2c plan: `docs/plans/2026-05-23-mobile-phase2c-firstrun-secrets.md` (real-device verification still pending). Phase 2d (Keystore migration for provider secrets) is captured as a stub: `docs/plans/2026-05-23-mobile-phase2d-keystore-secrets.md`. See [Phase 2 below](#phase-2-mobile-shell--native-integration).

## Build & run

Server build (current production, unchanged):

```bash
go build ./...
go run ./cmd/bot                 # bot + web server + scheduler
go test ./...
```

Mobile build (strips bot + MCP + web-push + OIDC):

```bash
go build -tags mobile ./...
go test  -tags mobile ./...
go run   -tags mobile ./cmd/bot  # LocalUserResolver + LocalNotificationSink wired
```

Capacitor spike (wraps the PWA, points at a running dev server):

```bash
cd capacitor
npm install
npx cap add ios                  # one-time, generates ios/ — gitignored
npx cap add android              # one-time, generates android/ — gitignored
npx cap sync
npx cap open ios                 # opens Xcode; build & run in Simulator
npx cap open android             # opens Android Studio
```

The spike's `capacitor.config.ts` sets `server.url` to `http://localhost:8080` so the WebView loads from a running `go run ./cmd/bot`. Embedding the Go binary inside the app bundle is Phase 2; for now the spike validates that the wrapper builds, the PWA loads, and the SW/Dexie/optimistic-write plumbing survives the Capacitor environment. See `capacitor/README.md` for known spike limitations (Telegram `initData` auth does not flow inside the WebView).

## Phase 2a build pipeline (Android only, in progress)

Phase 2a (`docs/plans/2026-05-22-mobile-phase2a-android-go-embedding.md`) wires a real cross-compile pipeline that drops Android-native binaries into a committed overlay tree. The overlay survives `npx cap add android` regeneration:

```bash
cd capacitor
npx cap add android                        # creates capacitor/android/ (gitignored)
../scripts/build-android-binaries.sh       # populates android-overlay/.../jniLibs
./apply-overlay.sh                         # copies overlay into android/
```

`scripts/build-android-binaries.sh` writes `libmedtracker.so` to `capacitor/android-overlay/app/src/main/jniLibs/<abi>/` for each ABI it can produce. The `lib*.so` naming + `jniLibs/<abi>/` placement is what triggers Android's automatic native-library extraction at install time — the binary ends up in `nativeLibraryDir` (read-only but executable) so the shell can `Runtime.exec()` it without an assets-copy dance.

**ABI coverage (current):**

| ABI | Status | Requirement |
|---|---|---|
| `arm64-v8a` | always built | CGO-free, no NDK needed |
| `armeabi-v7a` | NDK-gated | `ANDROID_NDK_HOME` must point at an NDK with the `armv7a-linux-androideabi*-clang` wrapper |
| `x86_64` | NDK-gated | same — emulator-only target |

This asymmetry comes from the Task 1 spike: `modernc.org/sqlite` is CGO-free but the Go runtime's `runtime/cgo` package still requires external linking on `android/arm` and `android/amd64` builds. Only `android/arm64` works with `CGO_ENABLED=0`. Modern devices are all arm64, so v1 of the mobile build ships arm64-only; the other two ABIs are best-effort and produced only when the operator installs the NDK and exports `ANDROID_NDK_HOME`.

A guarded smoke test in `cmd/bot/cross_compile_test.go` (build tag `cross_compile_smoke`) shells out to the build script and asserts an ELF arm64 binary lands in the expected path:

```bash
go test -tags cross_compile_smoke ./cmd/bot
```

It's gated so the default `go test ./...` doesn't pay the ~1s cross-compile cost on every push. CI / release jobs that care about the mobile pipeline opt in.

## What local-only mode is

A build of this app that runs entirely on-device — no MCP server, no Telegram bot, no web push, no OIDC. It's the same Go binary, same SQLite schema, same domain services, same vanilla-JS frontend, wrapped in Capacitor and pointed at a localhost HTTP server bundled inside the app.

The user's data lives in the app sandbox. The server-mode deployment (current production) keeps working unchanged.

## Why we're doing it (and not something simpler)

A real native mobile app for personal health data means: works offline, no server account to set up, no privacy concerns about hosting your own VPS, immediate install from the store. The PWA route gets us most of the way but loses native notifications, native camera/barcode scanning quality, and store distribution.

## Approaches considered

Two were genuinely on the table:

### Option A: Capacitor wrapper + JS-only data layer (rejected)

Strip the Go server entirely. Replace `/api/*` calls with a JS data layer over Dexie / `@capacitor-community/sqlite`. Re-implement every domain service (intake confirm/skip, reminder snooze, food macro calc, workout rotation, scheduler, tz transition planning) in JS.

**Why rejected**: huge duplication of business logic. The frontend's offline-first plumbing is already strong (SW, Dexie, optimistic writes via `DataStore.applyOptimistic`), but the *domain* logic in `internal/domain/*` and `internal/store/workout/`, `internal/store/tz/`, etc. is non-trivial. Forking it into JS would mean bug fixes in two languages, divergent behavior over time, and writing a second test suite. The architectural enforcement (bot and HTTP must share domain services) would die at the JS boundary.

### Option B: Go sidecar inside Capacitor (chosen)

Bundle the Go binary inside the Capacitor app, start it on app launch, expose it on `127.0.0.1:<port>`, point the WebView at that. Same Go code, third transport (localhost HTTP) sitting next to web and Telegram.

**Why chosen**:
- Behavioral parity is structural, not aspirational. Fixes flow to both.
- The codebase already enforces "transports must share the domain service" — mobile becomes a third transport with zero new business-logic layer.
- `internal/ai/openai.go` is already env-free (takes params); `modernc.org/sqlite` is already CGO-free (mobile cross-compile is straightforward); `Repos` aggregator is wired identically across `cmd/bot`, `cmd/mcptool`, `cmd/seeddemo`, `cmd/bpimporter` — adding a fourth (mobile) wiring is a known pattern.
- The places where this approach *frays* (scheduler under iOS backgrounding, env vars, auth) are tractable with thin abstractions — see Phase 1 below.

**Known costs**:
- iOS background-execution is restrictive — the scheduler can't tick reliably when backgrounded. Solved by handing scheduled reminders to the OS via `@capacitor/local-notifications` instead of relying on the Go scheduler to wake up.
- Go binary adds ~15–25 MB to the app bundle. Acceptable.
- App Store policy permits embedded localhost servers (many apps do this) as long as the port is not externally reachable.

## Phase 1: Go-side foundation + Capacitor spike (current plan)

Plan: `docs/plans/2026-05-18-local-only-mode-foundation.md`

Goal: a clean compile-time boundary that strips server-only subsystems and substitutes mobile-appropriate ones, and a Capacitor spike proving the wrapper works. **No Go binary embedding yet** — the spike points at the existing deployed server. We validate wrapping before investing in plugin work.

### Build tag, not runtime flag

`//go:build mobile` versus runtime `--mode=local` was an explicit choice:

- **Smaller binary, no dead paths.** The mobile build strips Telegram bot, MCP server, web-push, and OIDC entirely. No risk that a stale env var or misrouted call accidentally wakes the Telegram client inside the iOS sandbox.
- **Compile-time guarantee.** If something in `internal/bot` accidentally references a mobile-only symbol (or vice versa), the build fails. Runtime flags would let that drift unnoticed.
- **Paired files + CI matrix** keeps drift visible. Every PR runs `go build -tags mobile ./...`.

### What's tagged vs untagged

| Component | Tag-touched? |
|---|---|
| `internal/domain/*`, `internal/store/*` | No — shared unchanged |
| HTTP handlers in `internal/server/*` (except auth resolver and elevenlabs/openfoodfacts) | No |
| Frontend `web/static/*` | No |
| `internal/ai`, `internal/rxnorm`, `internal/webpush`, `internal/tzlookup` | No |
| `cmd/bot/main_{server,mobile}.go` | Yes — wiring differs |
| `internal/scheduler/sink_{webpush,localnotifications}.go` | Yes — sink impl differs |
| `internal/server/auth/resolver_{telegram,local}.go` | Yes — auth source differs |

The point is: the tagged surface is small enough to read in one sitting. Domain logic, store, and handlers stay untouched.

### Config layering (env → settings → default)

Mobile has no env vars. Server has them. The merge:

1. **Env** wins when set (server operators' source of truth, preserves current behavior).
2. **Settings table** is the fallback (user-editable via the new Settings UI; on mobile, this is the only source).
3. **Built-in default** (e.g. `https://api.openai.com/v1`).

`internal/config.LoadFromEnv()` returns env-derived config. `internal/config.LoadFromSettings(ctx, settingsRepo)` returns settings-derived config. `Merge(env, settings)` produces the final `*Config`. Server build does both and merges; mobile build only does the second.

Pre-loaded at startup, not lazy-resolved per request. Settings changes require restart — acceptable MVP behavior, simpler call sites, and the env-or-settings merge logic only runs once.

**Categorization of env vars:**

| Bucket | Vars | Mobile fate |
|---|---|---|
| Strip on `mobile` build | `TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_ID`, `MCP_*`, `POCKET_ID_*`, `OIDC_*`, `GOOGLE_*`, `VAPID_*`, `EXTERNAL_WORKOUT_API_KEY`, `MCP_AUDIT_SECRET` | Not compiled in |
| Bootstrap via argv | `DB_PATH`, `PORT`, `TZ`, `SESSION_SECRET` (generated on first run, persisted) | Set by Capacitor shell at launch |
| Settings table + UI | `OPENAI_API_KEY`/`URL`/`MODEL`, `OPENAI_VISION_*`, `FOOD_API_KEY`/`URL`/`DOMAIN`, `ELEVENLABS_*` | First-run setup screen |

The request-time env readers (`internal/server/elevenlabs_handlers.go:35-36,102`, `internal/store/food/openfoodfacts_api.go:29-43`) are migrated to read from the injected `*Config` in Phase 1 Task 1 — they're the only handlers that read env at request time rather than startup, and that asymmetry is worth eliminating regardless of mobile.

### Scheduler sink interface

`internal/scheduler.ReminderSink` is the seam. Server build's `WebPushSink` continues current behavior. Mobile build's `LocalNotificationSink` is a stub that **does not push** — instead it writes upcoming reminders to a queue, and a new endpoint `GET /api/reminders/upcoming` returns the next N to the frontend, which hands them to `@capacitor/local-notifications`. iOS/Android then fire the notification regardless of app state.

Phase 1 builds the sink interface and the endpoint. The JS bridge that actually calls `@capacitor/local-notifications` is Phase 2.

### Auth resolver

Server has multiple auth paths (Telegram `initData`, OIDC, session cookie). Mobile is single-user, no auth ceremony. `UserResolver` interface with `TelegramOIDCResolver` (`!mobile`) and `LocalUserResolver` (`mobile`) — the latter returns a fixed user ID 1 or whatever the argv flag specifies.

### Capacitor spike scope

Phase 1's Task 8 wraps `web/static/` and points the WebView at a running dev server (or the deployed production server). It does *not* embed the Go binary. Decision deferred to Phase 2 (see below). The spike proves the scaffolding works before we invest in plugin work or background-execution gymnastics.

## Phase 2: Mobile shell + native integration

Phase 2 is split into three plans, landing in order:

- **Phase 2a — Android Go-binary embedding** (in progress). Plan: `docs/plans/2026-05-22-mobile-phase2a-android-go-embedding.md`. Spawns the mobile-build binary inside the Capacitor Android shell, parses `LISTENING 127.0.0.1:<port>` from stdout, loads the WebView from that port. iOS deferred to a follow-up. See "Phase 2a build pipeline" above and "Go binary embedding: settled decision" below.
- **Phase 2b — Native plugin abstractions** (shipped — JS + plugin install + AndroidManifest overlay; real-device verification pending). Plan: `docs/plans/2026-05-22-mobile-phase2b-native-plugins.md`. Camera, geolocation, barcode, local notifications shims selected at runtime via `Capacitor.isNativePlatform()`. See "Native plugin JS abstractions" below.
- **Phase 2c — First-run setup + secrets storage** (shipped — overlay + endpoint + SQLite-plaintext decision; real-device APK verification still pending). Plan: `docs/plans/2026-05-23-mobile-phase2c-firstrun-secrets.md`. Four-screen overlay (welcome → permissions → integrations → done), fully skippable, gated on `bootstrap.needs_first_run`. See "First-run Settings flow" + "Secrets storage" + "First-run user provisioning" below.
- **Phase 2d — Keystore migration for provider secrets** (stub, deferred). Plan: `docs/plans/2026-05-23-mobile-phase2d-keystore-secrets.md`. Moves OpenAI / Food DB / ElevenLabs keys out of the SQLite `settings` table into Android `EncryptedSharedPreferences` (and iOS Keychain when iOS ships); the frontend reads on session start and forwards via headers. Re-evaluated after Phase 2c bakes on a real device for at least a week.

This section captures what's known about each sub-phase so the remaining plans can be written without re-deriving.

### Go binary embedding: settled decision

Two ways to get the Go binary running inside Capacitor:

**Option 2a-i: `gomobile bind`.** Compile Go as a static library (`.aar` for Android, `.framework` for iOS), call exported Go functions from native code via a bridge. Pros: cleaner integration, no port management, no HTTP overhead. Cons: every Go API needs a native bridge wrapper; the existing HTTP handler architecture would need to be re-exposed as Go function calls; iOS/Android native bridge code becomes part of the surface area.

**Option 2a-ii: Embedded localhost HTTP server (chosen).** Compile Go as a binary, ship it as a resource in the app bundle, spawn it on app launch, WebView talks to `http://127.0.0.1:<port>` exactly like the dev environment. Pros: zero changes to the existing HTTP/handler architecture; frontend code is identical to the deployed server case. Cons: native shell needs to manage the Go process lifecycle (start, stop on backgrounding, restart on foreground); port collisions need handling; minor battery cost from a running process.

**Phase 2a picked 2a-ii** on the structural grounds that embedded HTTP preserves the "transports share domain services" invariant (`gomobile bind` would force every endpoint to be duplicated in Kotlin/Swift glue), and that the cross-compile toolchain already works for `android/arm64` without an NDK. Full decision memo lives in the Phase 2a plan under "Spike outcome". The transport invariant is the load-bearing constraint — if a future Android policy change forces a switch to `gomobile bind`, the plan is to extract the HTTP contract into a generated client (OpenAPI or similar) first, so the two-places-to-update problem is solved at the contract layer rather than at the call sites.

### Native plugin JS abstractions

The web stack and Capacitor diverge on four capabilities; Phase 2b ships a JS abstraction layer at `web/static/js/native/` with two implementations per capability, selected at runtime via `Capacitor.isNativePlatform()`. Backend handlers (food upload, barcode lookup, reminder endpoint) are identical across both transports.

| Capability | Global | Web impl | Capacitor impl |
|---|---|---|---|
| Geolocation | `window.Geolocation` | `navigator.geolocation` | `@capacitor/geolocation` (last-known cache, 1h TTL) |
| Camera + photo picker (food photos) | `window.MediaCapture` | `<input type=file>` / `getUserMedia` | `@capacitor/camera` |
| Barcode scanning (food log) | `window.Barcode` | `BarcodeDetector` (Chrome only) / ZXing JS | `@capacitor-mlkit/barcode-scanning` |
| Local notifications (reminders) | `window.Reminders` | no-op shim (Web Push handled by `push.js`) | `@capacitor/local-notifications` |

**Runtime selector pattern** — each capability has a `web/<capability>.js` and a `capacitor/<capability>.js` module. The foundation module (`web/static/js/native/index.js`) exposes `registerImpl(capability, platform, impl)`; each impl file registers itself, and the foundation assigns the matching one to the global based on `isNativePlatform()`. Capacitor modules read plugins via `window.Capacitor.Plugins.*` rather than ES-module `import`, so no JS bundler is required — the existing script-tag load order in `index.html` is sufficient. In a pure-browser build where the plugins aren't loaded, the foundation simply never wires the Capacitor impl as the active global.

**Reminder pre-schedule loop** — `window.Reminders.startPreScheduleLoop()` (Capacitor only) polls `GET /api/reminders/upcoming?hours=24`, hands the queue to `@capacitor/local-notifications`, and re-runs on `App.addListener('appStateChange', ...)`. Replace-all semantics: every resume cancels all pending notifications via `LocalNotifications.getPending()` + `cancel(ids)` and reschedules the new batch. Simpler than diffing; the sub-second cancel/reschedule window is the cost we accept. Notification taps deliver `extra.intake_id`, which the deep-link handler in `capacitor/reminders.js` feeds into the existing `handleDeepLinks()` routing surface (same path `push.js` uses on web).

**Refactor footprint** — Phase 2b moved barcode + photo callers to the abstractions but left the rest of the frontend untouched:
- `web/static/js/features/food/scanner.js` calls `window.Barcode.scan({ source, formats })` and `window.MediaCapture.pickPhoto()`.
- `web/static/js/features/food/photo.js` calls `window.MediaCapture.pickPhoto({ capture: false })`.
- `web/static/js/features/bootstrap.js` continues to use `Intl.DateTimeFormat().resolvedOptions().timeZone` for tz detection — Intl is the right answer for *which timezone*; geolocation is for *where on earth*, a future capability with no current caller. The Geolocation abstraction ships as scaffolding for travel-aware tz correction or similar future work.

Each global has a one-line justification entry in `web/static/js/tests/architecture.globals.test.js`. Each capability has a dedicated `web/static/js/tests/native.<capability>.test.js` covering both impls plus the runtime selector — pure-unit tests are the right shape here because the abstractions sit below the feature-module integration entry point.

### First-run Settings flow

A fresh install runs the four-screen overlay implemented in `web/static/js/features/firstrun/`:

1. **Welcome** — app name, tagline, "Get started" / "Skip all".
2. **Permissions** (native builds only — hidden on web via `Capacitor.isNativePlatform()`) — camera, notifications, location. Each row's "Allow" calls into the Phase 2b abstractions (`window.MediaCapture.pickPhoto`, `window.Reminders.schedule([])`, `window.Geolocation.getCurrent`) so the Capacitor permission dialog surfaces with the right OS copy. Denials don't block progress.
3. **Integrations** — OpenAI API key + URL + model with sane defaults pre-filled (`https://api.openai.com/v1` + `gpt-4o-mini`). Submit calls `PATCH /api/settings/integrations` (reused verbatim from the Settings → Integrations screen via `window.SettingsIntegrations.patch`); Skip moves on without writing. The mobile build registers a `SetIntegrationsReloader` callback so the handler re-resolves config from the settings table and re-wires `foodAI` / `elevenLabs` / `food.RemoteConfig` in-process — the user can hit the food-photo / voice features immediately after "Open app" without force-stopping the app to pick up the new keys. Server build leaves the reloader unset; operators have always restarted to pick up env+settings changes there.
4. **Done** — "Open app" calls `POST /api/firstrun/complete`, dismisses the overlay, clears the resume-state sessionStorage key.

The overlay is **fully skippable** — every screen has a Skip / Skip-all affordance. The app is functional with zero configuration; features that depend on unconfigured keys (food AI, ElevenLabs voice) keep their existing "configure to enable" contextual empty states. The flow never gates access to the rest of the app.

**Trigger**: the bootstrap endpoint (`/api/bootstrap`, `internal/server/settings_handlers.go`) returns a top-level `needs_first_run: bool` derived from `settings.first_run_complete`. Existing settings rows (server installs past first run) are backfilled to `1` by migration `071_add_first_run_state.sql` so the overlay never fires for them. On a mobile install with no settings singleton yet, the row is created at first `GetFirstRunComplete` call with the default value `0`, and the overlay fires.

**Endpoint**: `POST /api/firstrun/complete` (`internal/server/firstrun_handlers.go`) is idempotent — it sets the flag to true and returns `{ok: true}`. It is registered in `internal/server/mcp_coverage_exempt.go` with `Reason: "first-run setup bootstrap; not user-actionable through MCP"` (per the MCP coverage policy in `docs/mcp-coverage.md`).

**Resume safety**: the current step name is persisted to sessionStorage under `wg-firstrun-step` (`web/static/js/features/firstrun/state.js`). A mid-flow process kill that retains sessionStorage (typical Android WebView behavior within a single device-power cycle) resumes at the persisted step. A device power-cycle wipes sessionStorage; the flow restarts from welcome on next launch — intentional, since `needs_first_run` is still true and re-seeing welcome is a low-cost regression. The orchestrator also defensively clears any stale `wg-firstrun-step` entry when bootstrap reports `needs_first_run: false`, so a corrupted entry never traps the user in the overlay.

**Render-only flag confusion guard**: `today.js` has a separate `__firstRun` flag that is render-only ("no data yet, show empty state"). The new `needs_first_run` bootstrap field is the persistent setup flag — distinct name, distinct purpose. The firstrun module's `index.js` top-of-file comment documents this so future readers don't conflate them.

### iOS background-execution strategy

iOS kills backgrounded processes aggressively. The Go scheduler cannot reliably tick when the app is backgrounded. Mitigation (already designed into Phase 1):

- Scheduler computes reminders ahead of time and writes them to the queue.
- Frontend polls `/api/reminders/upcoming` when foregrounded and pre-schedules N reminders via `@capacitor/local-notifications`.
- iOS fires them natively regardless of app state.
- When user taps a notification, deep link into the app; app on resume re-syncs and re-schedules.

Android is more permissive but the same approach works there too — no platform-specific code path needed.

### Secrets storage

**Phase 1 punt**: OpenAI API keys live in the SQLite settings table as plaintext. Acceptable MVP — user's device, user's data, no network exposure.

**Phase 2a partial**: `SESSION_SECRET` is generated on first launch (32 random bytes via `SecureRandom`) and persisted via `androidx.security:security-crypto` `EncryptedSharedPreferences` under key `session_secret_v1`. This is the only secret the shell owns directly; provider API keys still live in the SQLite settings table.

**Phase 2c decision (shipped)**: provider API keys (OpenAI, Food DB, ElevenLabs) stay in the SQLite `settings` table as plaintext. Plan: `docs/plans/2026-05-23-mobile-phase2c-firstrun-secrets.md`. The threat model that justifies this:

- The `meds.db` file lives in the app's private data directory (`/data/data/<package>/files/` on Android). On a non-rooted device, other apps cannot read it without sharing the same UID.
- The realistic attack vectors on a single-user device are: (a) physical theft after unlock, (b) Android auto-backup leaking the DB, (c) a malicious app running under the same UID, (d) device root + post-compromise file exfiltration. None of (a)–(d) are mitigated meaningfully by Keystore on a single-user device — once the WebView / app process has the key in memory to forward to the Go server, the key is reachable through the same compromise paths.
- Backup leakage (vector b) is orthogonal to where the key is stored at rest — it is addressed by setting `android:allowBackup="false"` (or an explicit `<backup-rules>` exclusion of `meds.db`) in `capacitor/android-overlay/app/src/main/AndroidManifest.xml`. Tracked as a follow-up alongside the Phase 2c Post-Completion items; if the manifest does not already set this, it should be filed as a quick PR regardless of whether Phase 2d ever lands.
- The first-run integrations screen reuses the existing `PATCH /api/settings/integrations` endpoint with its `***` secret-mask convention. The decision to keep keys in SQLite means the firstrun overlay needed no new write surface and no native↔Go init ceremony.

**Phase 2d (deferred)**: defense-in-depth migration to Android `EncryptedSharedPreferences` (and iOS Keychain when iOS ships). Plan stub: `docs/plans/2026-05-23-mobile-phase2d-keystore-secrets.md`. Sketch: the shell owns the key in `EncryptedSharedPreferences`, exposes it via `MedtrackerNative.getProviderSecret("openai_api_key")` (the sticky-across-navigations `@JavascriptInterface` pattern from Phase 2a), the frontend reads on session start and forwards via HTTP headers on AI-bound requests, the Go binary never persists the key to SQLite. Gate: re-evaluate after Phase 2c has baked on a real device for at least one week without first-run regressions.

### First-run user provisioning

`LocalUserResolver` returns a fixed user ID in Phase 1. Phase 2a's `SESSION_SECRET` generation + persistence on first launch is already handled in `MainActivity.kt` (see "Secrets storage" above).

**Phase 2c discovery**: the schema has no `users` table — `user_id` is a bare `INTEGER` column on each per-feature table with no enforced FK. So the originally-planned `INSERT OR IGNORE INTO users(...)` step in `handleFirstRunComplete` had nothing to insert into. Provisioning is implicit: the first write under `user_id = N` (a medication, a BP entry, etc.) creates that user's data namespace; reads under `user_id = N` against an empty namespace return zero rows. The `handleFirstRunComplete` endpoint comment captures this so future readers know the missing INSERT is intentional, not an oversight.

The bootstrap-side trigger relies on `settings.first_run_complete` rather than user-row existence. Multiple local profiles are still out of scope (single-user device); `LocalUserResolver` continues to return a fixed ID.

## Constraints we're betting on

These are load-bearing assumptions. If any change, the design needs revisiting.

- **`modernc.org/sqlite` stays CGO-free.** Already in `go.mod` (`v1.42.2`). Mobile cross-compile depends on this. If anyone considers switching to `mattn/go-sqlite3` for any reason, that's a blocker.
- **Only `android/arm64` cross-compiles without an NDK.** Even with `modernc.org/sqlite` CGO-free, `GOARCH=arm` and `GOARCH=amd64` on `GOOS=android` still demand `CGO_ENABLED=1` (the Go runtime's `runtime/cgo` package needs external linking on those targets). v1 of the mobile build ships arm64-only; armv7 + x86_64 are best-effort builds gated on `ANDROID_NDK_HOME` in `scripts/build-android-binaries.sh`. If a future Go version drops this asymmetry, drop the NDK gating.
- **Android extracts `lib*.so` from `jniLibs/<abi>/` into a read-only-but-executable `nativeLibraryDir` at install time, regardless of whether the file is an actual shared library.** Phase 2a leans on this: the Go binary is named `libmedtracker.so` and placed under `jniLibs/<abi>/`, the Android packager extracts it to `applicationInfo.nativeLibraryDir`, and the shell spawns it via `ProcessBuilder` with no assets-copy / chmod dance at launch. If Google ever tightens what's allowed under `jniLibs` (e.g. ELF-shape checks beyond magic-byte sniffing, or strips the executable bit), Phase 2b/2c would need to fall back to copying the binary from `assets/` into `getFilesDir()` and `chmod +x`ing it at first launch.
- **Capacitor WebView navigations destroy the JS context, so the native↔JS bridge must survive across `loadUrl`.** Phase 2a uses `addJavascriptInterface(NativeBridge, "MedtrackerNative")` (sticky across navigations) plus a tiny inline shim in `web/static/index.html` that copies `MedtrackerNative.apiBase()` into `window.__MEDTRACKER_BOOTSTRAP__.apiBase`. The earlier `evaluateJavascript`-then-`loadUrl` approach silently broke because the injected global lived on the *previous* document and was wiped by the navigation. Future native↔JS surfaces must follow the same `@JavascriptInterface` + inline-shim pattern; do not rely on `evaluateJavascript` for state that must persist across page loads.
- **The mobile binary embeds `web/static` via `//go:embed`.** The package `web/embed_mobile.go` (build tag `mobile`) bundles the entire `web/static/` tree into the Go binary, and `cmd/bot/main_mobile.go` wires it via `srv.SetStaticFS(web.StaticFS())`. The server-build handlers fall back to `./web/static` on disk as before. Without this, the WebView's `loadUrl("http://127.0.0.1:<port>")` would 500 because the Android binary spawns from a read-only `nativeLibraryDir` with no co-located filesystem. The trade-off is a few MB of binary growth versus an assets-copy/extract step at app launch (and avoiding a Capacitor `assets/public/` path the WebView would have to be re-pointed at). Any new top-level static file must be reachable via the `serveStaticFile` / `readStaticFile` helpers in `internal/server/server.go`, not raw `os.Open`, or the mobile build will silently 500 on that path.
- **Domain service pattern stays enforced.** The "transports share the domain service" rule is what makes the mobile transport free. If bot or HTTP handlers start calling stores directly, the mobile build will silently work but the architectural property dies.
- **Frontend stays offline-first.** SW precache, Dexie cache, `cachedFetch`, optimistic writes — these are why the mobile build needs almost zero frontend changes. New screens that bypass these patterns would make local-only mode degrade.
- **Settings repo stays singleton-row.** Per-user settings would require deciding "which user" on mobile, which is moot for single-user devices but would complicate the env-or-settings merge. If a future feature needs per-user settings, keep the integration config keys in the singleton table separately.
- **App Store policy on embedded localhost servers.** Many apps do this without issue, but Apple's review guidelines can shift. Keep the port loopback-only and document the architecture in the App Store submission to reduce review surprises.

## Open questions for Phase 2

When the Phase 2 plan is written, these need explicit decisions:

1. **`gomobile bind` vs embedded localhost HTTP** — current lean is embedded HTTP, but revisit with real iOS/Android lifecycle testing.
2. **Secrets in SQLite vs Keychain/Keystore** — resolved by Phase 2c: provider secrets stay in SQLite plaintext, justified by the single-user device threat model (see "Secrets storage" above). Defense-in-depth migration tracked as Phase 2d (`docs/plans/2026-05-23-mobile-phase2d-keystore-secrets.md`).
3. **Polling vs background fetch for reminder pre-scheduling** — does the frontend re-fetch upcoming reminders only on foreground, or via Capacitor's background fetch API on a schedule?
4. **Auto-update strategy** — App Store updates only, or in-app PWA-style asset updates for the frontend (with a native Go binary rev requiring a store update)? This affects how `web/static/` is bundled.
5. **Crash reporting** — Sentry or similar for the mobile build? Server-mode runs unattended on the operator's box; mobile users hit different bugs.
6. **Phase 2 scope size** — does Phase 2 include all native plugins + first-run flow + secrets + binary embedding, or split into 2a (embedding) and 2b (native plugins)?
