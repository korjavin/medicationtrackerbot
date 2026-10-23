#!/bin/bash
# Runner-only (the qa job in .github/workflows/ios.yml, bd med-w6gx.23.5):
# starts android/qa/tlsfront on :443 for qa.test, points the account-gone
# hosts at it in /etc/hosts (the Simulator uses the Mac's resolver), and
# trusts its throwaway CA on the booted Simulator. Never a dev step: it edits
# the host's /etc/hosts and needs root.
#
# Usage, after ios/qa/boot-sim.sh: ios/qa/fake-server.sh
set -euo pipefail
ca="$RUNNER_TEMP/ca.pem"
IFS='=' read -r _ udid < "$RUNNER_TEMP/devices"

go build -o "$RUNNER_TEMP/tlsfront" ./android/qa/tlsfront
go build -o "$RUNNER_TEMP/cloud" ./cmd/cloud

# The ceremony-exit flow (bd med-ckm5.15) needs a real /unlock page: cmd/cloud
# on :8080 behind tlsfront, as android-qa.yml does, and one minted invite.
export CLOUD_BASE_DOMAIN=qa.test SESSION_SECRET="$(openssl rand -base64 48)" CLOUD_DB_PATH="$RUNNER_TEMP/cloud.db" PORT=8080
nohup "$RUNNER_TEMP/cloud" > "$RUNNER_TEMP/cloud.log" 2>&1 &
for _ in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:8080/ && break; sleep 1; done
inv="$("$RUNNER_TEMP/cloud" admin invite)"
# admin invite prints the landing form https://<base>/i/<sub>#<token> (bd
# med-ta2n.16); the UI tests drive the claim form the landing hands off to.
landing="$(grep -oE 'https://[^[:space:]/]+/i/[a-z0-9-]+#[a-f0-9]+' <<<"$inv" | head -1)"
[ -n "$landing" ] || { cat "$RUNNER_TEMP/cloud.log"; echo "::error::no claim URL in: $inv"; exit 1; }
rest="${landing#https://}"; sub="${rest#*/i/}"; sub="${sub%%#*}"
host="$sub.${rest%%/*}"; claim="https://$host/#claim=${landing##*#}"
echo "QA_CLAIM_URL=$claim" >> "$GITHUB_ENV"

# :443 needs root (AccountURL.parse rejects ports). nobody./stale./down. are
# answered before the proxy; every other host goes to cmd/cloud.
sudo -b "$RUNNER_TEMP/tlsfront" -domain qa.test -ca "$ca" > "$RUNNER_TEMP/tlsfront.log" 2>&1
for _ in $(seq 1 30); do [ -s "$ca" ] && break; sleep 1; done
[ -s "$ca" ] || { cat "$RUNNER_TEMP/tlsfront.log"; echo "::error::tlsfront wrote no CA"; exit 1; }

# No wildcards in /etc/hosts: list each host the flows open.
echo "127.0.0.1 qa.test nobody.qa.test stale.qa.test down.qa.test $host" | sudo tee -a /etc/hosts
sudo dscacheutil -flushcache
sudo killall -HUP mDNSResponder || true

xcrun simctl keychain "$udid" add-root-cert "$ca"

# Preflight: the contract the flows rely on, from this host.
# (The CA is written before the listener is up.)
for _ in $(seq 1 10); do curl -s --cacert "$ca" -o /dev/null https://down.qa.test/ && break; sleep 1; done
curl -sS --cacert "$ca" -i https://nobody.qa.test/ | tee "$RUNNER_TEMP/nobody.txt"
grep -q '^HTTP/[0-9.]* 404' "$RUNNER_TEMP/nobody.txt" && grep -qi '^X-Account-Gone: 1' "$RUNNER_TEMP/nobody.txt" \
  || { echo "::error::nobody.qa.test did not answer 404 + X-Account-Gone"; exit 1; }
curl -sS --cacert "$ca" -i https://stale.qa.test/ | tee "$RUNNER_TEMP/stale.txt"
grep -q '^HTTP/[0-9.]* 404' "$RUNNER_TEMP/stale.txt" && ! grep -qi '^X-Account-Gone' "$RUNNER_TEMP/stale.txt" \
  || { echo "::error::stale.qa.test is not a bare 404"; exit 1; }
curl -sS --cacert "$ca" -i https://down.qa.test/ | grep -q '^HTTP/[0-9.]* 503' \
  || { echo "::error::down.qa.test did not answer 503"; exit 1; }
curl -sS --fail -o /dev/null --cacert "$ca" "https://$host/unlock" \
  || { cat "$RUNNER_TEMP/cloud.log"; echo "::error::the invite's /unlock did not load"; exit 1; }
