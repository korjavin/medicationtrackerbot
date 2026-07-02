// Package scoring is the pure, DB-free core of the gamification engine. It
// encodes the science settled in docs/gamification.md: outcome-in-range
// HealthPoints (HP) with an integrity floor, the trapezoid range-membership
// function (§4.1), per-domain scorers for the five Rings (§5–§6), the level
// curve and insight-tier gating (§7–§8), and forgiving streak math (§9).
//
// Nothing here touches a database, the clock, or any I/O — every function is a
// deterministic function of its inputs plus a Config. The domain service (Plan
// 1, Task 6–10) loads rows from the per-domain repos, resolves effective
// targets onto a Config, calls these scorers, and maps the returned []Award
// onto store gamification.LedgerEntry rows. Keeping the math here, as the spec,
// is what makes it exhaustively table-testable.
//
// Invariants enforced by construction (the ethical guardrails, §3):
//   - HP is only ever added, never subtracted — a bad or missing day earns
//     less, never negative. There is no point penalty anywhere.
//   - No metric is scored monotonically: every band is two-sided (both tails
//     score lower) except the explicitly one-sided-OK ones (protein adequacy,
//     SpO₂, weekly-activity progress) which saturate at a ceiling rather than
//     rewarding "more = better".
//   - Food and weight never reward restriction: a reading below a configured
//     floor scores zero outcome, never a bonus.
//   - Mood value is never scored: ScoreMind rewards the act of reflecting only.
package scoring

import (
	"fmt"
	"math"
)

// Ring identifiers — the five domain groups HP is earned across (§5). Stored in
// gamification_ledger.ring.
const (
	RingAdherence   = "adherence"
	RingMovement    = "movement"
	RingVitals      = "vitals"
	RingNourishment = "nourishment"
	RingMind        = "mind"
)

// Kind identifiers — the three layers of a daily domain award (§4). Stored in
// gamification_ledger.kind. KindFloor is the small fixed integrity payout for an
// honest log; KindOutcome is the larger range-graded bonus; KindConsistency is
// the optional regularity/process bonus.
const (
	KindFloor       = "floor"
	KindOutcome     = "outcome"
	KindConsistency = "consistency"
)

// Source-metric identifiers — the finer-grained signal within a ring. Stored in
// gamification_ledger.source_metric; together with (day, ring, kind) they form
// the UNIQUE ledger key, so two awards from the same scorer must differ here.
const (
	MetricMedication = "medication"
	MetricBP         = "bp"
	MetricRestingHR  = "resting_hr"
	MetricSpO2       = "spo2"
	MetricStress     = "stress"
	MetricSleep      = "sleep"
	MetricSteps      = "steps"
	MetricActivity   = "activity"
	MetricMeal       = "meal"
	MetricCalories   = "calories"
	MetricProtein    = "protein"
	MetricVeg        = "veg"
	MetricWeight     = "weight"
	MetricDiary      = "diary"
)

// Weight-scoring modes (§6.7). Maintenance rewards stability inside a band; Goal
// rewards safe-pace progress toward a user-set goal.
const (
	ModeWeightMaintenance = "maintenance"
	ModeWeightGoal        = "goal"
)

// Health Score contributor keys — stable identifiers for the API/UI
// breakdown. Distinct from the ledger-scoped Metric* constants above: these
// name a read-only signal in the 0–100 composite, not an HP source.
const (
	HealthKeyBP        = "bp"
	HealthKeySleep     = "sleep"
	HealthKeyRestingHR = "resting_hr"
	HealthKeyWeight    = "weight"
	HealthKeyAdherence = "adherence"
)

// Award is one HP grant produced by a scorer — the "[]LedgerEntry-shaped"
// breakdown the service maps onto a store gamification.LedgerEntry by adding
// UserID, Day, and CreatedAt. Keeping it a distinct, store-free type is what
// lets this package stay pure. Detail carries a small JSON explanation of the
// grant (e.g. the membership value r) for transparency.
type Award struct {
	Ring         string
	SourceMetric string
	Kind         string
	HP           int
	Detail       string
}

// Band is a two-sided target range with a linear falloff tolerance Δ on each
// side — the shape of every personalized clinical band (BP, sleep duration,
// steps, weight maintenance). Membership applies the trapezoid §4.1.
type Band struct {
	Low     float64
	High    float64
	Falloff float64
}

// Membership returns the range-membership r ∈ [0,1] for x against this band.
func (b Band) Membership(x float64) float64 {
	return RangeMembership(x, b.Low, b.High, b.Falloff)
}

