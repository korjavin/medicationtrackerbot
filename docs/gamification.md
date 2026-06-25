# Gamification: HealthPoints & the Journey

> **Status: Design proposal — not implemented.** This document specifies *what* we
> want to build and *why* (the science and the ethics). It does not specify the
> migrations, services, or UI components yet. No code in the repo depends on it.
> Treat every number below as a tunable default, not a fixed constant.

## TL;DR — the core loop

The whole system is one virtuous loop:

```
 behave well  ──▶  land in healthy ranges  ──▶  earn HealthPoints (HP)
      ▲                                                   │
      │                                                   ▼
 understand what drives  ◀──  unlock deeper insight  ◀──  level up
 your good days                into your own body
```

The reward for healthy behavior is **self-knowledge** — progressively deeper
personal analytics about *your own body*. That is the design's keystone: it makes
outcome-based scoring ethically safe, because we are never bribing someone to take
a pill — we are letting them *earn understanding of themselves*, which is
intrinsically motivating (competence + curiosity) rather than a manipulative
extrinsic carrot.

The four foundational choices this design is built on:

| Dimension | Choice | Consequence |
|-----------|--------|-------------|
| **Social model** | Solo self-improvement (you vs. your own past) | No leaderboards, no shame, maximal autonomy. Fits the self-hosted single-user ethos. |
| **What earns points** | Outcomes landing in healthy ranges | "Real" health is rewarded — with a thin integrity floor + carve-outs to prevent harm (see below). |
| **Tone** | Motivating: streaks + opt-in challenges, with guardrails | Drive without dark patterns. Forgiveness is mandatory, not optional. |
| **Currency** | Score → levels → unlocked insight | The reward is self-knowledge, not bribery. Purest fit with intrinsic motivation. |

## Why this app is a special case

Most health gamification is built by companies optimizing for **engagement and
retention** (daily-active-users, time-in-app). That commercial pressure is the
root of the dark patterns the genre is infamous for: manipulative variable-reward
schedules, anxiety-inducing all-or-nothing streaks, and leaderboards that motivate
through shame.

This app is **self-hosted, single-user, and built on data ownership**. There is no
retention metric to juice. That frees us — uniquely — to design *ethical,
science-first* gamification that optimizes for the user's actual health and
autonomy. We should treat that as the north star and a genuine differentiator, not
an afterthought.

---

## 1. Goals and non-goals

**Goals**

- Increase consistency of healthy behaviors and honest self-measurement.
- Make the user's own health data *legible and rewarding to engage with*.
- Build durable **intrinsic** motivation (competence, autonomy, curiosity) rather
  than fragile extrinsic dependence.
- Be defensible as science-based, and honest about where the evidence is thin.

**Non-goals (explicitly out of scope)**

- ❌ Maximizing engagement / session count / notifications. We do not optimize DAU.
- ❌ Social comparison, leaderboards, or competition (deferred; see §12).
- ❌ Any mechanic that can incentivize disordered behavior (under-eating,
  over-exercising, crash dieting, measurement avoidance, ignoring illness).
- ❌ Replacing medical judgment. This is not a diagnostic or treatment tool.

---

## 2. Scientific foundations

The design draws on established behavioral-science literature. Full citations in
§13. The honest summary up front: **gamification of health has *moderate,
heterogeneous* evidence** — it helps some people in some contexts, and the effects
decay if the design is shallow or manipulative. We lean on the theories with the
strongest mechanistic support and design *against* the known failure modes.

