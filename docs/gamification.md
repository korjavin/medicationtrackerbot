# Gamification: HealthPoints & the Journey

> **Status: MVP shipped (backend + HTTP/MCP + frontend); deeper vision still
> design-only.** The core loop is built across three plans — see §14.1 (backend),
> §14.2 (HTTP API + MCP), and §14.3 (frontend surfaces). The Phase-2 material below
> (challenges/quests UI, L5+ insight visualizations, recovery/ED-safe modes,
> per-Ring toggles, bot nudges) remains a design proposal specifying *what* we want
> and *why* (the science and the ethics), not yet built. Treat every number below as
> a tunable default, not a fixed constant.

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

### 2.5 Levers & Gauges

Every scored metric is either a **lever** — a decision the user makes *today*,
one they can actually act on (when to go to bed, how much to move, what to
eat) — or a **gauge** — what the body reports back, delayed and often noisy
(weight, BP, resting HR, stress, sleep duration). The two get different
treatment, and conflating them is the mistake gamification-10 corrects:

- **Gamify levers daily.** A lever gets a ring, a "your move" nudge, and a
  consistency bonus, because today's choice can change today's outcome.
- **Read gauges as long-term trends; never grade a gauge daily.** A gauge
  still earns HP and still feeds the Health Score (§14.7) and the insight
  ladder (§8, §14.8) once enough of it accumulates — but it never gets a daily
  "your move." A single noisy reading isn't something willed into range by
  trying harder today; grading it like a lever just rewards measurement noise
  or biology. Stress is the clearest case — even *improvement-vs-baseline*
  scoring grades the ungovernable, so it was removed from scoring entirely
  (§6.3) and now lives in charts only. Gamification-11 (§14.10) finishes the
  job for the remaining gauges: BP, weight, and resting HR moved from daily
  outcome grading to one idempotent weekly award each — daily still earns the
  logging-honesty floor, never the outcome.
- **Adherence is neither** — it's a solved habit (§6.1): silent unless it
  slips, then it surfaces once as a safety-net alert, never a ring.

This is why the daily ring set narrowed from five to three (§5): Bedtime,
Movement, and Nourishment are levers. Vitals and Adherence left the daily
ring set — they keep earning HP toward the Health Score, just without a ring
or daily grading.

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

The daily ring set (gamification-10) is the three **levers** (§2.5) — decisions
the user makes today — one ring each, still tuned to *balance* so no single
behavior can dominate the day's score:

| Ring | App data sources | What closes the ring (default — all editable) |
|------|------------------|--------------------------------------------------|
| **Bedtime** | sleep log lights-out timestamp | lights-out lands within the personalized bedtime window (trailing-median ± tolerance) — a *timing* target; sleep *duration* is a gauge and stays a Health Score contributor only (§6.4) |
| **Movement** | workouts, mi-band steps/active-minutes | weekly activity toward WHO 150–300 min; daily steps band |
| **Nourishment** | food / intake | calories within ± target; protein/fiber/veg adequacy |

Every other domain keeps earning HP into the same lifetime ledger (untouched —
§14.6) but no longer produces a ring:

- **Adherence** (medications) is a silent safety net (§6.1) — no ring, no daily
  grading; it only speaks up once it slips below threshold.
- **Vitals** (BP, weight, resting HR, SpO₂) are gauges (§2.5) — delayed, noisy
  body signals. They earn HP and feed the Health Score and insight ladder, but
  are never graded as "your move today."
- **Mind / diary** keeps its integrity floor + reflection HP (§6.8) unchanged —
  it just has no ring.
- **Stress** was removed from scoring entirely — the clearest ungovernable
  gauge (§6.3). It still shows in charts.

History logged under the old five-Ring rules is untouched: HP is non-punitive
and ring-agnostic in the lifetime sum, so a day scored before this change and a
day scored after it coexist harmlessly — there is no re-backfill.

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

Adherence *is* the clinical outcome for chronic meds, so it's still
outcome-scored into the lifetime ledger — but it's a solved habit ("more or
less given"), not something to grade daily, so gamification-10 pulled it out
of the daily ring set entirely: no ring, no "your move," no daily nag.

- **Integrity floor:** logging the dose action (taken / skipped-with-reason).
- **Outcome (per dose, still scored, no ring):** taken within the window →
  full; taken late → partial (trapezoid on minutes-late); intentionally
  skipped *with a reason* → **0, with no penalty** (a doctor-ordered stop must
  never cost points).
- **Health Score contribution:** a reduced-weight background contributor
  (§14.7) — adherence still counts, just less than before, since it no longer
  needs a daily ring to stay visible.