// Config holds every tunable constant: HP amounts, the recommended guideline
// bands (BP, sleep 7–9h, steps ~7–8k, WHO activity, calorie tolerance), the
// level curve, insight-tier thresholds, and streak/freeze params. The service
// overlays per-user target overrides onto a copy of DefaultConfig() to get the
// user's effective Config, then passes it to the scorers. Treat every number as
// a default, not a fixed constant (docs/gamification.md preamble).
type Config struct {
	// FloorHP is the integrity-floor payout per honest log, whatever the value
	// (§4 #2). Set to 0 for pure outcome-only scoring (documented tunable).
	FloorHP int

	// Adherence (§6.1). On-time within grace → full; late → trapezoid falloff
	// over LateFalloffMin minutes; intentional skip-with-reason → floor only.
	AdherenceOutcomeMaxHP   int
	AdherenceOnTimeGraceMin float64
	AdherenceLateFalloffMin float64

	// BP (§6.2). Two-sided systolic/diastolic bands; both must be in range
	// (the day scores the min of the two memberships).
	BPOutcomeMaxHP int
	BPSystolic     Band
	BPDiastolic    Band

	// Auto-captured vitals (§6.3): HR/SpO₂/stress, moderate weight (a notch
	// below effortful actions). Scored by range membership OR improvement vs.
	// the user's own baseline (fair to genetics), whichever is kinder.
	VitalsAutoOutcomeMaxHP int
	RestingHR              Band
	SpO2Low                float64
	SpO2Falloff            float64
	StressBand             Band
	VitalsImprovementSpan  float64 // fractional band around baseline for the relative credit

	// Sleep (§6.4), in the Mind ring. Two-sided duration band + a regularity
	// consistency sub-score on timing deviation.
	SleepOutcomeMaxHP           int
	SleepHours                  Band
	SleepRegularityMaxHP        int
	SleepRegularityToleranceMin float64
	SleepRegularityFalloffMin   float64

	// Movement (§6.5). Daily steps band + weekly WHO-activity progress that
	// saturates at the guideline (ceiling = anti-overtraining; never penalized
	// for exceeding it).
	StepsOutcomeMaxHP       int
	StepsBand               Band
	MovementOutcomeMaxHP    int
	WeeklyActivityTargetLow float64

	// Nourishment (§6.6) — handled with the most care. Calories two-sided
	// around a personalized target; protein one-sided-OK; veg positive bonus.
	// Never rewards restriction (below-floor → zero outcome).
	NourishmentCaloriesMaxHP int
	CalorieTolerancePct      float64
	NourishmentProteinMaxHP  int
	NourishmentVegMaxHP      int

	// Weight (§6.7), in the Vitals ring. Maintenance = stability in a band;
	// Goal = safe-pace progress, with an anti-crash-diet falloff above the safe
	// pace and a below-healthy-floor guard.
	WeightOutcomeMaxHP        int
	WeightMaintenanceFalloff  float64
	WeightSafePaceMaxPct      float64
	WeightSafePaceMinPct      float64
	WeightPaceFalloffBelowPct float64
	WeightPaceFalloffAbovePct float64

	// Mind (§6.8). Process-only: a small bonus for engaging with a reflection
	// prompt. The floor (logging a diary entry) uses FloorHP.
	MindReflectBonusHP int

	// Level curve (§7): HP_to_reach(n) = LevelBase·(n-1)^LevelExponent. Growing
	// curve so early levels come fast and later ones are meaningful. LevelMax
	// is a loop-safety cap, not a design ceiling.
	LevelBase     float64
	LevelExponent float64
	LevelMax      int

	// Insight ladder (§8). InsightTierLevels lists the level at which tiers 2,
	// 3, 4… unlock (tier 1 is always level 1). InsightMaxTier caps the MVP at
	// L1–L4 (Plan 1 scope; L5+ deferred to Phase 2).
	InsightTierLevels []int
	InsightMaxTier    int

	// Streaks & forgiveness (§9). Weekly cadence by default: earn
	// FreezeEarnPerPeriod freeze(s) per met period, bank up to MaxFreezes,
	// auto-applied on a miss so the streak survives.
	FreezeEarnPerPeriod int
	MaxFreezes          int

	// Health Score (Oura/Whoop pattern): named contributors compared over a
	// recent window against a personal baseline, combined as a weighted mean
	// over present contributors only — a missing signal dilutes the average,
	// never zeroes it. Below HealthScoreMinContributors present, the score is
	// reported as unknown rather than a misleadingly confident number from a
	// single signal.
	HealthScoreWindowDays         int
	HealthScoreBaselineDays       int
	HealthScoreMinContributors    int
	HealthScoreWeightBP           float64
	HealthScoreWeightSleep        float64
	HealthScoreWeightRestingHR    float64
	HealthScoreWeightBodyweight   float64
	HealthScoreWeightAdherence    float64
	HealthScoreAdherencePDCTarget float64 // PDC ≥ this fraction earns full adherence credit
	HealthScoreWeightStabilityPct float64 // ± this fraction of the trailing average earns full weight-stability credit

	// Habit strength (Loop Habit Tracker EMA): m = 0.5^(√f/HalfLifeDays); a
	// miss lowers strength gradually, never resets it. 13 is uhabits'
	// Score.kt default (a daily habit's multiplier ≈0.9481/day: ~0.8 after a
	// month of daily completion, ~0.99 after three months). Flexible
	// frequency (e.g. f=3/7 for 3×/week movement) works by construction.
	HabitStrengthHalfLifeDays float64
}

