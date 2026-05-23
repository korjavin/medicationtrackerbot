#!/usr/bin/env bash
# dev-emulator.sh — one-shot local build + install + launch of the medtracker
# APK on the running Android emulator. The inner dev loop for mobile UI
# smoke-testing without round-tripping through CI.
#
# What it does:
#   1. Cross-compile the Go binary into capacitor/android-overlay/.../jniLibs/.
#   2. If capacitor/android/ is missing, `cap add android`; otherwise reuse.
#   3. `cap sync android` (syncs web/static/ into assets/public/).
#   4. `apply-overlay.sh` (copies the Kotlin MainActivity + GoServerService +
#      manifest + jniLibs on top of Capacitor's generated tree).
#   5. Wire `apply from: 'medtracker.build.gradle'` into app/build.gradle.
#   6. `gradlew assembleDebug`.
#   7. force-stop + uninstall + install -r --no-streaming + am start on the
#      first connected emulator. The --no-streaming + uninstall combo is
#      required to defeat PackageManager's stale-native-lib cache; without it
#      Android may keep the previous libmedtracker.so even after reinstall.
#   8. Probe the WebView via DevTools to confirm the page rendered without the
#      Telegram login screen. Fails loudly if it did.
#
# Usage:
#   ./scripts/dev-emulator.sh                 # full rebuild + redeploy
#   FAST=1 ./scripts/dev-emulator.sh          # skip Go rebuild (use existing .so)
#   SKIP_PROBE=1 ./scripts/dev-emulator.sh    # skip DOM-probe assertion
#
# Prerequisites:
#   - ANDROID_HOME set or auto-detected from /opt/homebrew/share/android-commandlinetools
#   - JAVA_HOME pointing at JDK 17 (script tries /opt/homebrew/opt/openjdk@17/...)
#   - Node + npm
#   - At least one emulator listed by `adb devices`
#
# Tested on macOS (Apple Silicon) targeting an arm64-v8a emulator. The script
# only builds the arm64-v8a ABI by default since that's what the emulator
# uses on Apple Silicon; pass --all-abis to build armeabi-v7a + x86_64 too.

set -euo pipefail

REPO_ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
PKG=com.korjavin.medtracker
ACTIVITY="${PKG}/.MainActivity"

: "${ANDROID_HOME:=/opt/homebrew/share/android-commandlinetools}"
: "${JAVA_HOME:=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME ANDROID_SDK_ROOT="$ANDROID_HOME" JAVA_HOME
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

if [[ ! -x "$ANDROID_HOME/platform-tools/adb" ]]; then
    echo "error: adb not found at $ANDROID_HOME/platform-tools/adb" >&2
    exit 1
fi

if [[ ! -d "$JAVA_HOME" ]]; then
    echo "error: JDK 17 not found at $JAVA_HOME (set JAVA_HOME to override)" >&2
    exit 1
fi

DEVICE=$(adb devices | awk 'NR>1 && $2=="device" {print $1; exit}')
if [[ -z "$DEVICE" ]]; then
    echo "error: no emulator/device listed by 'adb devices'" >&2
    exit 1
fi
echo "==> device: $DEVICE"

cd "$REPO_ROOT"

# Step 1: Go binary
if [[ "${FAST:-0}" != "1" ]]; then
    echo "==> building Go binary for android/arm64"
    ./scripts/build-android-binaries.sh
else
    echo "==> FAST=1 set; skipping Go rebuild"
fi

# Step 2: cap add android (one-time)
cd capacitor
if [[ ! -d android ]]; then
    echo "==> generating android/ via 'cap add android'"
    npx cap add android
fi

# Step 3: cap sync (every run — picks up web/static/ edits)
echo "==> cap sync android"
npx cap sync android >/dev/null

# Step 4: apply-overlay.sh (idempotent — copies overlay on top of cap-add output)
echo "==> apply-overlay.sh"
./apply-overlay.sh >/dev/null

