# Mobile Phase 2b: Native plugin JS abstractions

## Overview

Phase 2a (`docs/plans/completed/2026-05-22-mobile-phase2a-android-go-embedding.md`) shipped the embedded Go binary inside the Capacitor Android shell: tapping the app launches the activity, which spawns the mobile-build binary, parses `LISTENING 127.0.0.1:<port>` from stdout, and points the WebView at that port. What it did *not* do is change how the frontend reaches the device's hardware. The WebView still calls `<input type=file>` for photos, `BarcodeDetector` (Chrome-only) plus a ZXing fallback for barcodes, `navigator.geolocation` is not currently called at all, and reminders flow through Web Push — which does not work inside a Capacitor WebView on either Android or iOS.

This plan introduces a thin JS abstraction layer at `web/static/js/native/` that the frontend code calls instead of the web platform APIs directly. At runtime the abstraction picks an implementation: `web/*` modules for browsers (lifted from the existing inline code, no new behavior), `capacitor/*` modules for the mobile shell (calling `@capacitor/camera`, `@capacitor/geolocation`, `@capacitor-mlkit/barcode-scanning`, `@capacitor/local-notifications`). Backend handlers stay identical — this is pure frontend + Capacitor plugin config work.

The new piece of behavior is the **reminder pre-schedule loop**: on app resume the Capacitor path polls `GET /api/reminders/upcoming?hours=24`, hands the queue to `@capacitor/local-notifications`, and the OS fires notifications natively regardless of app state. The Go-side scheduler's `LocalNotificationSink` and the upcoming-reminders endpoint already exist from Phase 1; this plan wires the consumer.

iOS is out of scope. Phase 2a is Android-only and Phase 2b inherits that constraint — the web fallback continues to work in browsers, the Capacitor path is gated on `Capacitor.isNativePlatform()`. Phase 2c (first-run setup + secrets storage) is stubbed in an adjacent file and depends on this plan landing first.

## Context (from discovery)

**Files/components involved:**
- `web/static/js/features/food/scanner.js` — owns the existing barcode scanning path. Line 40–64 creates `window.BarcodeDetector`, line 136 calls `navigator.mediaDevices.getUserMedia()` for the live stream, line 193 falls back to `window.ZXing.BrowserMultiFormatReader`, line 216–258 (`openPhotoPickerAndDecode`) creates a hidden `<input type=file accept=image/* capture=environment>`. Will be refactored to call `window.Barcode.scan()` and `window.MediaCapture.pickPhoto()`.
- `web/static/js/features/food/photo.js` — food photo logging. Line 19–24 (`triggerFoodPhotoPicker`) clicks a hidden `#food-photo-input`, line 154–161 parses EXIF, line 208 posts to `/api/food/log/from-photo`. Will be refactored to call `window.MediaCapture.takePhoto()` / `pickPhoto()`.
- `web/static/js/features/bootstrap.js` — current tz detection. Line 22 calls `Intl.DateTimeFormat().resolvedOptions().timeZone`. **No `navigator.geolocation` call exists today.** The Geolocation abstraction is built per the stub's intent, but there is no current caller to refactor — see "Open questions resolved" below.
- `web/static/js/push.js` — Web Push subscription path. Stays untouched on the web side; the Capacitor reminder path is additive, not a refactor of this file.
- `web/static/js/tests/architecture.globals.test.js` — owns the `window.*` allowlist. New globals (`MediaCapture`, `Geolocation`, `Barcode`, `Reminders`) need entries with one-line justifications.
- `web/static/js/tests/helpers/frontend-harness.js` — exports `loadFrontendEnv()` returning `{ window, document, cleanup }`. New tests follow the existing `features.*` pattern.
- `internal/server/reminders_handlers.go:12-22` — `GET /api/reminders/upcoming` returns `[]upcomingReminder` with `intake_id`, `medication_id`, `medication_name`, `scheduled_at`. Honors `?hours=N` (default 24, max 168). Filters by `SnoozedUntil`. Untouched by this plan; the JS contract pins to this shape.
- `internal/scheduler/sink_localnotifications.go` — Phase 1's reminder queue. Untouched.
- `capacitor/package.json` — adds `@capacitor/camera`, `@capacitor/geolocation`, `@capacitor-mlkit/barcode-scanning`, `@capacitor/local-notifications` to `dependencies`.
- `capacitor/capacitor.config.ts` — may need plugin-specific config blocks (e.g. local-notifications icon).
- `capacitor/android-overlay/app/src/main/AndroidManifest.xml` — adds runtime permissions: `CAMERA`, `ACCESS_COARSE_LOCATION` (fine optional), `POST_NOTIFICATIONS` (API 33+), `SCHEDULE_EXACT_ALARM` (API 31+ if exact reminder timing matters). The overlay is what survives `npx cap add android` regeneration per Phase 2a's "android-shell sources mirror" pattern.
- `capacitor/android-overlay/app/src/main/java/.../MainActivity.kt` — gains a lifecycle hook (`onResume` / `Capacitor.Plugin.App.resume` listener) that wakes the JS reminder pre-schedule loop. May also need a tap-handler bridge for notification deep links — see Task 6.

