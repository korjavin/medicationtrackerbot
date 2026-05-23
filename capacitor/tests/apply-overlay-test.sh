#!/bin/sh
# Tests for apply-overlay.sh.
#
# Creates a fake `capacitor/android/` tree mirroring what `npx cap add
# android` produces (including the auto-generated MainActivity.java stub),
# runs apply-overlay.sh against it, and asserts:
#   1. the MainActivity.java stub is gone
#   2. MainActivity.kt from the overlay is in place
#   3. the script's second run is idempotent (no error, stub stays gone)
#
# Usage:
#   sh capacitor/tests/apply-overlay-test.sh
#
# Exits 0 on success, 1 on failure.

set -eu

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
CAPACITOR_DIR=$(cd -- "${SCRIPT_DIR}/.." && pwd)
OVERLAY_DIR="${CAPACITOR_DIR}/android-overlay"
APPLY_OVERLAY="${CAPACITOR_DIR}/apply-overlay.sh"

if [ ! -f "$APPLY_OVERLAY" ]; then
  printf 'fail: apply-overlay.sh not found at %s\n' "$APPLY_OVERLAY" >&2
  exit 1
fi

if [ ! -d "$OVERLAY_DIR" ]; then
  printf 'fail: overlay dir missing at %s\n' "$OVERLAY_DIR" >&2
  exit 1
fi

# Stage the test sandbox. We mirror only the capacitor/ subset apply-overlay
# touches: SCRIPT_DIR (the script's own dir), android-overlay/ (the source),
# and android/ (the destination it operates on).
TMP_ROOT=$(mktemp -d 2>/dev/null || mktemp -d -t apply-overlay-test)
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

FAKE_CAP="${TMP_ROOT}/capacitor"
mkdir -p "$FAKE_CAP"
cp "$APPLY_OVERLAY" "${FAKE_CAP}/apply-overlay.sh"
chmod +x "${FAKE_CAP}/apply-overlay.sh"
cp -R "$OVERLAY_DIR" "${FAKE_CAP}/android-overlay"

FAKE_ANDROID="${FAKE_CAP}/android"
JAVA_PKG_DIR="${FAKE_ANDROID}/app/src/main/java/com/korjavin/medtracker"
mkdir -p "$JAVA_PKG_DIR"

# Plant the auto-generated MainActivity.java stub that `cap add android`
# emits — same shape Capacitor 6 produces.
cat > "${JAVA_PKG_DIR}/MainActivity.java" <<'EOF'
package com.korjavin.medtracker;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {}
EOF

# Plant a minimal app/build.gradle so the script's apply-from reminder
# path doesn't blow up (it greps for a line; we just need the file to exist).
mkdir -p "${FAKE_ANDROID}/app"
cat > "${FAKE_ANDROID}/app/build.gradle" <<'EOF'
// fake placeholder for tests
EOF
cat > "${FAKE_ANDROID}/build.gradle" <<'EOF'
buildscript {
    dependencies {
        classpath 'com.android.tools.build:gradle:8.2.1'
    }
}
EOF

# First run: stub present → should be removed.
if [ ! -f "${JAVA_PKG_DIR}/MainActivity.java" ]; then
  printf 'fail: precondition — stub not staged\n' >&2
  exit 1
fi

cd "$FAKE_CAP"
./apply-overlay.sh > "${TMP_ROOT}/run1.log" 2>&1 || {
  status=$?
  printf 'fail: apply-overlay.sh exited %d on first run\n' "$status" >&2
  cat "${TMP_ROOT}/run1.log" >&2
  exit 1
}

if [ -f "${JAVA_PKG_DIR}/MainActivity.java" ]; then
  printf 'fail: MainActivity.java stub still present after apply-overlay.sh\n' >&2
  exit 1
fi

if [ ! -f "${JAVA_PKG_DIR}/MainActivity.kt" ]; then
  printf 'fail: MainActivity.kt not copied from overlay\n' >&2
  exit 1
fi

if ! grep -qF "removed auto-generated MainActivity.java stub" "${TMP_ROOT}/run1.log"; then
  printf 'fail: expected guard log line not present in first-run output\n' >&2
  cat "${TMP_ROOT}/run1.log" >&2
  exit 1
fi

# Kotlin Gradle Plugin classpath must have been injected after the AGP line.
# Without this, the overlay's .kt sources silently drop from the APK.
if ! grep -qF "org.jetbrains.kotlin:kotlin-gradle-plugin" "${FAKE_ANDROID}/build.gradle"; then
  printf 'fail: Kotlin Gradle Plugin classpath not injected into project build.gradle\n' >&2
  cat "${FAKE_ANDROID}/build.gradle" >&2
  exit 1
fi

# Second run: stub already gone → script must remain idempotent and not
# emit the removal log line.
./apply-overlay.sh > "${TMP_ROOT}/run2.log" 2>&1 || {
  status=$?
  printf 'fail: apply-overlay.sh exited %d on second (idempotent) run\n' "$status" >&2
  cat "${TMP_ROOT}/run2.log" >&2
  exit 1
}

if grep -qF "removed auto-generated MainActivity.java stub" "${TMP_ROOT}/run2.log"; then
  printf 'fail: second run still emitted removal log (should be idempotent)\n' >&2
  exit 1
fi

if [ -f "${JAVA_PKG_DIR}/MainActivity.java" ]; then
  printf 'fail: stub somehow reappeared on second run\n' >&2
  exit 1
fi

# Idempotency: the Kotlin classpath line must appear exactly once after the
# second run (the awk insert is guarded by `grep -qF` and must not re-fire).
kotlin_count=$(grep -cF "org.jetbrains.kotlin:kotlin-gradle-plugin" "${FAKE_ANDROID}/build.gradle" 2>/dev/null || echo 0)
if [ "$kotlin_count" != "1" ]; then
  printf 'fail: Kotlin classpath count after second run is %s, expected 1\n' "$kotlin_count" >&2
  cat "${FAKE_ANDROID}/build.gradle" >&2
  exit 1
fi

printf 'pass: apply-overlay.sh deletes MainActivity.java stub and is idempotent\n'
