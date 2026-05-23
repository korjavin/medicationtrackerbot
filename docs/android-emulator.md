# Android emulator dev loop

This document is the canonical reference for building, installing, and
debugging the medtracker mobile APK locally. It is referenced by
`CLAUDE.md`'s docs index and by `capacitor/README.md`.

The goal of the local emulator loop is to reproduce what CI's
`.github/workflows/android-apk.yml` produces — a debug APK that ships
`libmedtracker.so` and spawns it from `MainActivity.kt` — on a developer
machine, fast enough to iterate on overlay / manifest / Kotlin changes
without round-tripping through CI.

If you only need the WebView and a running backend (no overlay code under
test), the dev-server fallback is faster — see
[capacitor/README.md → Pointing at a server](../capacitor/README.md#pointing-at-a-server-dev-server-fallback).
The flow below is for the embedded-binary mode.

## Prerequisites

- **Android SDK** with the following packages installed via `sdkmanager`:
  - `cmdline-tools;latest`
  - `platform-tools` (provides `adb`)
  - `build-tools;34.0.0`
  - `platforms;android-34`
  - `emulator`
  - A system image matching your host's preferred ABI:
    - Apple Silicon: `system-images;android-34;google_apis;arm64-v8a`
    - Intel / Linux: `system-images;android-34;google_apis;x86_64`
- **Java 17** (e.g. Temurin 17). Capacitor 6 + AGP 8 require it; older JDKs
  fail with a confusing `Unsupported class file major version` error.
- **Node 20+** for `npx cap add android` / `npx cap sync`.
- **Go 1.26+** to cross-compile `libmedtracker.so`.
- **(Optional) Android NDK** if you want to cross-compile the
  `armeabi-v7a` and `x86_64` ABIs. Set `ANDROID_NDK_HOME` to its install
  root. Without an NDK, `scripts/build-android-binaries.sh` only produces
  `arm64-v8a` — which is fine if your emulator is arm64 too.

Standard env vars (put these in your shell profile):

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"     # macOS default
# export ANDROID_HOME="$HOME/Android/Sdk"           # Linux default
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
```

Verify with `sdkmanager --list_installed`, `java -version` (expect 17.x),
`adb --version`, `node --version`, and `go version`.

## Creating an AVD

On a fresh machine, install the packages and create the AVD:

```sh
sdkmanager --install \
  "platform-tools" \
  "build-tools;34.0.0" \
  "platforms;android-34" \
  "emulator" \
  "system-images;android-34;google_apis;arm64-v8a"   # or x86_64

avdmanager create avd \
  --name medtracker_api34 \
  --package "system-images;android-34;google_apis;arm64-v8a" \
  --device "pixel_6"
```

For Apple Silicon, **always pick the arm64-v8a system image** — x86_64
system images run under translation and are noticeably slower, and the
ABI mismatch means you'd have to ship `x86_64/libmedtracker.so` too
(which requires the NDK).

For Intel / Linux hosts, pick `x86_64`. Either way, your AVD's ABI must
match an ABI we ship in `lib/<abi>/libmedtracker.so` — if it doesn't,
the binary spawn fails at launch with a `pkg: not found` / exec error
in logcat.

The AVD config lives at `~/.android/avd/medtracker_api34.avd/` — edit
`config.ini` there to tweak RAM, heap, or storage size if needed.

## Starting the emulator

Launch the AVD headlessly (or from Android Studio's AVD Manager):

```sh
emulator -avd medtracker_api34 -no-snapshot-load &
```

`-no-snapshot-load` ensures a clean cold boot, which is what you want
the first time around. Subsequent launches without that flag are faster
because they restore from the last saved snapshot.

Verify the device is visible to `adb`:

```sh
adb devices
# List of devices attached
# emulator-5554   device
```

If `emulator-5554` shows `offline` for more than ~30 seconds, the emulator
process is hung — kill it (`adb emu kill` or just `kill %1`) and try
again with `-wipe-data` to reset the AVD state.

## Building the APK locally

The build sequence mirrors `.github/workflows/android-apk.yml`. Run from
the repo root:

```sh
# 1. Cross-compile the Go binary into the overlay's jniLibs tree.
./scripts/build-android-binaries.sh
# arm64-v8a always; armv7 + x86_64 only when ANDROID_NDK_HOME is set.

# 2. Install Capacitor deps and generate the android/ project.
cd capacitor
npm install --no-audit
npx cap add android

# 3. Apply the overlay (manifest, Kotlin sources, gradle wire-in).
./apply-overlay.sh

# 4. Sync Capacitor's plugin entries into android/, then re-apply the
#    overlay (cap sync rewrites manifest + app/build.gradle).
npx cap sync
./apply-overlay.sh
./verify-overlay-applied.sh     # asserts GoServerService + apply-from line

# 5. Assemble the debug APK.
cd android
./gradlew assembleDebug --no-daemon
```

The resulting APK is at
`capacitor/android/app/build/outputs/apk/debug/app-debug.apk`.

If `assembleDebug` fails with `Duplicate class
com.korjavin.medtracker.MainActivity`, the overlay's `apply-overlay.sh`
did not delete the Capacitor-generated `MainActivity.java` stub —
re-run `./apply-overlay.sh` from `capacitor/` and check that
`capacitor/android/app/src/main/java/com/korjavin/medtracker/MainActivity.java`
is gone.

## Installing and launching

```sh
adb install -r capacitor/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -W -n com.korjavin.medtracker/.MainActivity
```

`-r` reinstalls if the app is already on the device (keeps data
intact). `am start -W` waits for the activity to be fully started and
prints the launch time — useful for catching regressions in cold-start
latency.

## Logcat tags to watch

```sh
adb logcat -c                                          # clear the buffer
adb logcat -v time \
  MedtrackerActivity:V MedtrackerGo:V \
  Capacitor:I Capacitor/Console:V \
  AndroidRuntime:E *:S
```

What each tag means:

- **`MedtrackerActivity`** — the `MainActivity.kt` bootstrap. You should
  see the activity binding to `GoServerService`, awaiting `LISTENING`,
  polling `/healthz`, and finally calling `WebView.loadUrl`.
- **`MedtrackerGo`** — passthrough of the Go binary's stdout / stderr
  (set by `GoServerService.LOGCAT_TAG`). The line `LISTENING
  127.0.0.1:<port>` is the signal the activity is waiting for.
- **`GoServerService`** — service lifecycle: spawn, grace-period
  SIGTERM, respawn after backgrounding.
- **`Capacitor/Console`** — JS `console.log` from the WebView. The
  frontend's slog-like prefix `[messenger-adapter] BrowserAdapter
  selected` appears here.
- **`Capacitor`** — asset resolution + plugin lifecycle. The asset-URL
  error cascade (`Unable to open asset URL: https://localhost/static/…`)
  appears here when the binary spawn never reached the WebView load —
  it should be **absent** in a healthy run.
- **`AndroidRuntime:E`** — uncaught exceptions / process crashes.

## Verifying spawn

In a healthy launch, logcat shows roughly:

```
I MedtrackerActivity: Spawned Go binary, pid=<pid>
I MedtrackerGo:       LISTENING 127.0.0.1:<port>
I MedtrackerActivity: /healthz on http://127.0.0.1:<port> responded; loading WebView
I Capacitor/Console:  [messenger-adapter] BrowserAdapter selected
```

If you see the activity log lines but not the `LISTENING` line within
10 seconds, the spawn is broken — most commonly because
`libmedtracker.so` was built for the wrong ABI (check `adb shell
getprop ro.product.cpu.abi` against `lib/<abi>/libmedtracker.so` in
the APK).

If `LISTENING` appears but the WebView shows a blank page with `Unable
to open asset URL` cascading errors, the overlay's Kotlin sources
didn't compile and the APK is using Capacitor's default
`BridgeActivity` — re-run `verify-overlay-applied.sh` and rebuild.

## Clearing state between runs

The app stores its SQLite DB at `/data/data/com.korjavin.medtracker/files/medtracker.db`
and its session secret in EncryptedSharedPreferences. To wipe both:

```sh
adb shell pm clear com.korjavin.medtracker
```

After this the next launch behaves like a fresh install: the binary
generates a new session secret, the SQLite DB is recreated, and the
first-run overlay appears in the WebView.

To wipe just the DB but keep the session secret, delete the file
directly:

```sh
adb shell run-as com.korjavin.medtracker rm -f files/medtracker.db
```

## Common gotchas

- **Emulator ABI must match `libmedtracker.so` ABIs in the APK.** Apple
  Silicon AVDs are arm64-v8a; Intel / Linux AVDs are typically x86_64.
  If the APK's `lib/` doesn't include the AVD's ABI, the
  `Runtime.exec()` of `libmedtracker.so` fails. Cross-compile the
  matching ABI (NDK required for x86_64) or use an AVD that matches
  what `scripts/build-android-binaries.sh` produced.
- **Cleartext-traffic to loopback is blocked by default on API 28+.**
  The overlay's manifest already sets `android:usesCleartextTraffic="true"`
  on `<application>` — if you ever regenerate the manifest, do not lose
  that attribute or `WebView.loadUrl("http://127.0.0.1:<port>")` will
  silently fail.
- **SELinux blocks `exec()` on JNI libs unless `extractNativeLibs="true"`.**
  Also already in the overlay's manifest. Without it, Android 6+ keeps
  `libmedtracker.so` mmap'd inside the APK and the binary can't be
  spawned with `Runtime.exec()`.
- **`npx cap sync` rewrites `AndroidManifest.xml` and `app/build.gradle`.**
  Always re-run `./apply-overlay.sh` after `cap sync`, then
  `./verify-overlay-applied.sh` to confirm the overlay survived. CI
  does the same.
- **The Kotlin Android plugin classpath must be on the project-level
  `build.gradle`.** Capacitor 6's default project-level gradle does
  NOT include it; `apply-overlay.sh` injects the line. If you regenerate
  `capacitor/android/` and skip `apply-overlay.sh`, the Kotlin sources
  silently get dropped and the APK falls back to a bare
  `BridgeActivity`.
- **Emulator clipboard / file picker are flaky.** If the food-photo or
  barcode-scan UI seems unresponsive, test on a physical device —
  Capacitor's MLKit / camera plugin behavior differs measurably between
  emulator and physical, and physical is the canonical target.

## Verifying a built APK

After building the APK (either via the GitHub Actions workflow or the
local gradle invocation), run `scripts/verify-apk.sh` to confirm the build
shipped what we expect.

```sh
./scripts/verify-apk.sh capacitor/android/app/build/outputs/apk/debug/app-debug.apk
```

The script unzips the APK into a temp directory and asserts:

1. `lib/arm64-v8a/libmedtracker.so` is present. This is the cross-compiled
   Go binary the Android shell spawns at launch.
2. `classes*.dex` contains the strings `GoServerService` and
   `MedtrackerActivity`. Their presence proves the Kotlin Android plugin
   compiled the overlay's `.kt` sources rather than silently dropping them
   (which would leave the APK with a bare `BridgeActivity` and no binary
   spawn — the regression Task 1 of the apk-spawn plan exists to prevent).
3. `assets/public/index.html` exists and does **not** reference
   `telegram.org`. The Telegram WebApp SDK is loaded dynamically by
   `web/static/js/core/messenger-adapter.js` only when running outside
   Capacitor — the mobile APK must never make an external network call for
   it.

A non-zero exit code means the APK is structurally broken. The script is
also wired into `.github/workflows/android-apk.yml` immediately after the
APK is renamed, so any of these regressions fails CI before the artifact is
uploaded.

The script's own assertion logic is covered by
`scripts/tests/verify-apk-test.sh`, which builds tiny fixture zip files and
exercises each pass/fail path.

## Switching to dev-server mode

If you're iterating on the frontend or backend without overlay code
under test, the embedded-binary build is overkill — `gradle assembleDebug`
takes minutes and `cap sync` rewrites things you don't care about.

Uncomment the `server` block in `capacitor/capacitor.config.ts` and
point it at a running `go run ./cmd/bot` (on the host, accessible from
the emulator as `http://10.0.2.2:8080`), then `npx cap sync && npx cap
open android` and run from Android Studio. See
[capacitor/README.md → Pointing at a server](../capacitor/README.md#pointing-at-a-server-dev-server-fallback)
for the full details.
