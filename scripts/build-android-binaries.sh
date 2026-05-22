#!/bin/sh
# Cross-compile cmd/bot (mobile build tag) for Android ABIs and drop the
# resulting binaries into the committed overlay tree as `libmedtracker.so`
# per-ABI. The `lib*.so` naming + jniLibs/<abi>/ placement triggers Android's
# automatic native-library extraction at install time, so the binary lives in
# the per-app nativeLibraryDir (read-only but executable) and can be spawned
# with Runtime.exec() without any assets-copy dance at launch. See
# docs/local-mode.md → "Phase 2a build pipeline" for the rationale.
#
# ABIs:
#   arm64-v8a   — always built (CGO-free; covers every modern Android device)
#   armeabi-v7a — built only when ANDROID_NDK_HOME points at a usable NDK
#                 (requires CGO + an armv7a-linux-androideabi clang)
#   x86_64      — built only when ANDROID_NDK_HOME points at a usable NDK
#                 (emulator-only; same CGO requirement)
#
# The arm64-only baseline matches the v1 scope captured in the Task 1 spike
# outcome of docs/plans/2026-05-22-mobile-phase2a-android-go-embedding.md.
# To produce the other two ABIs, install the Android NDK and export:
#
#   export ANDROID_NDK_HOME=/path/to/android-ndk-rXXx
#   export ANDROID_API=24            # optional, defaults to 24
#
# Usage:
#   ./scripts/build-android-binaries.sh           # arm64 only (or all three if NDK is set)
#   ./scripts/build-android-binaries.sh --abis arm64-v8a,x86_64
#   OUTPUT_DIR=/tmp/jni ./scripts/build-android-binaries.sh
#
# Exit codes:
#   0  build succeeded for every requested ABI
#   1  build failed (missing toolchain, compile error, missing NDK for non-arm64)
#   2  usage error

set -eu

usage() {
  cat >&2 <<'EOF'
Usage: build-android-binaries.sh [--abis arm64-v8a[,armeabi-v7a,x86_64]]

Environment:
  OUTPUT_DIR        Override the destination jniLibs directory (default:
                    capacitor/android-overlay/app/src/main/jniLibs)
  ANDROID_NDK_HOME  Android NDK root. Required for armeabi-v7a and x86_64.
  ANDROID_API       Android API level for NDK clang wrappers (default: 24)
  GO                Go binary to use (default: go)
EOF
}

REPO_ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
GO_BIN=${GO:-go}
ANDROID_API=${ANDROID_API:-24}
DEFAULT_OUTPUT_DIR="${REPO_ROOT}/capacitor/android-overlay/app/src/main/jniLibs"
OUTPUT_DIR=${OUTPUT_DIR:-$DEFAULT_OUTPUT_DIR}

REQUESTED_ABIS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --abis)
      [ $# -ge 2 ] || { usage; exit 2; }
      REQUESTED_ABIS=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage
      exit 2
      ;;
  esac
done

# When no --abis given, build arm64 always; add armv7 + x86_64 iff NDK is
# present. This keeps `./scripts/build-android-binaries.sh` zero-config on a
# vanilla Go install while still producing all three when the NDK is wired.
if [ -z "$REQUESTED_ABIS" ]; then
  if [ -n "${ANDROID_NDK_HOME:-}" ]; then
    REQUESTED_ABIS="arm64-v8a,armeabi-v7a,x86_64"
  else
    REQUESTED_ABIS="arm64-v8a"
  fi
fi

# Resolve the per-ABI NDK clang wrapper path. The wrapper picks the right
# sysroot + linker flags for the given API level so we don't have to.
ndk_cc_for() {
  abi=$1
  ndk=${ANDROID_NDK_HOME:-}
  [ -n "$ndk" ] || { printf '' ; return 0; }
  host_os=""
  case "$(uname -s)" in
    Darwin) host_os="darwin-x86_64" ;;
    Linux)  host_os="linux-x86_64" ;;
    *)      host_os="" ;;
  esac
  [ -n "$host_os" ] || { printf '' ; return 0; }
  base="${ndk}/toolchains/llvm/prebuilt/${host_os}/bin"
  case "$abi" in
    armeabi-v7a) printf '%s/armv7a-linux-androideabi%s-clang' "$base" "$ANDROID_API" ;;
    x86_64)      printf '%s/x86_64-linux-android%s-clang' "$base" "$ANDROID_API" ;;
    arm64-v8a)   printf '%s/aarch64-linux-android%s-clang' "$base" "$ANDROID_API" ;;
    *)           printf '' ;;
  esac
}

build_abi() {
  abi=$1
  case "$abi" in
    arm64-v8a)   goarch="arm64"; goarm=""; needs_ndk=0 ;;
    armeabi-v7a) goarch="arm";   goarm="7"; needs_ndk=1 ;;
    x86_64)      goarch="amd64"; goarm=""; needs_ndk=1 ;;
    *)
      printf 'Unknown ABI: %s\n' "$abi" >&2
      return 1
      ;;
  esac

  out_dir="${OUTPUT_DIR}/${abi}"
  out_path="${out_dir}/libmedtracker.so"
  mkdir -p "$out_dir"

  printf '==> Building %s -> %s\n' "$abi" "$out_path"

  if [ "$needs_ndk" -eq 0 ]; then
    CGO_ENABLED=0 GOOS=android GOARCH="$goarch" "$GO_BIN" build \
      -tags mobile -trimpath -ldflags='-s -w' \
      -o "$out_path" \
      "${REPO_ROOT}/cmd/bot"
    return 0
  fi

  cc=$(ndk_cc_for "$abi")
  if [ -z "$cc" ] || [ ! -x "$cc" ]; then
    printf 'NDK clang for %s not found.\n' "$abi" >&2
    printf '  Set ANDROID_NDK_HOME to an NDK install; tried %s\n' "${cc:-<no path>}" >&2
    printf '  Skipping %s. arm64-v8a still covers ~99%% of modern Android devices.\n' "$abi" >&2
    return 1
  fi

  if [ -n "$goarm" ]; then
    CGO_ENABLED=1 GOOS=android GOARCH="$goarch" GOARM="$goarm" CC="$cc" \
      "$GO_BIN" build \
      -tags mobile -trimpath -ldflags='-s -w' \
      -o "$out_path" \
      "${REPO_ROOT}/cmd/bot"
  else
    CGO_ENABLED=1 GOOS=android GOARCH="$goarch" CC="$cc" \
      "$GO_BIN" build \
      -tags mobile -trimpath -ldflags='-s -w' \
      -o "$out_path" \
      "${REPO_ROOT}/cmd/bot"
  fi
}

# Split the comma-separated ABI list portably (no GNU-only -d flag on tr).
abis=$(printf '%s' "$REQUESTED_ABIS" | tr ',' ' ')

any_fail=0
for abi in $abis; do
  if ! build_abi "$abi"; then
    any_fail=1
    # arm64 is the only baseline target — failing it is fatal. The other two
    # are best-effort when NDK is missing and we only warn.
    if [ "$abi" = "arm64-v8a" ]; then
      printf 'fatal: arm64-v8a build failed\n' >&2
      exit 1
    fi
  fi
done

printf '\nBinaries:\n'
find "$OUTPUT_DIR" -type f -name 'libmedtracker.so' -print | sort

if [ "$any_fail" -ne 0 ]; then
  printf '\nSome ABIs were skipped (see warnings above). arm64-v8a is the v1 baseline.\n' >&2
  # Exit 0 when only non-baseline ABIs were skipped — arm64 alone is a valid
  # build artifact for v1, per docs/local-mode.md.
fi