| Principle | Theory / source | How we use it |
|-----------|-----------------|---------------|
| Intrinsic motivation needs **autonomy, competence, relatedness** | Self-Determination Theory (Deci & Ryan) | Solo self-competition (autonomy), levels/insight (competence), forgiving design. |
| Extrinsic rewards can **crowd out** intrinsic motivation | Overjustification effect / Cognitive Evaluation Theory (Deci 1971; Lepper 1973) | Reward = *self-knowledge*, framed as informational feedback, not control. No cash/external bribes. |
| Behavior = **Motivation × Ability × Prompt** | Fogg Behavior Model; Tiny Habits | Make the "minimum viable day" tiny; celebrate small wins; gentle, well-timed prompts only. |
| Habits form by **cue → routine → reward** repetition in stable contexts | Wood & Neal; Duhigg (pop.) | Tie streaks/challenges to existing routines and times; reward immediately. |
| Goals work when **specific + challenging + attainable**, with feedback & commitment | Goal-Setting Theory (Locke & Latham) | Challenges are specific, time-boxed, personalized to a "Goldilocks" difficulty. |
| **If-then planning** beats good intentions | Implementation Intentions (Gollwitzer) | Challenges are authored as "When X, I will Y" plans. |
| **Loss aversion** powers streaks — but breaking them triggers the "what-the-hell effect" | Kahneman & Tversky; abstinence-violation effect | Streaks exist, but with freezes, grace, weekly cadence, and recovery framing. |
| **Temporal landmarks** boost fresh motivation | Fresh-Start Effect (Dai & Milkman) | Opt-in "new chapter" at Mondays / month starts / birthdays. |
| Healthy targets are **ranges, not maxima** | Clinical guidelines (see §6.5) | Scoring uses two-sided bands with graded falloff, never "more = better." |

---

## 3. Design principles (the ethical guardrails)

These are **invariants**. Any future mechanic must satisfy all of them.

1. **Ranges, never maxima.** No metric is scored monotonically. Sleep, calories,
   weight, BP, steps all have a healthy *band*; both tails score lower. "More
   sleep / fewer calories / lower weight = more points" is forbidden.
2. **Honesty is never punished — the Integrity Floor.** Because outcomes are
   rewarded, a naïve design would incentivize *not measuring on a bad day*
   (measurement avoidance), corrupting the app's single-source-of-truth. Every
   logged measurement earns a small fixed payout *regardless of value*; the large
   payout is reserved for in-range outcomes. You always win by being honest.
3. **Two domains are never outcome-scored:**
   - **Mood / diary** — paying for "happy" punishes depression. Reward the *act*
     of reflecting, never the mood value.
   - **Food** — paying for "ate less" is an eating-disorder vector. Reward hitting
     *targets* (two-sided), protein adequacy, and vegetables — never restriction.
4. **No dark patterns.** No manipulative variable-ratio reward schedules. No
   shame. No FOMO pressure. No fabricated scarcity. Earned levels never decay.
5. **Never gate safety or raw data behind the game.** Levels gate *depth of
   analysis and convenience*, never a dangerous-reading alert and never the raw
   data. Full export is always available (data ownership is non-negotiable).
6. **Personalized, clinician-aware targets.** Default ranges come from guidelines,
   but every band is user-editable and meant to be set with/by a clinician.
   Someone on antihypertensives, an athlete, or a person with a chronic condition
   has different "healthy."
7. **Default-on, but fully reversible and user-controlled.** Gamification is
   *enabled by default* (so its value is discoverable), introduced by a first-run
   explainer, and can be disabled globally or per-Ring at any time — disabling
   never destroys health data. Autonomy is preserved through *reversibility and
   per-domain control*, not through making the user opt in.
8. **Forgiveness is structural, not cosmetic.** Freezes, grace days, weekly
   cadence, illness/recovery mode, and comeback framing are part of the core
   mechanics — not a settings-page apology.
9. **Accessibility & chronic-illness first.** The system must never make a person
   who is sick, disabled, or having a bad health stretch feel like they are
   "losing." Adaptive targets and a recovery mode are first-class (§10).

---

## 4. HealthPoints (HP): the currency

