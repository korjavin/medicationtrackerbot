# Local-only mode (Capacitor mobile app)

Design context for the ongoing effort to compile this codebase into a mobile app via Capacitor. This doc captures the *why* behind decisions made during planning so future phases can be planned from a warm start, not by re-deriving from first principles. Living doc — update as Phase 2 lands.

Status: **Phase 1 complete** (Go-side foundation + Capacitor spike landed). Plan: `docs/plans/completed/2026-05-18-local-only-mode-foundation.md`. Phase 2 (Go binary embedding + native plugin abstractions) is not started — see [Phase 2 below](#phase-2-mobile-shell--native-integration-future-plan).

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

## Phase 2: Mobile shell + native integration (future plan)

Not planned yet. This section captures what's known about it so the Phase 2 plan can be created without re-deriving.

### Go binary embedding: open decision

Two ways to get the Go binary running inside Capacitor:

**Option 2a: `gomobile bind`.** Compile Go as a static library (`.aar` for Android, `.framework` for iOS), call exported Go functions from native code via a bridge. Pros: cleaner integration, no port management, no HTTP overhead. Cons: every Go API needs a native bridge wrapper; the existing HTTP handler architecture would need to be re-exposed as Go function calls; iOS/Android native bridge code becomes part of the surface area.

**Option 2b: Embedded localhost HTTP server.** Compile Go as a binary, ship it as a resource in the app bundle, spawn it on app launch, WebView talks to `http://127.0.0.1:<port>` exactly like the dev environment. Pros: zero changes to the existing HTTP/handler architecture; frontend code is identical to the deployed server case. Cons: native shell needs to manage the Go process lifecycle (start, stop on backgrounding, restart on foreground); port collisions need handling; minor battery cost from a running process.

Lean: **Option 2b** because it preserves the "third transport is just localhost HTTP" framing that motivated Option B in the first place. Option 2a starts forking the API surface again. But this is a real decision worth re-examining when Phase 2 starts, especially for Android battery behavior.

### Native plugin JS abstractions

The web stack and Capacitor diverge on three things; each needs a small JS abstraction layer with two implementations selected at runtime:

| Capability | Web impl | Capacitor impl |
|---|---|---|
| Geolocation (tz detection) | `navigator.geolocation` | `@capacitor/geolocation` |
| Camera + photo picker (food photos) | `<input type=file>` / `getUserMedia` | `@capacitor/camera` |
| Barcode scanning (food log) | `BarcodeDetector` (Chrome only) / ZXing JS | `@capacitor-mlkit/barcode-scanning` (native, fast, all phones) |
| Local notifications (reminders) | Web Push | `@capacitor/local-notifications` |

Suggested shape: a `window.MediaCapture`, `window.Geolocation`, `window.Reminders` abstraction in `web/static/js/native/` with Capacitor and web implementations. Selected at runtime via `Capacitor.isNativePlatform()`. Backend handlers (food upload, barcode lookup, tz endpoint) stay identical.

### First-run Settings flow

Mobile install starts with empty settings. The user must configure at least OpenAI keys (or skip and accept the "configure to enable food AI" empty state). A guided first-run setup screen prompts for:
- OpenAI API key + URL + model (with sane defaults)
- Optional: Food DB API config, ElevenLabs voice agent

Don't force completion — the app is fully functional without any of these. Just surface the unconfigured state contextually ("Add OpenAI key in Settings to enable photo meal logging").

### iOS background-execution strategy

iOS kills backgrounded processes aggressively. The Go scheduler cannot reliably tick when the app is backgrounded. Mitigation (already designed into Phase 1):

- Scheduler computes reminders ahead of time and writes them to the queue.
- Frontend polls `/api/reminders/upcoming` when foregrounded and pre-schedules N reminders via `@capacitor/local-notifications`.
- iOS fires them natively regardless of app state.
- When user taps a notification, deep link into the app; app on resume re-syncs and re-schedules.

Android is more permissive but the same approach works there too — no platform-specific code path needed.

### Secrets storage

**Phase 1 punt**: OpenAI API keys live in the SQLite settings table as plaintext. Acceptable MVP — user's device, user's data, no network exposure.

**Phase 2 decision**: revisit moving secrets to Keychain (iOS) / Keystore (Android) via `@capacitor-community/secure-storage` or `@capacitor/preferences` with encryption. The trade-off is: Keychain is the right answer for defense-in-depth (e.g. backup leaks, device-loss scenarios), but it means the Go binary doesn't see the key directly — the frontend would need to fetch the secret on session start and pass it to Go via an init endpoint. That re-introduces a small native↔Go ceremony. Decide based on real threat model when Phase 2 starts.

### First-run user provisioning

`LocalUserResolver` returns a fixed user ID in Phase 1. In Phase 2 we need to:
- Provision the local user row on first launch (or ensure migration 1 seeds it).
- Decide whether mobile supports multiple local profiles (probably no — single-user device, no need).
- Handle the SESSION_SECRET generation/persistence on first launch.

## Constraints we're betting on

These are load-bearing assumptions. If any change, the design needs revisiting.

- **`modernc.org/sqlite` stays CGO-free.** Already in `go.mod` (`v1.42.2`). Mobile cross-compile depends on this. If anyone considers switching to `mattn/go-sqlite3` for any reason, that's a blocker.
- **Domain service pattern stays enforced.** The "transports share the domain service" rule is what makes the mobile transport free. If bot or HTTP handlers start calling stores directly, the mobile build will silently work but the architectural property dies.
- **Frontend stays offline-first.** SW precache, Dexie cache, `cachedFetch`, optimistic writes — these are why the mobile build needs almost zero frontend changes. New screens that bypass these patterns would make local-only mode degrade.
- **Settings repo stays singleton-row.** Per-user settings would require deciding "which user" on mobile, which is moot for single-user devices but would complicate the env-or-settings merge. If a future feature needs per-user settings, keep the integration config keys in the singleton table separately.
- **App Store policy on embedded localhost servers.** Many apps do this without issue, but Apple's review guidelines can shift. Keep the port loopback-only and document the architecture in the App Store submission to reduce review surprises.

## Open questions for Phase 2

When the Phase 2 plan is written, these need explicit decisions:

1. **`gomobile bind` vs embedded localhost HTTP** — current lean is embedded HTTP, but revisit with real iOS/Android lifecycle testing.
2. **Secrets in SQLite vs Keychain/Keystore** — phase 1 punt; decide based on threat model.
3. **Polling vs background fetch for reminder pre-scheduling** — does the frontend re-fetch upcoming reminders only on foreground, or via Capacitor's background fetch API on a schedule?
4. **Auto-update strategy** — App Store updates only, or in-app PWA-style asset updates for the frontend (with a native Go binary rev requiring a store update)? This affects how `web/static/` is bundled.
5. **Crash reporting** — Sentry or similar for the mobile build? Server-mode runs unattended on the operator's box; mobile users hit different bugs.
6. **Phase 2 scope size** — does Phase 2 include all native plugins + first-run flow + secrets + binary embedding, or split into 2a (embedding) and 2b (native plugins)?
