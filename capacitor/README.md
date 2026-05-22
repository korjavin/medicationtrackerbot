Capacitor spike — wraps the medtracker PWA into iOS / Android shells.

Status: Phase 2a in progress on Android. The wrapper has two supported modes:

1. **Dev-server mode** (Phase 1 spike) — `capacitor.config.ts` sets `server.url`
   to a running `go run ./cmd/bot`. Fast inner loop, no rebuild between
   backend changes. Currently the default; preserved as a fallback for
   iterating on the WebView/frontend without re-cross-compiling the Go binary.
2. **Embedded-binary mode** (Phase 2a) — Android only. The shell spawns the
   mobile-build Go binary on a localhost port, waits for `/healthz`, and
   loads the WebView from that port. The binary lives in the per-app
   `nativeLibraryDir`, dropped there by Android's automatic `lib*.so`
   extraction. See "Building with the embedded Go binary" below.

Native plugin abstractions (camera, geolocation, barcode, local notifications)
are Phase 2b, separate from this README.

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
npx cap open android
```

`scripts/build-android-binaries.sh` runs `CGO_ENABLED=0 GOOS=android
GOARCH=arm64 go build -tags mobile ./cmd/bot` and writes the result to the
overlay's jniLibs tree. It also tries `armeabi-v7a` and `x86_64` if
`ANDROID_NDK_HOME` is set (those targets require CGO + NDK clang and are
v1.1 work — modern devices are arm64, the v1 baseline ships arm64-only).
See `docs/local-mode.md` → "Phase 2a build pipeline" for the why.

`apply-overlay.sh` is idempotent. Re-run it any time you regenerate
`capacitor/android/` via `cap add` or change overlay sources.

Pointing at a server (dev-server fallback)
------------------------------------------
Edit `capacitor.config.ts` and set `server.url`:

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
  notifications` lives in front-end work that is not yet wired here.
- `GET /api/reminders/upcoming` returns the next N reminders for the JS
  bridge to schedule natively.