// DefaultConfig returns the recommended guideline defaults. Every value is a
// starting recommendation the user (or their clinician) can override via
// gamification_targets; the service merges those overrides onto a copy of this.
func DefaultConfig() Config {
	return Config{
		FloorHP: 2,

		AdherenceOutcomeMaxHP:   10,
		AdherenceOnTimeGraceMin: 60,
		AdherenceLateFalloffMin: 120,

		BPOutcomeMaxHP: 10,
		BPSystolic:     Band{Low: 90, High: 120, Falloff: 10}, // ACC/AHA "normal", two-sided
		BPDiastolic:    Band{Low: 60, High: 80, Falloff: 5},

		VitalsAutoOutcomeMaxHP: 4, // moderate weight: passively captured
		RestingHR:              Band{Low: 50, High: 80, Falloff: 10},
		SpO2Low:                95,
		SpO2Falloff:            4,
		StressBand:             Band{Low: 0, High: 40, Falloff: 20}, // lower is better
		VitalsImprovementSpan:  0.2,

		SleepOutcomeMaxHP:           10,
		SleepHours:                  Band{Low: 7, High: 9, Falloff: 1.5}, // AASM 7–9h, two-sided
		SleepRegularityMaxHP:        5,
		SleepRegularityToleranceMin: 30,
		SleepRegularityFalloffMin:   60,

		StepsOutcomeMaxHP:       6,
		StepsBand:               Band{Low: 7000, High: 15000, Falloff: 3000}, // ~7–8k knee, diminishing returns above
		MovementOutcomeMaxHP:    10,
		WeeklyActivityTargetLow: 150, // WHO 150–300 min/week; saturates at the low bound

		NourishmentCaloriesMaxHP: 8,
		CalorieTolerancePct:      0.10, // ±10% of personalized target
		NourishmentProteinMaxHP:  4,
		NourishmentVegMaxHP:      3,

		WeightOutcomeMaxHP:        8,
		WeightMaintenanceFalloff:  1.0,
		WeightSafePaceMaxPct:      1.0, // ≤1% bodyweight/week is safe
		WeightSafePaceMinPct:      0.25,
		WeightPaceFalloffBelowPct: 0.2,
		WeightPaceFalloffAbovePct: 0.5, // crash-diet falloff above safe pace

		MindReflectBonusHP: 2,

		LevelBase:     100,
		LevelExponent: 1.5,
		LevelMax:      1000,

		InsightTierLevels: []int{3, 5, 7}, // tier2@L3, tier3@L5, tier4@L7
		InsightMaxTier:    4,

		FreezeEarnPerPeriod: 1,
		MaxFreezes:          4,

		HealthScoreWindowDays:         14,
		HealthScoreBaselineDays:       60,
		HealthScoreMinContributors:    2,
		HealthScoreWeightBP:           1.0,
		HealthScoreWeightSleep:        1.0,
		HealthScoreWeightRestingHR:    1.0,
		HealthScoreWeightBodyweight:   1.0,
		HealthScoreWeightAdherence:    1.0,
		HealthScoreAdherencePDCTarget: 0.8, // §6.1 weekly-adherence precedent
		HealthScoreWeightStabilityPct: 0.02,

		HabitStrengthHalfLifeDays: 13,
	}
}

// RangeMembership is the trapezoid §4.1: full credit (1) inside [low, high],
// linear partial credit over the falloff Δ on each side, and 0 beyond. With
// Δ ≤ 0 it degenerates to a hard step (1 in-band, 0 outside). A degenerate band
// (low > high) yields 0 everywhere. The result is always clamped to [0, 1].
func RangeMembership(x, low, high, delta float64) float64 {
	return trapezoid(x, low, high, delta, delta)
}

// trapezoid generalizes RangeMembership to independent below/above falloffs —
// used where the two tails are not symmetric (e.g. weight goal pace: gentle
// below the safe pace, steeper above it as an anti-crash-diet guard).
func trapezoid(x, low, high, deltaLow, deltaHigh float64) float64 {
	if high < low {
		return 0
	}
	if x >= low && x <= high {
		return 1
	}
	if x < low {
		if deltaLow <= 0 || x <= low-deltaLow {
			return 0
		}
		return clamp01(1 - (low-x)/deltaLow)
	}
	// x > high
	if deltaHigh <= 0 || x >= high+deltaHigh {
		return 0
	}
	return clamp01(1 - (x-high)/deltaHigh)
}

// ----- per-domain scorers ---------------------------------------------------

// DoseStatus is the outcome of one scheduled medication dose for the day.
type DoseStatus int

const (
	DoseMissed            DoseStatus = iota // no action logged → counts against adherence, earns no floor
	DoseTaken                               // taken; MinutesLate grades the outcome
	DoseSkippedWithReason                   // intentional skip (e.g. doctor-ordered) → floor only, excluded from outcome
)

// Dose is one scheduled dose's outcome. MinutesLate is meaningful only for
// DoseTaken (minutes after the scheduled time; 0 = on time or early).
type Dose struct {
	Status      DoseStatus
	MinutesLate int
}

// AdherenceDay is one user-day of medication doses.
type AdherenceDay struct {
	Doses []Dose
}

