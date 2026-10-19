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

run="$(gh api "repos/$GITHUB_REPOSITORY/actions/artifacts?name=$artifact&per_page=100" \
  --jq '[.artifacts[] | select(.workflow_run.head_branch == "master" and (.expired | not))] | sort_by(.created_at) | last | .workflow_run.id // empty' 2>/dev/null)"
note="no master \`$artifact\` artifact yet (dispatch the workflow on master to make one)"
if [ -n "$run" ]; then
  if gh run download "$run" -n "$artifact" -D "$ref"; then
    note="reference: master run [$run]($GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$run)"
  else
    note="could not download \`$artifact\` from master run $run"
  fi
fi
echo "::notice title=visual compare::$note"

pnpm install --frozen-lockfile --ignore-scripts --reporter=silent || echo "::warning title=visual compare::pnpm install failed"
node tests/visual/compare.mjs "$current" "$ref" "$out"
{ echo; cat "$out/summary.md" 2>/dev/null || echo "compare produced no summary"; echo; echo "$note"; } >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
exit 0
