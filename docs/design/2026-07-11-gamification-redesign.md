# Design: Gamification redesign — the Discovery Engine

**Beads:** med-z1n (Gamification epic), med-eyb (cloud port), med-z1n.3 (AI workout insights — absorbed into Phase 6)
**Date:** 2026-07-11 · **Status:** design proposal for owner review — not implemented
**Supersedes (conceptually):** the progression model of [docs/gamification.md](../gamification.md) §7–§8. The scoring engine, guardrails (§3), levers/gauges model (§2.5), and honesty-gate template (§14.8) all survive — they are the substrate this design builds on.
**Target:** the CLOUD build (`cmd/cloud` + `web/cloud` + `web/domain`). Zero-knowledge constraint: the server sees only ciphertext, so **everything here computes client-side** from decrypted vault data.

---

## 1. Why the current design is boring

The shipped system (HP → levels → insight ladder) is ethically excellent and mechanically inert. Diagnosis:

1. **Nothing unexpected ever happens.** Rewards are transparent and predictable (by design, to avoid dark patterns) — but the design conflated "no manipulative variable rewards" with "no surprise at all." The result: after week one, the user can predict every screen before opening it. Curiosity — the strongest intrinsic driver available — is never engaged.
2. **The insight ladder is a grind gate on a static prize.** Levels gate insights, but leveling is just accumulation, and the two insights behind the gates (sleep→BP, good-day model) are *fixed*. Once seen, they never change. The "reward" is a museum exhibit you visit once.
3. **Insights are terminal, not actionable.** "Nights under 6h precede +6 mmHg mornings" is the most interesting fact in the app — and there is nothing to *do* with it. No hypothesis to test, no prediction to check, no loop back into behavior.
4. **No identity, no story.** "Level 7, 3,412 HP" says nothing about who the user is becoming. Numbers accumulate; nothing *unfolds*.
5. **Progress is generic.** The progress-to-next-level bar measures grinding, not meaning. The user never sees progress toward something they specifically *want to know*.

The fix is not more points. The fix is making **discovery itself the game**: the app becomes an instrument the user points at their own body, and the pull to open it is *"what will it find next, and was it right about yesterday?"*

## 2. The vision: you are the experiment

> The app's promise changes from "earn points for healthy behavior" to **"the more honestly you log, the more your body's hidden patterns develop — and you can test them."**

The core loop becomes:

```
 log honestly ──▶ evidence accumulates ──▶ a discovery REVEALS
      ▲                                          │
      │                                          ▼
 tomorrow's forecast + ◀── run a self-experiment ◀── "is it really true?"
 a verdict to check                (N-of-1)
```

Three properties make this captivating where HP was not, without a single dark pattern:

- **Earned unpredictability.** *Which* pattern clears its evidence gate next is genuinely unknown — because it depends on the user's real physiology, not an RNG. This is a variable reward schedule run by *truth*: honest, unmanipulable, and still surprising. (Behavior science: curiosity gap / information-gap theory, Loewenstein; variable reward without the slot machine.)
- **Specific, meaningful progress.** Every locked discovery shows exactly what evidence it still needs ("6 of 8 workout-morning pairs — log BP tomorrow morning to add one"). Logging stops being abstract virtue and becomes *feeding a specific question you want answered*. (Progress principle, Amabile & Kramer; goal gradient effect.)
- **A daily open-loop.** The evening forecast ("tonight's bedtime window gives tomorrow a ~72% shot at an in-range morning") plants a question the user can only answer by coming back tomorrow — and by *doing the behavior*. Cue → routine → reward, with the reward being resolution of a prediction about your own body. (Zeigarnik effect; Fogg prompt design; implementation intentions.)

## 3. The mechanics

Eight named mechanics. #1–#4 are the new heart; #5–#7 are the narrative shell; #8 is the retained substrate.

### 3.1 The Discovery Atlas *(replaces the insight ladder)*

A living feed of **discovery cards** about the user's own body, in three states:

