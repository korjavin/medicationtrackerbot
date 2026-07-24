# Workouts: friendly body-part translation layer + chip on exercise cards (bd med-mj4)

## Overview
Keep the imported MEDICAL body-part taxonomy in `web/static/data/exercises-catalog.json`
exactly as-is, but (a) add ONE shared translation layer mapping medical body-part
values to lifter-friendly display names, and (b) show that friendly label as a chip
on active-session workout EXERCISE cards — not only in the Stats "Body-part Split"
section where the medical-term logic lives today.

Problem it solves: dogfooding the cloud workouts UI surfaces raw medical terms
("upper legs", "waist", "lower arms") on the Body-part Split and nowhere else. This
introduces a friendly vocabulary (Legs / Core / Forearms …) in a single reusable
helper and applies it to session cards too, so both surfaces agree.

## Context (from discovery)
- **Catalog (DO NOT EDIT):** `web/static/data/exercises-catalog.json` — 1324 exercises,
  each with `body_part` in {upper legs, lower legs, waist, chest, back, shoulders,
  upper arms, lower arms, cardio, neck}. Medical terms must stay.
- **Existing translation seam (to be replaced/reused):** `web/static/js/features/workout/stats.js`
  - `_exerciseBodyPartMapPromise` + `_loadExerciseBodyPartMap()` (L32–52): single-flight
    fetch of the catalog JSON → `Map<lowercased-trimmed name, body_part>`. Failure nulls
    the promise for retry and returns an empty Map.
  - `_BODY_PART_LABELS` map + `_bodyPartLabel(bp)` (L77–84): currently just capitalizes,
    including an 'uncategorized' → 'Uncategorized' entry.
  - `_computeBodyPartSplit(topExercises, bodyPartMap)` (L63–75): buckets by `map.get(key)`,
    unmatched → 'uncategorized'.
  - `_renderBodyPartSplit(root, topExercises)` (L88–136): `await`s the map, `if (map.size===0) return`,
    computes the split, renders rows with `_bodyPartLabel(body_part)`.
- **PR-badge pattern to mirror (sessions.js):**
  - `_buildSessionExerciseCard(log, index)` (L245–410) builds each card; `headerRow`
    holds `title` (child[0]) + `deleteButton` (child[1]); calls `_maybeAttachPRBadge(headerRow, log)`
    fire-and-forget at L286.
  - `_maybeAttachPRBadge(headerRow, log)` (L416–454): async, guards `headerRow.isConnected`,
    guards double-append via `headerRow.querySelector('.wg-workouts-session-exercise__pr-badge')`,
    `headerRow.insertBefore(badge, headerRow.children[1] || null)`.
- **Second catalog fetch:** `library.js` (`_exerciseCatalogNamesPromise`) — routing it
  through the shared cache is a NICE-TO-HAVE, not required. Skip unless trivial.
- **Load order:** `web/static/index.html` L2264–2275 loads the workout sub-files;
  `sessions.js` (2272) and `stats.js` (2274) both consume the new module.
- **Test harness:** `web/static/js/tests/helpers/frontend-harness.js` L425–442 evals the
  workout sub-files in dependency order under `withWorkout: true`.
- **Existing tests:** `features.workout-stats.test.js` (body-part split describe, stubs
  `window.fetch` for `/static/data/exercises-catalog.json`); `workout.session-detail.test.js`
  (`openSession(window, logs)` renders cards).
- **CSS:** `web/static/css/styles.css` L7749 `.wg-workouts-session-exercise__pr-badge`
  block uses `--wg-tag-high-*` tokens; tag tokens `--wg-tag-{normal,high,alert}-{bg,fg,border}`
  live at L252–260.
- **Globals allowlist:** `web/static/js/tests/architecture.globals.test.js` L161–164 lists
  the workout globals with justification comments.
- **SW precache:** `exercises-catalog.json` is NOT in any precache list today (grep clean);
  the chip is a silent no-op when the catalog can't load, so no precache change is needed —
  leave the sw-precache list alone.

## Development Approach
- **Testing approach:** Regular (code first, then extend the OWNING integration suites).
- **Frontend tests are integration-first** (CLAUDE.md rule 8): extend the existing
  `features.workout-stats.test.js` and `workout.session-detail.test.js` suites via the
  shared harness. **Do NOT** create `*-branches` / `*-edges` / `*-characterization` /
  `pin-defect-N` / `task-N` files.