- **Safety-net alert (the only nag left):** a rolling 14-day PDC below a
  threshold (default 0.90 — stricter than the Health Score's own 0.80 target)
  surfaces exactly one gentle line on Today ("2 missed evening doses this week
  — worth a look"), linking to Meds. Above threshold, nothing renders — a
  solved habit is invisible. (`adherence_alert` on `GET
  /api/gamification/summary` / `/rings`, `docs/api.md#gamification`.)
- **Guardrails:** never reward double-dosing; respect intentional med changes; a
  long deliberate taper is not "non-adherence."

### 6.2 Vitals — blood pressure  *(gauge, weekly-scored — gamification-11 §2)*

- **Integrity floor:** `+2 HP` for any reading logged, *whatever the value*, every
  day — honesty is always rewarded regardless of the number.
- **Outcome — rolling in-range share, once a week:** one bad day is no longer a
  same-day judgment. Instead, the trailing 30-day share of readings inside the
  personal band (default systolic `[90, 120]`, diastolic `[60, 80]`, ACC/AHA
  "normal", personalizable per §6.2's old per-user override path) is compared
  against the 60-day baseline share; full HP when the 30-day share holds or
  improves on baseline, falling off linearly as it drops below (`ScoreBPWeekly`,
  `GaugeBPShareFalloffPts`). Written once, on each week's last day
  (`MetricBPShareWeek`), so a couple of bad readings can only ever nudge a
  30-day percentage by a few points — visible as data, irrelevant as judgment.
- **Below `GaugeBPMinBaselineReadings` readings in the 60-day baseline:** no
  award either way — honest silence on thin history, never a zero judgment.
- **Carve-out / safety:** a dangerously high (or low) reading triggers a **health
  alert**, never a silent score penalty. Safety is not a game mechanic.

### 6.3 Vitals — resting HR / SpO₂ (mi-band continuous streams)  *(gauge, weekly-scored — gamification-11 §3)*

These are largely *auto-captured*, so the user can't directly "will" them moment
to moment. Resting HR **counts toward grading** (HP) — scored as a **trend vs
the user's own 60-day baseline**, so the reward tracks *your* trajectory rather
than absolute luck. It carries a **moderate** weight — real, but a notch below
effortful actions (taking a dose, completing a workout), since it's passively
captured. No ring (§5) — Vitals are gauges, read as trends, not graded daily.

- **Outcome — baseline-delta trend, once a week:** the trailing 14-day mean
  resting HR vs the strictly-prior 60-day baseline mean; full HP when the trend
  held or improved (lower is better), falling off linearly as it rises, reaching
  zero `GaugeRestingHRFalloffBPM` above baseline (`ScoreRestingHRWeekly`,
  `MetricRestingHRTrendWeek`). Written once, on each week's last day — no daily
  grade, so one rough night can't move it.
- **SpO₂ earns no HP at all.** It dropped out of scoring in gamification-10
  (stress) and gamification-11 (SpO₂ itself, per this plan's Overview §3): it's
  safety-alert data, not a game metric. The dangerous-reading alert path is
  untouched and unrelated to scoring; SpO₂ still appears in charts.
- **Stress was removed from scoring entirely (gamification-10, §2.5):** it's
  the clearest ungovernable gauge — even improvement-vs-baseline scoring grades
  something the user can't reliably will down. Stress still appears in charts;
  it earns no HP and has no target band.

### 6.4 Mind — sleep

Sleep splits cleanly along the lever/gauge line (§2.5): **when you go to bed is
a lever** (you choose it); **how long you sleep is a gauge** (the body reports
it back, and chasing a number can backfire). Gamification-10 flipped the daily
grading to match:

- **Integrity floor:** logging the night.
- **Bedtime ring (the lever, daily-graded):** timing-regularity is now the
  primary award — a trapezoid on how far lights-out lands from the user's own
  trailing-median bedtime window (default ± 45 min, overridable like any other
  band). This is what closes the Bedtime ring (§5); it replaces what used to be
  a duration outcome award.
- **Duration (the gauge, no longer daily-graded):** the two-sided `7–9h` band
  (AASM / Sleep Research Society / CDC) is no longer a daily outcome award — it
  moved to being a Health Score contributor only (§14.7), read as a trend
  rather than graded night by night.

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

### 6.7 Vitals — weight  *(also handled with care; gauge, weekly-scored — gamification-11 §1)*

Weight is **not** rewarded for going down. Instead:

- **Integrity floor:** logging weigh-ins, every day (rewards the *habit of
  measuring*, not the number) — the single-day reading itself is never judged.
- **Outcome — trend velocity + acceleration, once a week:** a single heavy day
  can't move the score. A day-indexed EMA (`trend_d = trend_{d-1} +
  α·(weight_d − trend_{d-1})`, α=0.10, Hacker's-Diet style) folds the trailing
  history into a smoothed trend line; **velocity** is the trend's change over
  the last 14 days in %bodyweight/week, and **acceleration** compares velocity
  now vs 14 days ago (deadbanded so "holding" is the default, not noise
  flapping between speeding/slowing). Both are read-model headlines
  (`GET /api/gamification/gauges`) *and* drive the once-a-week HP award
  (`ScoreWeightWeekly`, `MetricWeightTrendWeek`):
  - *Goal set:* full HP when velocity is on the safe pace toward the goal
    (`WeightSafePaceMinPct`–`WeightSafePaceMaxPct`, ≤1% bodyweight/week ceiling);
    trapezoid falloff — never negative — for too-fast (anti-crash-diet) or
    wrong-direction weeks.
  - *No goal (maintenance):* the same safe-pace minimum doubles as a symmetric
    stability band around zero velocity — holding steady earns full HP,
    drifting either direction falls off at the same crash-diet rate. This
    finally wires the safe-pace math that used to be dormant (§14.9 predates
    this: the goal-mode band existed in the engine but nothing drove it daily).
- **Below `GaugeWeightMinHistoryDays` days of logged history:** the trend isn't
  trusted yet — the gauge (and the award) report `insufficient_data` rather
  than a distorted number.
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

**Tier 3 shipped** (§14.8, Plan 9) — the first real L5–6 correlation insight,
sleep→next-morning BP. It is the template for every future tier: an honesty gate
(minimum paired-night count per bucket, then a noise floor below which "no effect"
is itself the reported finding) so "not enough data yet" and "no effect found" are
genuine, non-alarmist results, not error states or blank cards.

**Tier 4 shipped** (§14.12, Plan 13) — "your good-day model," a fixed four-behavior
association scan (workout, bedtime, steps, adherence) reusing the same honesty-gate
template. The insight ladder is now fully real end to end: every tier the ladder
advertises is a real card, not a placeholder. Future insights are additions to the
ladder's existing rungs, not new unlocks.

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

> **Superseded (§14.7, Plan 8).** As the Journey continuity mechanic, the weekly
> streak card above is replaced by the per-pillar habit-strength EMA — same
> "a miss is a rest, not a reset" ethic, computed continuously instead of at a
> weekly boundary. The derived streak (`deriveStreak`, §14.5) keeps running and is
> still shown, demoted to a footnote inside the Strengths card.

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
Plan 2 (HTTP/MCP, §14.2) is built; Plan 3 (frontend, §14.3) is built — the
**Surfaces** and **Targets editor** bullets above are now implemented.

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
- **Adherence misses are inferred, not swept.** Production never transitions a
  forgotten dose from `PENDING` to `MISSED` (only the demo seeder and importer
  write the literal `MISSED` status), so the adherence scorer treats a dose still
  `PENDING` past its scheduled time (relative to *now*, not the day's end) as a
  miss. Without this, logging only the doses taken on time would score a perfect
  outcome and the 365-day backfill would compute an inflated starting level. A
  dose still due later today, or a `PENDING` row whose slot already carries a
  resolved sibling (a tz_step orphan), is excluded; a later take re-scores the day
  and corrects any same-day transient.

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

### 14.2 HTTP API + MCP coverage — Plan 2 (status)

The Plan 1 service is now exposed over HTTP (plan
[docs/plans/2026-06-25-gamification-2-http-api.md](plans/2026-06-25-gamification-2-http-api.md)).
Handlers (`internal/server/gamification_handlers.go`) call **only** the
`GamificationService` (Critical Rule #1) and pass its snake_case JSON through
verbatim. The full route table + frozen JSON shapes live in
[docs/api.md → Gamification](archive/api.md#gamification); in brief:

- **Reads:** `GET /api/gamification/{summary,journey,rings,targets}`.
- **Write:** `PUT /api/gamification/targets` (validate + persist target overrides;
  400 on unknown metric, negative bound/falloff, or `low > high`).
- **Enable:** the existing generic toggle `POST /api/settings/features/gamification`.
  On a false→true flip the handler runs `EnsureBackfilled` **inline** (idempotent,
  latched on `backfilled_at_unix`) so the Journey is populated by the time the
  toggle returns 200.
- **Bootstrap:** `/api/bootstrap` embeds `service.GetSummary` under a `gamification`
  key (same shape as `/api/gamification/summary`), so the Today rings widget and
  Journey summary warm-load offline. Omitted on error so the client keeps its
  cached summary.

Every route gates on `gamification_enabled` in the service layer — flag-off returns
HTTP 200 with a `{enabled:false}` body, never a 500 or a handler-side flag branch.
All five routes are reachable through the MCP operation registry
(`internal/mcp/registry/operations_gamification.go`, `gamification` topic), keeping
the coverage guard green. No new tests were authored in this plan (per direction);
verification was build + lint + the existing coverage guard + the no-regression run.

### 14.3 Frontend surfaces — Plan 3 (status)

The three surfaces from the **Surfaces** / **Targets editor** bullets above are now
built in the vanilla-JS frontend (plan
[docs/plans/2026-06-25-gamification-3-frontend.md](plans/2026-06-25-gamification-3-frontend.md)),
all gated on the `gamification` feature flag and rendered with `--wg-*` tokens only:

- **Journey screen** — `web/static/js/features/journey.js` (`window.Gamification`),
  `#journey-view`. **Not a bottom-nav slot** — reached only from the Today rings
  tile (deeplink → `switchTab('journey')`); the nav stays at the 8 canonical
  sections (CLAUDE.md rule 6). Reads `GET /api/gamification/journey` via
  `cachedFetch` (local-first + `WGStaleBadge` freshness chip; `OfflineNoCacheError`
  → empty state). Renders the level badge + lifetime HP + progress-to-next-level
  bar, current/longest streak + freezes, the five domain rings, and the insight
  ladder L1–L4 (locked/unlocked from `unlocked_tiers`).
- **Today rings widget** — a `gamificationRingsCell` tile in `features/today.js`
  (card deeplinks to Journey), fed by a `gamification_rings` Today fetch spec
  (`GET /api/gamification/rings`); hidden when the flag is off. Beyond the
  per-ring gauges it surfaces the **next-step** loop: a **"N of 5 rings closed"**
  headline (each ring carries a `closed` flag = earned a non-floor
  outcome/consistency award today), a check on each closed ring, and a single
  **"your move"** prompt — the first open ring in canonical order, deep-linking
  to that ring's own logging section (`meds`/`workouts`/`bp`/`food`/`health`).
  All five closed → a celebration line, no nag. This is the lightweight,
  frontend-driven version of the challenges/quests vision (§10): the "what do I
  do next?" compass without a backend suggestion engine.
- **Settings targets editor** — `#gamification-targets-settings`, populated from
  `GET /api/gamification/targets` and saved via `DataStore.applyOptimistic` →
  `PUT /api/gamification/targets` (Critical Rule #9) for the six band metrics the
  backend honors (`bp_systolic`, `bp_diastolic`, `resting_hr`, `stress`,
  `sleep_hours`, `steps`).

Per direction this plan authored no new tests; verification was frontend lint + the
existing architecture guards (globals allowlist incl. `window.Gamification`, design
tokens, SW precache) + the no-regression run + manual browser/emulator smoke. See
[docs/frontend.md → Navigation](frontend.md#navigation) for the runtime wiring.

### 14.3.1 Clarity pass — Plan 5 (status)

Plan 3 shipped the rings as relative-fill horizontal bars (`hp ÷
highest-scoring-ring-today`), independent of the `closed` flag — a ring could be
`closed: true` and still render a short bar, and the nourishment ring gave no
hint whether to eat more or less. Plan 5
([docs/plans/2026-06-30-gamification-5-clarity.md](plans/2026-06-30-gamification-5-clarity.md))
made the daily loop honest with two additive `RingScore` fields and a real arc
gauge:

- **`RingScore.Progress`** (`internal/store/gamification/repo.go`, populated in
  `domain/gamification/summary.go` `ringScores()`) — `0..1`, `1.0` whenever
  `Closed` is true, otherwise the day's real range-membership `r` from the pure
  scorer (`ScoreDay`'s per-ring trapezoid membership, computed alongside the
  existing recent-window re-score and otherwise discarded). `Closed` and
  `Progress` can no longer disagree. Only populated for **today's** rings;
  `PeriodRings` (weekly) leave `Progress` at `0`.
- **`RingScore.Goal`** — a short, token-free imperative string built server-side
  from the user's effective bands + food targets, e.g. `"Eat near target ·
  1,800–2,200 kcal"` for nourishment (answers "more or less?" directly) or
  `"Sleep 7–9h"` for mind. Both fields flow through `ringsView`, the summary,
  journey, and bootstrap payloads unchanged (additive JSON, old clients ignore
  them).
- **`wg-ring`** (`web/static/js/components/wg-ring.js`) — a small SVG arc-gauge
  web component (fixed radius so circumference ≈ 100 user units; JS sets only
  the `--ring-progress` custom property, CSS owns the dash offset/color)
  replaces the relative-fill bar on both the Today rings tile and the Journey
  screen's five domain rings. A closed ring always renders as a full ring with a
  check; an open ring renders a partial arc proportional to `progress`, never a
  bar that can read "closed" while visibly short.
- **Goal subtitles** — every ring (Today tile and Journey) shows its `goal`
  string as a sub-line, so what closes the ring is always stated in the user's
  own numbers.
- **Honest insight ladder** — `journey.js` `renderLadder()` only ever emits
  `"Unlocked → view"` for a tier that has a real destination
  (`hasDestination`); tiers without one read `"Unlocks at Lvl N · soon"` instead
  of the previous blanket `"Unlocked"`.
- **Discoverable Journey entry + first-run explainer** — the Today rings tile
  gained an explicit "View Journey →" affordance distinct from the "your move"
  logging deep-link, and `#journey-view` gained a short "How this works" card
  explaining HP, rings, closing, levels, and the insight ladder in plain
  language — the first-run explainer §15 called for but never shipped.

Per direction this plan added one test (`tests/wg-ring.test.js`, the arc-geometry
math — the documented web-component exception to integration-first testing,
CLAUDE.md rule 8); no other new tests, matching the no-backend-test posture of
Plans 2–3. Verification was `go test ./...`, `pnpm test` (243 files / 2636
tests), `golangci-lint`/`gofmt` on touched packages, and manual browser/emulator
smoke of the four originally-reported confusions.

### 14.4 Dynamic re-scoring — Plan 4 (status)

Scores now update as data arrives instead of being frozen after the initial 365-day
backfill. Implemented in
[docs/plans/2026-06-29-gamification-dynamic-rescore.md](plans/2026-06-29-gamification-dynamic-rescore.md).
Three mechanisms together cover every write path:

**Recent-window re-score on gamification reads.** Every gamification read
(`/api/gamification/{summary,journey,rings}` and the bootstrap `GetSummary` call)
re-scores yesterday and today (UTC) via `ScoreDay` before returning. This covers all
live single writes (food, BP, weight, intake, diary, workout) through any transport
(server handlers or bot callbacks) without per-handler instrumentation. Two `ScoreDay`
calls per read; cheap on single-user SQLite. Yesterday covers late entries that land
on the prior UTC day. Streak fold leaves already-scored days untouched
(`streak.go:30`), so order of re-scores is safe.
(ponytail: 2-day window is the live-write cover; widen or add per-write hooks if
future analytics need sub-read latency.)

**Import re-score — atomic import then ScoreDay all affected days.** Bulk/historical
importers (Mi Band sleep/vitals/day-stats/workouts via the bot, external workout via
HTTP, BP import via HTTP) collect the union of affected UTC days from the parsed
records' `DateTime`/`Day` fields, then call `ScoreDay` per day after the import
completes. This is the only path that can score months-old days that a recent-window
read can't reach. The distinct-day set is O(distinct-days) `ScoreDay` calls —
bounded by, and cheaper than, the 365-day backfill; acceptable for a rare heavy op.
Re-scores are best-effort/logged and never fail the originating import.
Logging a past intake (`POST /api/medications/log-past`) takes the same explicit
path: its `taken_at` can be days old — outside the read window — so the handler
re-scores that one back-dated day directly rather than relying on the recent-window
cover the way today's confirm/skip does.

**Frontend `gamification` co-invalidation on scored writes.** Food, BP, weight,
intake, diary/notes, and workout-completion write handlers (in `features/food/log.js`,
`features/food/photo.js`, `features/food/ai-undo.js`, `features/bp.js`,
`features/weight.js`, `features/meds.js`, `features/meds-history.js`,
`features/health.js`, `features/workout/sessions.js`) now include `'gamification'`
in their `invalidateTags([...])`
arrays. This causes the rings (`gamification_rings`) and journey (`gamification`)
caches to evict and refetch immediately after a write; the refetch hits the
recent-window read-rescore and renders fresh HP without a full reload.
The import case is covered for free: `ScoreDay` writes the ledger → the
migration-073 `change_events('gamification')` trigger fires → SSE propagates to all
connected clients automatically.

**Shared single service instance.** Server and bot share one `GamificationService`
instance (constructed in `cmd/bot/main_server.go`, passed into both `server.New` and
`bot.New`). This is required because `ScoreDay` serializes per user via an in-process
lock (`scoreMu`) on the service struct — separate instances would let a bot import
and a server read-rescore for the same user race and stale-overwrite each other.

### 14.5 Sync honesty — Plan 6 (status)

The system used to be unable to tell "the user didn't do it" from "the data hasn't
synced yet," and the streak was transactional state a late import couldn't repair.
Implemented in
[docs/plans/2026-07-02-gamification-6-sync-honesty.md](plans/2026-07-02-gamification-6-sync-honesty.md).

**`sync_pending` ring state.** Rings whose outcome depends on a device-synced sample
(`movement` ← steps, `mind` ← sleep) carry `SyncPending: true` when *today's* ring
hasn't closed and no synced sample has landed yet — "hasn't synced" instead of
"failed." `syncPendingRings` (`summary.go`) reuses the same per-domain loaders
`scoreday.go` already calls for today's re-score, so no new queries. Period (weekly)
rings and any already-closed ring always report `false` (`ringScores`,
`summary.go:219`: `SyncPending: !closed[ring] && syncPending[ring]`). It's a display
state only — HP/ledger scoring is untouched. Frontend: `today.js` `renderRingsTile`
dims sync-pending rings with a "syncs later" sub-line instead of an empty "failed"
arc, excludes them from the "your move" candidate list, and appends "· M waiting for
sync" to the "N of 5 rings closed" headline; `journey.js` mirrors the dimmed
treatment on the rings card.

**Derived (backfill-proof) streak.** The old `advanceStreak` only moved forward at
score time (`streak.go:39-43`: returns unchanged when `curWeek <= prevWeek`), so a
late import that filled an already-passed "failed" week left the streak stranded —
only the one-time `Backfill` ever rebuilt it. `deriveStreak` (`streak.go:116`)
replaces that read path: on every `GetSummary`/`GetJourney` call it replays
`scoring.NextStreak` oldest-first over the trailing 52 weeks of ledger HP sums
(`WeeklyHPSums`, one `GROUP BY` query), stopping at the last *completed* week — same
semantics as `advanceStreak` (earn a freeze per met week, bank ≤4, auto-spend on a
miss), but computed fresh instead of carried forward. A late import lands ledger HP
in the past week; the very next read re-folds it and the streak self-repairs, with no
explicit repair path or stranded state. `LongestStreak` reports
`max(persisted, derived)` so history recorded before this change is never lost. The
transactional `gamification_state` streak columns keep being written
(`recomputeState`) for compatibility, but no read path depends on them for the
current streak anymore.

**Insight ladder tier 2 gets a real destination.** Tier 2 ("per-domain trend
charts," §8) used to read "soon" for a surface that already existed. `journey.js`
`renderLadder` now marks tier 2 `hasDestination` and deep-links "Unlocked → view" to
the Vitals section's existing trend charts (`switchTab('health')`). Tiers 3-4 keep
the honest "Unlocks at Lvl N · soon" until plans 8/9 ship their destinations.

### 14.6 Concentric rings — Plan 7 (status)

Plans 3/5/6 rendered the five rings as a stacked *list* of separate `wg-ring` arcs —
readable but not the sub-second, gestalt-closure glance Apple's Activity Rings
popularized. Implemented in
[docs/plans/2026-07-02-gamification-7-concentric-rings.md](plans/2026-07-02-gamification-7-concentric-rings.md)
as a pure presentation change — no scoring, API, or `RingScore` field changes.

**`wg-ring-stack`** (`web/static/js/components/wg-ring-stack.js`, `window.WGRingStack`)
— one SVG rendering up to five concentric arcs outer→inner in canonical ring order
(adherence outermost, mind innermost), reusing `wg-ring`'s per-arc dash-math contract
(`pathLength="100"` keeps dash math a flat percentage regardless of that ring's
radius). `WGRingStack.render({ rings, centerLabel, label })` takes each ring's
`{ key, progress, closed, syncPending }`; JS only sets the neutral `--ring-progress`
custom property and picks the `.wg-ring-stack__arc--<key>` color-variant class, CSS
owns dash offset and per-ring hue. A closed ring always renders full + a brighter
variant; a sync-pending ring renders its dimmed track only (never an accusatory empty
arc); an open ring renders its real `progress`. `centerLabel` is caller-supplied
(Today/Journey both pass `"N/5"`, or a check glyph when every actionable ring is
closed) so the component stays a pure geometry/color primitive. Per-ring accent
colors are `--wg-*` tokens, shared by the legend. Covered by
`tests/wg-ring-stack.test.js` (arc-geometry math — the same web-component testing
exception as `tests/wg-ring.test.js`, CLAUDE.md rule 8).

**Today rings tile and Journey rings card** (`features/today.js` `renderRingsTile`,
`features/journey.js`) both replace their five-row ring list with one
`wg-ring-stack` (~180px on Today, larger on Journey) beside a compact legend —
per-ring icon, label, check when closed, `goal` sub-line, and the Plan 6
"syncs later" sub-line when `sync_pending`. The Phase-A headline ("N of 5 rings
closed · M waiting for sync"), the "your move" prompt, the "View Journey →"
affordance, and each ring's per-section logging deeplink are unchanged — only the
ring visualization and its legend layout moved. `wg-ring` itself is untouched and
stays available for other surfaces; the stack is a sibling component, not a rewrite.

Per direction this plan added no tests beyond `tests/wg-ring-stack.test.js`;
verification was `go test ./...` (untouched), `pnpm test` (architecture guards:
globals allowlist incl. `window.WGRingStack`, design tokens, SW precache; existing
Today/Journey feature suites), and manual phone-width smoke.

### 14.7 Health Score & habit strength — Plan 8 (status)

"34 HP today" is illegible on its own — it doesn't say whether that's good or what
to do next. Implemented in
[docs/plans/2026-07-02-gamification-8-health-score-strength.md](plans/2026-07-02-gamification-8-health-score-strength.md)
as two new score layers, both **pure functions of the event log** (a backfill
import just makes them more accurate on the next read — there is no transactional
state to reset). HP, levels, and the ledger are untouched; this is the presentation
layer of motivation, not a new currency.

**Health Score 0–100** (Oura/Whoop pattern) — `scoring.ComputeHealthScore`
(`internal/domain/gamification/scoring/scoring.go`). Five named contributors, each
a range-membership value in `[0,1]`: `bp` (mean systolic/diastolic vs. the same
two-sided bands `ScoreBP` grants HP for), `sleep` (mean duration vs. band, averaged
with a timing-regularity sub-score once the baseline has ≥5 nights), `resting_hr`
(band membership *or* improvement vs. the user's own baseline, whichever is
kinder — `BaselineRelative`), `weight` (stability vs. the trailing average, not an
absolute band), and `adherence` (Proportion of Days Covered vs.
`HealthScoreAdherencePDCTarget`, the §6.1 ≥80% precedent, via `RampUp`). The
composite is a weighted mean over *present* contributors only:
`score = 100 · Σ(w_i·v_i) / Σ(w_i)` — a missing signal (no data in the window)
dilutes the average instead of scoring 0. Below `HealthScoreMinContributors`
(default 2) present contributors, `Score` is `nil` ("not enough data") rather than
a misleadingly confident number from one signal. Windows: recent = 14d
(`HealthScoreWindowDays`), baseline = 60d (`HealthScoreBaselineDays`), both
trailing the request day, so a late import re-enters the math on the very next
read. Built read-time by `wellbeing.go`'s `computeHealthScore`, one loader per
contributor over the same per-domain repos `scoreDayAwards` already calls — no new
tables, no new queries beyond the window reads.

**Habit strength per pillar** (Loop Habit Tracker EMA, uhabits `Score.kt`
provenance) — `scoring.HabitStrength(checkmarks, frequency, cfg)`: chronological
fold `score_d = score_{d-1}·m + checkmark_d·(1−m)`, decay multiplier
`m = 0.5^(√frequency/HalfLifeDays)`, half-life 13 days
(`HabitStrengthHalfLifeDays`) — a daily habit's multiplier ≈0.9481/day (~0.8 after
a month of daily completion, ~0.99 after three months). A miss lowers strength
gradually; it never resets to 0. Checkmarks may be fractional (a day's adherence
ratio is a valid checkmark, not just 0/1). The EMA's steady state is the *mean* of
its input, so `frequency` only tunes decay speed — a non-daily habit reaches the
1.0 ceiling only when fed an *implicit* checkmark reflecting cadence compliance
(uhabits-style), not raw 0/1 daily. Folded per pillar by `wellbeing.go` over a
90-day lookback (`habitStrengthLookbackDays`; ≈7 half-lives, so anything older
contributes a negligible remainder): `meds` (checkmark = day's taken/expected dose
ratio, frequency 1), `movement` (implicit checkmark = share of the 3×/week target
met in the trailing 7 days, `min(1, workouts_in_last_7d/3)`, frequency 3/7 so the
decay matches the cadence), `measurement` (any BP/weight/food log that day,
frequency 1). This replaces the weekly streak as the Journey continuity
mechanic (§9 note); the derived streak (§14.5) survives as a footnote inside the
new Strengths card, not a separate headline metric.

**API/MCP surface** (additive, no new routes — see `docs/api.md#gamification`).
`GetSummary`/`GetJourney` carry `health_score {value, contributors[{key, label,
score, weight, missing}], missing[]}` and `strengths [{key, label, value,
frequency}]`; `/api/gamification/rings` also carries `health_score` (verbatim from
`Summary`) so the Today tile's headline needs no second round-trip.

**Frontend.** Today tile headline becomes the Health Score (0–100 with a
qualitative band word, token-colored) in place of the raw "N HP today" number;
rings/legend/"your move" unchanged. Journey gets a new Health Score card (big
number + one mini-bar per contributor, "no data" state for missing ones) above the
rings card, and the old streak card becomes the Strengths card — one gauge per
pillar with the derived streak as a footnote line ("N-week streak · best M", the
streak being weekly-cadence). The
"How this works" explainer gains Health Score and Strengths terms in plain
language.

Per Testing Strategy this plan added one integration test —
`TestGetSummary_HealthScore_RenormalizesOverPresentContributorsOnly`
(`internal/domain/gamification/wellbeing_test.go`), seeding only BP + adherence
data and asserting the composite renormalizes over the two present contributors
while `sleep`/`resting_hr`/`weight` land in `missing` scored `nil`, not 0 — through
the real service and a seeded SQLite store, guarding the loaders → composite → API
shape boundary end to end. No new unit tests: `ComputeHealthScore` and
`HabitStrength` are pure functions already covered at this integration boundary.
(ponytail: compute-on-read, no caching — add one only if a read ever measurably
gets slow.)

### 14.8 First real insight: sleep → next-morning BP — Plan 9 (status)

The insight ladder's L5–6 promise ("cross-domain correlations — e.g. nights under
6h precede next-day systolic +N mmHg for *you*", §8) said "soon" for every earlier
plan. Implemented in
[docs/plans/2026-07-02-gamification-9-first-insight.md](plans/2026-07-02-gamification-9-first-insight.md)
as the tier-3 unlock, and deliberately the *only* insight this plan ships — the
honesty-gate pattern below is the template future insights (tier 4+) reuse, not a
general correlation framework.

**Computation** (`internal/domain/gamification/insights.go`, `GetInsights`) —
pure function of the existing sleep + BP logs, no new tables, same invariant as
the Health Score (§14.7). Over the trailing `InsightWindowDays` (90), each night's
sleep duration pairs with the first systolic reading before
`InsightMorningCutoffHour` (12:00) local time, resolved through a narrow `TZStore`
(`GetCurrent()`, mirroring `bp.Repo`'s `TimezoneLookup`) that falls back to UTC
when unset. Pairs bucket into "short" (below the effective `SleepHours.Low` band
floor) vs "in-band" nights; the two bucket means are compared. **Honesty gate:**
below `InsightMinPairsPerBucket` (8) nights in *either* bucket, the result is
`insufficient_data` (with `needed`); otherwise a difference under
`InsightNoiseFloorMmHg` (3 mmHg) is `no_effect` — a genuine, reportable finding,
not a blank state — and only a difference at or above the floor is `effect`. Gated
on `gamification_enabled` AND `InsightTier ≥ 3`: below tier 3 the response is
`{enabled, locked:true, unlocks_at_level}` with no numbers at all (principle #5 —
tiers gate depth, never raw data).

**API/MCP surface** — `GET /api/gamification/insights`, registry op
`gamification.insights` (see `docs/api.md#gamification`).

**Frontend** (`journey.js`) — tier 3 becomes the ladder's first `hasDestination`
row ("Unlocked → view"), scrolling to a new insight card that renders all three
states in plain language ("Nights under 7h → next-morning systolic ~+8 mmHg · 23
nights" / "Your morning BP looks steady regardless of sleep length — solid." /
"Not enough paired nights yet · 5 of 8 — keep logging"). Fetched through its own
`cachedFetch` entry (`gamification` tag) with an `OfflineNoCacheError` empty
state, independent of the main Journey payload. Tier 4 shipped in Plan 13 (§14.12).

Per Testing Strategy this plan added integration tests guarding loaders →
pairing → API shape end to end (`internal/domain/gamification/insights_test.go`:
seeded correlated data asserts the `effect` status/delta/counts, sparse data
asserts `insufficient_data`, below-tier asserts the locked shape carries no
numbers) — no unit tests, the same boundary-test posture as Health Score.

---

### 14.9 Levers & gauges restructure — Plan 10 (status)

Implemented in
[docs/plans/2026-07-03-gamification-10-levers-gauges.md](plans/2026-07-03-gamification-10-levers-gauges.md).
Concept sharpening on top of Plans 1–9, view-layer only — no ledger migration,
no re-backfill (§2.5, §5).

- **Engine** (`internal/domain/gamification/scoring/scoring.go`): `ScoreSleep`
  makes timing-regularity the primary award (`SleepRegularityMaxHP` → 10) and
  drops the daily duration outcome award; `ScoreVitalsAuto` no longer scores
  stress. New `Config.BedtimeWindow` band (reuses the existing `Band`/trapezoid
  machinery, §4.1) with a `bedtime` target-override metric key
  (`TargetKeyBedtime`, validated like every other band).
- **View layer** (`summary.go`, `goals.go`): `ringScores()` now returns exactly
  three rings — `bedtime`, `movement`, `nourishment` — for both `TodayRings`
  and `PeriodRings` (shared code path, one mapping). `loadSleep`
  (`scoreday.go`) computes the trailing 14-night median bedtime
  (`medianBedtimeOnset`) to center each night's timing deviation and feed the
  Bedtime ring's real clock-time goal string.
- **Adherence safety net** (`wellbeing.go`): `computeAdherenceAlert` grades
  rolling 14-day dose-level PDC against `Config.AdherenceAlertPDCThreshold`
  (0.90, distinct from and stricter than the Health Score's own 0.80 adherence
  target) and surfaces `adherence_alert {active, pdc, missed_doses}` additively
  on `Summary` and the slim `/api/gamification/rings` view — absent/inactive
  when adherence is fine.
- **Health Score** (`wellbeing.go`): `HealthScoreWeightAdherence` lowered from
  1.0 to 0.5 (a stress contributor never existed here to remove — `ScoreVitalsAuto`
  already didn't score it before this plan's own engine change landed first).
- **Frontend**: Settings' targets editor drops the `stress` band editor and
  adds a `bedtime` window editor (same generic band-override pattern); Journey's
  "How this works" explainer gained one paragraph distinguishing levers (close
  rings daily) from gauges (read as trends).
- **Testing**: one integration test per the Testing Strategy —
  `internal/domain/gamification/gamification10_lever_test.go`, through the real
  service against a real SQLite-backed store — asserting the three-ring shape,
  a consistent-bedtime night closing the Bedtime ring while a diary-only day
  doesn't, and the adherence alert tripping/not-tripping at the PDC threshold.
- **Mixed-rule history:** HP awarded under the old five-Ring rules and HP
  awarded under this plan's rules coexist in the same lifetime sum without
  reconciliation — the ledger is non-punitive and ring-agnostic, so a
  before/after mix is harmless and there is no re-backfill of history.

---

### 14.10 Gauge trends — Plan 11 (status)

Implemented in
[docs/plans/2026-07-03-gamification-11-gauge-trends.md](plans/2026-07-03-gamification-11-gauge-trends.md).
The gauge half of the levers/gauges model (§14.9 did levers): BP, weight, and
resting HR move from daily grading to weekly, view-layer + HP-economy change,
no ledger migration, no re-backfill (§2.5, §5).

- **Read model** (`internal/domain/gamification/gauges.go`, new): `GetGauges` →
  `GET /api/gamification/gauges` (`docs/api.md#gamification`). Weight — EMA
  trend (α=0.10/day) with velocity (%bodyweight/week) and acceleration vs the
  same window one cycle back; pace status vs the user's goal direction+rate, or
  trend-only when no goal is set. BP — 14d/30d in-range share vs a 60d
  baseline, with reading counts. Resting HR — 14d mean vs 60d baseline delta.
  Every gauge reports `insufficient_data` honestly below its configured minimum
  sample count; all computed on read, no new tables, no persisted state, so a
  late backup import re-enters the math on the next read (same invariant as
  the Health Score).
- **Engine** (`internal/domain/gamification/scoring/scoring.go`): `ScoreBP` and
  `ScoreWeight` now grant only their integrity floor — the daily outcome bands
  are gone. `ScoreVitalsAuto` drops the resting-HR and SpO₂ outcome awards
  (SpO₂ earns no HP at all now; its safety-alert path is untouched). Three new
  once-a-week replacements, written only on each week's last day from the same
  reads `gauges.go` computes: `ScoreWeightWeekly` (`MetricWeightTrendWeek`,
  goal-mode safe-pace trapezoid or symmetric maintenance-stability band),
  `ScoreBPWeekly` (`MetricBPShareWeek`, full HP when the 30d share holds/beats
  the 60d baseline, linear falloff below), `ScoreRestingHRWeekly`
  (`MetricRestingHRTrendWeek`, full HP when the trend held/improved vs
  baseline, linear falloff as it rises). All three are `KindOutcome` rows on
  the existing Vitals ring's ledger stream — no new ring.
- **Rescore plumbing** (`internal/domain/gamification/scoreday.go`,
  `rescore_imports.go`, `streak.go`): `scoreDayAwards` calls the three weekly
  scorers only when `isWeekEndDay` (Monday–Sunday, same `weekIndex` anchor as
  the streak fold). `RescoreInstants` adds each affected day's week-end day to
  its dedupe set, so a late import into any day of a week refreshes that
  week's already-written gauge award in place — no `internal/server` wiring
  needed, since the existing recent-window read-path rescore (`{now-1day,
  now}`) already covers the current week's in-progress end day for free.
  Idempotent under the ledger's existing UNIQUE `(user_id, day_unix, ring,
  source_metric, kind)` constraint.
- **Frontend** (`journey.js`): a Gauges panel (below Health Score, above rings)
  — weight sparkline (`WeightGaugeView.TrendHistory`, last 60 days of the same
  trend line, additive/omitempty, no scoring effect) plus the velocity/pace/
  acceleration headline; BP in-range share vs baseline; resting HR vs baseline;
  `insufficient_data` states in plain language; a "why is this moving?" link
  reusing the existing tier-3 insight-card scroll target. Tone: numbers and
  direction words only, no alert-colored tags — a slowing trend is an
  observation, never red.
- **Testing**: one integration test per the Testing Strategy —
  `internal/domain/gamification/gauges_weekly_test.go` — a seeded downward
  weight trend + goal asserting velocity sign/pace/acceleration, a seeded BP
  series with two bad recent days asserting the 30d share stays within 0.10 of
  the 60d baseline, and a week-end award scored then rewritten in place (not
  duplicated) after a late import triggers `RescoreInstants` elsewhere in the
  same week — plus `journey.render.test.js` coverage for the panel's states.
- **Mixed-rule history:** past daily gauge awards stay in the ledger as scored
  (levels never decrease); the weekly stream starts alongside them with no
  re-backfill, same non-punitive, ring-agnostic reasoning as §14.9.

### 14.11 Weekly review — Plan 12 (status)

Implemented in
[docs/plans/2026-07-03-gamification-12-weekly-review.md](plans/2026-07-03-gamification-12-weekly-review.md).
Under the levers/gauges model (§14.9, §14.10), the weekly review is the
cadence at which gauges are meant to be read: one read model, two
presentations, both pure presentation over already-computed data — no new
mechanics, no new tables.

- **Read model** (`internal/domain/gamification/weekly.go`, new):
  `GetWeeklyReview` → `GET /api/gamification/weekly-review`
  (`docs/api.md#gamification`). Resolves the current ISO week (Mon–Sun, UTC
  day-keyed) via the same `weekIndex`/`weekBounds` bucketing `streak.go` and the
  weekly gauge awards use, and folds it against the prior week: per-lever
  closed-day counts (levers), the best day (most rings closed, omitted if
  none did), habit-strength deltas now vs 7 days ago, `gauges.go`'s gauge
  views plus BP's 30-day share a week ago, and the Health Score now vs
  anchored 7 days earlier. A zero-HP week returns `quiet: true` with the rest
  of the shape still valid (zeros, not an error) — "a quiet week," never a
  failure. Everything is computed on read from existing folds, so a late
  backup import that retro-fills a lighter week simply changes what the next
  read returns.
- **Surfaces, "one read model, two presentations":**
  - **Journey card** (`journey.js`): a collapsible "Your week" card between
    the Health Score card and the Gauges panel, fetched via `cachedFetch`
    (tag `gamification`, `OfflineNoCacheError` → empty state). Renders score
    movement, the lever line, gauge lines, and the best day.
  - **Bot digest** (`internal/bot/gamification_commands.go`): the on-demand
    `/week` command calls `GetWeeklyReview` and renders it through
    `FormatWeeklyReview` — a thin-channel formatter shared with the
    scheduled digest below, independently phrased from the web card (no
    shared template layer between the two presentation languages).
  - **Opt-in Sunday digest** (`internal/scheduler/weekly_digest.go`):
    a scheduler job polling for Sunday at
    `WeeklyDigestHour` (19:00, user tz, `Config` constant, no per-user
    customization) for users with both `gamification_enabled` and the new
    `weekly_digest_enabled` flag, sending `FormatWeeklyReview`'s text
    through the bot sink. The flag defaults **OFF** (migration +
    `weekly_digest_enabled` settings column), toggled via the generic
    `POST /api/settings/features/weekly_digest` surface and a Settings UI
    switch next to the gamification toggle — opt-in per design principles
    #4/#8. Send failures are logged and never retried (a weekly nicety,
    next week comes) and never affect scoring or other reminders.
- **Tone:** neutral-to-positive phrasing only, matching the rest of the
  design's Gentler-Streak stance (§9) — a down week reads as observation
  ("BP logging was lighter this week"), never "you failed"; no red styling
  for negative deltas anywhere in the card or digest text.
- **Testing:** one service-level integration test per the Testing Strategy —
  seeded two weeks with a known difference, asserting lever counts, gauge
  movement fields, best day, and the empty-week shape — no unit tests, no
  E2E.

---

### 14.12 Second real insight: your good-day model — Plan 13 (status)

Implemented in
[docs/plans/2026-07-03-gamification-13-good-day-insight.md](plans/2026-07-03-gamification-13-good-day-insight.md).
The L7–8 promise (§8, "your good-day model — a simple personal
feature-importance") was the last ladder rung still reading "soon." This plan
ships it as an attribution engine over the plan-10 levers: the proof that
*your* levers move *your* gauges, using the plan-9 honesty-gate template rather
than a new correlation framework.

- **Computation** (`internal/domain/gamification/insights.go`, additive to
  `GetInsights`): over the trailing `InsightWindowDays` (90), a day is a
  **good day** if it has ≥1 BP reading and its mean systolic sits in the
  user's effective band (days with no reading are excluded from the
  denominator, not counted as bad). Four fixed candidate behaviors are
  evaluated on the previous day/bridging-night — completed a workout,
  bedtime in window (the plan-10 membership predicate, not sleep duration),
  steps in band, all doses taken on time (the adherence loader's miss
  inference) — and each behavior's good-day rate with vs without is compared.
  **Honesty gate:** a behavior needs ≥10 days in *each* arm or it is
  `insufficient_data`; a rate difference ≥15 percentage points clears into
  `findings` (ordered by `|delta_pp|`, capped at 3), otherwise it's
  `no_effect` — both are genuine reported results, not blank states. Gated on
  `InsightTier ≥ 4` (level 7) independently of `sleep_bp`'s tier-3 gate, so
  `good_day` can read locked while `sleep_bp` is already unlocked.
- **API/MCP surface** — additive `good_day` key on the existing
  `GET /api/gamification/insights`, registry op `gamification.insights` (see
  `docs/api.md#gamification`). No new route.
- **Frontend** (`journey.js`) — tier 4 becomes the ladder's second
  `hasDestination` row, same inline-expand pattern as tier 3: one line per
  finding ("On days after a workout, BP in range 78% vs 55% ·
  21/34 days", max 3), a `no_effect` line ("No single habit stands out yet —
  your good days look evenly spread."), an `insufficient_data` line ("Not
  enough contrast yet · keep logging — 6 of 10 workout days needed"), and a
  `good_day_definition` sub-line stating the user's own band ("in range =
  systolic 90–120") so the model is never a black box. Below level 7 the
  honest "Unlocks at Lvl 7" row remains — the ladder no longer has any
  "soon" tier.
- **Tone:** no causal language anywhere in the copy — a behavior's days were
  "in range more often", never "because"; same non-alarmist stance as tier 3.
- **Testing:** one service-level integration test per the Testing Strategy —
  seeded 90 days with a planted workout→good-day association asserts the
  finding's sign/rates/counts, and sparse workout days assert
  `insufficient_data` — no unit tests, no E2E.

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
- **Auto-captured streams are part of grading.** Resting HR/steps count toward
  HP, scored by trend-vs-baseline (fair to genetics, weekly for resting HR —
  gamification-11 §3), at a moderate weight below effortful actions (§6.3).
  SpO₂ earns no HP (gamification-11 §3): safety-alert data, not a game metric.
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