- **Developing** — the probe hasn't cleared its evidence gate. The card shows the question and a *specific* progress meter: "Do workout days lower your next-morning BP? · 6 of 8 paired mornings — 2 more to develop." Tapping it says exactly which log action adds evidence.
- **Revealed** — the gate cleared. A one-time reveal moment (card "develops" like a photograph, single gentle animation, never a loot-box) shows the finding with its numbers: "Mornings after workouts: systolic ~6 mmHg lower · 23 paired days."
- **No effect / steady** — the gate cleared and found nothing. Rendered as a *genuine finding* with equal visual dignity: "Your morning BP holds steady regardless of sleep length — that's stability worth having." (Inherited verbatim from the §14.8 honesty-gate template: `insufficient_data` and `no_effect` are results, never blanks.)

**The critical rule change: discoveries are gated by *evidence*, not by *level*.** The old design locked insight behind grinding HP; a user with rich data but low engagement-theater saw nothing. Here the gate is the honest statistical minimum (min N per arm + noise floor) — which is also the only gate that was ever epistemically defensible. Levels stop gating anything.

Revealed discoveries are not static: each card carries a **freshness window** (recomputed over the trailing 90d on read) and can change state over time — "this effect has strengthened since last month" / "this pattern has faded." The Atlas is a garden, not a trophy case.

*Loop driven:* log → watch specific meters fill → reveal → curiosity for the next one.
*Science:* information-gap curiosity; progress principle; competence (SDT); endowment — they're *your* discoveries.

### 3.2 The probe catalog *(the deterministic insight engine — see §4)*

A fixed, curated catalog (~15 at launch, extensible) of **probes**: deterministic lever→gauge and pattern questions with pre-registered pairing rules, evidence gates, and noise floors. No data dredging, no p-hacking-as-a-service — every probe is a hand-written, clinically sane question. The LLM never invents probes (§4.3).

### 3.3 Self-Experiments (N-of-1 trials) *(the flagship — promoted from the old design's "L9+, someday")*

Any revealed discovery — or a suggestion card — offers **"Test it."** The user commits to a 14-day structured experiment, authored as an implementation intention:

> **When** it's 22:30, **I will** start winding down. **We'll measure:** your next-morning systolic on window-nights vs. off-nights, against your 60-day baseline. **Verdict in 14 days.**

During the run: a small "Day 6 of 14 · 5 window-nights so far" tracker on Today. At the end: a **Verdict card** computed by the same honesty-gate math — `effect` / `no_effect` / `not_enough_contrast` — with the numbers shown. **"No effect" pays exactly the same completion reward as "effect"** (a Keystone entry + the verdict itself), so the user is never incentivized to want a result, only to run a clean trial.

Max **one** concurrent experiment. Templates only from a curated library keyed to lever behaviors (bedtime window, workout cadence, dose timing, protein target, morning walk) — never restriction, never "lose X kg" (§5).

*Loop driven:* discovery → hypothesis → 14 days of unusually motivated logging → verdict anticipation → next question.
*Science:* implementation intentions (Gollwitzer); self-efficacy through enactive mastery (Bandura); commitment & consistency; the entire single-case experimental design literature (N-of-1 trials are a real clinical method — this is the honest version of "personalized medicine").

### 3.4 The Tomorrow Forecast + calibration *(the daily open-loop)*

Every evening, one card on Today, computed from the user's own good-day model (the §14.12 attribution engine, generalized):

> "Tonight: bedtime in your window + both doses done → mornings like that have been in-range **72%** for you (vs 51% otherwise)."

Next morning, after the BP log, the card resolves: "Your body agreed ✓" or "Not this time — one morning is noise; the pattern needs weeks." Alongside it, a **"How well do we know you?"** calibration meter — the model's trailing hit-rate — which becomes the app's most honest progress bar: it only improves with more honest data, and it *can* say "we don't know you well yet."

Forecasts are only ever attached to **lever-conditioned process outcomes** ("in-range morning share"), phrased as chances, never risks; never on weight; hidden in ED-safe and recovery modes (§5).

*Loop driven:* evening cue → behavior → morning resolution → daily return without a single push notification.
*Science:* Zeigarnik open loops; prediction-error dopamine (honest version — the surprise is real); cue→routine→reward with an *informational* reward.

### 3.5 Chapters *(narrative structure — replaces endless leveling as the arc)*

