#!/usr/bin/env bash
# Prod check for med-l5yr.5 (weight sanity): mints an invite, then drives a
# fresh account through the real workout UI (weight-check.mjs). Screenshots
# land in e2e/out/.
#
# Run this ON the host where the cloud container lives — it needs `docker exec`
# for the admin CLI.
#
#   ./e2e/run-weight-check.sh
#   CONTAINER=medtracker-cloud ./e2e/run-weight-check.sh
#
# Browsers come from the Playwright image, so nothing is installed on the host.
set -euo pipefail

CONTAINER="${CONTAINER:-medtracker-cloud}"
PLAYWRIGHT_IMAGE="${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.56.0-noble}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "→ Minting a fresh invite via the admin CLI"
INVITE="$(docker exec "$CONTAINER" ./cloud admin invite)"
# Prints https://<base>/i/<subdomain>#<hex> plus a "subdomain: <sub>" line.
SUB="$(sed -n 's/^subdomain: *//p' <<<"$INVITE" | head -1)"
URL="$(grep -oE 'https://[^[:space:]]+#[^[:space:]]+' <<<"$INVITE" | head -1)"
[ -n "$SUB" ] && [ -n "$URL" ] || { echo "✗ could not parse the invite from:"; echo "$INVITE"; exit 1; }

# The throwaway account goes away however the run ends.
cleanup() {
  echo "→ Deleting throwaway account $SUB"
  printf '%s\n' "$SUB" | docker exec -i "$CONTAINER" ./cloud admin delete "$SUB" || echo "  ✗ delete failed for $SUB"
}
trap cleanup EXIT

HOST="${URL#https://}"; HOST="${HOST%%/*}"
BASE_URL="https://$SUB.$HOST"
CLAIM_TOKEN="${URL##*#}"
echo "  ✓ ${BASE_URL}"

mkdir -p "$HERE/out"
echo "→ Driving the browser (${PLAYWRIGHT_IMAGE})"
docker run --rm --init \
  --network host \
  -v "$HERE:/e2e" -w /e2e \
  -e BASE_URL="$BASE_URL" \
  -e CLAIM_TOKEN="$CLAIM_TOKEN" \
  -e OUT_DIR=/e2e/out \
  "$PLAYWRIGHT_IMAGE" \
  sh -c 'npm install --no-audit --no-fund --silent && node weight-check.mjs'

echo
echo "✓ Weight check passed — screenshots in $HERE/out/"