**Related patterns found:**
- The 2a overlay convention (`capacitor/android-overlay/` committed, copied into the gitignored `capacitor/android/` by `apply-overlay.sh`) is the only sustainable way to land AndroidManifest changes. Any plugin config that auto-modifies the manifest still needs to be reconciled against the overlay.
- `Capacitor.isNativePlatform()` is the standard runtime gate. No existing references in `web/static/js/` (grep is clean) — Phase 2a did not ship any frontend-side native detection. Task 1 is the first to introduce it.
- The `LocalNotificationSink` already produces a queue Phase 1 stubbed but no consumer pulls from. This plan adds the consumer.
- Frontend tests are integration-first (CLAUDE.md rule #8): coverage lives in `features.<area>.<aspect>.test.js` files going through `loadFrontendEnv()`. Pure-unit tests are reserved for layers without an integration entry point — the native abstractions are unit-testable in isolation because they have no DOM-side integration entry point beyond their own API surface, so a dedicated `native.<capability>.test.js` per capability is the right shape.

**Dependencies identified:**
- New npm packages (in `capacitor/package.json`): `@capacitor/camera`, `@capacitor/geolocation`, `@capacitor-mlkit/barcode-scanning`, `@capacitor/local-notifications`. Each adds a Gradle dependency on the Android side; `@capacitor-mlkit/barcode-scanning` pulls in MLKit (~5–10 MB APK growth) and is the biggest single addition.
- No new Go modules.
- No schema migrations.
- AndroidManifest changes (permissions + notification channel metadata) flow through `capacitor/android-overlay/`.

## Development Approach

- **Testing approach**: Regular (code first, then tests) — matches Phase 2a and recent plans in this repo.
- Complete each task fully before moving to the next.
- Make small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task. Tests are a required deliverable, not optional.
- **CRITICAL: all tests must pass before starting next task** — `pnpm test`, `go test ./...`, `go build -tags mobile ./...`. The Go suite is touched only by the verify-acceptance task because the Go side is unchanged in scope.
- **CRITICAL: update this plan file when scope changes during implementation**, especially if a Capacitor plugin needs a Go-side change we didn't anticipate (would invalidate the "no new Go endpoints" constraint).
- Run tests after each change.
- Maintain backward compatibility: browser users of the PWA must continue to work unchanged. The Capacitor path is gated behind `isNativePlatform()`; the web impl is the existing code path lifted behind an interface.

## Testing Strategy

- **Unit tests (Vitest)**: one `web/static/js/tests/native.<capability>.test.js` per abstraction. Each covers (a) web impl behavior end-to-end against JSDOM (file input, BarcodeDetector mock, navigator.geolocation mock), (b) Capacitor impl behavior with the plugin mocked via `vi.mock('@capacitor/...')`, (c) the runtime selector picking the right impl based on a mocked `Capacitor.isNativePlatform()` return. Integration-first per CLAUDE.md rule #8 — but native abstractions sit below the feature-module layer, so they get their own `native.*.test.js` files rather than being folded into `features.food.*`.
- **Integration tests (Vitest)**: refactor existing `features.food.scanner.test.js` / `features.food.photo.test.js` to exercise the abstraction seam — they continue to assert end-to-end behavior, but the platform calls now go through the new globals.
- **Capacitor plugin smoke**: a real-device pass under Task 7 — install the APK, take a photo through the food flow, scan a barcode, receive a scheduled notification while backgrounded. Documented in Post-Completion.
- **No new Go tests** — backend is unchanged. The verify-acceptance task runs `go build -tags mobile ./...` to confirm nothing drifted.
- **E2E**: no Playwright for the mobile shell. The real-device smoke is the e2e equivalent (same pattern as 2a).

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with `➕` prefix.
- Document issues/blockers with `⚠️` prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): `web/static/js/native/` modules, refactor of `scanner.js` / `photo.js`, additions to `capacitor/package.json`, AndroidManifest overlay edits, allowlist updates in `tests/architecture.globals.test.js`, new Vitest files.
- **Post-Completion** (no checkboxes): real-device install + capability smoke (camera grants, barcode accuracy comparison vs ZXing, notification fires while app backgrounded, geolocation prompt), APK size delta measurement, decision capture in `docs/local-mode.md`.