Time-boxed **4-week themed arcs** the user chooses (or accepts a suggestion for): "The Steady Month" (BP consistency), "The Early Sleeper" (bedtime window), "The Rebuild" (post-illness gentle return). A chapter has: a theme, 2–3 relevant probes pinned to its dashboard, an optional experiment slot, and — at the end — a **Chapter Review**: a short written recap of what happened and what was discovered, deterministic-template by default, LLM-narrated with the user's own key if enabled (§4.3).

Chapters end; they are never failed. A quiet chapter closes with "a quiet chapter" (the §14.11 precedent). Starting one is always opt-in at a temporal landmark (Monday / month start — Fresh-Start Effect, Dai & Milkman).

*Loop driven:* monthly re-commitment; story you can retell ("my March was the Steady Month").
*Science:* fresh-start effect; narrative identity (McAdams); goal-setting with time-boxing (Locke & Latham).

### 3.6 Traits *(identity-based habits, with gentle loss-aversion)*

Sustained lever behavior earns a **Trait** — a present-tense identity statement, not a badge: after bedtime-in-window ≥21 of 28 nights, the user *is* an **Early Sleeper**. Traits are living:

- **Held** — currently true (trailing 28d window).
- **Dormant** — the behavior lapsed. The trait dims; it is *never deleted*. Copy: "Early Sleeper · dormant — 5 window-nights rekindles it." This is loss-aversion at its gentlest: something real to maintain, nothing that can be destroyed, and re-kindling is always cheap (defusing the what-the-hell effect).

Traits exist only for **levers** (bedtime, movement cadence, logging honesty, dose timing, protein adequacy). There is no gauge trait — no "Weight Loser," no "Low BP" (§5).

*Science:* identity-based habits (Clear; self-perception theory, Bem); loss aversion applied to status-maintenance rather than streak-destruction.

### 3.7 Keystones *(rare, real milestones)*

Permanent entries in the Atlas for **outcome events that actually matter**, detected from gauges: "Your 90-day BP trend entered your target band — first time since tracking began." "Resting HR trend: best 60-day stretch on record." Plus experiment completions. Keystones are rare *because reality makes them rare* — earned scarcity, never manufactured. They never decay, never expire, and are never a countdown.

*Science:* peak-end rule (memorable moments anchor the whole experience); competence consolidation.

### 3.8 The substrate: HP, rings, Health Score *(retained, demoted)*

Everything shipped in gamification plans 1–13 (three lever rings, integrity floor, weekly gauge awards, Health Score, habit strength, weekly review) **survives unchanged as the substrate** — it is good daily mechanics. What changes is billing: rings and Health Score are the *dashboard*; the Atlas, experiments, and forecast are the *game*. HP keeps accruing (it feeds nothing new; lifetime HP and levels remain as a gentle long-run counter and for continuity), but **levels no longer gate insight** — the one structural retcon (§3.1).

## 4. The insight engine (client-side, zero-knowledge)

### 4.1 Deterministic core: the probe catalog

Every number the user ever sees is computed **deterministically, client-side**, from decrypted vault records. A probe is a declarative spec:

```js
{
  id: 'workout_next_morning_bp',
  question: 'Do workout days lower your next-morning BP?',
  lever: 'workout_completed',          // arm predicate over day d
  gauge: 'first_morning_systolic',     // outcome over day d+1 (lag rule)
  pairing: { lag: 1, cutoffHour: 12 }, // §14.8 pairing semantics
  gate: { minPerArm: 8, noiseFloor: 3 /* mmHg */ },
  guardClass: 'lever_gauge',           // §5 table row that governs it
  phrase: (delta, n) => `Mornings after workouts: systolic ~${delta} mmHg lower · ${n} paired days`,
}
```

The engine is one evaluator over the catalog: bucket days by the lever predicate, compare gauge means/shares across arms, apply the gate, emit `developing | revealed | no_effect` with the exact counts. This **generalizes the two shipped Go insights** (sleep→BP §14.8, good-day model §14.12) into a table — same honesty-gate template, ~15 rows instead of 2. Statistical honesty rules, pre-registered per probe: minimum N per arm, noise floor in the gauge's clinical units, trailing 90-day window, no multiple-comparison fishing beyond the fixed catalog, and copy that never uses causal language ("mornings after X were lower", never "because").

**Launch catalog by domain** (illustrative findings a real user could see):