// ScoreAdherence (§6.1) grants an integrity floor for every honestly logged dose
// action (taken or skipped-with-reason) and a single outcome award graded by the
// mean on-time membership across "expected" doses (taken + missed). Doctor-ordered
// skips are excluded from the outcome denominator so a deliberate stop never
// costs points. Never negative.
func ScoreAdherence(in AdherenceDay, cfg Config) []Award {
	var awards []Award
	floorLogs := 0
	var expected, takenSum float64
	for _, d := range in.Doses {
		switch d.Status {
		case DoseTaken:
			floorLogs++
			expected++
			takenSum += RangeMembership(float64(d.MinutesLate), 0, cfg.AdherenceOnTimeGraceMin, cfg.AdherenceLateFalloffMin)
		case DoseSkippedWithReason:
			floorLogs++ // honest log; excluded from outcome (no penalty)
		case DoseMissed:
			expected++ // drags the outcome down, earns no floor
		}
	}
	awards = addAward(awards, RingAdherence, MetricMedication, KindFloor, floorLogs*cfg.FloorHP, detailCount(floorLogs))
	if expected > 0 {
		r := takenSum / expected
		awards = addAward(awards, RingAdherence, MetricMedication, KindOutcome, scaleHP(cfg.AdherenceOutcomeMaxHP, r), detailR(r))
	}
	return awards
}

// BPReading is one blood-pressure measurement.
type BPReading struct {
	Systolic  float64
	Diastolic float64
}

// BPDay is one user-day of BP readings.
type BPDay struct {
	Readings []BPReading
}

// ScoreBP (§6.2) grants one integrity floor for the day (regardless of how many
// readings — measurement floors don't multiply, unlike scheduled doses) and a
// two-sided outcome on the day's mean reading. Both systolic and diastolic must
// be in range: the outcome uses the min of the two memberships. Safety alerts on
// dangerous readings are a separate concern — never a silent score penalty.
func ScoreBP(in BPDay, cfg Config) []Award {
	if len(in.Readings) == 0 {
		return nil
	}
	var awards []Award
	awards = addAward(awards, RingVitals, MetricBP, KindFloor, cfg.FloorHP, "")
	var sumSys, sumDia float64
	for _, rd := range in.Readings {
		sumSys += rd.Systolic
		sumDia += rd.Diastolic
	}
	n := float64(len(in.Readings))
	r := math.Min(cfg.BPSystolic.Membership(sumSys/n), cfg.BPDiastolic.Membership(sumDia/n))
	awards = addAward(awards, RingVitals, MetricBP, KindOutcome, scaleHP(cfg.BPOutcomeMaxHP, r), detailR(r))
	return awards
}

// VitalsAutoDay is one user-day of auto-captured streams. The Baseline* fields
// carry the user's own recent baseline (0 = unknown) so scoring can credit
// improvement-vs-self, not just absolute range.
type VitalsAutoDay struct {
	HasRestingHR      bool
	RestingHR         float64
	BaselineRestingHR float64
	HasSpO2           bool
	SpO2              float64
	HasStress         bool
	Stress            float64
	BaselineStress    float64
}

// ScoreVitalsAuto (§6.3) scores resting HR, SpO₂, and stress at a moderate
// weight. HR and stress take the kinder of (absolute band membership,
// improvement vs. the user's own baseline) so someone with a genetically high
// resting HR still earns by trending down for themselves. SpO₂ is one-sided
// (≥95%). One outcome award per present stream; no floor (auto-captured streams
// don't need an honesty incentive).
func ScoreVitalsAuto(in VitalsAutoDay, cfg Config) []Award {
	var awards []Award
	if in.HasRestingHR {
		r := math.Max(cfg.RestingHR.Membership(in.RestingHR),
			BaselineRelative(in.RestingHR, in.BaselineRestingHR, true, cfg.VitalsImprovementSpan))
		awards = addAward(awards, RingVitals, MetricRestingHR, KindOutcome, scaleHP(cfg.VitalsAutoOutcomeMaxHP, r), detailR(r))
	}
	if in.HasSpO2 {
		r := RangeMembership(in.SpO2, cfg.SpO2Low, 100, cfg.SpO2Falloff)
		awards = addAward(awards, RingVitals, MetricSpO2, KindOutcome, scaleHP(cfg.VitalsAutoOutcomeMaxHP, r), detailR(r))
	}
	if in.HasStress {
		r := math.Max(cfg.StressBand.Membership(in.Stress),
			BaselineRelative(in.Stress, in.BaselineStress, true, cfg.VitalsImprovementSpan))
		awards = addAward(awards, RingVitals, MetricStress, KindOutcome, scaleHP(cfg.VitalsAutoOutcomeMaxHP, r), detailR(r))
	}
	return awards
}

// SleepDay is one logged night. TimingDeviationMin is |onset − personal average|
// in minutes for the regularity sub-score; HasRegularity is false when there is
// no baseline to compare against yet.
type SleepDay struct {
	Logged             bool
	DurationHours      float64
	HasRegularity      bool
	TimingDeviationMin float64
}

