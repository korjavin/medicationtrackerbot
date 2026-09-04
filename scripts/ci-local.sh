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

run() {
  local label=$1
  shift
  echo "=== ci-local: ${label} ==="
  if ! act "$@"; then
    echo "ci-local: FAILED — ${label}" >&2
    exit 1
  fi
}

run 'frontend-tests.yml (vitest shards)'    pull_request -W .github/workflows/frontend-tests.yml
run 'golangci-lint.yml'                     pull_request -W .github/workflows/golangci-lint.yml
run 'deploy.yml job "test" (go build+test)' pull_request -W .github/workflows/deploy.yml -j test

echo 'ci-local: all three passed'
