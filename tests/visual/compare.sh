#!/usr/bin/env bash
# CI half of the compare step (bd med-y5xx.4): fetch master's latest artifact
# named <artifact> (a dispatch on master: no goldens in git), diff <current-dir>
# against it with compare.mjs into <out-dir>, and append the summary to the job
# summary. Needs GH_TOKEN with actions: read and pnpm on PATH. Evidence only:
# a missing reference or a failed download is a notice, never an error.
#
#   tests/visual/compare.sh ios-visual shots shots/compare
set -u
artifact="$1" current="$2" out="$3"
ref="${RUNNER_TEMP:-/tmp}/reference-$artifact"
rm -rf "$ref" && mkdir -p "$ref"

# Only this workflow's dispatches on master: a dispatch runs this repo's own
# master (a fork PR's branch named master never qualifies), newest first,
# never the current run. The first one that still has the artifact wins
# (build-only dispatches have none).
workflow="${GITHUB_WORKFLOW_REF%%@*}"; workflow="${workflow##*/}"
note="no master \`$artifact\` artifact yet (dispatch the workflow on master to make one)"
for run in $(gh run list --workflow "$workflow" --branch master --event workflow_dispatch -L 30 \
    --json databaseId --jq ".[].databaseId | select(. != ${GITHUB_RUN_ID:-0})" 2>/dev/null); do
  if gh run download "$run" -n "$artifact" -D "$ref" 2>/dev/null; then
    note="reference: master run [$run]($GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$run)"
    break
  fi
  rm -rf "$ref" && mkdir -p "$ref"
done
echo "::notice title=visual compare::$note"

pnpm install --frozen-lockfile --ignore-scripts --reporter=silent || echo "::warning title=visual compare::pnpm install failed"
node tests/visual/compare.mjs "$current" "$ref" "$out"
{ echo; cat "$out/summary.md" 2>/dev/null || echo "compare produced no summary"; echo; echo "$note"; } >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
exit 0