// ScoreSleep (§6.4) lives in the Mind ring. It grants a floor for logging the
// night, a two-sided duration outcome (chasing 10h+ is not rewarded), and a
// regularity consistency bonus that rewards stable timing without scoring the
// raw value.
func ScoreSleep(in SleepDay, cfg Config) []Award {
	var awards []Award
	if in.Logged {
		awards = addAward(awards, RingMind, MetricSleep, KindFloor, cfg.FloorHP, "")
		r := cfg.SleepHours.Membership(in.DurationHours)
		awards = addAward(awards, RingMind, MetricSleep, KindOutcome, scaleHP(cfg.SleepOutcomeMaxHP, r), detailR(r))
	}
	if in.HasRegularity {
		r := RangeMembership(math.Abs(in.TimingDeviationMin), 0, cfg.SleepRegularityToleranceMin, cfg.SleepRegularityFalloffMin)
		awards = addAward(awards, RingMind, MetricSleep, KindConsistency, scaleHP(cfg.SleepRegularityMaxHP, r), detailR(r))
	}
	return awards
}

// MovementDay is one user-day of movement signals. WeeklyActivityMinutes is the
// rolling 7-day moderate-equivalent total the service supplies.
type MovementDay struct {
	HasSteps              bool
	Steps                 float64
	WorkoutLogged         bool
	HasActivity           bool
	WeeklyActivityMinutes float64
}

// ScoreMovement (§6.5) scores a daily steps band and weekly WHO-activity
// progress. Steps get a floor (having step data) + a two-sided outcome. Activity
// gets a floor (a workout was logged) + an outcome that ramps to full at the WHO
// lower guideline and then saturates — exceeding the upper guideline earns no
// extra points but is never penalized (the anti-overtraining ceiling).
func ScoreMovement(in MovementDay, cfg Config) []Award {
	var awards []Award
	if in.HasSteps {
		awards = addAward(awards, RingMovement, MetricSteps, KindFloor, cfg.FloorHP, "")
		r := cfg.StepsBand.Membership(in.Steps)
		awards = addAward(awards, RingMovement, MetricSteps, KindOutcome, scaleHP(cfg.StepsOutcomeMaxHP, r), detailR(r))
	}
	if in.WorkoutLogged {
		awards = addAward(awards, RingMovement, MetricActivity, KindFloor, cfg.FloorHP, "")
	}
	if in.HasActivity {
		r := RampUp(in.WeeklyActivityMinutes, cfg.WeeklyActivityTargetLow)
		awards = addAward(awards, RingMovement, MetricActivity, KindOutcome, scaleHP(cfg.MovementOutcomeMaxHP, r), detailR(r))
	}
	return awards
}

// NourishmentDay is one user-day of food intake. The targets/floor are resolved
// by the service (personalized); CalorieFloor (0 = unset) guards against ever
// rewarding under-eating below a safe minimum.
type NourishmentDay struct {
	Logged        bool
	Calories      float64
	CalorieTarget float64
	CalorieFloor  float64
	Protein       float64
	ProteinTarget float64
	VegServings   float64
	VegTarget     float64
}

// ScoreNourishment (§6.6) is handled with the most care: it never rewards
// restriction. Calories are two-sided around the personalized target (both under
// and over score lower), and a reading below CalorieFloor scores zero outcome
// regardless. Protein is one-sided-OK (ramps to full at target, saturates).
// Vegetables are a positive-framing bonus. The floor rewards logging meals.
func ScoreNourishment(in NourishmentDay, cfg Config) []Award {
	var awards []Award
	if in.Logged {
		awards = addAward(awards, RingNourishment, MetricMeal, KindFloor, cfg.FloorHP, "")
	}
	if in.CalorieTarget > 0 {
		tol := cfg.CalorieTolerancePct
		r := RangeMembership(in.Calories,
			in.CalorieTarget*(1-tol), in.CalorieTarget*(1+tol), in.CalorieTarget*tol)
		if in.CalorieFloor > 0 && in.Calories < in.CalorieFloor {
			r = 0 // never award for being under a calorie floor (anti-restriction)
		}
		awards = addAward(awards, RingNourishment, MetricCalories, KindOutcome, scaleHP(cfg.NourishmentCaloriesMaxHP, r), detailR(r))
	}
	if in.ProteinTarget > 0 {
		r := RampUp(in.Protein, in.ProteinTarget)
		awards = addAward(awards, RingNourishment, MetricProtein, KindOutcome, scaleHP(cfg.NourishmentProteinMaxHP, r), detailR(r))
	}
	if in.VegTarget > 0 {
		r := RampUp(in.VegServings, in.VegTarget)
		awards = addAward(awards, RingNourishment, MetricVeg, KindOutcome, scaleHP(cfg.NourishmentVegMaxHP, r), detailR(r))
	}
	return awards
}