## Implementation Steps

### Task 1: Foundation — `web/static/js/native/` runtime selector

- [x] create `web/static/js/native/index.js` that exposes `window.MediaCapture`, `window.Geolocation`, `window.Barcode`, `window.Reminders` as stubs that throw `NotImplementedError` for every method. Wires the runtime selection helper `isNativePlatform()` that calls `Capacitor?.isNativePlatform?.() ?? false` (safe when Capacitor is absent in browser builds).
- [x] add `<script src="/js/native/index.js"></script>` to `web/static/index.html` *before* feature modules but after any vendor scripts — load order matters because Task 7's refactored callers read these globals at module-evaluate time.
- [x] add four new entries to `web/static/js/tests/architecture.globals.test.js`'s `ALLOWED_GLOBALS` set: `'window.MediaCapture'`, `'window.Geolocation'`, `'window.Barcode'`, `'window.Reminders'`, each with a one-line justification comment naming `native/index.js` as the owner.
- [x] write `web/static/js/tests/native.foundation.test.js`: assert the four globals are present after loading `native/index.js`, assert each stub method throws `NotImplementedError`, assert `isNativePlatform()` returns `false` when `window.Capacitor` is undefined and `true` when `window.Capacitor.isNativePlatform()` returns `true`.
- [x] run `pnpm test` — must pass before Task 2. Architecture globals test must specifically be green.

### Task 2: Geolocation abstraction

- [x] create `web/static/js/native/web/geolocation.js` exporting `getCurrentPosition({ timeoutMs, maximumAgeMs })` wrapping `navigator.geolocation.getCurrentPosition` as a promise. Maps the `PositionError.code` values to a stable `{ code: 'PERMISSION_DENIED'|'POSITION_UNAVAILABLE'|'TIMEOUT', message }` shape so consumers don't see platform-specific errors.
- [x] create `web/static/js/native/capacitor/geolocation.js` calling `@capacitor/geolocation`'s `Geolocation.getCurrentPosition` and normalizing to the same shape. Implements last-known-position caching with a 1h TTL (in-memory only; cleared on app restart) — resolves the stub's open question. (Reads plugin via `window.Capacitor.Plugins.Geolocation` rather than ES-module `import`, so no JS bundler is required.)
- [x] update `web/static/js/native/index.js` to wire `window.Geolocation = isNativePlatform() ? capacitorImpl : webImpl` at script load. (Added `registerImpl(capability, platform, impl)` + `getImpl(capability, platform)` on the foundation; impl files register themselves and the foundation assigns the matching one to the global.)
- [x] write `web/static/js/tests/native.geolocation.test.js`: web impl success (mock `navigator.geolocation`), web impl permission-denied error normalization, web impl timeout normalization, Capacitor impl success with `vi.mock('@capacitor/geolocation')`, Capacitor impl cache hit (second call within 1h returns cached without invoking the plugin), Capacitor impl cache miss after 1h.
- [x] no caller refactor in this task — `bootstrap.js` continues using `Intl.DateTimeFormat` for tz string (Intl is the right answer for *which timezone*; geolocation is for *where on earth*, a future capability not currently exercised).
- [x] run `pnpm test` — must pass before Task 3.

