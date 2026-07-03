# Gamification 10 — Levers & Gauges Restructure

> **Run order: this plan first, then 11 (gauge trends), then 12 (weekly review),
> then 13 (good-day insight).**

## Overview

Concept sharpening on top of shipped phases A–D (plans 6–9). Every metric is
either a **lever** (a decision the user makes today: when to go to bed, how much
to move, what to eat) or a **gauge** (what the body reports back, delayed and
noisy: weight, BP, resting HR, stress, sleep duration). The rule: **gamify levers
daily; read gauges as long-term trends (plan 11); never grade a gauge daily.**

This plan does the lever half:

1. **Daily rings become the three levers: Bedtime · Movement · Nourishment.**
   Vitals and Adherence leave the daily ring set. Every remaining ring is
   closable *by choice today*.
2. **Sleep scoring flips from duration to timing.** The lever is lights-out
   regularity (you choose when to go to bed); duration is a gauge and stays only
   as a Health Score contributor. The Bedtime ring closes on
   bedtime-within-window, not on 7–9h slept.
3. **Adherence becomes a background safety net.** It's a solved habit ("more or
   less given") — no ring, no "your move", no daily grading. It keeps earning its
   integrity-floor HP silently and surfaces exactly one gentle line on Today when
   the rolling 14-day PDC drops below threshold.
4. **Stress leaves scoring entirely.** It is not a lever; even
   improvement-vs-baseline grades the ungovernable. Charts keep showing it.
5. **Health Score reweighting:** stress contributor removed, adherence weight
   reduced (it stays as a small background contributor).

The ledger, levels, HP history, and the pure-function-of-the-log invariant are
untouched. Ring restructure happens at the **view layer** — no migration.

## Context (from discovery)

- Ring taxonomy: `internal/domain/gamification/scoring/scoring.go:33-39`
  (`RingAdherence|Movement|Vitals|Nourishment|Mind`); ledger rows are keyed by
  these strings (UNIQUE `(user_id, day_unix, ring, source_metric, kind)`), so the
  engine keeps writing awards under the existing keys — the **rings read model**
  re-maps to lever rings for display.
- Rings view: `ringScores()` in `internal/domain/gamification/summary.go`
  (per-ring `Closed`/`Progress`/`Goal`/`SyncPending`); goal strings in
  `goals.go`; the frontend renders whatever list the API returns (`today.js`
  rings tile, `journey.js` rings card, `wg-ring-stack` takes N rings).
- Sleep scoring: `ScoreSleep` (`scoring.go:~424`) — duration outcome
  (`SleepOutcomeMaxHP=10`) + timing-regularity consistency
  (`SleepRegularityMaxHP=5`). This plan swaps the emphasis.
- Auto vitals: `ScoreVitalsAuto` (`scoring.go:~391`) — stress award removed here;
  resting HR / SpO₂ daily awards are removed in plan 11 (all gauge-HP economy
  changes live there).
- Adherence loader + miss inference: `scoreday.go` (PENDING-past-slot = miss);
  PDC precedent in `docs/gamification.md` §6.1.
- Health Score contributors + weights: `internal/domain/gamification/wellbeing.go`,
  constants in scoring `Config`.
- Targets: `targets.go` overlay + Settings editor
  (`web/static/js/features/settings.js`, metrics list incl. `stress`,
  `sleep_hours`).
- Sync honesty (phase A): `SyncPending` semantics — the Bedtime ring is
  sync-flavored (backup imports), it inherits the Mind ring's treatment.

## Development Approach

- **Testing approach**: NO unit tests. One service-level integration test
  guarding the lever-ring mapping + safety-net contract (see Task 5).
- View-layer restructure only: ledger keys, backfill latch, level math untouched.
  No re-backfill of history; new rules apply to newly scored/rescored days (HP is
  non-punitive, so mixed-rule history is harmless — document this).
- All JSON changes additive or same-shape (the rings array simply contains three
  lever rings; shape per element unchanged plus a stable `key`).
- **CRITICAL: update this plan file when scope changes during implementation.**

## Testing Strategy

- **Unit tests**: none.
- **Integration tests**: one — through the real service + seeded SQLite store:
  (a) rings view returns exactly Bedtime/Movement/Nourishment; (b) Bedtime
  closes on a bedtime-in-window night and does NOT close from a diary entry;
  (c) seeded missed doses below PDC threshold → `adherence_alert.active=true`,
  above threshold → absent/false.
