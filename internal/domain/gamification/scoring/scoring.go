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
	// MetricSpO2 no longer earns HP (gamification-11 Overview §3: safety-alert
	// data, not a game metric) — the identifier stays only as a stable ledger
	// value for any pre-plan-11 historical rows.
	MetricSpO2     = "spo2"
	MetricSleep    = "sleep"
	MetricSteps    = "steps"
	MetricActivity = "activity"
	MetricMeal     = "meal"
	MetricCalories = "calories"
	MetricProtein  = "protein"
	MetricVeg      = "veg"
	MetricWeight   = "weight"
	MetricDiary    = "diary"

	// Weekly gauge-award metrics (gamification-11 §Task2): the idempotent
	// once-per-week replacements for the removed daily BP/weight/resting-HR
	// outcomes, written only on each week's last day. Distinct from
	// MetricBP/MetricWeight/MetricRestingHR above (the still-daily integrity
	// floors) so floor and weekly-outcome rows never collide on the ledger's
	// UNIQUE key.
	MetricWeightTrendWeek    = "weight_trend_week"
	MetricBPShareWeek        = "bp_share_week"
	MetricRestingHRTrendWeek = "resting_hr_trend_week"
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

	// BP (§6.2). Two-sided systolic/diastolic bands, still shared by the
	// integrity floor, the weekly in-range-share award, and the Health Score
	// contributor. The daily band-membership outcome moved to the weekly
	// award (gamification-11 §Task2).
	BPSystolic  Band
	BPDiastolic Band

	// Auto-captured vitals (§6.3): resting HR feeds the Health Score
	// contributor and the weekly trend award (gamification-11 §Task2) via
	// range membership OR improvement vs. the user's own baseline (fair to
	// genetics), whichever is kinder. Stress and SpO₂ are not scored
	// (gamification-10 §2.5 / gamification-11 Overview §3: ungovernable /
	// safety-alert data, not levers) — both stay visible in charts only.
	RestingHR             Band
	VitalsImprovementSpan float64 // fractional band around baseline for the relative credit

	// Sleep (§6.4). Bedtime timing (lights-out deviation from the user's
	// bedtime window) is the lever and the primary award — the user chooses
	// when to go to bed. Duration is a gauge: it stays as a Health Score
	// contributor (HealthContributorSleep) only, never a daily ledger award.
	// BedtimeWindow is deliberately reused as a Band (Low is always 0) so the
	// bedtime target override rides the existing band-override machinery
	// (applyTarget/validateTarget) instead of new bespoke validation: High is
	// the ±window half-width in minutes around the personal bedtime center
	// (default: trailing 14-day median bedtime ± 45min — the service resolves
	// the center, this Config only holds the tolerance/falloff), Falloff
	// softens the edge instead of a hard cutoff.
	SleepHours           Band // Health Score contributor band only (gamification-10)
	SleepRegularityMaxHP int
	BedtimeWindow        Band

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

	// Weight (§6.7), in the Vitals ring. The daily band/outcome moved to the
	// weekly trend-velocity award (gamification-11 §Task2); these remain as the
	// safe-pace tolerance both ScoreWeightWeekly and gauges.go's pace-status
	// read share.
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

	// First real insight (§8 tier 3): sleep→next-morning-BP, the honesty-gate
	// template future insights follow. Pairs each night over the trailing
	// InsightWindowDays with the first systolic reading before
	// InsightMorningCutoffHour local time; nights below the effective
	// SleepHours.Low are "short", the rest "in-band". Reports insufficient_data
	// below InsightMinPairsPerBucket nights in either bucket, else no_effect
	// when the two buckets' mean systolic differs by less than
	// InsightNoiseFloorMmHg.
	InsightWindowDays        int
	InsightMinPairsPerBucket int
	InsightNoiseFloorMmHg    float64
	InsightMorningCutoffHour int

	// Second real insight (§8 tier 4): the good-day association scan
	// (gamification-13). Over the trailing GoodDayWindowDays, a day is "good"
	// when its mean systolic sits in the effective BPSystolic band. Each
	// candidate behavior (workout, bedtime, steps, adherence) on the previous
	// day is compared with-vs-without; a behavior needs GoodDayMinDaysPerArm
	// days in *each* arm to be judged at all, and is only reported as a finding
	// when the rate difference is at least GoodDayNoiseFloorPP percentage
	// points. GoodDayTopFindings caps how many findings the read model returns.
	GoodDayWindowDays    int
	GoodDayMinDaysPerArm int
	GoodDayNoiseFloorPP  float64
	GoodDayTopFindings   int

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

	// Adherence safety net (§6.1/§Task 3): adherence has no ring and no daily
	// grading — it's a solved habit that should stay invisible. The one
	// exception is a trailing-PDC alert when it slips below this threshold,
	// distinct from (and stricter than) HealthScoreAdherencePDCTarget above,
	// which grades Health Score credit rather than firing a nudge.
	AdherenceAlertPDCThreshold float64

	// Gauge trends (gamification-11 §Overview): weight becomes a trend
	// velocity+acceleration read (Hacker's-Diet-style EMA) instead of a daily
	// band score; BP becomes a rolling in-range share; resting HR a trend vs
	// baseline. All three compute on read from the raw log — no new tables —
	// feeding the Journey gauges panel and the weekly award streams that
	// replace the removed daily gauge outcomes. WeightSafePaceMinPct/MaxPct
	// above (already scored by ScoreWeight) double as the pace-status
	// thresholds here — one definition of "safe pace", not a duplicate.
	GaugeWeightEMAAlpha                       float64
	GaugeWeightLookbackDays                   int
	GaugeWeightVelocityWindowDays             int
	GaugeWeightAccelerationDeadbandPctPerWeek float64
	GaugeWeightMinHistoryDays                 int

	GaugeBPRecentWindowDays    int
	GaugeBPMidWindowDays       int
	GaugeBPBaselineWindowDays  int
	GaugeBPMinBaselineReadings int

	GaugeRestingHRRecentWindowDays   int
	GaugeRestingHRBaselineWindowDays int
	GaugeRestingHRMinBaselineDays    int

	// Weekly gauge awards (gamification-11 §Task2): the idempotent replacement
	// for the removed daily BP/weight/resting-HR outcomes, granted once per
	// week on the week's last day from the same trend/share reads gauges.go
	// computes. Weight and BP reuse the existing safe-pace/falloff constants
	// above (WeightSafePaceMinPct/MaxPct, WeightPaceFalloffBelowPct/AbovePct) —
	// one definition of "safe pace", not a weekly-specific duplicate.
	GaugeWeightWeeklyMaxHP int

	GaugeBPWeeklyMaxHP     int
	GaugeBPShareFalloffPts float64 // share-point (0..1) decline below the 60d baseline before the award reaches 0

	GaugeRestingHRWeeklyMaxHP int
	GaugeRestingHRFalloffBPM  float64 // bpm rise above the 60d baseline before the award reaches 0
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

		BPSystolic:  Band{Low: 90, High: 120, Falloff: 10}, // ACC/AHA "normal", two-sided
		BPDiastolic: Band{Low: 60, High: 80, Falloff: 5},

		RestingHR:             Band{Low: 50, High: 80, Falloff: 10},
		VitalsImprovementSpan: 0.2,

		SleepHours:           Band{Low: 7, High: 9, Falloff: 1.5}, // AASM 7–9h, Health Score only
		SleepRegularityMaxHP: 10,                                  // primary sleep award (was 5): bedtime timing is the lever
		BedtimeWindow:        Band{Low: 0, High: 45, Falloff: 60}, // ±45min around the personal median, softening over 60 more

		StepsOutcomeMaxHP:       6,
		StepsBand:               Band{Low: 7000, High: 15000, Falloff: 3000}, // ~7–8k knee, diminishing returns above
		MovementOutcomeMaxHP:    10,
		WeeklyActivityTargetLow: 150, // WHO 150–300 min/week; saturates at the low bound

		NourishmentCaloriesMaxHP: 8,
		CalorieTolerancePct:      0.10, // ±10% of personalized target
		NourishmentProteinMaxHP:  4,
		NourishmentVegMaxHP:      3,

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

		InsightWindowDays:        90,
		InsightMinPairsPerBucket: 8,
		InsightNoiseFloorMmHg:    3,
		InsightMorningCutoffHour: 12,

		GoodDayWindowDays:    90,
		GoodDayMinDaysPerArm: 10,
		GoodDayNoiseFloorPP:  15,
		GoodDayTopFindings:   3,

		FreezeEarnPerPeriod: 1,
		MaxFreezes:          4,

		HealthScoreWindowDays:         14,
		HealthScoreBaselineDays:       60,
		HealthScoreMinContributors:    2,
		HealthScoreWeightBP:           1.0,
		HealthScoreWeightSleep:        1.0,
		HealthScoreWeightRestingHR:    1.0,
		HealthScoreWeightBodyweight:   1.0,
		HealthScoreWeightAdherence:    0.5, // solved habit (Task 3 safety net); small background credit, not a peer signal
		HealthScoreAdherencePDCTarget: 0.8, // §6.1 weekly-adherence precedent
		HealthScoreWeightStabilityPct: 0.02,

		HabitStrengthHalfLifeDays: 13,

		AdherenceAlertPDCThreshold: 0.90,

		GaugeWeightEMAAlpha:                       0.10, // Hacker's Diet ~10%/day
		GaugeWeightLookbackDays:                   120,
		GaugeWeightVelocityWindowDays:             14,
		GaugeWeightAccelerationDeadbandPctPerWeek: 0.15,
		GaugeWeightMinHistoryDays:                 28, // 2x the velocity window: enough for both velocity and acceleration

		GaugeBPRecentWindowDays:    14,
		GaugeBPMidWindowDays:       30,
		GaugeBPBaselineWindowDays:  60,
		GaugeBPMinBaselineReadings: 4,

		GaugeRestingHRRecentWindowDays:   14,
		GaugeRestingHRBaselineWindowDays: 60,
		GaugeRestingHRMinBaselineDays:    5,

		GaugeWeightWeeklyMaxHP: 20,

		GaugeBPWeeklyMaxHP:     20,
		GaugeBPShareFalloffPts: 0.20, // a 20-point share decline zeroes the award

		GaugeRestingHRWeeklyMaxHP: 10,
		GaugeRestingHRFalloffBPM:  5, // a 5bpm rise above baseline zeroes the award
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
// readings — measurement floors don't multiply, unlike scheduled doses). The
// two-sided range-membership outcome moved to the weekly rolling in-range
// share (gamification-11 §Task2, ScoreBPWeekly): one bad day is no longer a
// same-day judgment. Safety alerts on dangerous readings are a separate
// concern — never a silent score penalty.
func ScoreBP(in BPDay, cfg Config) []Award {
	if len(in.Readings) == 0 {
		return nil
	}
	return addAward(nil, RingVitals, MetricBP, KindFloor, cfg.FloorHP, "")
}

