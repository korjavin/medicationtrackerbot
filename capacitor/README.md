Capacitor spike — wraps the medtracker PWA into iOS / Android shells.

Status: Phase 1 spike. The wrapper points its webview at a running server
(`http://localhost:8080` by default — edit `capacitor.config.ts` to change).
It does NOT yet embed the Go binary or call native plugins. That is Phase 2.

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

Pointing at a server
--------------------
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
