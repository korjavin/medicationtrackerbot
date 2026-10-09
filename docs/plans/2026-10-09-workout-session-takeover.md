# Workout session takeover (W1–W3) — bd med-xso6.21

Spec: `docs/design/claude-design/ui_kits/app-v2/screens-workouts.html` W1–W3; kit
classes `.wg-session-top/-prog/-foot`, `.wg-ex`, `.wg-sethead`, `.wg-set`, `.wg-rest`,
`.wg-plates` (already shipped in `web/static/css/components.css`).

## Data model (no schema change)

- `log.sets` stays the persisted per-set array and now means **done sets**.
- Pending rows = `max(done, log._targetSets) - done`. `_targetSets` comes from the
  plan (snapshot row or live variant, matched by `exercise_id`) at open; "Add set"
  raises it. Pending rows are never written — Finish drops them.
- Un-logged planned rows open with `sets: []` (zero done) instead of the old
  "Not yet logged — edit to include" synthesized sets.
- Pending row values = draft (`log._drafts[j]`, accepted/adjusted cells) over a
  ghost: last session's set i (`GET /api/workout/exercises/history`, newest
  prior session), else the previous done set, else the plan target.
- Session status is `WorkoutSessionsState.targetStatus` (the status select is
  gone); Finish sets `completed`, a finished session changes it from the overview.

## Tasks

1. Markup: `#workout-session-modal` becomes a `wg-page wg-session` full-screen
   takeover (top bar with minimise/clock/status chip, progress segments button,
   `.wg-content`, rest dock, `.wg-session-foot`).
2. sessions.js: one-exercise view with `.wg-set` rows (idx toggle → RPE/type,
   ghost cells tap-to-accept, ± adjusters on the active row, done/undo check),
   prev/next in the footer; overview (exercise rows, + Exercise, gym switch,
   status for finished sessions) on progress tap.
3. Rest timer: 90s dock after each done set (in-progress only), +30s / Skip;
   best-effort `reg.showNotification` when `document.hidden` at expiry.
4. Finish: `safeForm` kit dialog (sun primary) listing unlogged sets + time /
   sets / volume summary, then the unchanged serialized save.
5. Keep autosave/flush/refuse-close, med-laj4 nudge, applyOptimistic writes.
6. Tests: update the session suites; docs/features.md.
