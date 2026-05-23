#!/bin/sh
# Verify that a built medtracker APK contains the expected overlay symbols
# and assets. Complements the unit tests:
#
#   - Unit tests verify intent: apply-overlay.sh removes the Java stub,
#     index.html has no telegram.org tag, messenger-adapter dynamic-loads it.
#   - This script verifies the result: the overlay Kotlin classes actually
#     made it into the dex, libmedtracker.so is bundled for arm64-v8a, and
#     the packaged assets/public/index.html still has no telegram.org link.
#
# Assertions:
#   1. lib/arm64-v8a/libmedtracker.so present (baseline ABI).
#   2. strings on classes*.dex contains:
#        - GoServerService     (the foreground service that spawns the binary)
#        - MedtrackerActivity  (the log tag emitted by our MainActivity.kt)
#      Their presence proves the Kotlin Android plugin compiled the overlay
#      .kt sources rather than silently dropping them.
#   3. assets/public/index.html exists and does NOT contain "telegram.org"
#      (regression guard — the SDK must only be dynamic-loaded by
#      messenger-adapter.js outside Capacitor).
#
# Usage:
#   scripts/verify-apk.sh path/to/app-debug.apk
#
# Exits 0 on success, 1 on assertion failure, 2 on usage error.

set -eu

usage() {
  printf 'Usage: %s <apk-path>\n' "$0" >&2
}

if [ $# -ne 1 ]; then
  usage
  exit 2
fi

APK=$1

if [ ! -f "$APK" ]; then
  printf 'fail: APK not found at %s\n' "$APK" >&2
  exit 1
fi

for cmd in unzip strings; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf 'fail: required tool %s not on PATH\n' "$cmd" >&2
    exit 1
  fi
done

WORK=$(mktemp -d 2>/dev/null || mktemp -d -t verify-apk)
trap 'rm -rf "$WORK"' EXIT INT TERM

# Quiet extraction; we only need dex files, the manifest of entries, and the
# packaged index.html.
unzip -q -o "$APK" -d "$WORK"

failed=0

# 1. arm64-v8a binary present.
SO_PATH="${WORK}/lib/arm64-v8a/libmedtracker.so"
if [ ! -f "$SO_PATH" ]; then
  printf 'fail: lib/arm64-v8a/libmedtracker.so missing from APK\n' >&2
  failed=1
else
  printf 'ok: lib/arm64-v8a/libmedtracker.so present\n'
fi

# 2. Overlay Kotlin classes compiled into the dex. classes.dex always exists;
# classes2.dex+ only when multidex kicks in. Scan all of them so we don't
# depend on AGP's split heuristics.
DEX_GLOB=$(find "$WORK" -maxdepth 1 -type f -name 'classes*.dex' 2>/dev/null || true)
if [ -z "$DEX_GLOB" ]; then
  printf 'fail: no classes*.dex found in APK\n' >&2
  failed=1
else
  for symbol in GoServerService MedtrackerActivity; do
    if printf '%s\n' "$DEX_GLOB" | xargs strings 2>/dev/null | grep -qF "$symbol"; then
      printf 'ok: dex contains %s\n' "$symbol"
    else
      printf 'fail: %s not found in classes*.dex — overlay .kt sources were not compiled\n' "$symbol" >&2
      failed=1
    fi
  done
fi

# 3. Packaged index.html exists and is Telegram-free.
INDEX="${WORK}/assets/public/index.html"
if [ ! -f "$INDEX" ]; then
  printf 'fail: assets/public/index.html missing from APK\n' >&2
  failed=1
elif grep -qF "telegram.org" "$INDEX"; then
  printf 'fail: assets/public/index.html still references telegram.org\n' >&2
  printf '       Strip the script tag — messenger-adapter.js dynamic-loads it.\n' >&2
  failed=1
else
  printf 'ok: assets/public/index.html packaged and telegram-free\n'
fi

if [ "$failed" -ne 0 ]; then
  printf '\nverify-apk.sh: FAIL\n' >&2
  exit 1
fi

printf '\nverify-apk.sh: PASS\n'