HP is the single point currency (the name is a deliberate double meaning — "hit
points" from RPGs, "health points" here). HP is earned **daily, per domain**, in
two layers:

```
daily_domain_HP  =  INTEGRITY_FLOOR        # small, fixed: you logged honestly
                 +  OUTCOME_BONUS           # large: graded by how in-range you are
                 +  CONSISTENCY_BONUS       # optional: regularity / streak upkeep
```

- **Integrity floor** (principle #2): a small fixed amount for each honest
  measurement (e.g. `+2 HP` for logging a BP reading, *whatever the number*).
  Symbolic, but it guarantees honesty is never the losing move.
- **Outcome bonus** (the primary reward, per your choice): scaled by a **range
  membership** value `r ∈ [0,1]` describing how well the outcome sits in your
  personalized healthy band (§5). `OUTCOME_BONUS = OUTCOME_MAX × r`.
- **Consistency bonus** (optional): rewards *regularity* — e.g. sleep timing
  stability, or simply keeping a streak alive — without rewarding the raw value.

> **Tunable:** if you want *pure* outcome scoring, set `INTEGRITY_FLOOR = 0`. We
> recommend a small non-zero floor and document why (measurement-avoidance is a
> real failure mode for an outcome-only system). This is the one place this design
> intentionally deviates from "outcomes only."

### 4.1 The range-membership function `r`

To avoid the discouraging all-or-nothing cliff, `r` is a **trapezoid**, not a step
function. Given a target band `[low, high]` and a falloff tolerance `Δ`:

```
r = 1                              when  low ≤ x ≤ high          (full credit in-band)
r = 1 − (low − x)/Δ                when  low−Δ ≤ x < low         (linear partial credit below)
r = 1 − (x − high)/Δ               when  high < x ≤ high+Δ       (linear partial credit above)
r = 0                              otherwise
```

So a reading just outside the band still earns most of the points (gentle, keeps
people engaged), while a reading far outside earns the integrity floor only. For
one-sided-OK metrics (e.g. protein adequacy) the upper arm is flat to a sane cap.

---

## 5. Domains, "Rings," and personalized targets

HP is earned across the app's real tracking domains, grouped into five **Rings**
(à la activity rings, but covering the whole app and tuned to *balance* — no single
behavior can dominate the day's score):

| Ring | App data sources | What "in range" means (default — all editable) |
|------|------------------|--------------------------------------------------|
| **Adherence** | medications / intake_log | doses taken on time; weekly adherence ≥ 80% (PDC) |
| **Movement** | workouts, mi-band steps/active-minutes | weekly activity toward WHO 150–300 min; daily steps band |
| **Vitals** | BP, weight, resting HR, SpO₂, stress | each reading inside its personalized clinical band |
| **Nourishment** | food / intake | calories within ± target; protein/fiber/veg adequacy |
| **Mind** | diary, mood, sleep | diary/mood *process*-scored (you reflected); sleep *outcome*-scored — duration 7–9h & timing regularity in band |

> Sleep sits in **Mind** deliberately — it pairs with reflection/recovery and its
> regularity sub-score is process-flavored. Place it in Vitals if you prefer; it's
> a labeling choice, not a scoring one.

**Personalized targets are a hard requirement, not a nicety — and they are
self-set with recommendations.** Every band lives in Settings and is owned by the
user. Guideline-derived defaults (§6.5) are pre-filled and *labeled as
recommendations* ("recommended: 7–9h — tap to set your own"), so the user always
sees a sensible starting point but the value is theirs to confirm or override.
First-run onboarding walks through the handful of bands that matter most (BP,
sleep, calorie target, weight goal/mode) with their recommendations. The app
already has a settings/targets surface (food targets, weight goals); gamification
targets extend that model. A medical disclaimer ("not medical advice; set ranges
with your doctor") accompanies the target editor.

---

## 6. Per-domain scoring

Each domain defines: an **integrity floor** (what counts as an honest log), an
**outcome band** (default from guidelines, personalized), and any **carve-outs**.
Numbers are illustrative defaults.

### 6.1 Adherence — medications

This is the clearest controllable health behavior, and adherence *is* the clinical
outcome for chronic meds, so outcome-scoring is both safe and meaningful here.

- **Integrity floor:** logging the dose action (taken / skipped-with-reason).
- **Outcome (per dose):** taken within the window → full; taken late → partial
  (trapezoid on minutes-late); intentionally skipped *with a reason* → **0, with
  no penalty** (a doctor-ordered stop must never cost points).
- **Outcome (weekly):** bonus when adherence rate lands in a healthy band —
  default ≥ 80% Proportion of Days Covered (a real pharmacology threshold).
- **Guardrails:** never reward double-dosing; respect intentional med changes; a
  long deliberate taper is not "non-adherence."

### 6.2 Vitals — blood pressure

- **Integrity floor:** `+2 HP` for any reading logged, *whatever the value*.
- **Outcome band (default):** systolic `[90, 120]`, diastolic `[60, 80]`
  (ACC/AHA "normal"), two-sided so hypotension also scores lower; `Δ` ≈ 10/5.
  Personalized — many on medication target `<130/80`; some elderly run higher by
  clinical design.
- **Carve-out / safety:** a dangerously high (or low) reading triggers a **health
  alert**, never a silent score penalty. Safety is not a game mechanic.

### 6.3 Vitals — resting HR / SpO₂ / stress (mi-band continuous streams)

These are largely *auto-captured*, so the user can't directly "will" them moment
to moment. They **do count toward grading** (HP) — but scored in a way that's fair
to genetics: by **range membership *and* improvement vs. the user's own baseline**,
so the reward tracks *your* trend rather than absolute luck. They carry a
**moderate** weight — real, but a notch below effortful actions (taking a dose,
completing a workout), since they're passively captured.

- Resting HR in a personalized band (default `[50, 80]`), SpO₂ ≥ 95%, stress
  trending down vs. baseline. Graded HP, plus a big role in the insight ladder (§8).

### 6.4 Mind — sleep

- **Integrity floor:** logging the night.
- **Outcome (duration):** two-sided band `7–9h` for adults (AASM / Sleep Research
  Society / CDC), falloff both sides — chasing 10h+ is *not* rewarded.
- **Consistency sub-score:** reward **regularity** of sleep/wake timing (low
  social jetlag). Sleep regularity is a strong, independent predictor of health
  outcomes (Windred et al. 2023), and rewarding *consistency* sidesteps rewarding
  the raw value.

### 6.5 Movement — workouts & steps

- **Integrity floor:** logging a workout / having step data for the day.
- **Outcome (weekly accumulation):** progress toward WHO guidelines — 150–300 min
  moderate **or** 75–150 min vigorous activity per week, plus 2× strength
  sessions. **Ceiling at the upper guideline:** beyond it, *no extra points*, with
  a gentle "you've hit your healthy ceiling — rest and recovery are part of
  training" message. This is the explicit **anti-overtraining** guardrail.
- **Steps:** personalized daily band; default centered near ~7,000–8,000 (the
  mortality-benefit knee from Paluch et al. 2022), **not** a dogmatic 10k, with
  diminishing returns above. Disability-aware: step targets are opt-in and can be
  replaced by active-minutes for wheelchair users etc. (§10).

### 6.6 Nourishment — food  *(handled with the most care — principle #3)*

Range-based only. Never rewards restriction.

- **Integrity floor:** logging meals.
- **Outcome:**
  - calories **within ± X% of personalized target** — two-sided; *both* under and
    over reduce the score. There is no "ate less = more points."
  - protein **≥ target** (one-sided OK to encourage, capped at a sane ceiling).
  - positive framing bonuses: fiber / vegetable servings hit.
- **Hard guardrails:**
  - Never award for being under a calorie or BMI floor.
  - **ED-safe mode** (toggle): switches food scoring to pure logging-consistency +
    qualitative (veg servings, meal regularity), hides calorie/weight numbers, and
    removes any deficit-style mechanic.
  - Food and weight are **never** combined into a "deficit" reward.

### 6.7 Vitals — weight  *(also handled with care)*

Weight is **not** rewarded for going down. Instead:

- **Integrity floor:** logging weigh-ins (rewards the *habit of measuring*, not the
  number).
- **Outcome — two modes:**
  - *Maintenance:* reward **stability** (low variance) within a user-defined band.
  - *Goal:* reward trending toward a user-set goal **at a safe pace**
    (≤ 0.5–1% bodyweight/week). Points *drop* if loss is too fast (anti-crash-diet)
    or if the goal sits below a healthy floor.
- **Guardrails:** refuse to set a goal below a healthy BMI floor without explicit
  override; ED-safe mode hides the number and scores only weigh-in consistency.

### 6.8 Mind — diary / mood  *(the explicit outcome-scoring exception)*

- **Process-scored only.** Reward the *act* of journaling and logging mood. The
  mood **value is never scored** — a sad day must never cost points. Optionally a
  small bonus for "noticing" (engaging with a reflection prompt).

---

## 7. Levels & progression

- **Lifetime HP → Levels.** Levels are cumulative and **never decrease** —
  competence, once demonstrated, is permanent. There is no demotion, no decay, no
  shame.
- A gently **growing curve** so early levels come fast (momentum — Fogg's small
  wins) and later levels are meaningful, e.g. `HP_to_reach(n) = base · n^1.5`.
- Each level **unlocks an insight tier** (§8). That is the point of leveling: not a
  bigger number, but a deeper mirror.
- **Daily/weekly HP** drives streaks and rings; **lifetime HP** drives levels. Two
  clocks, so a bad week dents momentum but never your hard-won standing.

---

## 8. The reward currency: the Insight Ladder

This is the heart of the design. Points and levels unlock progressively deeper
**personal analytics about the user's own body**. The reward for being healthy is
*understanding yourself better*, which in turn teaches you what to do — a closed,
self-reinforcing, intrinsically-satisfying loop.

| Tier | Unlocks (illustrative) |
|------|------------------------|
| **L1–2** | Rings view, current streak, personal bests, "minimum viable day." |
| **L3–4** | Per-domain trend charts; 30/90-day personal baselines; "you vs. your past." |
| **L5–6** | Cross-domain **correlations** — e.g. "nights under 6h precede next-day systolic +N mmHg for *you*." |
| **L7–8** | "Your good-day model" — a simple personal feature-importance: which behaviors most predict *your* in-range days. |
| **L9+** | Forecasts & gentle nudges; **Experiment mode** ("try X for 14 days; we'll measure the effect on your own data"). |

**Non-negotiable guardrail (principle #5):** levels gate *depth of analysis and
convenience* only. They **never** gate a safety alert (a dangerous reading always
surfaces immediately at any level) and **never** gate raw data or export. We are
unlocking *richer mirrors*, never withholding the user's own facts.

---

## 9. Streaks & forgiveness  *(motivating, with guardrails — your tone choice)*

Streaks are kept because they motivate, but engineered so a miss is a *rest*, not a
*failure* (defusing the what-the-hell effect).

- **Default cadence is weekly**, not daily — hit your weekly goal to keep the
  streak. Far less daily pressure. A daily "minimum viable day" streak is available
  but opt-in.
- **Streak freezes:** earn ~1 per good week, bank up to N; auto-applied on a miss so
  the streak survives. (Borrowed from the *good* part of Duolingo, minus the guilt.)
- **Grace days** and **comeback framing:** "Welcome back — let's pick up where you
  left off," never "you lost your 47-day streak."
- **Illness / recovery mode** pauses streaks entirely (§10).
- **No shame notifications.** Reminders are opt-in, gentle, and well-timed (Fogg
  prompts), never loss-pressure pings.

---

## 10. Challenges / Quests  *(opt-in autonomy)*

Time-boxed, user-*chosen* missions — the autonomy engine of the system.

- **Library + data-driven suggestions.** The app may *suggest* from your data
  ("your evening BP runs high — try a 14-day wind-down routine"), but you always
  choose. Suggestion ≠ assignment.
- **Authored as implementation intentions** (Gollwitzer): every challenge is a
  "**When** X, **I will** Y" plan ("When I brush my teeth at night, I'll take my
  evening dose").
- **Goldilocks difficulty** (Locke & Latham + flow): specific, challenging, but
  attainable; difficulty adapts to the user's recent baseline.
- **Rewards:** HP + a badge + a relevant **insight unlock** (so finishing a sleep
  challenge reveals your sleep-regularity analysis). Badges are cosmetic and
  permanent; they never expire or shame.

Examples per ring: *Adherence* — "7 perfect-window days." *Movement* — "3 strength
sessions this week." *Mind* — "consistent lights-out within a 30-min window for 10
nights." *Nourishment* — "hit protein target 5 days" (never "eat under X").

---

## 11. Self-competition, baselines & the fresh start

- **You vs. your own baseline, everywhere.** Trend arrows, personal bests, "best
  week ever." No other humans appear in the scoring (per the solo choice). This is
  the autonomy- and competence-preserving alternative to leaderboards.
- **Fresh-Start Effect** (Dai & Milkman): offer an opt-in "**new chapter**" at
  temporal landmarks (Mondays, month starts, birthday) — a clean slate for
  *challenges and weekly goals*, **never** erasing lifetime HP or levels.

---

## 12. A week in the life (worked example)

> Illustrative, with placeholder numbers, to show the loop end-to-end.

Maria enables gamification and sets her BP target with her doctor (`<135/85`,
she's on medication). Monday she logs a morning BP of 138/88 — just outside her
band. She earns the **integrity floor** (+2, honesty rewarded) plus a partial
outcome bonus via the trapezoid (close to the band → most of the points). She takes
both doses on time (full Adherence), logs 7h20m sleep (in band), and journals two
lines (Mind floor). Her rings fill; she keeps her weekly streak.

Wednesday she's unwell, sleeps 5h, skips her workout. She turns on **recovery
mode**: streaks pause, targets soften, no "you're failing" anywhere. She still logs
honestly and still earns integrity floors.

By Sunday she's hit her weekly Movement goal (within the WHO band, not above the
ceiling — the app congratulates her *and* tells her to rest). She crosses into
**Level 5**, which unlocks a **correlation insight**: across her last 90 days,
nights under 6h precede a next-morning systolic bump of ~6 mmHg *for her*. That's
not a generic fact — it's her body. She starts a self-chosen 14-day "wind-down"
**challenge** to test it. The loop closes: behavior → ranges → HP → insight →
better behavior.

---

## 13. Anti-patterns explicitly rejected

For the record, so future contributors don't "helpfully" add them:

- ❌ **Leaderboards / social ranking** — out of scope; shame risk (deferred, §15).
- ❌ **Manipulative variable-ratio rewards** (slot-machine loot) — banned by
  principle #4. Rewards are transparent and predictable.
- ❌ **Daily all-or-nothing streaks with no forgiveness** — the #1 cause of dropout
  and anxiety.
- ❌ **Monotonic "more is better" metrics** — eating-disorder / overtraining vector.
- ❌ **Scoring mood value** — punishes mental illness.
- ❌ **Gating raw data or safety alerts behind levels** — violates data ownership
  and safety.
- ❌ **Loss of earned levels / decay** — competence is permanent.
- ❌ **Guilt-trip notifications** — prompts are gentle, opt-in, never loss-pressure.

---

## 14. Integration & configurability (sketch only — not a build plan)

Kept deliberately light; the implementation plan is a separate future doc.

- **Feature flag** `gamification_enabled`, **default ON**, with **per-domain
  (per-Ring) toggles** so a user can gamify only what they track. A first-run
  explainer introduces it, disabling is one tap (global or per-Ring), and
  disabling never deletes health data. Autonomy comes from easy reversibility, not
  from opt-in friction.
- **Historical backfill on first enable, capped at the last 365 days.** Because
  scoring runs over existing logs (decision below), enabling gamification computes
  HP from the user's past year of data so they arrive at a satisfying starting
  level with several insight tiers already unlocked. The 365-day cap keeps the
  starting level meaningful rather than runaway for users with years of history.
  Backfill applies the same integrity-floor + range rules and is deterministic from
  the data (re-runnable, no double-counting). Combined with default-ON, the *first
  time the user opens the Journey screen it is already rewarding* — no empty state.
- **Where it would live**, following the project's domain-service pattern (not built
  yet): a future `internal/domain/gamification` service computes HP/levels/streaks
  by *reading the existing per-domain repos* (medication, bp, weight, workout,
  vitals, food, diary) — no business logic in handlers or the bot. A store table
  would hold the HP ledger, level, streak, freezes, and per-user target bands. Bot
  and HTTP both call the same service (Critical Rule #1).
- **Surfaces:** a rings widget on the **Today** dashboard; a dedicated **Journey**
  screen for levels / insight ladder / challenges; gentle, opt-in **bot** nudges.
  All visuals via `--wg-*` design tokens (Critical Rule #3).
- **Targets editor** extends the existing Settings/targets surface, with the medical
  disclaimer.

### 14.1 Backend implemented — Plan 1 (status)

The backend core from this design now exists (plan
[docs/plans/2026-06-25-gamification-1-backend-core.md](plans/2026-06-25-gamification-1-backend-core.md)).
Plan 2 (HTTP/MCP) and Plan 3 (frontend) are not yet built.

**Packages**

- `internal/domain/gamification/scoring/` — the pure, DB-free engine: the
  trapezoid `RangeMembership` (§4.1), per-domain scorers (`ScoreAdherence`,
  `ScoreBP`, `ScoreVitalsAuto`, `ScoreSleep`, `ScoreMovement`, `ScoreNourishment`,
  `ScoreWeight`, `ScoreMind`), the level curve (`LevelForLifetimeHP` /
  `HPToReachLevel`), insight-tier gating (`InsightTierForLevel`), and streak math
  (`NextStreak`). All constants live in `Config` / `DefaultConfig()`.
- `internal/domain/gamification/` — the `GamificationService` (Critical Rule #1
  single code path): `ScoreDay`, `GetSummary`, `GetInsightTier`, `Backfill`,
  `EnsureBackfilled`, targets CRUD. Reads the existing per-domain repos through
  narrow store interfaces; merges per-user target overrides onto `DefaultConfig()`.
- `internal/store/gamification/` — the `Repo` (targets, ledger, state) wired into
  `store.Repos`.

**Tables** (migration `073_add_gamification.sql`): `gamification_targets`
(overrides only), `gamification_ledger` (HP awards — source of truth, UNIQUE
`(user_id, day_unix, ring, source_metric, kind)` makes rescore/backfill
idempotent), `gamification_state` (cached level / streak / tier). Feature flag
`settings.gamification_enabled` defaults to 1 (default-ON). All three tables emit
`change_events('gamification')` triggers. `day_unix` is INTEGER unix-seconds and
allowlisted in `TestDoseTimeColumnsAreInteger`. `gamification_state.backfilled_at_unix`
is a dedicated "365-day window fully replayed" latch — set only after `Backfill`
finishes the whole window, and the signal `EnsureBackfilled` keys off (NOT
`last_scored_day_unix`, which advances on the first backfilled day and on every
daily score, so a partial backfill or a live score would otherwise look complete).
`ScoreDay` serializes its read-recompute-write per user (in-process lock) so
concurrent scores can't desync `gamification_state` from the ledger.

**Scoring-constant choices** (the doc left these as implementation-level, §7/§8):

- Level curve `HPToReachLevel(n) = 100·(n−1)^1.5` (`LevelBase=100`,
  `LevelExponent=1.5`).
- Insight tiers unlock at L3 / L5 / L7, capped at L4 (`InsightMaxTier=4`) for the
  MVP; L5+ deferred to Phase 2.
- Integrity floor `FloorHP=2` per honest log; outcome maxima sit above it (e.g.
  adherence/BP/sleep 10, movement 10, calories 8, weight 8) with passively
  captured vitals at a moderate 4 (§6.3). Weekly streaks earn 1 freeze/period,
  banked up to 4.
- Guideline bands match the doc: BP 90–120 / 60–80, sleep 7–9h, steps ~7k knee,
  WHO 150 min/week, calories ±10% of target.

**MVP simplifications vs. the design (single-day online path):**

- Improvement-vs-own-baseline for resting HR / stress (§6.3) and sleep-timing
  regularity (§6.4) need a trailing personal baseline; the single-day path leaves
  them unknown, so those scorers fall back to their absolute bands. The engine
  already supports the baseline-relative and regularity paths — the service just
  doesn't feed them yet.
- Weight is scored in **maintenance** mode around a trailing-average band (§6.7);
  goal-mode safe-pace scoring exists in the engine but isn't driven online yet.
- Weekly WHO-activity progress accumulates completed-session durations over the
  trailing movement week.
- Per-Ring toggles, the first-run explainer, recovery/ED-safe modes, and
  challenges/quests are not in Plan 1 (UI/Phase 2). Scoring is non-punitive by
  construction (HP only ever added, never negative), so deferring the safety
  toggles is safe.

---

## 15. Safety, accessibility & open questions

**Safety / accessibility (first-class, not bolt-on):**

- **Recovery / illness mode** — pauses streaks, softens targets, removes all "you're
  losing" affordances. One tap.
- **Adaptive targets** — a sick or hard stretch shouldn't tank everything; bands can
  auto-relax against recent baseline.
- **Disability-aware** — never assume steps/ambulation; active-minutes and
  qualitative goals substitute. Targets are opt-in per domain.
- **ED safeguards** — ED-safe mode for food & weight (§6.6, §6.7); BMI floor on
  weight goals.
- **Medical disclaimer** on the targets editor; "set ranges with your clinician."

**Resolved decisions:**

- **Default ON.** Gamification is enabled by default and discoverable, with a
  first-run explainer and one-tap global/per-Ring disable. Autonomy is preserved
  by reversibility, not opt-in (§3 #7, §14).
- **Targets are self-set, with recommendations.** Guideline-derived defaults are
  pre-filled and labeled as recommendations; the user confirms or overrides, and
  onboarding walks the key bands (§5).
- **Score historical data on first enable, capped at 365 days.** HP is backfilled
  from the last year of logs so the user starts at a satisfying level with insight
  tiers unlocked; backfill uses the same floor/range rules, is deterministic, and
  the 1-year cap keeps the starting level meaningful (§14).
- **Auto-captured streams are part of grading.** HR/SpO₂/steps count toward HP,
  scored by range membership *and* improvement vs. the user's own baseline (fair to
  genetics), at a moderate weight below effortful actions (§6.3).
- **Sleep is outcome-scored.** Sleep duration (7–9h band) and timing regularity
  contribute real HP; it stays in the **Mind** ring, which makes Mind a
  substantively graded ring rather than process-only (§6.4).

**Remaining decisions are implementation-level**, not design — the HP constants,
the exact level curve, and the screen layouts. They belong in the implementation
plan, not here.

---

## 16. References & reading

Evidence honesty: gamification's effect on health behavior is **moderate and
context-dependent**; design quality and intrinsic-motivation alignment matter more
than the presence of points. Key sources:

- Deci, E. & Ryan, R. — *Self-Determination Theory* (autonomy/competence/
  relatedness; intrinsic motivation).
- Deci (1971); Lepper, Greene & Nisbett (1973) — overjustification / reward
  crowd-out.
- Fogg, BJ — *Tiny Habits* and the Fogg Behavior Model (B = MAP).
- Wood, W. & Neal, D. — habit formation; cue–context–repetition.
- Locke, E. & Latham, G. (2002) — Goal-Setting Theory.
- Gollwitzer, P. (1999) — Implementation Intentions ("if-then" planning).
- Kahneman, D. & Tversky, A. — Prospect Theory / loss aversion.
- Dai, H., Milkman, K. & Riis, J. (2014) — the Fresh-Start Effect.
- Johnson, D. et al. (2016); Sardi, Idri & Fernández-Alemán (2017); Cugelman
  (2013) — systematic reviews of gamification for health (effects & caveats).
- Whelton et al. (2017) — ACC/AHA blood-pressure guideline (BP ranges).
- WHO (2020) — Physical Activity Guidelines (150–300 min/week).
- Paluch, A. et al. (2022) — steps & mortality (the ~7–8k knee).
- Windred, D. et al. (2023) — sleep *regularity* predicts mortality.
- AASM / Sleep Research Society — adult sleep duration (7–9h).

---

## 17. Glossary

- **HealthPoints (HP)** — the single point currency; earned daily per domain.
- **Integrity floor** — small fixed HP for logging honestly, regardless of value;
  prevents measurement-avoidance.
- **Outcome bonus** — the primary, larger HP, graded by range membership `r`.
- **Range membership `r`** — `[0,1]` trapezoid measuring how in-band an outcome is.
- **Ring** — a domain group (Adherence, Movement, Vitals, Nourishment, Mind).
- **Level** — cumulative-HP tier; never decreases; unlocks an insight tier.
- **Insight Ladder** — the progression of unlocked personal analytics; the reward.
- **Streak freeze / grace / recovery mode** — the forgiveness mechanics.
- **Fresh-start chapter** — opt-in goal reset at a temporal landmark; never erases
  lifetime HP/levels.
