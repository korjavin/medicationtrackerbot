#!/bin/bash
# Creates (or reuses) and boots one Simulator for the first available device
# type, for the visual and qa jobs in .github/workflows/ios.yml. Appends
# "<Device-Name>=<udid>" to $RUNNER_TEMP/devices.
#
# Usage: ios/qa/boot-sim.sh "iPhone 16e,iPhone 16,iPhone 15" <label for errors>
set -euo pipefail
types_csv="${1:?device types}"
label="${2:-device}"
devices="$RUNNER_TEMP/devices"

xcrun simctl list devicetypes runtimes
# The software keyboard, not the Mac's (Simulator.app's setting).
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false
IFS=',' read -ra types <<< "$types_csv"
# The first listed type with a runtime that supports it, on the newest such
# iOS runtime. Not just the newest runtime: an image can carry a
# device-specific variant (iOS-27-2-iPhone19-4, run 42135010106) that refuses
# older devices with "Incompatible device". Same version → the generic
# (shorter) identifier.
runtimes="$(xcrun simctl list runtimes -j)"
t="" runtime=""
for c in "${types[@]}"; do
  runtime="$(jq -r --arg n "$c" '[.runtimes[] | select(.platform == "iOS" and .isAvailable and any(.supportedDeviceTypes[]?; .name == $n))] | sort_by([(.version | split(".") | map(tonumber? // 0)), -(.identifier | length)]) | last | .identifier // empty' <<< "$runtimes")"
  [ -n "$runtime" ] && { t="$c"; break; }
done
[ -n "$t" ] || { echo "::error::no device type with an iOS runtime for $label"; exit 1; }
echo "runtime: $runtime ($t)"
# The image's own device if it has one (a fresh device's first boot
# migrates data for minutes), else a new one.
udid="$(xcrun simctl list devices available -j | jq -r --arg rt "$runtime" --arg n "$t" '.devices[$rt][]? | select(.name == $n) | .udid' | head -n 1)"
[ -n "$udid" ] || udid="$(xcrun simctl create "QA $t" "$t" "$runtime")"
dev="${t// /-}"
start=$SECONDS
booted_at="$(date '+%Y-%m-%d %H:%M:%S')"
xcrun simctl bootstatus "$udid" -b < /dev/null | tail -n 1
echo "$dev booted in $((SECONDS - start))s"
# Booted is not settled: the first XCUITest launch right after a boot timed
# out "acquiring background assertion" (bd med-w6gx.23.6, runs 39419413374,
# 39437482836/3). Settled = a system app launches within 5 s twice running;
# capped at 3 min, then the flows run anyway.
start=$SECONDS fast=0
while [ "$fast" -lt 2 ] && [ $((SECONDS - start)) -lt 180 ]; do
  t=$SECONDS
  if xcrun simctl launch "$udid" com.apple.Preferences > /dev/null 2>&1 && [ $((SECONDS - t)) -le 5 ]; then
    fast=$((fast + 1))
  else
    fast=0
  fi
  xcrun simctl terminate "$udid" com.apple.Preferences > /dev/null 2>&1 || true
  sleep 2
done
echo "$dev settled in $((SECONDS - start))s"
# Settled is not Health-ready: healthd finishes its profile setup ~3 min
# after it spawns ("reported daemon ready"), and a requestAuthorization sent
# before that never gets an answer, even after it is ready — no sheet, the
# Health tests stall "pending" (bd med-8f4s.18, runs 42142522395 and the
# first .18 diagnostic; the one run whose request came after it passed the
# sheet). Logs since this boot only; capped at 5 min, then the flows run
# anyway and the Health tests fail on their own.
# QA_HEALTH_READY=0 skips the wait (the qa parts without the Health test,
# bd med-5yr8); unset = wait, as the visual job always has.
if [ "${QA_HEALTH_READY:-1}" = 1 ]; then
  start=$SECONDS
  until xcrun simctl spawn "$udid" log show --start "$booted_at" --style compact \
      --predicate 'process == "healthd" AND eventMessage CONTAINS "reported daemon ready"' 2>/dev/null \
      | grep -q 'reported daemon ready'; do
    [ $((SECONDS - start)) -lt 300 ] || { echo "::warning::$dev: healthd not ready after 300s"; break; }
    sleep 5
  done
  echo "$dev healthd ready check took $((SECONDS - start))s"
else
  echo "$dev healthd ready check skipped (QA_HEALTH_READY=0)"
fi
xcrun simctl status_bar "$udid" override --time 9:41 --batteryState charged --batteryLevel 100 --wifiBars 3 --cellularBars 4
xcrun simctl ui "$udid" appearance dark
echo "$dev=$udid" >> "$devices"
cat "$devices"
