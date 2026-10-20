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
runtime="$(xcrun simctl list runtimes -j | jq -r '[.runtimes[] | select(.platform == "iOS" and .isAvailable)] | last | .identifier')"
echo "runtime: $runtime"
pick() { for t in "$@"; do xcrun simctl list devicetypes | grep -qF "$t (" && { echo "$t"; return; }; done; }
# The software keyboard, not the Mac's (Simulator.app's setting).
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false
IFS=',' read -ra types <<< "$types_csv"
t="$(pick "${types[@]}")"
[ -n "$t" ] || { echo "::error::no device type for $label"; exit 1; }
# The image's own device if it has one (a fresh device's first boot
# migrates data for minutes), else a new one.
udid="$(xcrun simctl list devices available -j | jq -r --arg rt "$runtime" --arg n "$t" '.devices[$rt][]? | select(.name == $n) | .udid' | head -n 1)"
[ -n "$udid" ] || udid="$(xcrun simctl create "QA $t" "$t" "$runtime")"
dev="${t// /-}"
start=$SECONDS
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
xcrun simctl status_bar "$udid" override --time 9:41 --batteryState charged --batteryLevel 100 --wifiBars 3 --cellularBars 4
xcrun simctl ui "$udid" appearance dark
echo "$dev=$udid" >> "$devices"
cat "$devices"