// SleepDay is one logged night. TimingDeviationMin is |bedtime − the user's
// bedtime window center| in minutes for the bedtime-timing award; HasRegularity
// is false when there is no personal bedtime baseline to compare against yet.
// DurationHours is logged for completeness but is a gauge, not a lever: it is
// never scored here (see Config.SleepHours doc) — only the Health Score reads
// it (HealthContributorSleep).
type SleepDay struct {
	Logged             bool
	DurationHours      float64
	HasRegularity      bool
	TimingDeviationMin float64
}

// ScoreSleep (§6.4) lives in the Mind ring. It grants a floor for logging the
// night and a bedtime-timing award: membership of the lights-out deviation
// within the user's bedtime window (§2.5 — the lever is choosing a bedtime,
// not the hours slept). Duration is a gauge and is intentionally not scored
// here.
func ScoreSleep(in SleepDay, cfg Config) []Award {
	var awards []Award
	if in.Logged {
		awards = addAward(awards, RingMind, MetricSleep, KindFloor, cfg.FloorHP, "")
	}
	if in.HasRegularity {
		r := cfg.BedtimeWindow.Membership(math.Abs(in.TimingDeviationMin))
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

// WeightDay is one user-day of weight scoring: only whether a weigh-in was
// logged, for the integrity floor. The maintenance/goal outcome moved to the
// weekly trend-velocity award (gamification-11 §Task2, ScoreWeightWeekly).
type WeightDay struct {
	Logged bool
}

// ScoreWeight (§6.7) lives in the Vitals ring and grants only the habit floor
// for weighing in — the day's reading itself is never judged (§Task2: that
// moved to the weekly trend-velocity/pace award, so a single heavy day can't
// move it).
func ScoreWeight(in WeightDay, cfg Config) []Award {
	if !in.Logged {
		return nil
	}
	return addAward(nil, RingVitals, MetricWeight, KindFloor, cfg.FloorHP, "")
}

// ----- weekly gauge awards (gamification-11 §Task2) -------------------------
//
// The three functions below are the once-per-week replacements for the daily
// BP/weight/resting-HR outcomes removed above. They are written only on each
// week's last day, from the same trend/share reads gauges.go's GaugesView
// already computes (velocity, in-range share, baseline delta) — no separate
// math, no new tables. HasData=false (the gauge reported insufficient_data)
// grants no award: honest silence on thin history, never a zero judgment.

// WeightWeeklyInput is one week's smoothed weight-trend read at week-end.
// VelocityPctPerWeek is the EMA trend's %bodyweight/week (gauges.go's
// WeightGaugeView.VelocityPctPerWeek). GoalDirection is -1 (lose)/+1 (gain)
// when the user has a goal, 0 when they don't (maintenance: stability itself
// is rewarded, not progress toward any target).
type WeightWeeklyInput struct {
	HasData            bool
	VelocityPctPerWeek float64
	GoalDirection      int
}

// ScoreWeightWeekly grants full HP when the trend's velocity sits on the safe
// pace toward the goal, with the same gentle-below/steep-above (anti-crash-
// diet) trapezoid falloff ScoreWeight's daily goal mode used. With no goal
// (GoalDirection 0), the safe-pace minimum doubles as a symmetric stability
// band around zero velocity — holding steady earns full HP, drifting either
// direction falls off at the same crash-diet rate.
func ScoreWeightWeekly(in WeightWeeklyInput, cfg Config) []Award {
	if !in.HasData {
		return nil
	}
	var r float64
	if in.GoalDirection != 0 {
		toward := in.VelocityPctPerWeek * float64(in.GoalDirection) // positive = progress toward goal
		r = trapezoid(toward, cfg.WeightSafePaceMinPct, cfg.WeightSafePaceMaxPct, cfg.WeightPaceFalloffBelowPct, cfg.WeightPaceFalloffAbovePct)
	} else {
		r = trapezoid(in.VelocityPctPerWeek, -cfg.WeightSafePaceMinPct, cfg.WeightSafePaceMinPct, cfg.WeightPaceFalloffAbovePct, cfg.WeightPaceFalloffAbovePct)
	}
	return addAward(nil, RingVitals, MetricWeightTrendWeek, KindOutcome, scaleHP(cfg.GaugeWeightWeeklyMaxHP, r), detailR(r))
}

// BPWeeklyInput is one week's rolling in-range share read at week-end
// (gauges.go's BPGaugeView.Share30d/BaselineShare60d).
type BPWeeklyInput struct {
	HasData          bool
	Share30d         float64
	BaselineShare60d float64
}

// ScoreBPWeekly grants full HP when the trailing 30-day in-range share is at
// or above the 60-day baseline (holding or improving control), falling off
// linearly as the share drops GaugeBPShareFalloffPts below baseline. Two bad
// days can only ever nudge this a few points — never a same-day judgment.
func ScoreBPWeekly(in BPWeeklyInput, cfg Config) []Award {
	if !in.HasData {
		return nil
	}
	delta := in.Share30d - in.BaselineShare60d
	r := trapezoid(delta, 0, 1, cfg.GaugeBPShareFalloffPts, 0)
	return addAward(nil, RingVitals, MetricBPShareWeek, KindOutcome, scaleHP(cfg.GaugeBPWeeklyMaxHP, r), detailR(r))
}

// RestingHRWeeklyInput is one week's baseline-delta read at week-end
// (gauges.go's RestingHRGaugeView.DeltaFromBaseline; negative/zero = the
// recent 14-day mean is at or below the 60-day baseline, i.e. held or
// improved — lower resting HR is better).
type RestingHRWeeklyInput struct {
	HasData           bool
	DeltaFromBaseline float64
}

// ScoreRestingHRWeekly grants full HP when the trend held or improved vs
// baseline, falling off linearly as it rises, reaching 0 at
// GaugeRestingHRFalloffBPM above baseline.
func ScoreRestingHRWeekly(in RestingHRWeeklyInput, cfg Config) []Award {
	if !in.HasData {
		return nil
	}
	r := 1.0
	if in.DeltaFromBaseline > 0 {
		if cfg.GaugeRestingHRFalloffBPM <= 0 {
			r = 0
		} else {
			r = clamp01(1 - in.DeltaFromBaseline/cfg.GaugeRestingHRFalloffBPM)
		}
	}
	return addAward(nil, RingVitals, MetricRestingHRTrendWeek, KindOutcome, scaleHP(cfg.GaugeRestingHRWeeklyMaxHP, r), detailR(r))
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
			reg := cfg.BedtimeWindow.Membership(math.Abs(meanTimingDeviationMin))
			v = (v + reg) / 2
		}
		c.Value = v
	}
	return c
}

// HealthContributorRestingHR builds the "resting_hr" contributor using a
// kinder-of-two rule: absolute-band membership or improvement vs. the user's
// own baseline, whichever is higher — so a genetically high resting HR still
// earns by trending down for that person specifically.
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
// (e.g. a day's adherence ratio) rather than a hard 0/1. frequency only tunes
// decay speed; it does not rescale the output, whose steady state is the mean
// of the input. A non-daily habit therefore reaches 1.0 only when the caller
// feeds an *implicit* checkmark reflecting cadence compliance (uhabits-style —
// e.g. movement at 3×/week ⇒ trailing-week fill, not raw 0/1 daily), with
// frequency (3.0/7.0) set to slow the decay to match.
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
