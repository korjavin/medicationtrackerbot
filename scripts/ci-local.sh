#!/usr/bin/env bash
# Optional: run the act-friendly subset of GitHub Actions locally (nektos/act).
#
# NOT a required pre-push step and NOT a git hook. For code checks this is
# redundant with `go build ./... && TZ=UTC go test ./...`, `pnpm test` and
# `golangci-lint run`, minus a multi-GB runner image and amd64 emulation. Reach
# for it when you changed .github/workflows/*, when CI is red but local is
# green, or to sanity-check a newly added action/step.
# See docs/cloud-deployment.md → "Local CI via act".
set -euo pipefail

# .actrc pins the runner image and arch, and act only reads ./.actrc from cwd.
cd "$(dirname "$0")/.."

# Once any action writes to GITHUB_PATH (pnpm/action-setup and setup-go both
# do), act rebuilds PATH from its own default and drops the image's node in
# /opt/acttoolcache — every later JS action then dies with `exec: "node":
# executable file not found in $PATH`. Seed PATH from the image itself so the
# toolcache entry survives; reading the image out of .actrc keeps one source of
# truth, and asking the image keeps this from rotting when its node moves.
image=$(sed -n 's/^-P ubuntu-latest=//p' .actrc)
runner_path=$(docker run --rm --platform linux/amd64 "$image" printenv PATH)

run() {
  local label=$1
  shift
  echo "=== ci-local: ${label} ==="
  if ! act --env "PATH=${runner_path}" "$@"; then
    echo "ci-local: FAILED — ${label}" >&2
    exit 1
  fi
}

# Ordered cheapest-and-most-deterministic first; the vitest shards go last
# because emulation is slow enough to trip their 10s hook timeouts, which reads
# as a red that CI would never show.
run 'deploy.yml job "test" (go build+test)' pull_request -W .github/workflows/deploy.yml -j test
run 'golangci-lint.yml'                     pull_request -W .github/workflows/golangci-lint.yml
run 'frontend-tests.yml (vitest shards)'    pull_request -W .github/workflows/frontend-tests.yml

echo 'ci-local: all three passed'