| Domain | Probe (question) | Example revealed finding |
|---|---|---|
| BP × workouts | workout day → next-morning systolic | "Mornings after workouts: ~6 mmHg lower · 23 pairs" |
| BP × sleep | short night → next-morning systolic (ships today, §14.8) | "Nights under 7h → mornings ~+8 mmHg · 19 pairs" |
| BP × adherence | all-doses-on-time day → same-day evening systolic | "On-time days: evening readings in range 81% vs 62%" |
| BP × pattern | weekday effect on systolic (Mon–Sun buckets) | "Sunday readings run ~4 mmHg higher than your weekday mean" |
| Weight × food | protein-target weeks vs weight-trend velocity | "You hit protein ≥4 days in 4 of your last 5 safe-pace weeks" |
| Sleep × behavior | bedtime-in-window → next-day steps | "Window nights → next-day steps +18%" |
| Sleep × food | late last-meal (>21:00) → sleep duration | "Late dinners: ~40 min less sleep · 14 pairs" |
| Resting HR × movement | ≥2-session weeks vs RHR trend delta | "RHR trend improved in 6 of 8 active weeks" |
| Meds × routine | dinner-logged-before-20:00 → evening dose on time | "Evening dose on time 92% after early dinners vs 61%" |
| Mood × movement | workout day → diary-logged day (process only — mood *value* never scored) | "You wrote in your diary 2× as often on workout days" |

Where a domain's data is absent, its probes simply sit `developing` with honest meters — the feed self-scales to what the user tracks.

### 4.2 What is stored vs. recomputed

Following the Plans 8–13 invariant — *scores are pure functions of the event log* — the Atlas, forecast, gauges, and verdict math are **recomputed on read** and never persisted. Persisted (as encrypted vault records) is only irreducible user state: experiment commitments, chapter selection, trait acknowledgment timestamps, seen/dismissed reveal flags, and cached LLM narrations. A late device sync therefore self-repairs every number on the next read, with no repair path (the §14.5 lesson, inherited for free).

### 4.3 LLM layer: narration, never numbers *(BYO key, opt-in)*

The AI layer reuses the **direct-from-browser BYO-provider pattern** (C2c food AI: `web/cloud/js/aiclient.js` reading the unmasked key from the vault's `integrations.openai` record; requests go device → user's provider, never through `/api`). Hard division of labor:

- **Deterministic engine computes every number.** The LLM receives a compact JSON of *already-computed* stats (revealed discoveries, week deltas, verdicts — no raw logs, no diary text unless separately opted in) and returns prose only: the weekly story, chapter reviews, warmer discovery phrasings, and experiment suggestions *drawn from the template library by id* (it picks and personalizes; it cannot invent an experiment shape).
- **Numbers on screen always come from the deterministic values**, rendered by the client next to the narration, so a hallucinated figure can never displace a computed one. LLM text is visually attributed ("narrated by your AI").
- **Zero key → zero degradation of truth:** every surface has a deterministic template fallback. The LLM is seasoning, not the meal.
- **Opt-in with a plain leakage note** (same class as C2c food AI, documented in the cloud-mode leakage table): "this sends computed health summaries to your own AI provider."

This layer also **is** med-z1n.3 (AI workout insights): the workout-domain stats slice + narration, on an on-app-open / every-N-days cadence with a per-week call cap, cached in a vault record.

## 5. Guardrails

All nine invariants of `docs/gamification.md` §3 apply unchanged (ranges never maxima; integrity floor; mood/food never outcome-scored; no dark patterns; never gate safety or raw data; personalized targets; reversible default-on; structural forgiveness; chronic-illness first). New mechanics add their own rows:

| Mechanic | Guardrail |
|---|---|
| Probes | Fixed curated catalog only — no automated pattern mining, no LLM-invented probes. Every probe pre-registers gate + noise floor. Movement probes respect the WHO ceiling: no probe or phrasing ever implies exceeding it. Mood appears only as a *process* variable (logged/didn't), never as a value. |
| Reveals | One calm reveal per card, ever. No queued "3 new discoveries!" pressure, no reveal countdowns, no FOMO. Recompute can *update* a card quietly; it never re-fires the moment. |
| Experiments | Curated lever templates only; nothing that restricts intake, targets weight directly, or exceeds activity ceilings. Max 1 concurrent; 7–28 day duration; cancel anytime with no penalty; auto-paused by recovery/illness mode. `no_effect` verdicts celebrated identically to `effect`. A verdict is an observation about 14 days, labeled as such — never medical advice; disclaimer on the verdict card. |
| Forecast | Lever-conditioned process outcomes only ("in-range morning share"); phrased as chance, never risk; never about weight; suppressed in ED-safe mode, recovery mode, and whenever the underlying model's arms fall below gate minimums (it says "we don't know you well enough yet" — honesty over theater). A miss is always framed as noise. |
| Traits | Levers only — no gauge traits (no "Weight Loser", no "Low BP"). Dormant, never destroyed; rekindle cost is small and stated. No trait for logging *volume* beyond honesty (no incentive to over-measure). |
| Chapters | Opt-in, never auto-enrolled; a quiet chapter is "a quiet chapter"; no chapter can have a weight-loss-amount theme (pace/consistency themes only). |
| Keystones | Detected from trends the user already earns HP for; never a countdown ("3 days to lose your keystone" is impossible — they're permanent). |
| LLM | Stats-JSON in, prose out; numbers never sourced from the model; opt-in + leakage note; weekly call cap; diary text excluded by default. |
| Global | ED-safe mode extends to: no weight/calorie probes, forecasts, traits, or experiment templates. Recovery mode pauses experiments, forecasts, and trait-window clocks (a sick week can't send a trait dormant). Everything remains one tap to disable per-mechanic, and disabling deletes no data. |

## 6. Cloud architecture

### 6.1 `web/domain/gamification.js` — the pure module

One runtime-agnostic module mirroring the `bp.js`/`weight.js` pattern: injected ports, zero browser globals, guarded by `architecture.domain-purity.test.js`.

```js
export function createGamificationDomain({ records, now, timeZone, aiClient = null }) {
  return {
    // -- substrate parity (mirrors internal/domain/gamification, med-eyb) --
    getSummary(), getJourney(), getRings(), getGauges(), getWeeklyReview(),
    getTargets(), putTargets(body),
    // -- discovery engine --
    getAtlas(),                    // evaluate probe catalog → cards w/ states + evidence meters
    markDiscoverySeen(id),         // reveal-once bookkeeping (vault record write)
    // -- forecast --
    getForecast(),                 // tonight's card + this-morning resolution + calibration meter
    // -- experiments --
    listExperiments(), startExperiment(templateId, params),
    cancelExperiment(id), getVerdict(id),
    // -- chapters & traits --
    getChapter(), startChapter(themeId), closeChapter(),
    getTraits(),
    // -- narration (all optional; deterministic fallback when aiClient == null) --
    narrateWeekly(), narrateChapter(), suggestExperiments(),
  };
}
```

- `records` — the existing vault records port from `web/cloud/js/sync.js` (`recordsPort`); the module **reads the same record types the other domain modules own** (bp, weight, food logs, workout sessions/logs, sleep/vitals, medication intakes, diary) and never duplicates their write paths.
- `aiClient` — the same shape `createFoodAIDomain` consumes, provided by `web/cloud/js/aiclient.js`; `null` in bot mode or when no key is configured.
- Scoring parity: `ScoreDay`, range-membership trapezoid, level curve, habit-strength EMA, gauge trends, and both shipped insights are **ported from the Go engine as the single reference** (per med-eyb: no divergent reimplementation — port `internal/domain/gamification/scoring` semantics function-for-function, with the Go tests' fixtures reused as JS test vectors).
- Performance: full-window recompute on read (365d × ScoreDay + probe evaluation) is fine for one user's data in-browser; memoized per session keyed on the records store's change counter. No persisted ledger.
  (ponytail: recompute-on-read, session memo only — add an IndexedDB score cache only if a real device measurably stutters.)

The probe catalog lives inside the module (a `PROBES` table). If it outgrows the file, it splits into `web/domain/gamification-probes.js` — still pure, still purity-guarded.

### 6.2 apishim routes

`web/cloud/js/apishim.js` wires the module exactly like `bp`/`weight`, and adds `'gamification'` to `PORTED_SET` (closing the med-eyb clamp):

| Route | Method | Module call |
|---|---|---|
| `/api/gamification/summary` · `/journey` · `/rings` · `/gauges` · `/weekly-review` · `/insights` | GET | parity calls (frozen shapes from `docs/api.md#gamification` — the shared `web/static` screens keep working unmodified) |
| `/api/gamification/targets` | GET/PUT | `getTargets` / `putTargets` |
| `/api/gamification/atlas` | GET | `getAtlas` |
| `/api/gamification/atlas/seen` | POST | `markDiscoverySeen` |
| `/api/gamification/forecast` | GET | `getForecast` |
| `/api/gamification/experiments` | GET/POST | `listExperiments` / `startExperiment` |
| `/api/gamification/experiments/{id}` | DELETE | `cancelExperiment` |
| `/api/gamification/chapter` | GET/POST/DELETE | `getChapter` / `startChapter` / `closeChapter` |
| `/api/gamification/traits` | GET | `getTraits` |
| `/api/gamification/narrate/weekly` | POST | `narrateWeekly` (returns cached narration when fresh) |

New routes are cloud-first; a later Go backport for bot mode registers the same paths (+ MCP registry ops per the coverage guard) but is explicitly out of this design's scope.

### 6.3 New vault record types

All encrypted client-side like every other record; synced through the existing oplog. Only irreducible user state (§4.2):

| Record type | Content | Cardinality |
|---|---|---|
| `gamification.targets` | band overrides (parity with `gamification_targets`) | singleton |
| `gamification.experiment` | template id, params, start/end, status, frozen verdict snapshot on completion | one per experiment |
| `gamification.journal` | current chapter {theme, startedAt}, closed-chapter summaries, trait acknowledgments, seen-discovery ids, keystone entries | singleton |
| `gamification.narration` | cached LLM outputs {kind, weekIndex/chapterId, text, generatedAt} | small ring buffer |

### 6.4 UI surfaces (shared `web/static` frontend, both modes)

- **Today:** existing rings tile (unchanged) + the **Forecast card** (evening question / morning resolution) + the in-flight experiment tracker line.
- **Journey screen → becomes "Atlas"** (same `#journey-view` id and deeplink for stability, label change only, per the nav-id precedent): order — chapter header, Health Score card, Discovery feed (developing/revealed/steady cards), experiment slot, gauges panel, traits row, rings card, keystone timeline. The insight-ladder card is retired; its two shipped insights re-render as ordinary Atlas cards (`revealed` from day one for users who had them).
- **Settings:** targets editor (existing) + per-mechanic toggles (forecast / experiments / narration / traits) + the narration opt-in with leakage note.
- All new visuals via `--wg-*` tokens; new globals allowlisted; writes via `DataStore.applyOptimistic` (Critical Rules 3/4/9). Fixing the med-z1n.2 back-nav bug rides along with the first Journey-screen touch.

## 7. Phased implementation plan

Phases are cumulative; each ships user-visible value and keeps `pnpm test` + purity/architecture guards green. "Seams" = files touched.

### Phase 1 — The Atlas POC *(the smallest captivating slice)*

**Delivers:** `web/domain/gamification.js` with the probe evaluator + a 6-probe catalog (the two shipped Go insights as ports — sleep→BP, good-day → plus workout→BP, adherence→BP-share, weekday-BP, protein-weeks×weight-trend), evidence-gated Discovery feed with progress-to-reveal meters and reveal-once state, rendered on the Journey/Atlas screen in cloud mode. `PORTED_SET` gains `gamification` (feature renders; substrate routes may still return `{enabled:false}` stubs). No HP/levels/rings yet — insight leads.
**Seams:** `web/domain/gamification.js` (new), `web/cloud/js/apishim.js` (`/atlas`, `/atlas/seen`, stub parity routes, PORTED_SET), `web/static/js/features/journey.js` (Atlas feed card; flag-gated), `gamification.journal` record type, tests: `tests/architecture.domain-purity.test.js` coverage + a `gamification.atlas` feature suite with fixture vaults (correlated / sparse / null-effect datasets asserting `revealed` / `developing` / `no_effect`).
**Acceptance:** a cloud user with ≥60 days of vault BP+sleep+workout data opens Atlas and sees ≥1 revealed discovery with true numbers, ≥1 developing card whose meter names the exact next log action, and a no-effect card rendered as a finding — all computed client-side; server logs show zero plaintext; purity guard green.

### Phase 2 — Substrate parity *(med-eyb proper)*

**Delivers:** port of the Go scoring engine (ScoreDay, trapezoid, rings, Health Score, habit strength, gauges, weekly review, targets CRUD, level curve for continuity) into the same module; all parity routes live; Today rings tile + Journey substrate cards work in cloud identically to bot mode. Go test fixtures reused as JS vectors to prevent divergence.
**Seams:** `web/domain/gamification.js`, `web/cloud/js/apishim.js` (parity routes), `gamification.targets` record, existing `journey.js`/`today.js` (no changes needed — frozen API shapes), parity test suite.
**Acceptance:** same seeded dataset produces equal HP/level/ring/Health-Score numbers in bot mode (Go) and cloud mode (JS) within documented rounding; med-eyb closable.

### Phase 3 — Tomorrow Forecast + calibration

**Delivers:** `getForecast()` over the generalized good-day model; evening card + morning resolution on Today; "how well do we know you" calibration meter; all suppression guardrails (gates, ED-safe, recovery).
**Seams:** `web/domain/gamification.js`, apishim `/forecast`, `web/static/js/features/today.js` (card), feature tests for evening/morning/insufficient states.
**Acceptance:** with model arms above gate minimums the evening card shows a lever-conditioned chance and resolves next morning; below minimums it honestly declines; never references weight.

### Phase 4 — Self-Experiments

**Delivers:** template library (5 launch templates: bedtime window, workout cadence, dose timing, protein adequacy, morning walk), experiment lifecycle (start/track/cancel/verdict) with honesty-gate verdict math, Today tracker line, Atlas verdict + keystone entry.
**Seams:** `web/domain/gamification.js`, apishim `/experiments*`, `gamification.experiment` record, `journey.js` + `today.js`, experiment feature suite (planted-effect fixture → `effect`; flat fixture → `no_effect` celebrated equally).
**Acceptance:** a full 14-day simulated run yields a numerically correct verdict card; cancel/recovery-pause leave no penalty state; max-1-concurrent enforced.

### Phase 5 — Chapters, Traits, Keystones

**Delivers:** chapter lifecycle + deterministic chapter review; trait engine (held/dormant/rekindle over 28d windows, levers only); keystone detection from existing gauge trends; Atlas layout completes (chapter header, traits row, keystone timeline). Insight-ladder card retired.
**Seams:** `web/domain/gamification.js`, apishim `/chapter` `/traits`, `gamification.journal`, `journey.js`, Settings per-mechanic toggles, feature tests (trait dormancy math, recovery-mode clock pause, quiet-chapter copy).
**Acceptance:** a lapsed trait renders dormant (never deleted) with a stated rekindle cost; a closed chapter produces a review from the deterministic template; keystones appear only on genuine trend events.

### Phase 6 — AI narration *(absorbs med-z1n.3)*

**Delivers:** optional `aiClient` port wiring: weekly story, chapter-review narration, experiment suggestions (template-id-constrained), workout-insight slice — all BYO-key browser-direct, cached in `gamification.narration`, weekly call cap, opt-in + leakage-table entry, deterministic fallbacks everywhere.
**Seams:** `web/domain/gamification.js` (narration functions), `web/cloud/js/aiclient.js` (reuse), apishim `/narrate/*`, Settings opt-in, `docs/cloud-mode.md` leakage table, tests with a stub aiClient (asserting stats-JSON-only payload and that displayed numbers come from deterministic values, not model output).
**Acceptance:** with no key, every surface renders its deterministic fallback; with a key, narration appears attributed, numbers still deterministic, and the request payload contains computed stats only — no raw logs, no diary text.

---

## 8. Open questions for the owner

1. **Levels retcon:** keep lifetime HP/levels visible as a legacy counter, or hide levels entirely once the Atlas ships? (This design demotes but keeps them.)
2. **Bot-mode backport:** should Phases 3–5 mechanics eventually land in Go for bot mode, or is cloud the only forward target? (Affects whether probe specs should live in a shareable JSON form.)
3. **Probe catalog review:** the launch catalog (§4.1) wants a sanity pass against the owner's own data reality (e.g., is last-meal-time reliably logged enough for the sleep×food probe?).
4. **Chapter themes:** curated-only at launch, or user-authored themes from day one?