### Task 3: MediaCapture abstraction (camera + photo picker)

- [x] create `web/static/js/native/web/media-capture.js` exporting `takePhoto()` (live camera via `getUserMedia` + canvas snapshot, returns a `Blob`) and `pickPhoto()` (hidden `<input type=file accept=image/* capture=environment>`, returns a `Blob`). Lifted from the patterns in `scanner.js:136` and `photo.js:19-24` — no behavior change, just relocated behind the interface.
- [x] create `web/static/js/native/capacitor/media-capture.js` calling `@capacitor/camera`'s `Camera.getPhoto({ source: CameraSource.Camera, resultType: ... })` for `takePhoto()` and `Camera.getPhoto({ source: CameraSource.Photos })` for `pickPhoto()`. Returns a `Blob` (decoded from the plugin's base64 or webPath response) so callers see one return type across both impls. (Reads plugin via `window.Capacitor.Plugins.Camera` to match the geolocation pattern — no JS bundler required.)
- [x] update `web/static/js/native/index.js` to wire `window.MediaCapture`. (Wiring is handled by the foundation's `registerImpl` helper that the new impl files call into; index.js itself is unchanged from Task 2.)
- [x] write `web/static/js/tests/native.media-capture.test.js`: web `takePhoto` happy path with `navigator.mediaDevices.getUserMedia` mocked, web `takePhoto` permission-denied, web `pickPhoto` with mocked file input change event, Capacitor `takePhoto` with `vi.mock('@capacitor/camera')`, Capacitor `pickPhoto`, Capacitor cancel path (plugin throws `User cancelled photos app`) → resolves to `null` rather than rejecting (resolves it like an empty selection so callers can branch on null).
- [x] run `pnpm test` — must pass before Task 4.

### Task 4: Barcode abstraction

- [ ] create `web/static/js/native/web/barcode.js` exporting `scan(formats?)` that uses `window.BarcodeDetector` if available, falls back to `window.ZXing.BrowserMultiFormatReader`. Lifted from `scanner.js:40-64,193`. Returns `{ format, rawValue }` on success or `null` on user cancel. Single-shot only — resolves the stub's open question.
- [ ] create `web/static/js/native/capacitor/barcode.js` calling `@capacitor-mlkit/barcode-scanning`'s `BarcodeScanner.scan({ formats })`. Maps MLKit formats to the same `{ format, rawValue }` shape. Single-shot.
- [ ] update `web/static/js/native/index.js` to wire `window.Barcode`.
- [ ] write `web/static/js/tests/native.barcode.test.js`: web BarcodeDetector path with stubbed `window.BarcodeDetector`, web ZXing fallback when BarcodeDetector is undefined, web cancel returns `null`, Capacitor success with `vi.mock('@capacitor-mlkit/barcode-scanning')`, Capacitor permission-denied normalization, Capacitor cancel returns `null`.
- [ ] run `pnpm test` — must pass before Task 5.

### Task 5: Reminders abstraction + pre-schedule loop

- [ ] create `web/static/js/native/web/reminders.js` exporting `schedule(reminders)` and `cancelAll()` as no-ops on web (or thin shims that document "Web Push is handled by `push.js`; this is a Capacitor-only path"). Web callers continue to use the existing webpush subscribe flow.
- [ ] create `web/static/js/native/capacitor/reminders.js` calling `@capacitor/local-notifications`. `schedule(reminders)` is **replace-all**: calls `LocalNotifications.getPending()`, cancels all pending with `LocalNotifications.cancel(ids)`, then schedules the new batch. Resolves the stub's open question (simpler, no diff bookkeeping; risk of duplicate notifications is the cost we accept). `cancelAll()` cancels every pending. Each reminder is mapped to `{ id: intake_id, title: medication_name, body: 'Time to take...', schedule: { at: new Date(scheduled_at) }, extra: { intake_id, medication_id } }`.
- [ ] update `web/static/js/native/index.js` to wire `window.Reminders`.
- [ ] create the pre-schedule loop in `web/static/js/native/capacitor/reminders.js`: `startPreScheduleLoop()` that (1) immediately polls `GET /api/reminders/upcoming?hours=24`, (2) calls `Reminders.schedule(response)`, (3) registers a Capacitor `App.addListener('appStateChange', ...)` so the same flow re-runs on resume. Loop is started by the foundation module at app-ready time when on native platform.
- [ ] add an `App.addListener('appStateChange', ...)` deep-link handler in `web/static/js/native/capacitor/reminders.js` (or a small `notifications-tap.js` sibling) that, when a notification tap delivers `extra.intake_id`, calls into the existing app routing to deep-link to the today/medications view for that intake. Reuses whatever navigation surface `web/static/js/app.js` already exposes — no new router work.
- [ ] write `web/static/js/tests/native.reminders.test.js`: web `schedule()` is a no-op (does not throw), Capacitor `schedule()` cancels pending before scheduling new (replace-all semantics), Capacitor `schedule()` maps endpoint response to plugin payload shape correctly, Capacitor `cancelAll()` calls `LocalNotifications.cancel`, pre-schedule loop fires on `appStateChange` to active, deep-link handler invokes the app navigation surface with the intake id from `extra`.
- [ ] run `pnpm test` — must pass before Task 6.

### Task 6: Capacitor plugin install + Android overlay wiring

- [ ] add `@capacitor/camera`, `@capacitor/geolocation`, `@capacitor-mlkit/barcode-scanning`, `@capacitor/local-notifications` to `capacitor/package.json` dependencies at their latest 6.x-compatible versions (Capacitor core is `^6.1.2`).
- [ ] add `<uses-permission>` entries to `capacitor/android-overlay/app/src/main/AndroidManifest.xml` for `CAMERA`, `ACCESS_COARSE_LOCATION`, `POST_NOTIFICATIONS`, `SCHEDULE_EXACT_ALARM`. Also add the `<uses-feature android:name="android.hardware.camera" android:required="false" />` and barcode-scanner manifest metadata per `@capacitor-mlkit/barcode-scanning` README.
- [ ] add `LocalNotifications` plugin config block to `capacitor/capacitor.config.ts` (icon, default sound, small-icon resource name).
- [ ] update `capacitor/README.md` with a "Phase 2b plugins" section: which plugins are wired, what AndroidManifest permissions they require, what to run after pulling (`npm install` + `npx cap sync` + `./apply-overlay.sh`).
- [ ] write a Vitest test in `web/static/js/tests/native.foundation.test.js` (extend existing file from Task 1) asserting that after the full module load (all four abstractions wired), the four globals are functional methods, not stubs.
- [ ] run `pnpm test` — must pass before Task 7.

### Task 7: Refactor callers to use abstractions

- [ ] update `web/static/js/features/food/scanner.js`: replace lines 40–64 (BarcodeDetector creation) + line 102 (`detector.detect`) + line 193 (ZXing fallback) + line 216–258 (`openPhotoPickerAndDecode`) with calls to `window.Barcode.scan()` and `window.MediaCapture.pickPhoto()`. Remove the now-dead code paths.
- [ ] update `web/static/js/features/food/photo.js`: replace `triggerFoodPhotoPicker` (line 19–24) with a call to `window.MediaCapture.takePhoto()` (or `pickPhoto()` for gallery selection — preserve whichever the existing UI offers). Keep the EXIF parsing at line 154–161 and the `POST /api/food/log/from-photo` at line 208 unchanged.
- [ ] verify `web/static/js/features/bootstrap.js`'s tz detection (line 22) does NOT change — Intl is the right answer for the tz string and the Geolocation abstraction is for a future capability, not this refactor.
- [ ] update or extend `web/static/js/tests/features.food.scanner.test.js` and `features.food.photo.test.js` so the integration assertions go through the abstraction seam (mock `window.Barcode` / `window.MediaCapture` instead of `navigator.mediaDevices`).
- [ ] write tests for the refactored callers: scanner uses `window.Barcode.scan()` and dispatches the existing barcode-found event; photo flow uses `window.MediaCapture.takePhoto()` and posts the resulting blob to `/api/food/log/from-photo` unchanged.
- [ ] run `pnpm test` — must pass before Task 8.

### Task 8: Verify acceptance criteria

- [ ] verify all four abstractions present in `web/static/js/native/index.js` and exposed as `window.*` globals.
- [ ] verify all four globals listed in `tests/architecture.globals.test.js` with justification comments.
- [ ] verify existing food-scanner and food-photo flows continue to work in the browser (web impls) — `pnpm test` covers this.
- [ ] verify `go build -tags mobile ./...` and `go test ./...` still pass (backend unchanged, but confirm no drift).
- [ ] run full `pnpm test` — all tests including the new `native.*.test.js` files green.
- [ ] run frontend lint / formatting check if the project has one (`pnpm lint` or equivalent — skip if no script).
- [ ] verify no `*-branches` / `*-edges` / `*-characterization` test files were created (CLAUDE.md rule #8).
- [ ] verify each new `window.*` global has exactly one allowlist entry (no duplicates, no stale entries from earlier iterations).

### Task 9: Update documentation

- [ ] update `docs/local-mode.md`'s "Native plugin JS abstractions" subsection: mark Phase 2b as in-progress / shipped (per actual landing), describe the `web/static/js/native/` runtime selector pattern, link to this plan.
- [ ] update `docs/frontend.md` if a native-abstractions section makes sense there (it probably does — the abstraction is part of the frontend architecture). Add a "Native platform abstractions" subsection that names the four globals, the runtime selector, and where the web vs Capacitor impls live.
- [ ] update `capacitor/README.md` (already touched in Task 6) with a verification checklist for someone pulling Phase 2b for the first time: `npm install`, `npx cap sync`, `./apply-overlay.sh`, then `npx cap open android`.
- [ ] add a CLAUDE.md note (only if the abstraction pattern needs to be enforced going forward — e.g. "new device-API access must route through `web/static/js/native/`") — judgment call during the task; skip if the pattern feels too narrow to deserve a top-level rule.

*Note: ralphex automatically moves completed plans to `docs/plans/completed/`.*

## Technical Details

### Runtime selector

```js
// web/static/js/native/index.js (sketch)
const isNative = () => Boolean(window.Capacitor?.isNativePlatform?.());

import * as webGeolocation from './web/geolocation.js';
import * as capacitorGeolocation from './capacitor/geolocation.js';
// ...etc

window.Geolocation  = isNative() ? capacitorGeolocation  : webGeolocation;
window.MediaCapture = isNative() ? capacitorMediaCapture : webMediaCapture;
window.Barcode      = isNative() ? capacitorBarcode      : webBarcode;
window.Reminders    = isNative() ? capacitorReminders    : webReminders;
```

The Capacitor modules import their plugin (`import { Camera } from '@capacitor/camera'`) lazily — the import is resolved at module-eval, so in a pure-browser build where `@capacitor/camera` isn't bundled, the Capacitor module file simply isn't reached. Bundle config / load-order needs to handle this; if the existing PWA doesn't have a bundler, the Capacitor modules can do `await import('@capacitor/camera')` inside `isNative()` branches to avoid hard import failures.

### Reminders endpoint contract (existing, unchanged)

```json
GET /api/reminders/upcoming?hours=24
[
  {
    "intake_id": 123,
    "medication_id": 456,
    "medication_name": "Metformin 500mg",
    "scheduled_at": "2026-05-22T08:00:00Z"
  }
]
```

JS maps to `LocalNotifications.schedule` payload:
```js
{
  notifications: response.map(r => ({
    id: r.intake_id,            // stable across replace-all
    title: r.medication_name,
    body: `Time to take ${r.medication_name}`,
    schedule: { at: new Date(r.scheduled_at) },
    extra: { intake_id: r.intake_id, medication_id: r.medication_id }
  }))
}
```

### Replace-all reminder semantics

On every resume:
1. `pending = await LocalNotifications.getPending()`
2. `await LocalNotifications.cancel({ notifications: pending.notifications.map(n => ({ id: n.id })) })`
3. `await LocalNotifications.schedule(buildPayload(upcoming))`

This is intentionally simple. The cost: a brief window where notifications are unscheduled during the cancel+reschedule. The alternative (diff against pending) is more correct but adds a join-by-id step. Lean simple per the stub.

### Open questions resolved

| Stub open question | Resolution |
|---|---|
| Reminders: replace-all vs diff | **Replace-all.** Simpler, the cancel+reschedule window is sub-second, and the existing reminder cadence is one-per-medication-dose so duplicates were never a real risk. Revisit if telemetry shows duplicates. |
| Barcode: single-shot vs continuous | **Single-shot.** Existing scanner.js flow is single-shot; continuous mode is a UX bet without a current need. |
| Geolocation: cache last-known position? | **Yes, 1h TTL, in-memory only.** No caller exists today (bootstrap uses Intl), but the cache is cheap and matches the stub's recommendation. |

### Geolocation has no current caller

The Explore pass confirmed `bootstrap.js:22` uses `Intl.DateTimeFormat().resolvedOptions().timeZone` and there are no `navigator.geolocation` calls anywhere in `web/static/`. The stub's "refactor existing feature code (tz prompt) to call the abstraction" instruction has nothing to refactor today. The Geolocation abstraction ships in Task 2 as scaffolding for future work (e.g. travel-aware tz correction) but Task 7's refactor leaves `bootstrap.js` alone.

If a future change wants to use device geolocation for tz detection, it lands through `window.Geolocation.getCurrentPosition()`; the wiring already exists.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only.*

**Real-device verification** (Android, Pixel-class or similar):
- Install the APK built with Phase 2a's pipeline + Phase 2b's npm dependencies.
- Trigger the food photo flow: confirm `@capacitor/camera` opens the native camera (not the WebView file-input), the photo lands in `POST /api/food/log/from-photo`, EXIF parsing works.
- Trigger the barcode scanner: confirm `@capacitor-mlkit/barcode-scanning` opens the native scanner (full-screen overlay), scans a real product barcode, hands the value to the existing food-add flow.
- Background the app, wait for a scheduled reminder to fire (set a 2-minute-from-now reminder before backgrounding). Confirm the notification fires natively (with the app fully backgrounded), and tapping it deep-links to the medication view.
- Background for 30 minutes during a known reminder window; confirm the notification still fires (Doze tolerance check).
- Grant/deny permissions during the first-use prompt for each capability; confirm graceful error states in the food flow when camera is denied.

**APK size delta**: measure the APK size before and after adding the four plugins (especially `@capacitor-mlkit/barcode-scanning` with its MLKit dependency). Document in `docs/local-mode.md` under "ABI coverage" or a new "APK size" subsection. Expected delta: ~5–10 MB.

**Decision capture**: update `docs/local-mode.md`'s "Native plugin JS abstractions" subsection from "Phase 2 work" to a description of the shipped abstraction pattern, including the runtime selector mechanism and the replace-all reminder semantics decision.

**Browser regression check**: load the PWA in Chrome, Firefox, and Safari (if accessible). Confirm food scanner + food photo still work end-to-end via the web impls. The Capacitor modules' dynamic-import path must not pollute browser console with module-not-found errors.

**Phase 2c gate**: once Phase 2b has baked on a real device for at least one week without notification-delivery surprises or permission-flow regressions, Phase 2c (`docs/plans/2026-05-22-mobile-phase2c-firstrun-secrets.md`) can be unblocked.
