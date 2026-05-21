# Fix TZ-dependent flake in health.dexie-hydration.test.js

## Overview

`web/static/js/tests/health.dexie-hydration.test.js` fails deterministically when the test runner's environment TZ is `Europe/Berlin` or `America/Los_Angeles`. The suite uses those two IANA zone names as **sentinel keys** to exercise the TZ-mismatch fallback path in `hydrateSectionsFromDexie`, but never proves the sentinels are disjoint from the runner's TZ — when they collide, the sanity assertion (line 230) fails:

```
expected 'health_overview_Europe/Berlin' not to be 'health_overview_Europe/Berlin'
```

Confirmed locally:
- `TZ=Europe/Berlin pnpm test web/static/js/tests/health.dexie-hydration.test.js` → 1 failed / 9 passed
- `TZ=America/Los_Angeles ...` → 1 failed / 9 passed
- `TZ=UTC ...` → 10 passed

This is the test reported as "Pre-existing flake — TZ-env dependent" in ralphex's runs. It is unrelated to the current branch but blocks any contributor whose machine or CI defaults to Berlin/LA time.

## Context (from discovery)

- **Failing file**: `web/static/js/tests/health.dexie-hydration.test.js:218-252` (TZ-mismatch fallback test) and `:254-278` (TZ-fallback rendering test, also affected but currently passing by coincidence).
- **Production code under test**: `web/static/js/app.js:767-770` — `healthOverviewCacheKey()` returns `health_overview_${Intl.DateTimeFormat().resolvedOptions().timeZone}`.
- **Hydration prefix scan**: `MedTrackerDB.ApiCache.findMostRecentByPrefix('health_overview_', { exclude })` — pure string prefix match; sentinels do not need to be real IANA names for the production logic to exercise the fallback path.
- **Root cause**: lines 226–227 hardcode `'health_overview_America/Los_Angeles'` and `'health_overview_Europe/Berlin'` as the "prior TZ" rows. When `Intl.DateTimeFormat().resolvedOptions().timeZone` happens to equal one of those zones, the test's "prior" row is actually the current-TZ row, so:
  1. The explicit sanity assertion (`expect(currentTzKey).not.toBe(newerKey)`) fails.
  2. Even without that assertion, the fallback path wouldn't be exercised — direct current-TZ lookup would short-circuit.
- The second test (line 257, `health_overview_Europe/Berlin` as `fallbackKey`) has the same latent issue: under `TZ=Europe/Berlin` the row is matched directly, not via the prefix-scan fallback. Its assertions (chip is offline, content rendered) happen to hold either way, so it passes by coincidence, but it is not actually testing what its name claims.

## Development Approach

- **Testing approach**: Regular (the existing tests *are* the deliverable; we modify them so they exercise their intended logic under any TZ).
- Run the suite under `TZ=Europe/Berlin`, `TZ=America/Los_Angeles`, and the default before/after to confirm the fix.
- No production code changes — this is purely a test-correctness fix.

## Testing Strategy

- **Unit tests**: the modified test file *is* the test. Verify by running it under multiple TZ envs.
- **No new test file** — this is a fix to an existing flake, not new coverage. Per CLAUDE.md rule #8 (frontend tests are integration-first), the change stays inside the owning suite.
- **E2E tests**: N/A — Vitest unit suite only.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add ➕ for newly discovered tasks; ⚠️ for blockers.

## Implementation Steps

### Task 1: Replace hardcoded IANA sentinels with non-IANA strings

The fix is to use sentinel TZ strings that *cannot* be valid IANA zone names — anything starting with a double-underscore works, since IANA zones never do. The prefix scan only does `startsWith('health_overview_')`, so the sentinels just need to share that prefix.

- [x] In `web/static/js/tests/health.dexie-hydration.test.js:218-252`, replace the two hardcoded keys:
  - `'health_overview_America/Los_Angeles'` → `'health_overview___TEST_FALLBACK_OLDER__'`
  - `'health_overview_Europe/Berlin'` → `'health_overview___TEST_FALLBACK_NEWER__'`
