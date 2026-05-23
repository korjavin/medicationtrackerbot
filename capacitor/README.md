Capacitor spike — wraps the medtracker PWA into iOS / Android shells.

Status: Phase 2a shipped on Android. The wrapper has two supported modes:

1. **Embedded-binary mode** (Phase 2a, default) — Android only. The shell
   spawns the mobile-build Go binary on a localhost port, waits for
   `/healthz`, and loads the WebView from that port. The binary lives in
   the per-app `nativeLibraryDir`, dropped there by Android's automatic
   `lib*.so` extraction. This is what the committed `capacitor.config.ts`
   produces and what the CI APK build ships. See "Building with the
   embedded Go binary" below.
2. **Dev-server mode** (Phase 1 spike, opt-in) — uncomment the `server.url`
   block in `capacitor.config.ts` to point the WebView at a running
   `go run ./cmd/bot`. Fast inner loop, no rebuild between backend changes.
   Preserved for iterating on the WebView/frontend without re-cross-compiling
   the Go binary; do NOT commit the edit.

Native plugin abstractions (camera, geolocation, barcode, local notifications)
are Phase 2b — see the "Phase 2b plugins" section below for the plugin set,
required AndroidManifest permissions, and the post-pull setup steps.

Prerequisites
-------------
- Node 18+ (use `node --version` to verify)
- Xcode 15+ (for iOS) — install from the Mac App Store, then accept the
  license: `sudo xcodebuild -license`
- Android Studio (for Android) with SDK Platform 34 installed
- CocoaPods (for iOS): `sudo gem install cocoapods`

One-time setup
--------------
```sh
cd capacitor
npm install
npx cap add ios
npx cap add android
```

`npx cap add ios` creates `capacitor/ios/`; `npx cap add android` creates
`capacitor/android/`. Both directories are gitignored — re-running `cap add`
on a fresh checkout regenerates them.

Iterate
-------
Whenever you change `web/static/` or `capacitor.config.ts`, copy the changes
into the native projects:
```sh
npx cap sync
```

Open the native IDE:
```sh
npx cap open ios       # Xcode
npx cap open android   # Android Studio
```

From there, build & run on the simulator/emulator with the IDE's normal
Run button.

Building with the embedded Go binary (Android, Phase 2a)
--------------------------------------------------------
The Android shell can spawn a Go binary embedded inside the APK instead of
talking to an external dev server. The binary lives under
`capacitor/android-overlay/app/src/main/jniLibs/<abi>/libmedtracker.so` —
that directory is committed (but the `.so` files themselves are gitignored
and re-built locally).

Full build flow on a fresh checkout:

```sh
cd capacitor
npm install
npx cap add android                 # generates android/ (gitignored)
../scripts/build-android-binaries.sh
./apply-overlay.sh                  # copies android-overlay/ → android/
npx cap sync
./apply-overlay.sh                  # re-apply: cap sync may have clobbered manifest / apply-from
./verify-overlay-applied.sh         # asserts GoServerService manifest entry + apply-from line
npx cap open android
```

The double `apply-overlay.sh` + `verify-overlay-applied.sh` pair is what
the CI workflow runs and is the supported way to catch a `cap sync`
regression locally before opening Android Studio. The paragraph
beginning "`npx cap sync` may rewrite ..." below explains why this is
necessary.

> The committed `capacitor.config.ts` leaves `server.url` unset, so the
> overlay's `MainActivity` takes the embedded-binary spawn path by default
> — the APK is self-sufficient out of the box. Uncomment the `server`
> block in `capacitor.config.ts` to fall back to the dev-server path
> instead (see "Pointing at a server" below).

`scripts/build-android-binaries.sh` runs `CGO_ENABLED=0 GOOS=android
GOARCH=arm64 go build -tags mobile ./cmd/bot` and writes the result to the
overlay's jniLibs tree. It also tries `armeabi-v7a` and `x86_64` if
`ANDROID_NDK_HOME` is set (those targets require CGO + NDK clang and are
v1.1 work — modern devices are arm64, the v1 baseline ships arm64-only).
See `docs/local-mode.md` → "Phase 2a build pipeline" for the why.

`apply-overlay.sh` is idempotent. Re-run it any time you regenerate
`capacitor/android/` via `cap add` or change overlay sources.

`npx cap sync` may rewrite `AndroidManifest.xml` (Capacitor reinjects plugin
entries) and `app/build.gradle` (re-applies `capacitor.build.gradle`), which
can drop our overlay's manifest and the `apply from: 'medtracker.build.gradle'`
wire-in. Re-run `apply-overlay.sh` (and re-append the apply-from line) AFTER
`cap sync`, then verify with:

```sh
./verify-overlay-applied.sh   # or: npm run verify:overlay
```

This greps for `GoServerService` in the manifest and the apply-from line in
`app/build.gradle`, exiting non-zero if either is missing. CI runs the same
checks before `gradlew assembleDebug`.

Local emulator testing
----------------------
The full dev loop — Android SDK setup, AVD creation, building the APK
locally, installing on the emulator, logcat tags to watch, and how to
clear state between runs — is documented in
[`docs/android-emulator.md`](../docs/android-emulator.md). That doc also
covers `scripts/verify-apk.sh`, the APK structural verifier CI runs after
`assembleDebug`.

