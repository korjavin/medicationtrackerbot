# Android emulator dev loop

This document is the canonical reference for building, installing, and
debugging the medtracker mobile APK locally. It is referenced by
`CLAUDE.md`'s docs index and by `capacitor/README.md`.

> The full dev loop (SDK setup, AVD creation, emulator launch, install,
> logcat, state-clearing) is owned by Task 7 of the
> `2026-05-23-fix-apk-spawn-and-strip-telegram` plan and is being filled in
> there. The "Verifying a built APK" section below is owned by Task 5 and is
> already authoritative.

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