# Step 5: wire apply-from line (idempotent)
APP_BUILD=android/app/build.gradle
LINE="apply from: 'medtracker.build.gradle'"
if ! grep -qF "$LINE" "$APP_BUILD"; then
    printf '\n%s\n' "$LINE" >> "$APP_BUILD"
fi

# Step 6: gradle build
echo "==> gradle assembleDebug"
cd android
./gradlew assembleDebug --no-daemon -q

APK="$REPO_ROOT/capacitor/android/app/build/outputs/apk/debug/app-debug.apk"
if [[ ! -f "$APK" ]]; then
    echo "error: APK not at $APK after build" >&2
    exit 1
fi
echo "==> APK: $APK ($(du -h "$APK" | cut -f1))"

# Step 7: force-stop + uninstall + install + launch
echo "==> redeploying to $DEVICE"
adb -s "$DEVICE" shell am force-stop "$PKG" >/dev/null 2>&1 || true
adb -s "$DEVICE" uninstall "$PKG" >/dev/null 2>&1 || true
adb -s "$DEVICE" install -r --no-streaming "$APK" | tail -1
adb -s "$DEVICE" logcat -c
adb -s "$DEVICE" shell am start -W -n "$ACTIVITY" | tail -1
echo "==> launched; waiting 15s for Go binary spawn + WebView load"
sleep 15

# Step 8: optional DOM probe — confirms we're not on the Telegram login screen.
if [[ "${SKIP_PROBE:-0}" == "1" ]]; then
    echo "==> SKIP_PROBE=1; not probing WebView state"
    exit 0
fi

PID=$(adb -s "$DEVICE" shell pidof "$PKG" | tr -d '\r')
if [[ -z "$PID" ]]; then
    echo "error: app process not running after launch" >&2
    exit 1
fi
DEVTOOLS_PORT=${DEVTOOLS_PORT:-9333}
adb -s "$DEVICE" forward --remove-all >/dev/null 2>&1 || true
adb -s "$DEVICE" forward "tcp:$DEVTOOLS_PORT" "localabstract:webview_devtools_remote_$PID" >/dev/null

PROBE_DIR=$(mktemp -d)
trap 'rm -rf "$PROBE_DIR"' EXIT
(cd "$PROBE_DIR" && npm init -y >/dev/null 2>&1 && npm install ws --no-audit --no-fund >/dev/null 2>&1)

PAGE=$(curl -s "http://localhost:$DEVTOOLS_PORT/json" | grep -oE 'devtools/page/[A-F0-9]+' | head -1)
if [[ -z "$PAGE" ]]; then
    echo "error: WebView devtools_remote socket has no debuggable page" >&2
    exit 1
fi

cat > "$PROBE_DIR/probe.js" <<EOF
const WS = require("ws");
const ws = new WS("ws://localhost:$DEVTOOLS_PORT/$PAGE");
ws.on("open", () => ws.send(JSON.stringify({
    id: 1, method: "Runtime.evaluate", params: {
        expression: 'JSON.stringify({url:location.href, loginContainer:!!document.querySelector(".login-container"), firstrun:!!document.querySelector(".wg-firstrun-overlay, [data-wg-firstrun]"), authState:localStorage.getItem("medtracker_auth_state"), bodyHead:document.body?document.body.innerText.slice(0,160):null})',
        returnByValue: true
    }
})));
ws.on("message", (d) => {
    const m = JSON.parse(d);
    if (m.id === 1) { console.log(m.result.result.value); ws.close(); process.exit(0); }
});
setTimeout(() => { console.error("timeout"); process.exit(2); }, 8000);
EOF

RESULT=$(cd "$PROBE_DIR" && node probe.js)
echo "==> DOM probe: $RESULT"

if grep -q '"loginContainer":true' <<< "$RESULT"; then
    echo "FAIL: login container is rendered. The mobile build is showing the Telegram login screen." >&2
    exit 1
fi
echo "==> OK: no login container; mobile WebView is healthy"
