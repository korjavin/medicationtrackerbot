#!/bin/sh
# Verify that the overlay's markers are present in capacitor/android/.
#
# `npx cap sync` may regenerate AndroidManifest.xml (Capacitor reinjects
# plugin entries) or rewrite app/build.gradle (re-applies
# capacitor.build.gradle). If our overlay's manifest / apply-from wire-in
# gets lost between `apply-overlay.sh` and `gradlew assembleDebug`, the
# resulting APK ships a bare BridgeActivity again and silently regresses
# back to the broken state Task 3 of the apk-spawn plan exists to prevent.
#
# This script asserts:
#   1. android/app/src/main/AndroidManifest.xml contains the
#      GoServerService declaration (overlay manifest is in place).
#   2. android/app/build.gradle contains
#      `apply from: 'medtracker.build.gradle'` (the wire-in line that pulls
#      in the Kotlin plugin + deps).
#
# Usage:
#   sh capacitor/verify-overlay-applied.sh
#
# Exits 0 on success, 1 on failure. Run AFTER `apply-overlay.sh` (and
# ideally after `npx cap sync`, to catch sync-time regressions early).

set -eu

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
ANDROID_DIR="${SCRIPT_DIR}/android"

MANIFEST="${ANDROID_DIR}/app/src/main/AndroidManifest.xml"
APP_GRADLE="${ANDROID_DIR}/app/build.gradle"

failed=0

if [ ! -f "$MANIFEST" ]; then
  printf 'fail: %s not found (did you run "npx cap add android"?)\n' "$MANIFEST" >&2
  failed=1
elif ! grep -qF "GoServerService" "$MANIFEST"; then
  printf 'fail: GoServerService not declared in %s\n' "$MANIFEST" >&2
  printf '       overlay AndroidManifest.xml was lost — re-run apply-overlay.sh\n' >&2
  failed=1
fi

if [ ! -f "$APP_GRADLE" ]; then
  printf 'fail: %s not found\n' "$APP_GRADLE" >&2
  failed=1
elif ! grep -qF "apply from: 'medtracker.build.gradle'" "$APP_GRADLE"; then
  printf 'fail: "apply from: '"'"'medtracker.build.gradle'"'"'" missing from %s\n' "$APP_GRADLE" >&2
  printf '       Kotlin plugin + deps will not be applied — re-wire after cap sync\n' >&2
  failed=1
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi

printf 'pass: overlay markers present (GoServerService + apply-from)\n'