// WeightDay is one user-day of weight scoring. Maintenance mode uses Weight
// against [BandLow, BandHigh]; goal mode uses WeeklyChangePct (signed % of
// bodyweight/week, negative = loss) and GoalDirection (-1 lose, +1 gain).
// BelowHealthyFloor forces a zero outcome (refuse to reward an unhealthy target).
type WeightDay struct {
	Logged            bool
	Mode              string
	Weight            float64
	BandLow           float64
	BandHigh          float64
	WeeklyChangePct   float64
	GoalDirection     int
	SafePaceMaxPct    float64
	BelowHealthyFloor bool
}

// ScoreWeight (§6.7) lives in the Vitals ring and is never rewarded for going
// down per se. The floor rewards the habit of weighing in. Maintenance rewards
// stability inside the user's band (two-sided). Goal rewards safe-pace progress
// toward the goal, with a gentle falloff below the safe minimum and a steeper
// anti-crash-diet falloff above the safe maximum. A weight below the healthy
// floor scores zero outcome.
func ScoreWeight(in WeightDay, cfg Config) []Award {
	var awards []Award
	if !in.Logged {
		return awards
	}
	awards = addAward(awards, RingVitals, MetricWeight, KindFloor, cfg.FloorHP, "")
	var r float64
	switch {
	case in.BelowHealthyFloor:
		r = 0
	case in.Mode == ModeWeightGoal:
		safeMax := in.SafePaceMaxPct
		if safeMax <= 0 {
			safeMax = cfg.WeightSafePaceMaxPct
		}
		toward := in.WeeklyChangePct * float64(in.GoalDirection) // positive = progress toward goal
		r = trapezoid(toward, cfg.WeightSafePaceMinPct, safeMax, cfg.WeightPaceFalloffBelowPct, cfg.WeightPaceFalloffAbovePct)
	default: // maintenance
		if in.BandHigh > in.BandLow {
			r = RangeMembership(in.Weight, in.BandLow, in.BandHigh, cfg.WeightMaintenanceFalloff)
		}
	}
	awards = addAward(awards, RingVitals, MetricWeight, KindOutcome, scaleHP(cfg.WeightOutcomeMaxHP, r), detailR(r))
	return awards
}

// MindDay is one user-day of reflection. There is deliberately no mood-value
// field: the mood is never scored (§6.8). Only the act of reflecting earns HP.
type MindDay struct {
	JournaledEntries  int
	EngagedWithPrompt bool
}

// ScoreMind (§6.8) is process-scored only. It grants a floor for journaling and
// an optional "noticing" consistency bonus for engaging with a reflection
// prompt. A sad day never costs points because the mood value is never read.
func ScoreMind(in MindDay, cfg Config) []Award {
	var awards []Award
	if in.JournaledEntries > 0 {
		awards = addAward(awards, RingMind, MetricDiary, KindFloor, cfg.FloorHP, detailCount(in.JournaledEntries))
	}
	if in.EngagedWithPrompt {
		awards = addAward(awards, RingMind, MetricDiary, KindConsistency, cfg.MindReflectBonusHP, "")
	}
	return awards
}

// ----- levels, insight tiers, streaks ---------------------------------------

// HPToReachLevel is the cumulative lifetime HP needed to be at the given level:
// LevelBase·(level-1)^LevelExponent, rounded. Level 1 needs 0 HP. The curve
// grows so early levels arrive fast (momentum) and later ones are meaningful.
func HPToReachLevel(level int, cfg Config) int {
	if level <= 1 {
		return 0
	}
	return int(math.Round(cfg.LevelBase * math.Pow(float64(level-1), cfg.LevelExponent)))
}

// LevelForLifetimeHP returns the highest level whose HPToReachLevel threshold is
// at or below hp. Monotonic non-decreasing in hp; never below 1. Levels never
// decrease (§7) — that invariant lives in the service, which only ever raises
// the stored level — but this function itself is a pure mapping.
func LevelForLifetimeHP(hp int, cfg Config) int {
	if hp <= 0 {
		return 1
	}
	level := 1
	for level < cfg.LevelMax && HPToReachLevel(level+1, cfg) <= hp {
		level++
	}
	return level
}

// InsightTierForLevel maps a level to its unlocked insight tier (§8). Tier 1 is
// always available; each threshold in InsightTierLevels unlocks the next tier.
// Capped at InsightMaxTier (MVP: L1–L4). Tiers gate depth of analysis only —
// never raw data or safety alerts (§8, principle #5).
func InsightTierForLevel(level int, cfg Config) int {
	tier := 1
	for _, lv := range cfg.InsightTierLevels {
		if level >= lv {
			tier++
		}
	}
	if cfg.InsightMaxTier > 0 && tier > cfg.InsightMaxTier {
		tier = cfg.InsightMaxTier
	}
	return tier
}

// StreakInput is the minimal prior streak state NextStreak needs. The service
// maps gamification.State onto it, keeping this package free of the store import.
type StreakInput struct {
	CurrentStreak int
	Freezes       int
}

