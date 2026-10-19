#!/usr/bin/env bash
# Runs inside android-emulator-runner's `script` (bd med-nt9p.23, .24): point the emulator at
# the runner's local cloud, install the QA APK, drive the scenario, then always collect logcat +
# the shell's diag log. Usage: run.sh <apk> <scenario|all> <outDir>
set -u
apk=$1 scenario=$2 out=$3
pkg=${QA_PKG:-com.example.medtracker}
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$out"

# Before the app first starts (bd med-nt9p.24): the runner CA into the user trust store (the
# debug-only network_security_config trusts it) and *.qa.test → the runner, for WebView only.
if [ -n "${QA_CA:-}" ]; then
  adb root && adb wait-for-device
  hash=$(openssl x509 -subject_hash_old -in "$QA_CA" -noout)
  adb shell mkdir -p /data/misc/user/0/cacerts-added
  adb push "$QA_CA" "/data/misc/user/0/cacerts-added/$hash.0"
  adb shell "chown system:system /data/misc/user/0/cacerts-added/$hash.0 && chmod 644 /data/misc/user/0/cacerts-added/$hash.0 && restorecon -R /data/misc/user/0/cacerts-added"
  adb shell "echo '_ --host-resolver-rules=\"MAP *.${CLOUD_BASE_DOMAIN:-qa.test} 10.0.2.2\"' > /data/local/tmp/webview-command-line"
  adb shell cat /data/local/tmp/webview-command-line
fi

adb install -r "$apk"
adb logcat -c
node "$here/run.mjs" "$scenario" "$out"
rc=$?

adb logcat -d > "$out/logcat.txt" 2>&1
adb shell run-as "$pkg" cat shared_prefs/diag.xml > "$out/diag.xml" 2>&1
# Acceptance (bd med-nt9p.24): the WebView reached *.qa.test with no DNS or certificate errors.
neterr=$(grep -cE 'ERR_NAME_NOT_RESOLVED|ERR_CERT_|net_error -(105|2[0-9][0-9])\b|handshake failed' "$out/logcat.txt")
echo "logcat network/TLS error lines: $neterr"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "logcat network/TLS error lines: **$neterr**" >> "$GITHUB_STEP_SUMMARY"
exit $rc
