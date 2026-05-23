#!/bin/sh
# Tests for scripts/verify-apk.sh.
#
# Builds tiny fixture APKs (just zip files with the right entries) covering:
#   1. healthy APK — all assertions pass, exit 0.
#   2. missing arm64-v8a binary — fails the lib/* check.
#   3. dex missing GoServerService — fails the overlay-symbol check.
#   4. dex missing MedtrackerActivity — fails the overlay-symbol check.
#   5. assets/public/index.html still mentions telegram.org — fails the
#      regression-guard check.
#   6. usage error (no arg) — exit 2.
#   7. nonexistent APK path — exit 1.
#
# We don't need a real APK — verify-apk.sh treats the input as a zip and
# scans extracted files, so a hand-built zip with the right entry names is
# enough to exercise every code path.
#
# Usage:
#   sh scripts/tests/verify-apk-test.sh
#
# Exits 0 on success, 1 on failure.

set -eu

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(cd -- "${SCRIPT_DIR}/../.." && pwd)
VERIFY="${REPO_ROOT}/scripts/verify-apk.sh"

if [ ! -x "$VERIFY" ]; then
  printf 'fail: %s not found or not executable\n' "$VERIFY" >&2
  exit 1
fi

for cmd in zip unzip strings; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf 'skip: required tool %s missing — verify-apk-test cannot run\n' "$cmd" >&2
    exit 0
  fi
done

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t verify-apk-test)
trap 'rm -rf "$TMP"' EXIT INT TERM

# Build a healthy fixture tree, then variants that fail individual checks.
# All fixtures use the same APK-relative layout so we can diff exactly one
# failure mode at a time.
build_apk() {
  variant=$1
  staging="${TMP}/stage-${variant}"
  apk="${TMP}/${variant}.apk"
  rm -rf "$staging"
  mkdir -p "$staging/lib/arm64-v8a" "$staging/assets/public"

  # libmedtracker.so — content doesn't matter, only the entry path.
  printf 'fake-binary\n' > "$staging/lib/arm64-v8a/libmedtracker.so"

  # classes.dex — a binary file that happens to contain the two symbol
  # strings verify-apk.sh greps for. `strings` will surface them.
  {
    printf '\x00\x00\x00\x00MedtrackerActivity\x00'
    printf 'GoServerService\x00'
    printf 'random-padding-bytes\n'
  } > "$staging/classes.dex"

  # assets/public/index.html — clean by default.
  cat > "$staging/assets/public/index.html" <<'EOF'
<!doctype html><html><head><title>med</title></head><body>hi</body></html>
EOF

  case "$variant" in
    healthy)
      :
      ;;
    no-arm64)
      rm -rf "$staging/lib/arm64-v8a"
      ;;
    no-goservice)
      # Rewrite dex without GoServerService.
      {
        printf '\x00\x00\x00\x00MedtrackerActivity\x00'
        printf 'random-padding-bytes\n'
      } > "$staging/classes.dex"
      ;;
    no-mainactivity)
      {
        printf '\x00\x00\x00\x00GoServerService\x00'
        printf 'random-padding-bytes\n'
      } > "$staging/classes.dex"
      ;;
    has-telegram)
      cat > "$staging/assets/public/index.html" <<'EOF'
<!doctype html><html><head>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
</head><body></body></html>
EOF
      ;;
    *)
      printf 'unknown variant: %s\n' "$variant" >&2
      return 1
      ;;
  esac

  ( cd "$staging" && zip -q -r "$apk" . )
  printf '%s\n' "$apk"
}

assert_exit() {
  expected=$1
  actual=$2
  label=$3
  if [ "$actual" -ne "$expected" ]; then
    printf 'fail: %s — expected exit %d, got %d\n' "$label" "$expected" "$actual" >&2
    return 1
  fi
  return 0
}

# Helper: run verify, capture exit code without tripping set -e.
run_verify() {
  set +e
  "$VERIFY" "$1" > "${TMP}/last.log" 2>&1
  rc=$?
  set -e
  printf '%s' "$rc"
}

# 1. Healthy APK passes.
APK_OK=$(build_apk healthy)
rc=$(run_verify "$APK_OK")
assert_exit 0 "$rc" "healthy APK should pass" || { cat "${TMP}/last.log" >&2; exit 1; }
grep -qF "PASS" "${TMP}/last.log" || {
  printf 'fail: healthy run missing PASS line\n' >&2
  cat "${TMP}/last.log" >&2
  exit 1
}

# 2. Missing arm64-v8a binary.
APK_NO_ARM64=$(build_apk no-arm64)
rc=$(run_verify "$APK_NO_ARM64")
assert_exit 1 "$rc" "missing libmedtracker.so should fail" || exit 1
grep -qF "lib/arm64-v8a/libmedtracker.so missing" "${TMP}/last.log" || {
  printf 'fail: missing-arm64 run did not emit expected error\n' >&2
  cat "${TMP}/last.log" >&2
  exit 1
}

# 3. Dex without GoServerService.
APK_NO_GO=$(build_apk no-goservice)
rc=$(run_verify "$APK_NO_GO")
assert_exit 1 "$rc" "dex without GoServerService should fail" || exit 1
grep -qF "GoServerService not found" "${TMP}/last.log" || {
  printf 'fail: no-goservice run did not emit expected error\n' >&2
  cat "${TMP}/last.log" >&2
  exit 1
}

# 4. Dex without MedtrackerActivity.
APK_NO_MAIN=$(build_apk no-mainactivity)
rc=$(run_verify "$APK_NO_MAIN")
assert_exit 1 "$rc" "dex without MedtrackerActivity should fail" || exit 1
grep -qF "MedtrackerActivity not found" "${TMP}/last.log" || {
  printf 'fail: no-mainactivity run did not emit expected error\n' >&2
  cat "${TMP}/last.log" >&2
  exit 1
}

# 5. index.html still references telegram.org.
APK_TG=$(build_apk has-telegram)
rc=$(run_verify "$APK_TG")
assert_exit 1 "$rc" "index.html with telegram.org should fail" || exit 1
grep -qF "still references telegram.org" "${TMP}/last.log" || {
  printf 'fail: has-telegram run did not emit expected error\n' >&2
  cat "${TMP}/last.log" >&2
  exit 1
}

# 6. Usage error — no args.
set +e
"$VERIFY" > "${TMP}/usage.log" 2>&1
rc=$?
set -e
assert_exit 2 "$rc" "no-arg invocation should exit 2" || {
  cat "${TMP}/usage.log" >&2
  exit 1
}

# 7. Nonexistent APK.
set +e
"$VERIFY" "${TMP}/does-not-exist.apk" > "${TMP}/missing.log" 2>&1
rc=$?
set -e
assert_exit 1 "$rc" "nonexistent APK should exit 1" || {
  cat "${TMP}/missing.log" >&2
  exit 1
}
grep -qF "APK not found" "${TMP}/missing.log" || {
  printf 'fail: nonexistent-APK run did not emit expected error\n' >&2
  cat "${TMP}/missing.log" >&2
  exit 1
}

printf 'pass: verify-apk.sh covers healthy, missing-so, missing-symbol, telegram-regression, usage, and missing-file paths\n'
