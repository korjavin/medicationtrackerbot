#!/usr/bin/env bash
# med-ku8r: headless repro of "Send photo" during a trial-agent voice call.
#
# Run ON the cloud host (needs `docker exec` for the admin CLI):
#
#   ./e2e/run-trial-photo.sh
#   CONTAINER=medtracker-cloud ./e2e/run-trial-photo.sh
#   KEEP_ACCOUNT=1 ./e2e/run-trial-photo.sh     # don't delete the test account
#
# Mints a throwaway invite, drives the browser in the Playwright image, prints
# one JSON line ({files_requests, user_messages, vision_status, callbar, console, verdict, detail}),
# saves e2e/trial-photo.png, and always deletes the test account on exit.
set -euo pipefail

CONTAINER="${CONTAINER:-medtracker-cloud}"
PLAYWRIGHT_IMAGE="${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.56.0-noble}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INVITE="$(docker exec -u 1000:1000 "$CONTAINER" ./cloud admin invite)"
SUB="$(sed -n 's/^subdomain: *//p' <<<"$INVITE" | head -1)"
URL="$(grep -oE 'https://[^[:space:]]+#[^[:space:]]+' <<<"$INVITE" | head -1)"
[ -n "$SUB" ] && [ -n "$URL" ] || { echo "could not parse the invite:" >&2; echo "$INVITE" >&2; exit 1; }

cleanup() {
  if [ "${KEEP_ACCOUNT:-}" = "1" ]; then
    echo "kept test account: $SUB" >&2
  else
    printf '%s\n' "$SUB" | docker exec -u 1000:1000 -i "$CONTAINER" ./cloud admin delete "$SUB" >&2 \
      || echo "DELETE FAILED — remove by hand: docker exec -u 1000:1000 -it $CONTAINER ./cloud admin delete $SUB" >&2
  fi
}
trap cleanup EXIT

# https://<base>/i/<sub>#<token> (current) or https://<sub>.<base>/#claim=<token> (old).
HOST="${URL#https://}"; HOST="${HOST%%/*}"
if [[ "$URL" == *"#claim="* ]]; then
  BASE_URL="https://$HOST"
  CLAIM_TOKEN="${URL##*#claim=}"
else
  BASE_URL="https://$SUB.$HOST"
  CLAIM_TOKEN="${URL##*#}"
fi
echo "test account: $SUB ($BASE_URL)" >&2

SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker run --rm --init \
  --network host \
  -v "$HERE:/e2e" -w /e2e \
  -e BASE_URL="$BASE_URL" \
  -e CLAIM_TOKEN="$CLAIM_TOKEN" \
  -e SCREENSHOT=/e2e/trial-photo.png \
  "$PLAYWRIGHT_IMAGE" \
  sh -c 'npm install --no-audit --no-fund --silent >&2 && node trial-photo-call.mjs' \
  || true

echo "screenshot: $HERE/trial-photo.png" >&2
# The trial proxy logs ElevenLabs' upstream status; show what it said.
echo "--- server log (trial/elevenlabs since $SINCE) ---" >&2
docker logs --since "$SINCE" "$CONTAINER" 2>&1 | grep -iE 'trial|elevenlabs|voice llm relay' | tail -20 >&2 || true