Pointing at a server (dev-server fallback)
------------------------------------------
Edit `capacitor.config.ts` and uncomment the `server` block, setting
`server.url`:

- iOS Simulator → host's `localhost` is shared: `http://localhost:8080`
- Android emulator → use the host alias: `http://10.0.2.2:8080`
- Physical device → use your host's LAN IP, e.g. `http://192.168.1.42:8080`
  (and make sure your `go run ./cmd/bot` binds `0.0.0.0`, not `127.0.0.1`)
- Deployed server → `https://meds.example.com`

After editing, run `npx cap sync` so the change propagates to the native
projects.

Spike known limitations
-----------------------
- Telegram `initData` auth flow does not work inside the webview — the
  WebView has no Telegram client. Use OIDC or session-cookie login during
  the spike, or wait for the Phase 2 `LocalUserResolver` (`go build -tags
  mobile`) once the binary is embedded.
- Camera, geolocation, barcode, and local notifications all currently use
  the browser APIs they have in the PWA. Native plugin shims are Phase 2.
- iOS background execution is not configured — the scheduler does not run
  in the background. Phase 2 introduces `LocalNotifications` scheduled via
  `/api/reminders/upcoming` to address this.

Phase 2 hooks
-------------
- `cmd/bot/main_mobile.go` is the entry point for `go build -tags mobile
  ./...` — it skips bot/MCP/web-push/OIDC and uses a single fixed user.
- `internal/scheduler/sink_localnotifications.go` is the mobile reminder
  sink; the JS bridge that hands reminders to `@capacitor/local-
  notifications` lives in `web/static/js/native/capacitor/reminders.js`
  (Phase 2b — see below).
- `GET /api/reminders/upcoming` returns the next N reminders for the JS
  bridge to schedule natively.

Phase 2b plugins
----------------
Phase 2b adds four Capacitor plugins for native device access. The JS-side
abstraction (`web/static/js/native/`) picks the web or Capacitor impl at
runtime based on `Capacitor.isNativePlatform()` — see
`docs/plans/2026-05-22-mobile-phase2b-native-plugins.md` for the design.

Plugins wired (in `package.json`):

- `@capacitor/camera` — native camera UI + photo picker for the food-photo
  flow. Replaces the WebView `<input type="file" capture="environment">`.
- `@capacitor/geolocation` — coarse location for future travel-aware tz
  correction. No current caller; the abstraction is scaffolding.
- `@capacitor-mlkit/barcode-scanning` — full-screen MLKit barcode scanner.
  Replaces `BarcodeDetector` + the ZXing fallback in `food/scanner.js`.
- `@capacitor/local-notifications` — OS-level reminder firings. Replaces
  Web Push in the Capacitor build (the Go scheduler's
  `LocalNotificationSink` populates `GET /api/reminders/upcoming` and the
  Capacitor `reminders.js` impl pre-schedules from that endpoint on app
  resume).
- `@capacitor/app` — exposes the `appStateChange` event the reminder
  pre-schedule loop subscribes to. Without it, `window.Capacitor.Plugins.App`
  is undefined at runtime and the resume re-fetch never registers — the
  OS-scheduled queue would only refresh on cold launch.

AndroidManifest permissions added (in `android-overlay/`):

- `CAMERA` — `@capacitor/camera` + `@capacitor-mlkit/barcode-scanning`.
- `ACCESS_COARSE_LOCATION` — `@capacitor/geolocation`. Fine location is
  intentionally NOT requested.
- `POST_NOTIFICATIONS` (already present for the service notification) —
  also required by `@capacitor/local-notifications` on API 33+.
- `SCHEDULE_EXACT_ALARM` — so reminders fire at the scheduled minute on
  API 31+ under Doze, instead of getting batched.
- `<uses-feature android:name="android.hardware.camera"
  android:required="false">` — so the app installs on cameraless devices
  (camera/barcode features then fail at runtime there).
- `<meta-data android:name="com.google.mlkit.vision.DEPENDENCIES"
  android:value="barcode">` — bundles the MLKit barcode model at install
  time so the first scan doesn't trigger a Play Services model download.

Setup after pulling Phase 2b on a fresh checkout:

```sh
cd capacitor
npm install                          # picks up the four new plugins
npx cap add android                  # regenerates capacitor/android/
../scripts/build-android-binaries.sh # builds libmedtracker.so per ABI
./apply-overlay.sh                   # copies overlay (incl. new manifest)
npx cap sync                         # syncs the plugins into android/
npx cap open android                 # opens Android Studio
```

Verification checklist on a real device:

- Food photo: tapping the camera button opens the OS camera UI (not the
  WebView file input), the resulting photo posts to
  `POST /api/food/log/from-photo`, EXIF parsing works.
- Barcode scan: tapping the scan button opens the MLKit full-screen
  scanner, scans a real product barcode, hands the value to the existing
  food-add flow.
- Reminders: schedule a medication reminder ~2 minutes out, background
  the app, confirm the notification fires natively while backgrounded,
  and tapping it deep-links to the medication confirm view.
