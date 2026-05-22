import type { CapacitorConfig } from '@capacitor/cli';

// Phase 1 spike configuration.
//
// `webDir` points at the existing PWA bundle at the repo root (`web/static/`)
// so `npx cap sync` has something to copy into the native projects. In the
// spike, the webview actually loads the URL from `server.url` below — this
// proves the Capacitor wrapper works against the deployed/dev server before
// we commit to embedding the Go binary.
//
// Phase 2 will:
//   - drop `server.url`
//   - either embed a Go binary on a localhost port (and point `server.url`
//     at it) OR ship the PWA fully offline using `webDir` alone
//   - add native plugin abstractions (Camera, LocalNotifications,
//     Geolocation, Barcode) — none of those are wired here.
const config: CapacitorConfig = {
  appId: 'com.lochyard.medtracker',
  appName: 'medtracker',
  webDir: '../web/static',
  server: {
    // Override locally by editing this file (do NOT commit a personal IP).
    // For iOS Simulator: 'http://localhost:8080' works.
    // For Android emulator: use 'http://10.0.2.2:8080' (emulator host alias).
    // For a deployed server: e.g. 'https://meds.example.com'.
    url: 'http://localhost:8080',
    cleartext: true,
  },
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
