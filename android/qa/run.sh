#!/usr/bin/env bash
# Runs inside android-emulator-runner's `script` (bd med-nt9p.23): install the QA
# APK, drive the scenario, then always collect logcat + the shell's diag log.
# Usage: run.sh <apk> <scenario|all> <outDir>
set -u
apk=$1 scenario=$2 out=$3
pkg=${QA_PKG:-com.example.medtracker}
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$out"

adb install -r "$apk"
adb logcat -c
node "$here/run.mjs" "$scenario" "$out"
rc=$?

adb logcat -d > "$out/logcat.txt" 2>&1
adb shell run-as "$pkg" cat shared_prefs/diag.xml > "$out/diag.xml" 2>&1
exit $rc
