# testscenarios

A catalogue of user-facing invariants, one YAML file per user-visible behaviour. Humans read it
(release device checks); automation links back to it via `covered_by`. A runner that executes
these files is out of scope: the YAML is documentation, not a test input.

## Layout

`testscenarios/<folder>/<id>.yaml`. `<folder>` is `common` when `platforms` lists all three
(web, android, ios); otherwise the single platform's name. `id` equals the file name, is
kebab-case, and is unique across all folders.

## Format

See `common/voice-trial-call.yaml` for a worked example. Keys:

- `id`, `title`: title is user-facing wording, at most 90 chars.
- `platforms`: list of `web`, `android`, `ios`.
- `preconditions`: state the user starts in.
- `steps`: what a human does on a phone; no selectors.
- `invariants`: observable outcomes, one per line; the thing a regression would break.
- `covered_by`: one key per platform in `platforms`. Value is a repo-relative path
  (optionally `#symbol`) or the literal `manual`. Paths must exist; the reviewer checks by eye.
- `source`: optional beads / PR numbers that motivated the scenario.

One scenario per user-visible behaviour, not per bug: a new regression in a covered flow
updates the existing file's invariants and `source`.

## Release checklist

Release device checks are the scenarios whose `covered_by` for that platform is `manual`:

    grep -rl 'manual' testscenarios/common testscenarios/<platform>

then read the `title` of each hit (and check the platform's own `covered_by` line, since a
`common/` file may be manual on one platform only).

That grep counts files containing the word `manual` anywhere, including other platforms and
preconditions. For an Android coverage audit, count the Android obligations separately:

    grep -rhE '^  android: manual([[:space:]]|$)' testscenarios/common testscenarios/android | wc -l

Keep `manual # reason` when a linked test asserts only part of the scenario. The comment names
the existing evidence and the missing checks; a partial test does not remove the release check.

The Android harness [runbook](../docs/android.md) describes `core-local` and
`offline-account`, including their real-device interactions and receipt-counting evidence. The
standalone account `update-banner` uses real stamped A/B binaries and asserts the worker/version
swap; `degraded-boot` asserts a one-shot required-module failure and one offline recovery navigation.
Its failed-read title/body assertions use the shared med-31gk fix. Store-installed updates still
need a real device. Native Home/resume visibility delivery remains a separate non-gating gap
(med-jyxy); the account cold-open update invariant does not depend on an explicit DOM stimulus.
The B3 `file-backup` scenario requires the real saved document and native restore picker, full
canonical content/settings after erase and typed Replace, and corrupt-file preservation. File
Restore is Replace-only by design (ruling17664/17666). `local-lock` uses a real emulator PIN and
verified cleanup; `health-connect` adds SDK weight/sleep source-label proof with the accepted
same-package origin limit. Real third-party Health origins/data, unasserted permission-sheet and
denied-guidance branches, live vendor voice/photo, Play-installed updates and the other precisely
named partial checks remain release obligations in their own YAML comments.

## Where automation lives

- Android: `android/qa/scenarios/*.mjs`, run by `.github/workflows/android-qa.yml`.
- iOS: `ios/UITests/FlowQA*.swift`, run by the `qa` job in `.github/workflows/ios.yml`.
- Web: `web/static/js/tests`, `web/cloud/js/tests`, `tests/visual`.

## Process rule

A regression fix adds or updates its scenario here (CLAUDE.md rule 17). The reviewer enforces
it, not CI. A common scenario that passes on one platform and fails on another is a parity
bug ([docs/mobile-parity.md](../docs/mobile-parity.md)), filed with the scenario id.