- **E2E tests**: none.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope

## What Goes Where

- **Implementation Steps**: engine tweaks, view remap, safety net, frontend,
  docs.
- **Post-Completion**: lived-experience check of the three-ring day.

## Implementation Steps

### Task 1: Engine — sleep flips to bedtime timing; stress descored

- [x] `ScoreSleep`: timing-regularity becomes the primary award
      (`SleepRegularityMaxHP` → 10); the daily duration outcome award is removed
      (`SleepOutcomeMaxHP` → deleted or 0 with a comment pointing to the Health
      Score contributor); integrity floor for logging a night stays
- [x] bedtime membership: trapezoid on lights-out deviation from the user's
      bedtime window — default window = trailing 14-day median bedtime ± 45 min
      (Config constants), overridable via a new `bedtime` target metric
      (validated like the other bands)
- [x] `ScoreVitalsAuto`: remove the stress award and its Config band; resting
      HR / SpO₂ daily awards stay for now (plan 11 moves them to weekly gauges —
      keep this plan's engine diff minimal)
- [x] Config cleanup: delete stress constants; add bedtime-window constants

  ➕ Implementation note: `Config.BedtimeWindow` reuses the existing `Band`
  type (`Low` pinned to 0, `High`/`Falloff` in minutes) so the `bedtime` target
  override rides the existing generic band-override validation
  (`applyTarget`/`validateTarget`) with no new code — `ScoreSleep` scores
  `cfg.BedtimeWindow.Membership(|deviation|)`. Computing the trailing 14-day
  median bedtime that centers `TimingDeviationMin` for a real night stays a
  loader concern (`loadSleep` still leaves `HasRegularity` unset, as before
  this plan — see scoreday.go's package doc); wiring that loader is left to
  whichever later task first needs a live bedtime award (view layer/goals.go,
  Task 2) rather than duplicated here.

### Task 2: View layer — rings become the three levers

- [x] `ringScores()` (`summary.go`): build the rings list as
      `bedtime` (← sleep timing award, `SyncPending` when no sleep row today),
      `movement` (← steps/workout awards, unchanged),
      `nourishment` (← food awards, unchanged); per-ring `Closed` = that lever's
      non-floor award present; adherence/vitals/mind-diary awards keep flowing
      into HP but produce no ring
- [x] `goals.go`: goal strings per lever — bedtime reads in the user's numbers
      ("Lights out 22:45–00:15"); movement/nourishment unchanged

  ➕ Implementation note: wiring the bedtime goal's real clock numbers required
  wiring the loader Task 1 punted here — `loadSleep` (scoreday.go) now computes
  the trailing 14-night median bedtime (`medianBedtimeOnset`, reusing
  wellbeing.go's existing `sleepOnsetMinutes` continuous-scale helper + a new
  `median()` numeric helper) and sets `HasRegularity`/`TimingDeviationMin` for
  real; a parallel `bedtimeBaselineCenter` method (same query shape, ponytail:
  accepted as a second read like `ringProgress`'s existing re-derivation) feeds
  `ringGoals` the clock-time window even on a night with no sleep row yet.

- [x] `PeriodRings` (weekly view) re-mapped to the same three levers (shared
      `ringScores`, no separate code path)
- [x] update `docs/api.md#gamification` (rings array now three lever rings) and
      the MCP `ResponseExample`s in `operations_gamification.go`
- [x] frontend follows the API automatically (`wg-ring-stack` takes N rings);
      verify "your move" candidates are now levers-only by construction, headline
      becomes "N of 3"; adjust any hardcoded five-ring assumptions in
      `today.js` / `journey.js` / their test fixtures

### Task 3: Adherence safety net

- [x] compute rolling 14-day PDC in the summary read path (reuse the adherence
      loader + miss inference); expose additive
      `adherence_alert {active, pdc, missed_doses}` on summary/bootstrap when PDC
      < threshold (Config, default 0.90) — field absent/inactive otherwise
- [x] `today.js`: one gentle line when active ("2 missed evening doses this
      week — worth a look"), token-neutral styling, links to Meds section; no
      line at all when adherence is fine (a solved habit is invisible)
- [x] remove adherence from any remaining daily-loop surface (it no longer has a
      ring; confirm nothing else nags it)

  ➕ Implementation note: `computeAdherenceAlert` (wellbeing.go) reuses the
  same `loadAdherenceRange` window as `healthScoreAdherence` (Config's
  existing `HealthScoreWindowDays`, 14d default) but grades dose-level PDC
  (taken ÷ expected doses) rather than day-level, so `missed_doses` is a plain
  count (`expected - taken`) for the nudge copy. `AdherenceAlertPDCThreshold`
  (0.90) is a distinct, stricter config constant from
  `HealthScoreAdherencePDCTarget` (0.8, Health Score credit) — the two must
  not be conflated. Wired additively onto `Summary` (bootstrap/journey ride
  along automatically) and onto the slim `ringsView` (`/api/gamification/rings`,
  what Today actually reads). A repo-wide grep confirmed no other frontend
  surface nags adherence — this is the only nudge.

### Task 4: Health Score reweight + targets editor

- [x] `wellbeing.go`: remove the stress contributor; lower the adherence
      contributor weight (Config); sleep-duration contributor stays (duration's
      new home); renormalization already handles the changed set
- [x] Settings targets editor: drop `stress`, add `bedtime` (window editor with
      the recommended-value hint pattern); `PUT /api/gamification/targets`
      validation covers the new metric
- [x] update the Journey "How this works" explainer: levers close rings daily;
      gauges (weight, BP, heart) are read as trends — one plain-language
      paragraph

  ➕ Implementation note: the Health Score never had a stress contributor
  (`ScoreVitalsAuto`'s stress award was already removed in Task 1; the
  `Contributors` slice in `wellbeing.go` only ever listed bp/sleep/hr/weight/
  adherence) — that half of the first bullet was a no-op check. Lowered
  `Config.HealthScoreWeightAdherence` from 1.0 to 0.5 (small background
  contributor, per Overview). The targets backend already had `TargetKeyBedtime`
  and no stress key (Task 1/2); only the frontend (`settings.js`'s
  `GAMIFICATION_TARGET_METRICS` array + `index.html`'s stress input block) still
  needed the swap — replaced with a `bedtime` block (min-unit Low/High fields,
  same generic band-override editor pattern as the other metrics, ordered to
  match backend `targetMetricKeys`). Added one explainer row to `journey.js`'s
  `EXPLAINER_TERMS` distinguishing levers (close rings daily) from gauges (read
  as trends).

### Task 5: Verify acceptance criteria

- [ ] integration test per Testing Strategy
- [ ] verify Overview requirements: three lever rings, bedtime-not-duration,
      silent adherence with working alert, no stress anywhere in scoring or
      targets
- [ ] `go test ./...` passes (incl. MCP coverage guard)
- [ ] `pnpm test` passes (fixtures updated for three rings)
- [ ] `golangci-lint run` + `gofmt` clean

### Task 6: Update documentation

- [ ] `docs/gamification.md`: new §2.5 "Levers & Gauges" stating the rule
      (gamify levers daily, trend gauges long-term, attribute via insights);
      rewrite §5 ring table to the three levers; §6.4 sleep flip; §6.1 adherence
      safety-net role; note the mixed-rule history stance
- [ ] `docs/api.md`: rings + `adherence_alert` + `bedtime` target

## Technical Details

- **No ledger migration**: engine keeps writing `RingMind/MetricSleep/...` keys;
  only the read model groups awards into lever rings. Lifetime HP is a
  ring-agnostic sum, so nothing moves.
- Bedtime source: sleep rows' start timestamp (`internal/store/vitals`); nights
  bridging midnight belong to the wake-day, same day-resolution as scoring;
  bedtime after midnight is a valid in-window value (window may span midnight —
  handle the wrap).
- The Bedtime ring inherits `SyncPending` (phase A): unsynced night → dimmed
  "syncs later", closes retroactively on import; the "your move" evening nudge
  for bedtime is *prospective* copy ("lights out by 00:15 keeps your rhythm"),
  which is the one lever where a forward-looking prompt makes sense.
- Diary/mood: keeps its floor + reflection HP (process reward, §6.8 unchanged) —
  it just no longer has a ring. (ponytail: if Mind-as-a-ring is missed in
  practice, re-adding a fourth ring is a view-layer one-liner.)

## Post-Completion

**Manual verification:**
- Live with the three-ring day: evening bedtime nudge feels like a suggestion,
  not a nag; a backup import closes Bedtime retroactively; adherence line stays
  invisible while doses are normal.