- Smallest coherent diff. Reuse the PR-badge async-attach flow verbatim. No new
  abstractions beyond the one shared catalog helper the bead asks for.
- All tests must pass before the next task.

## Testing Strategy
- **Unit-ish (via integration harness):** translation dict + single-flight lookup asserted
  through the extended `features.workout-stats.test.js` suite.
- **Integration:** per-card chip asserted through `workout.session-detail.test.js` (matched
  exercise → chip; unmatched → no chip).
- **Architecture guards:** globals allowlist, inline-styles/design-token, sw-precache tests
  must stay green.

## Progress Tracking
- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix; blockers with ⚠️ prefix.

## Implementation Steps

### Task 1: Create shared WorkoutExerciseCatalog helper
- [x] Create `web/static/js/features/workout/exercise-catalog.js` — an IIFE that owns a
      module-private single-flight promise for `fetch('/static/data/exercises-catalog.json')`,
      building a `Map<lowercased-trimmed name, body_part>` (mirror the exact normalization
      and failure handling of stats.js `_loadExerciseBodyPartMap`: on error `console.error`,
      null the promise for retry, resolve an empty Map).
- [x] Expose `window.WorkoutExerciseCatalog` with:
      `load()` → `Promise<Map>` (the single-flight name→body_part map),
      `getBodyPart(exerciseName)` → `Promise<string|null>` (`(await load()).get(norm(name)) || null`),
      `friendlyBodyPart(bodyPart)` → `string|null` (pure dict lookup, no fetch).
- [x] Translation dict (medical DB value = key → friendly display):
      `upper legs→Legs, lower legs→Calves, waist→Core, upper arms→Arms, lower arms→Forearms,
      chest→Chest, back→Back, shoulders→Shoulders, neck→Neck, cardio→Cardio`.
      Any unmatched/unknown/uncategorized key → return `null`.
- [x] Add `window.WorkoutExerciseCatalog` to the allowlist in
      `web/static/js/tests/architecture.globals.test.js` with a justification comment
      (single-flight catalog fetch + medical→friendly body-part translation shared by
      stats split and session-card chip; med-mj4).
- [x] Add `<script src="/static/js/features/workout/exercise-catalog.js?v=TIMESTAMP_PLACEHOLDER"></script>`
      to `web/static/index.html` in the workout block BEFORE `sessions.js` and `stats.js`
      (e.g. right after `miband.js`, before `sessions.js`).
- [x] Register the new file in `web/static/js/tests/helpers/frontend-harness.js`
      (`WORKOUT_EXERCISE_CATALOG_JS` const + `evalFileCached(window, WORKOUT_EXERCISE_CATALOG_JS)`
      in the `withWorkout` block, BEFORE `WORKOUT_SESSIONS_JS` and `WORKOUT_STATS_JS`).
- [x] Extend `features.workout-stats.test.js` with a `describe('WorkoutExerciseCatalog')`
      block: assert `friendlyBodyPart` maps every medical value to its friendly name
      (spot-check upper legs→Legs, waist→Core, lower arms→Forearms, cardio→Cardio) and
      returns `null` for unknown/'uncategorized'; assert `getBodyPart` is case-insensitive
      and returns `null` for a name absent from the catalog; assert the catalog is fetched
      at most ONCE across repeated `getBodyPart`/`load` calls (single-flight).
- [x] Run the two suites — must pass before Task 2:
      `export PATH="$(ls -d /tmp/node-v20*/bin | head -1):$PATH"` then
      `npx vitest run web/static/js/tests/features.workout-stats.test.js web/static/js/tests/architecture`.
      ➕ Also added the new JS file to `web/static/sw.js` STATIC_ASSETS (sw-precache guard)
      and an ALLOWLIST entry in `architecture.offline-coverage.test.js` (static-asset fetch,
      silent no-op offline — not a section-landing read).

### Task 2: Route stats.js through the shared helper (delete its duplicates)
- [x] In `web/static/js/features/workout/stats.js` delete `_exerciseBodyPartMapPromise`,
      `_loadExerciseBodyPartMap()`, `_BODY_PART_LABELS`, and `_bodyPartLabel()`.
- [x] In `_renderBodyPartSplit`: replace `await _loadExerciseBodyPartMap()` with
      `await window.WorkoutExerciseCatalog.load()` (keep the `if (map.size === 0) return;`
      guard so an unavailable catalog still skips the split).