// NextStreak advances the streak for one cadence period (weekly by default,
// §9). A met period extends the streak and earns a freeze (banked up to
// MaxFreezes). A missed period auto-applies a banked freeze so the streak
// survives; with no freezes left the streak resets to 0. Never negative, never a
// point penalty — a miss is a rest, not a failure.
func NextStreak(prev StreakInput, periodMet bool, cfg Config) (streak, freezesLeft int) {
	cur := max0(prev.CurrentStreak)
	fz := max0(prev.Freezes)
	if periodMet {
		freezesLeft = fz + cfg.FreezeEarnPerPeriod
		if cfg.MaxFreezes > 0 && freezesLeft > cfg.MaxFreezes {
			freezesLeft = cfg.MaxFreezes
		}
		return cur + 1, freezesLeft
	}
	if fz > 0 {
		return cur, fz - 1 // freeze auto-applied: streak preserved
	}
	return 0, 0 // reset, never negative
}

// ----- health score & habit strength -----------------------------------------

// HealthScoreContributor is one named signal feeding the Health Score
// composite: a range-membership Value in [0,1] (meaningless when !Present),
// its Weight, and whether this window actually had enough data to compute
// it at all. Present is decided by the caller's loader — the only thing
// that knows whether a signal exists this window, as opposed to existing
// but scoring poorly.
type HealthScoreContributor struct {
	Key     string
	Label   string
	Value   float64
	Weight  float64
	Present bool
}

// HealthScoreInput is the full named-contributor set for one computation: a
// recent window (HealthScoreWindowDays) compared against a personal
// baseline (HealthScoreBaselineDays), resolved by the service's per-domain
// loaders. DB-free here by design — only the composite math lives in this
// package.
type HealthScoreInput struct {
	Contributors []HealthScoreContributor
}

// HealthScoreResult is the composite Health Score (0–100) plus its
// breakdown. Score is nil when fewer than Config.HealthScoreMinContributors
// signals are present — "not enough data" rather than a misleadingly
// confident number computed from a single signal.
type HealthScoreResult struct {
	Score        *float64
	Contributors []HealthScoreContributor
	Missing      []string
}

// ComputeHealthScore folds present contributors into a weighted mean scaled
// to 0–100, renormalizing over the Σweight of only the present ones — a
// missing contributor dilutes the average instead of scoring it 0. Backfill
// imports that add or complete data simply change the input set on the next
// read; there is no state to reset.
func ComputeHealthScore(in HealthScoreInput, cfg Config) HealthScoreResult {
	res := HealthScoreResult{Contributors: in.Contributors}
	var sumWeight, sumWeightedValue float64
	present := 0
	for _, c := range in.Contributors {
		if !c.Present {
			res.Missing = append(res.Missing, c.Key)
			continue
		}
		present++
		sumWeight += c.Weight
		sumWeightedValue += c.Weight * clamp01(c.Value)
	}
	minContributors := cfg.HealthScoreMinContributors
	if minContributors <= 0 {
		minContributors = 2
	}
	if present < minContributors || sumWeight <= 0 {
		return res
	}
	score := 100 * sumWeightedValue / sumWeight
	res.Score = &score
	return res
}

// HealthContributorBP builds the "bp" Health Score contributor from the
// recent window's mean reading — the same two-sided membership ScoreBP
// grants HP for, applied to a window average instead of a single day.
func HealthContributorBP(meanSystolic, meanDiastolic float64, present bool, cfg Config) HealthScoreContributor {
	c := HealthScoreContributor{Key: HealthKeyBP, Label: "Blood pressure", Weight: cfg.HealthScoreWeightBP, Present: present}
	if present {
		c.Value = math.Min(cfg.BPSystolic.Membership(meanSystolic), cfg.BPDiastolic.Membership(meanDiastolic))
	}
	return c
}

// HealthContributorSleep builds the "sleep" contributor from the window's
// mean duration and, when a personal timing baseline exists, mean timing
// deviation — the same two signals ScoreSleep grants HP for, averaged into
// one 0..1 value instead of two separate awards.
func HealthContributorSleep(meanDurationHours, meanTimingDeviationMin float64, hasRegularity, present bool, cfg Config) HealthScoreContributor {
	c := HealthScoreContributor{Key: HealthKeySleep, Label: "Sleep", Weight: cfg.HealthScoreWeightSleep, Present: present}
	if present {
		v := cfg.SleepHours.Membership(meanDurationHours)
		if hasRegularity {
			reg := RangeMembership(math.Abs(meanTimingDeviationMin), 0, cfg.SleepRegularityToleranceMin, cfg.SleepRegularityFalloffMin)
			v = (v + reg) / 2
		}
		c.Value = v
	}
	return c
}

// HealthContributorRestingHR builds the "resting_hr" contributor using the
// same kinder-of-two rule as ScoreVitalsAuto: absolute-band membership or
// improvement vs. the user's own baseline, whichever is higher — so a
// genetically high resting HR still earns by trending down for that person
// specifically.
func HealthContributorRestingHR(meanHR, baselineHR float64, present bool, cfg Config) HealthScoreContributor {
	c := HealthScoreContributor{Key: HealthKeyRestingHR, Label: "Resting heart rate", Weight: cfg.HealthScoreWeightRestingHR, Present: present}
	if present {
		c.Value = math.Max(cfg.RestingHR.Membership(meanHR), BaselineRelative(meanHR, baselineHR, true, cfg.VitalsImprovementSpan))
	}
	return c
}