- [x] Update the inline comment block (lines 222–225) to explain *why* the sentinels look unusual: they are deliberately non-IANA so the test is robust to whatever TZ env the harness inherits.
- [x] Keep the two sanity assertions (`expect(currentTzKey).not.toBe(olderKey/newerKey)`) — they remain a useful guard against accidental future regressions.
- [x] In the second affected test (line 254-278), replace `'health_overview_Europe/Berlin'` with `'health_overview___TEST_FALLBACK_BERLIN__'` (or similar non-IANA sentinel) and add a sanity assertion `expect(currentTzKey).not.toBe(fallbackKey)` so the fallback path is provably exercised, not entered by coincidence.
- [x] Run `pnpm test web/static/js/tests/health.dexie-hydration.test.js` with default TZ — must pass.
- [x] Run `TZ=Europe/Berlin pnpm test web/static/js/tests/health.dexie-hydration.test.js` — must pass.
- [x] Run `TZ=America/Los_Angeles pnpm test web/static/js/tests/health.dexie-hydration.test.js` — must pass.
- [x] Run `TZ=UTC pnpm test web/static/js/tests/health.dexie-hydration.test.js` — must pass.

### Task 2: Verify acceptance criteria

- [x] Confirm both affected tests (lines 218 and 254) exercise the prefix-scan fallback path (not the direct current-TZ lookup) under every TZ checked above. A quick way: assert that `currentTzKey` is *not* in the seeded `installApiCacheMap` initial map. (Both tests already assert `currentTzKey` ≠ every seeded key; since the seeded map only contains the sentinel keys, this implies currentTzKey is not in the map, forcing the prefix-scan fallback. Verified across TZ=default, Berlin, LA, UTC, NY.)
- [x] Run the full frontend suite (`pnpm test`) — no regressions in unrelated specs. (214 test files, 2295 passing, 29 skipped — clean.)
- [x] Run with one additional TZ that mirrors common CI (`TZ=America/New_York pnpm test web/static/js/tests/health.dexie-hydration.test.js`) — must pass. (10/10 passed.)

## Technical Details

### Why double-underscore-bracketed sentinels?

IANA tzdata zone names are constrained to the alphabet `[A-Za-z0-9_+/-]`, must start with a letter or digit, and never use leading/trailing underscores in any region or city segment. `Intl.DateTimeFormat().resolvedOptions().timeZone` returns either a canonical IANA name or, when the system zone is unknown, `'UTC'` — never a string like `__TEST_FALLBACK_NEWER__`. So `health_overview___TEST_FALLBACK_NEWER__` is guaranteed disjoint from every possible value of `healthOverviewCacheKey()`.

### Alternatives considered

- **Stub `Intl.DateTimeFormat().resolvedOptions().timeZone` to a fixed value** — would require patching before `app.js` loads in the harness; more invasive, and other tests in the same file (lines 130, 162) deliberately call the real `healthOverviewCacheKey()` to verify TZ-qualified seeding. Mixing real and stubbed TZ in one file is fragile.
- **Pick non-matching sentinels at runtime from a candidate list** — works but adds branching in the test. The current static-sentinel structure is fine once the sentinels are guaranteed disjoint.
- **Set `process.env.TZ` inside `beforeEach`** — `Intl` reads the TZ at process start; mutating `process.env.TZ` mid-process does not retroactively change `Intl.DateTimeFormat().resolvedOptions().timeZone` on Node. Not viable.

The non-IANA sentinel approach is the minimal, surgical fix.

## Post-Completion

**Manual verification**:
- None required — the fix is fully reproducible via the three TZ-env runs in Task 1.

**External system updates**:
- None.

**Memory update candidate**:
- Worth adding a gotcha-style memory: "Test sentinels that share a real-world namespace (IANA zones, ISO codes, well-known IDs) can collide with the runner's environment — prefer non-namespace-valid sentinels (`__TEST_*__`) and add an `expect(actual).not.toBe(sentinel)` guard." Decide after the fix lands.