- [x] Replace label rendering: `name.textContent = window.WorkoutExerciseCatalog.friendlyBodyPart(body_part)
      || (body_part.charAt(0).toUpperCase() + body_part.slice(1))` — preserving the current
      'Uncategorized' fallback for the uncategorized bucket.
- [x] Keep `_computeBodyPartSplit(topExercises, map)` unchanged (it already takes the Map).
- [x] Confirm the existing body-part-split cases in `features.workout-stats.test.js` still
      pass unchanged (case-insensitive bucketing, no-top_exercises → no fetch, failed
      catalog → silent no split). Adjusted the one label assertion (now friendly 'Legs' vs
      medical 'Upper legs') — expected given the intended medical→friendly switch.
- [x] Run the suite — must pass before Task 3:
      `npx vitest run web/static/js/tests/features.workout-stats.test.js`.

### Task 3: Friendly body-part chip on active-session exercise cards
- [x] In `web/static/js/features/workout/sessions.js` add `_maybeAttachBodyPartChip(headerRow, log)`
      mirroring `_maybeAttachPRBadge`: `const bp = await window.WorkoutExerciseCatalog.getBodyPart(log.exercise_name);`
      then `const friendly = window.WorkoutExerciseCatalog.friendlyBodyPart(bp);` — return early
      when `!friendly`. Guard `if (!headerRow.isConnected) return;` and
      `if (headerRow.querySelector('.wg-workouts-session-exercise__bodypart-chip')) return;`.
      Wrap the lookup so a missing/failed catalog is a silent no-op (guard
      `window.WorkoutExerciseCatalog` presence). Insert the chip left of the delete button:
      `headerRow.insertBefore(chip, headerRow.querySelector('.exercise-log-delete-btn') || null)`
      (or `headerRow.children[1]`), so it coexists with the PR badge.
- [x] Call `_maybeAttachBodyPartChip(headerRow, log)` fire-and-forget in
      `_buildSessionExerciseCard`, next to the existing `_maybeAttachPRBadge(headerRow, log)` (~L286).
- [x] Add `.wg-workouts-session-exercise__bodypart-chip` to `web/static/css/styles.css`
      near the pr-badge block (~L7749), styled ONLY with `--wg-*` tokens (use
      `--wg-tag-normal-{bg,fg,border}`, `--radius-sm`, `--space-xs`, `--font-size-xs`,
      `--wg-font-mono` — mirror pr-badge but the normal/green tone to distinguish from the
      amber PR badge). NO hardcoded colors, NO inline `.style.` in JS.
- [x] Extend `workout.session-detail.test.js`: stub `window.fetch` so the catalog resolves
      with a small fixture (e.g. `{name:'Bench', body_part:'chest'}`), open a session with a
      matched-name log, assert a `.wg-workouts-session-exercise__bodypart-chip` with textContent
      'Chest' appears; open with an unmatched name and assert no chip. (Await a
      microtask/flush so the fire-and-forget async attach completes, as the PR-badge cases do.)
- [x] Run both suites — must pass:
      `npx vitest run web/static/js/tests/features.workout-stats.test.js web/static/js/tests/workout.session-detail.test.js web/static/js/tests/architecture`.

### Task 4: Verify acceptance criteria
- [ ] `git diff --stat` confirms `web/static/data/exercises-catalog.json` is UNCHANGED.
- [ ] One shared translation layer maps medical→friendly and is used by BOTH the Stats split
      and the new chip (no duplicated dict/fetch remains in stats.js).
- [ ] Chip appears on session cards only for catalog-matched exercises; absent otherwise.
- [ ] Globals allowlist updated with justification; inline-styles/design-token tests green.
- [ ] Run the FULL frontend suite: `npx vitest run` (Node 20 on PATH).
- [ ] Sanity: `go build ./...` still succeeds (frontend-only change → no-op).

## Technical Details
- `getBodyPart` is async (awaits the single-flight map); `friendlyBodyPart` is sync (pure dict).
- Single-flight: one module-level promise; failure nulls it for retry (as stats.js did).
- Chip and PR badge both insert before the delete button; their relative order is
  non-deterministic (both async) but both sit left of delete — acceptable.
- Normalization for the name key: `String(name).toLowerCase().trim()` (identical to stats.js today).

## Post-Completion
**Manual verification** (optional, not agent-automatable):
- Open an active workout session with a catalog-matched exercise (e.g. "Barbell Squat") and
  confirm a "Legs" chip renders next to the name; confirm the Stats → Body-part Split now
  reads "Legs / Core / Forearms …" instead of the medical terms.