// HealthContributorWeight builds the "weight" contributor as stability
// against the user's own trailing average — not an absolute band like
// ScoreWeight's maintenance mode, but how close the window's readings sit
// to that person's own recent normal.
func HealthContributorWeight(meanWeight, trailingAvg float64, present bool, cfg Config) HealthScoreContributor {
	c := HealthScoreContributor{Key: HealthKeyWeight, Label: "Weight stability", Weight: cfg.HealthScoreWeightBodyweight, Present: present}
	if present && trailingAvg > 0 {
		tol := trailingAvg * cfg.HealthScoreWeightStabilityPct
		c.Value = RangeMembership(meanWeight, trailingAvg-tol, trailingAvg+tol, tol)
	}
	return c
}

// HealthContributorAdherence builds the "adherence" contributor from the
// window's proportion of days covered (PDC) — full credit at or above
// Config.HealthScoreAdherencePDCTarget (the §6.1 weekly ≥80% precedent),
// ramping linearly below it. One-sided-OK: PDC cannot exceed 1.0, so there
// is no ceiling to fall off from the other side.
func HealthContributorAdherence(pdc float64, present bool, cfg Config) HealthScoreContributor {
	c := HealthScoreContributor{Key: HealthKeyAdherence, Label: "Medication adherence", Weight: cfg.HealthScoreWeightAdherence, Present: present}
	if present {
		target := cfg.HealthScoreAdherencePDCTarget
		if target <= 0 {
			target = 0.8
		}
		c.Value = RampUp(pdc, target)
	}
	return c
}

// HabitStrength folds a chronological (oldest-first) series of fractional
// checkmarks into the Loop Habit Tracker EMA (uhabits Score.kt provenance):
// score_d = score_{d-1}·m + checkmark_d·(1−m), where the daily decay
// multiplier m = 0.5^(√frequency/HalfLifeDays). A miss lowers strength
// gradually — it never resets to 0 — and a checkmark may be fractional
// (e.g. a day's adherence ratio) rather than a hard 0/1. frequency lets a
// non-daily habit (e.g. movement at 3×/week ⇒ frequency=3.0/7.0) reach the
// same steady-state strength as a daily habit hitting its own cadence.
func HabitStrength(checkmarks []float64, frequency float64, cfg Config) float64 {
	halfLife := cfg.HabitStrengthHalfLifeDays
	if halfLife <= 0 {
		halfLife = 13
	}
	if frequency <= 0 {
		frequency = 1
	}
	m := math.Pow(0.5, math.Sqrt(frequency)/halfLife)
	var score float64
	for _, ck := range checkmarks {
		score = score*m + clamp01(ck)*(1-m)
	}
	return score
}

// ----- helpers --------------------------------------------------------------

// BaselineRelative grades x against the user's own baseline (0 = unknown → 0
// credit, falls back to the absolute band). lowerIsBetter inverts the direction
// (HR, stress). At x = baseline it returns 0.5; a full span of improvement
// reaches 1.0, the same span of regression reaches 0.
func BaselineRelative(x, baseline float64, lowerIsBetter bool, span float64) float64 {
	if baseline <= 0 || span <= 0 {
		return 0
	}
	delta := baseline * span
	improvement := x - baseline
	if lowerIsBetter {
		improvement = baseline - x
	}
	return clamp01(0.5 + improvement/(2*delta))
}

// RampUp is a one-sided-OK membership: 0 at/below 0, ramping linearly to full
// (1) at full, saturating at 1 beyond. Used where more is fine up to a ceiling
// (weekly activity progress, protein/veg adequacy, adherence PDC vs target).
func RampUp(x, full float64) float64 {
	if full <= 0 {
		return 0
	}
	return clamp01(x / full)
}

// scaleHP converts a membership r ∈ [0,1] into rounded, non-negative HP.
func scaleHP(maxHP int, r float64) int {
	v := int(math.Round(float64(maxHP) * clamp01(r)))
	if v < 0 {
		return 0
	}
	return v
}

// addAward appends a non-zero award, dropping HP ≤ 0 grants so the ledger stays
// free of empty rows (a domain with no in-range outcome simply records no
// outcome award, keeping its floor).
func addAward(awards []Award, ring, source, kind string, hp int, detail string) []Award {
	if hp <= 0 {
		return awards
	}
	return append(awards, Award{Ring: ring, SourceMetric: source, Kind: kind, HP: hp, Detail: detail})
}

// clamp01 bounds v to [0, 1].
func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

// max0 floors n at 0.
func max0(n int) int {
	if n < 0 {
		return 0
	}
	return n
}

// detailR renders the membership value as a compact JSON detail blob.
func detailR(r float64) string {
	return fmt.Sprintf(`{"r":%.3f}`, r)
}

// detailCount renders a log count as a compact JSON detail blob.
func detailCount(n int) string {
	return fmt.Sprintf(`{"logs":%d}`, n)
}
