import type { CapacitorConfig } from '@capacitor/cli';

// Embedded-binary configuration (Phase 2a shipped).
//
// `webDir` points at the existing PWA bundle at the repo root (`web/static/`)
// so `npx cap sync` has something to copy into the native projects. At
// runtime the WebView is loaded by `MainActivity.kt` from
// `http://127.0.0.1:<port>` — the port the embedded Go binary reports via
// its `LISTENING 127.0.0.1:<port>` stdout line.
//
// No `server.url` is set: that flag is the dev-server fallback gate in
// `MainActivity.onCreate` (lines 118-123). When unset, the activity spawns
// `GoServerService`, waits for `LISTENING`, polls `/healthz`, and only then
// loads the WebView. The APK is fully self-sufficient — no external server.
//
// Local dev-server workflow (point the WebView at a running
// `go run ./cmd/bot`): uncomment the `server` block below and set the URL
// for your platform. DO NOT commit that edit.
//   For iOS Simulator: 'http://localhost:8080'
//   For Android emulator: 'http://10.0.2.2:8080' (emulator host alias)
//   For a deployed server: e.g. 'https://meds.example.com'
const config: CapacitorConfig = {
  appId: 'com.lochyard.medtracker',
  appName: 'medtracker',
  webDir: '../web/static',
  // server: {
  //   url: 'http://10.0.2.2:8080',
  //   cleartext: true,
  // },
  plugins: {
    // Phase 2b: local-notifications drives reminder firings on the mobile
    // build. The icon name refers to a drawable resource that ships with the
    // Android shell (mipmap/ic_launcher is the launcher icon, used as a
    // fallback until a dedicated white-on-transparent notification icon is
    // added under res/drawable). smallIcon must match a resource name without
    // the @drawable/ prefix; the plugin resolves it from the app's resources.
    LocalNotifications: {
      smallIcon: 'ic_launcher',
      iconColor: '#2481cc',
      sound: undefined,
    },
  },
};

export default config;
