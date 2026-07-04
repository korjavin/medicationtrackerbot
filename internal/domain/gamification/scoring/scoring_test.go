package scoring

import (
	"math"
	"testing"
)

// findAward returns the HP of the (ring, source, kind) award, and whether it was
// present. Absent awards (HP ≤ 0) report present=false, which the scorers use to
// mean "no in-range outcome".
func findAward(awards []Award, ring, source, kind string) (int, bool) {
	for _, a := range awards {
		if a.Ring == ring && a.SourceMetric == source && a.Kind == kind {
			return a.HP, true
		}
	}
	return 0, false
}

// assertNonNegative is the cross-cutting invariant: no scorer ever emits a
// negative HP award.
func assertNonNegative(t *testing.T, awards []Award) {
	t.Helper()
	for _, a := range awards {
		if a.HP < 0 {
			t.Fatalf("negative HP award: %+v", a)
		}
	}
}

func TestRangeMembership(t *testing.T) {
	// low=10, high=20, delta=5 → falloff 5..10 below, 20..25 above.
	const low, high, delta = 10.0, 20.0, 5.0
	tests := []struct {
		name string
		x    float64
		want float64
	}{
		{"in-band low edge", 10, 1},
		{"in-band high edge", 20, 1},
		{"in-band middle", 15, 1},
		{"below halfway", 7.5, 0.5},
		{"below near band", 9, 0.8},
		{"below outer edge zero", 5, 0},
		{"below beyond tail", 2, 0},
		{"above halfway", 22.5, 0.5},
		{"above near band", 21, 0.8},
		{"above outer edge zero", 25, 0},
		{"above beyond tail", 40, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := RangeMembership(tc.x, low, high, delta)
			if math.Abs(got-tc.want) > 1e-9 {
				t.Fatalf("RangeMembership(%v) = %v, want %v", tc.x, got, tc.want)
			}
		})
	}
}

func TestRangeMembership_DegenerateAndStep(t *testing.T) {
	// delta <= 0 → hard step function.
	if got := RangeMembership(15, 10, 20, 0); got != 1 {
		t.Fatalf("step in-band = %v, want 1", got)
	}
	if got := RangeMembership(9, 10, 20, 0); got != 0 {
		t.Fatalf("step just-below = %v, want 0", got)
	}
	if got := RangeMembership(21, 10, 20, 0); got != 0 {
		t.Fatalf("step just-above = %v, want 0", got)
	}
	// degenerate band low > high → always 0.
	if got := RangeMembership(15, 20, 10, 5); got != 0 {
		t.Fatalf("degenerate band = %v, want 0", got)
	}
	// single-point band low == high with falloff → trapezoid both sides.
	if got := RangeMembership(10, 10, 10, 5); got != 1 {
		t.Fatalf("point band at point = %v, want 1", got)
	}
	if got := RangeMembership(12.5, 10, 10, 5); math.Abs(got-0.5) > 1e-9 {
		t.Fatalf("point band half-above = %v, want 0.5", got)
	}
	// result is always clamped to [0,1] — never exceeds 1 in-band.
	if got := RangeMembership(15, 10, 20, 5); got > 1 {
		t.Fatalf("membership exceeded 1: %v", got)
	}
}

func TestScoreAdherence(t *testing.T) {
	cfg := DefaultConfig()

	t.Run("all taken on time → floor + full outcome", func(t *testing.T) {
		aw := ScoreAdherence(AdherenceDay{Doses: []Dose{
			{Status: DoseTaken, MinutesLate: 0},
			{Status: DoseTaken, MinutesLate: 0},
		}}, cfg)
		assertNonNegative(t, aw)
		if hp, ok := findAward(aw, RingAdherence, MetricMedication, KindFloor); !ok || hp != 2*cfg.FloorHP {
			t.Fatalf("floor = %d (ok=%v), want %d", hp, ok, 2*cfg.FloorHP)
		}
		if hp, ok := findAward(aw, RingAdherence, MetricMedication, KindOutcome); !ok || hp != cfg.AdherenceOutcomeMaxHP {
			t.Fatalf("outcome = %d (ok=%v), want %d", hp, ok, cfg.AdherenceOutcomeMaxHP)
		}
	})

	t.Run("one taken late → partial outcome", func(t *testing.T) {
		// 120 min late = halfway down the late falloff → r=0.5 → 5 HP.
		aw := ScoreAdherence(AdherenceDay{Doses: []Dose{
			{Status: DoseTaken, MinutesLate: 120},
		}}, cfg)
		hp, ok := findAward(aw, RingAdherence, MetricMedication, KindOutcome)
		if !ok || hp != 5 {
			t.Fatalf("late outcome = %d (ok=%v), want 5", hp, ok)
		}
	})

	t.Run("skip-with-reason → floor only, no penalty", func(t *testing.T) {
		aw := ScoreAdherence(AdherenceDay{Doses: []Dose{
			{Status: DoseSkippedWithReason},
		}}, cfg)
		if hp, ok := findAward(aw, RingAdherence, MetricMedication, KindFloor); !ok || hp != cfg.FloorHP {
			t.Fatalf("floor = %d (ok=%v), want %d", hp, ok, cfg.FloorHP)
		}
		// excluded from outcome denominator → no outcome award at all.
		if hp, ok := findAward(aw, RingAdherence, MetricMedication, KindOutcome); ok {
			t.Fatalf("unexpected outcome %d for a doctor-ordered skip", hp)
		}
	})

	t.Run("missed dose drags outcome but earns no floor", func(t *testing.T) {
		aw := ScoreAdherence(AdherenceDay{Doses: []Dose{
			{Status: DoseTaken, MinutesLate: 0},
			{Status: DoseMissed},
		}}, cfg)
		// floor only for the one taken dose.
		if hp, _ := findAward(aw, RingAdherence, MetricMedication, KindFloor); hp != cfg.FloorHP {
			t.Fatalf("floor = %d, want %d (one taken)", hp, cfg.FloorHP)
		}
		// meanR = (1 + 0)/2 = 0.5 → 5 HP.
		if hp, _ := findAward(aw, RingAdherence, MetricMedication, KindOutcome); hp != 5 {
			t.Fatalf("outcome = %d, want 5", hp)
		}
	})

	t.Run("empty day → no awards", func(t *testing.T) {
		if aw := ScoreAdherence(AdherenceDay{}, cfg); len(aw) != 0 {
			t.Fatalf("expected no awards, got %+v", aw)
		}
	})
}

func TestScoreBP(t *testing.T) {
	cfg := DefaultConfig()

	t.Run("readings logged → floor only, the day's reading is not judged", func(t *testing.T) {
		aw := ScoreBP(BPDay{Readings: []BPReading{{Systolic: 115, Diastolic: 75}}}, cfg)
		assertNonNegative(t, aw)
		if hp, ok := findAward(aw, RingVitals, MetricBP, KindFloor); !ok || hp != cfg.FloorHP {
			t.Fatalf("floor = %d (ok=%v), want %d", hp, ok, cfg.FloorHP)
		}
		if hp, ok := findAward(aw, RingVitals, MetricBP, KindOutcome); ok {
			t.Fatalf("expected no daily outcome (moved to the weekly award), got %d", hp)
		}
	})

	t.Run("multiple readings → single floor (no multiplication)", func(t *testing.T) {
		aw := ScoreBP(BPDay{Readings: []BPReading{
			{Systolic: 110, Diastolic: 70}, {Systolic: 118, Diastolic: 78}, {Systolic: 116, Diastolic: 76},
		}}, cfg)
		if hp, _ := findAward(aw, RingVitals, MetricBP, KindFloor); hp != cfg.FloorHP {
			t.Fatalf("floor = %d, want a single %d regardless of reading count", hp, cfg.FloorHP)
		}
	})

	t.Run("far out of range → still just the floor (honesty rewarded)", func(t *testing.T) {
		aw := ScoreBP(BPDay{Readings: []BPReading{{Systolic: 180, Diastolic: 110}}}, cfg)
		if _, ok := findAward(aw, RingVitals, MetricBP, KindFloor); !ok {
			t.Fatal("expected integrity floor even for a dangerous reading (honesty rewarded)")
		}
	})

	t.Run("no readings → nil", func(t *testing.T) {
		if aw := ScoreBP(BPDay{}, cfg); aw != nil {
			t.Fatalf("expected nil, got %+v", aw)
		}
	})
}

func TestScoreSleep(t *testing.T) {
	cfg := DefaultConfig()

	t.Run("logged night → floor only, duration is not scored (gauge)", func(t *testing.T) {
		aw := ScoreSleep(SleepDay{Logged: true, DurationHours: 8}, cfg)
		assertNonNegative(t, aw)
		if hp, ok := findAward(aw, RingMind, MetricSleep, KindFloor); !ok || hp != cfg.FloorHP {
			t.Fatalf("sleep floor = %d (ok=%v)", hp, ok)
		}
		if hp, ok := findAward(aw, RingMind, MetricSleep, KindOutcome); ok {
			t.Fatalf("duration should never earn a ledger outcome award, got %d", hp)
		}
	})

	t.Run("bedtime-timing award is primary", func(t *testing.T) {
		aw := ScoreSleep(SleepDay{Logged: true, DurationHours: 8, HasRegularity: true, TimingDeviationMin: 15}, cfg)
		if hp, ok := findAward(aw, RingMind, MetricSleep, KindConsistency); !ok || hp != cfg.SleepRegularityMaxHP {
			t.Fatalf("bedtime timing = %d (ok=%v), want %d", hp, ok, cfg.SleepRegularityMaxHP)
		}
	})
}

func TestScoreMovement(t *testing.T) {
	cfg := DefaultConfig()

	t.Run("steps in band → floor + full outcome", func(t *testing.T) {
		aw := ScoreMovement(MovementDay{HasSteps: true, Steps: 8000}, cfg)
		assertNonNegative(t, aw)
		if hp, ok := findAward(aw, RingMovement, MetricSteps, KindOutcome); !ok || hp != cfg.StepsOutcomeMaxHP {
			t.Fatalf("steps outcome = %d (ok=%v), want %d", hp, ok, cfg.StepsOutcomeMaxHP)
		}
	})

	t.Run("activity saturates at WHO ceiling — exceeding never penalized", func(t *testing.T) {
		at := ScoreMovement(MovementDay{HasActivity: true, WeeklyActivityMinutes: 150}, cfg)
		over := ScoreMovement(MovementDay{HasActivity: true, WeeklyActivityMinutes: 600}, cfg)
		atHP, _ := findAward(at, RingMovement, MetricActivity, KindOutcome)
		overHP, _ := findAward(over, RingMovement, MetricActivity, KindOutcome)
		if atHP != cfg.MovementOutcomeMaxHP {
			t.Fatalf("at-ceiling outcome = %d, want %d", atHP, cfg.MovementOutcomeMaxHP)
		}
		if overHP != atHP {
			t.Fatalf("over-ceiling outcome = %d, want same as ceiling %d (no extra, no penalty)", overHP, atHP)
		}
	})

	t.Run("workout logged → activity floor", func(t *testing.T) {
		aw := ScoreMovement(MovementDay{WorkoutLogged: true}, cfg)
		if hp, ok := findAward(aw, RingMovement, MetricActivity, KindFloor); !ok || hp != cfg.FloorHP {
			t.Fatalf("activity floor = %d (ok=%v)", hp, ok)
		}
	})
}

func TestScoreNourishment(t *testing.T) {
	cfg := DefaultConfig()

	t.Run("on-target calories → full outcome", func(t *testing.T) {
		aw := ScoreNourishment(NourishmentDay{Logged: true, Calories: 2000, CalorieTarget: 2000}, cfg)
		assertNonNegative(t, aw)
		if hp, ok := findAward(aw, RingNourishment, MetricCalories, KindOutcome); !ok || hp != cfg.NourishmentCaloriesMaxHP {
			t.Fatalf("calorie outcome = %d (ok=%v), want %d", hp, ok, cfg.NourishmentCaloriesMaxHP)
		}
		if _, ok := findAward(aw, RingNourishment, MetricMeal, KindFloor); !ok {
			t.Fatal("expected meal floor")
		}
	})

	t.Run("over-target is penalized too (two-sided, never 'more = better')", func(t *testing.T) {
		// 2600 with target 2000, tol 10% → high=2200, delta=200 → beyond → r=0.
		aw := ScoreNourishment(NourishmentDay{Logged: true, Calories: 2600, CalorieTarget: 2000}, cfg)
		if hp, ok := findAward(aw, RingNourishment, MetricCalories, KindOutcome); ok {
			t.Fatalf("over-eating should not earn calorie HP, got %d", hp)
		}
	})

	t.Run("below calorie floor → zero outcome (anti-restriction)", func(t *testing.T) {
		// 1100 would otherwise be far below band anyway; assert the floor guard
		// explicitly forces zero even if a band were generous.
		aw := ScoreNourishment(NourishmentDay{Logged: true, Calories: 1100, CalorieTarget: 2000, CalorieFloor: 1200}, cfg)
		if hp, ok := findAward(aw, RingNourishment, MetricCalories, KindOutcome); ok {
			t.Fatalf("under-floor calories must never be rewarded, got %d", hp)
		}
		// honesty still rewarded.
		if _, ok := findAward(aw, RingNourishment, MetricMeal, KindFloor); !ok {
			t.Fatal("expected meal floor even when under the calorie floor")
		}
	})

	t.Run("protein one-sided-OK: meeting target → full, exceeding never penalized", func(t *testing.T) {
		at := ScoreNourishment(NourishmentDay{ProteinTarget: 100, Protein: 100}, cfg)
		over := ScoreNourishment(NourishmentDay{ProteinTarget: 100, Protein: 160}, cfg)
		atHP, _ := findAward(at, RingNourishment, MetricProtein, KindOutcome)
		overHP, _ := findAward(over, RingNourishment, MetricProtein, KindOutcome)
		if atHP != cfg.NourishmentProteinMaxHP || overHP != cfg.NourishmentProteinMaxHP {
			t.Fatalf("protein at=%d over=%d, want both %d", atHP, overHP, cfg.NourishmentProteinMaxHP)
		}
	})

	t.Run("veg bonus scales toward target", func(t *testing.T) {
		aw := ScoreNourishment(NourishmentDay{VegTarget: 5, VegServings: 5}, cfg)
		if hp, ok := findAward(aw, RingNourishment, MetricVeg, KindOutcome); !ok || hp != cfg.NourishmentVegMaxHP {
			t.Fatalf("veg = %d (ok=%v), want %d", hp, ok, cfg.NourishmentVegMaxHP)
		}
	})
}

func TestScoreWeight(t *testing.T) {
	cfg := DefaultConfig()

	t.Run("logged → floor only, the day's reading is not judged", func(t *testing.T) {
		aw := ScoreWeight(WeightDay{Logged: true}, cfg)
		assertNonNegative(t, aw)
		if hp, ok := findAward(aw, RingVitals, MetricWeight, KindFloor); !ok || hp != cfg.FloorHP {
			t.Fatalf("floor = %d (ok=%v), want %d", hp, ok, cfg.FloorHP)
		}
		if hp, ok := findAward(aw, RingVitals, MetricWeight, KindOutcome); ok {
			t.Fatalf("expected no daily outcome (moved to the weekly award), got %d", hp)
		}
	})

	t.Run("not logged → no awards", func(t *testing.T) {
		if aw := ScoreWeight(WeightDay{Logged: false}, cfg); len(aw) != 0 {
			t.Fatalf("expected no awards, got %+v", aw)
		}
	})
}

func TestScoreWeightWeekly(t *testing.T) {
	cfg := DefaultConfig()

	t.Run("goal: safe-pace loss rewarded, crash-diet pace penalized", func(t *testing.T) {
		safe := ScoreWeightWeekly(WeightWeeklyInput{HasData: true, VelocityPctPerWeek: -0.6, GoalDirection: -1}, cfg)
		crash := ScoreWeightWeekly(WeightWeeklyInput{HasData: true, VelocityPctPerWeek: -2.0, GoalDirection: -1}, cfg)
		safeHP, _ := findAward(safe, RingVitals, MetricWeightTrendWeek, KindOutcome)
		crashHP, _ := findAward(crash, RingVitals, MetricWeightTrendWeek, KindOutcome)
		if safeHP != cfg.GaugeWeightWeeklyMaxHP {
			t.Fatalf("safe-pace outcome = %d, want %d", safeHP, cfg.GaugeWeightWeeklyMaxHP)
		}
		if crashHP != 0 {
			t.Fatalf("crash-diet pace should earn no outcome, got %d", crashHP)
		}
	})

	t.Run("no goal: holding steady earns full, drifting either way falls off", func(t *testing.T) {
		steady := ScoreWeightWeekly(WeightWeeklyInput{HasData: true, VelocityPctPerWeek: 0}, cfg)
		partial := ScoreWeightWeekly(WeightWeeklyInput{HasData: true, VelocityPctPerWeek: 0.5}, cfg)
		steadyHP, _ := findAward(steady, RingVitals, MetricWeightTrendWeek, KindOutcome)
		partialHP, ok := findAward(partial, RingVitals, MetricWeightTrendWeek, KindOutcome)
		if steadyHP != cfg.GaugeWeightWeeklyMaxHP {
			t.Fatalf("steady outcome = %d, want %d", steadyHP, cfg.GaugeWeightWeeklyMaxHP)
		}
		if !ok || partialHP >= steadyHP {
			t.Fatalf("drifting outcome = %d (ok=%v), want a nonzero amount less than steady %d", partialHP, ok, steadyHP)
		}

		// Far enough off in either direction falls all the way to zero.
		up := ScoreWeightWeekly(WeightWeeklyInput{HasData: true, VelocityPctPerWeek: 2.0}, cfg)
		down := ScoreWeightWeekly(WeightWeeklyInput{HasData: true, VelocityPctPerWeek: -2.0}, cfg)
		if _, ok := findAward(up, RingVitals, MetricWeightTrendWeek, KindOutcome); ok {
			t.Fatal("expected zero outcome for a large upward drift")
		}
		if _, ok := findAward(down, RingVitals, MetricWeightTrendWeek, KindOutcome); ok {
			t.Fatal("expected zero outcome for a large downward drift")
		}
	})

	t.Run("insufficient data → no award", func(t *testing.T) {
		if aw := ScoreWeightWeekly(WeightWeeklyInput{HasData: false}, cfg); len(aw) != 0 {
			t.Fatalf("expected no awards, got %+v", aw)
		}
	})
}

func TestScoreBPWeekly(t *testing.T) {
	cfg := DefaultConfig()

	t.Run("share held at baseline → full HP", func(t *testing.T) {
		aw := ScoreBPWeekly(BPWeeklyInput{HasData: true, Share30d: 0.8, BaselineShare60d: 0.8}, cfg)
		assertNonNegative(t, aw)
		if hp, ok := findAward(aw, RingVitals, MetricBPShareWeek, KindOutcome); !ok || hp != cfg.GaugeBPWeeklyMaxHP {
			t.Fatalf("outcome = %d (ok=%v), want %d", hp, ok, cfg.GaugeBPWeeklyMaxHP)
		}
	})

	t.Run("share improved above baseline → still full HP (saturates, no bonus)", func(t *testing.T) {
		aw := ScoreBPWeekly(BPWeeklyInput{HasData: true, Share30d: 0.95, BaselineShare60d: 0.7}, cfg)
		if hp, ok := findAward(aw, RingVitals, MetricBPShareWeek, KindOutcome); !ok || hp != cfg.GaugeBPWeeklyMaxHP {
			t.Fatalf("outcome = %d (ok=%v), want %d", hp, ok, cfg.GaugeBPWeeklyMaxHP)
		}
	})

	t.Run("share dropped far below baseline → falls off to zero", func(t *testing.T) {
		aw := ScoreBPWeekly(BPWeeklyInput{HasData: true, Share30d: 0.2, BaselineShare60d: 0.8}, cfg)
		if hp, ok := findAward(aw, RingVitals, MetricBPShareWeek, KindOutcome); ok {
			t.Fatalf("expected zero outcome for a large share drop, got %d", hp)
		}
	})

	t.Run("insufficient data → no award", func(t *testing.T) {
		if aw := ScoreBPWeekly(BPWeeklyInput{HasData: false}, cfg); len(aw) != 0 {
			t.Fatalf("expected no awards, got %+v", aw)
		}
	})
}

func TestScoreRestingHRWeekly(t *testing.T) {
	cfg := DefaultConfig()

	t.Run("held or improved (delta <= 0) → full HP", func(t *testing.T) {
		aw := ScoreRestingHRWeekly(RestingHRWeeklyInput{HasData: true, DeltaFromBaseline: -2}, cfg)
		assertNonNegative(t, aw)
		if hp, ok := findAward(aw, RingVitals, MetricRestingHRTrendWeek, KindOutcome); !ok || hp != cfg.GaugeRestingHRWeeklyMaxHP {
			t.Fatalf("outcome = %d (ok=%v), want %d", hp, ok, cfg.GaugeRestingHRWeeklyMaxHP)
		}
	})

	t.Run("rose beyond the falloff → zero outcome", func(t *testing.T) {
		aw := ScoreRestingHRWeekly(RestingHRWeeklyInput{HasData: true, DeltaFromBaseline: cfg.GaugeRestingHRFalloffBPM + 1}, cfg)
		if hp, ok := findAward(aw, RingVitals, MetricRestingHRTrendWeek, KindOutcome); ok {
			t.Fatalf("expected zero outcome for a large HR rise, got %d", hp)
		}
	})

	t.Run("insufficient data → no award", func(t *testing.T) {
		if aw := ScoreRestingHRWeekly(RestingHRWeeklyInput{HasData: false}, cfg); len(aw) != 0 {
			t.Fatalf("expected no awards, got %+v", aw)
		}
	})
}

func TestScoreMind(t *testing.T) {
	cfg := DefaultConfig()

	t.Run("journaling earns floor; mood value is never scored", func(t *testing.T) {
		aw := ScoreMind(MindDay{JournaledEntries: 2}, cfg)
		assertNonNegative(t, aw)
		if hp, ok := findAward(aw, RingMind, MetricDiary, KindFloor); !ok || hp != cfg.FloorHP {
			t.Fatalf("diary floor = %d (ok=%v)", hp, ok)
		}
		// there is no outcome award — mood value is never read.
		if _, ok := findAward(aw, RingMind, MetricDiary, KindOutcome); ok {
			t.Fatal("Mind must never produce an outcome award (no mood-value scoring)")
		}
	})

	t.Run("reflection prompt → consistency bonus", func(t *testing.T) {
		aw := ScoreMind(MindDay{JournaledEntries: 1, EngagedWithPrompt: true}, cfg)
		if hp, ok := findAward(aw, RingMind, MetricDiary, KindConsistency); !ok || hp != cfg.MindReflectBonusHP {
			t.Fatalf("noticing bonus = %d (ok=%v), want %d", hp, ok, cfg.MindReflectBonusHP)
		}
	})

	t.Run("no reflection → no awards", func(t *testing.T) {
		if aw := ScoreMind(MindDay{}, cfg); len(aw) != 0 {
			t.Fatalf("expected no awards, got %+v", aw)
		}
	})
}

func TestLevelCurve(t *testing.T) {
	cfg := DefaultConfig()

	if got := HPToReachLevel(1, cfg); got != 0 {
		t.Fatalf("level 1 threshold = %d, want 0", got)
	}
	// Thresholds strictly increase with level (growing curve).
	prev := -1
	for n := 1; n <= 50; n++ {
		th := HPToReachLevel(n, cfg)
		if th <= prev && n > 1 {
			t.Fatalf("HPToReachLevel not strictly increasing at level %d: %d <= %d", n, th, prev)
		}
		prev = th
	}
	// LevelForLifetimeHP is monotonic non-decreasing and matches the thresholds.
	lastLevel := 0
	for hp := 0; hp <= 5000; hp += 25 {
		lv := LevelForLifetimeHP(hp, cfg)
		if lv < 1 {
			t.Fatalf("level < 1 at hp=%d: %d", hp, lv)
		}
		if lv < lastLevel {
			t.Fatalf("level decreased at hp=%d: %d < %d", hp, lv, lastLevel)
		}
		// being at level lv means hp >= threshold(lv) and < threshold(lv+1).
		if hp < HPToReachLevel(lv, cfg) {
			t.Fatalf("hp=%d below its own level %d threshold %d", hp, lv, HPToReachLevel(lv, cfg))
		}
		lastLevel = lv
	}
	// Zero / negative HP floors at level 1.
	if LevelForLifetimeHP(0, cfg) != 1 || LevelForLifetimeHP(-100, cfg) != 1 {
		t.Fatal("non-positive HP must map to level 1")
	}
}

func TestInsightTierForLevel(t *testing.T) {
	cfg := DefaultConfig() // thresholds {3,5,7}, max 4
	tests := []struct {
		level, want int
	}{
		{1, 1}, {2, 1}, {3, 2}, {4, 2}, {5, 3}, {6, 3}, {7, 4}, {8, 4}, {100, 4},
	}
	for _, tc := range tests {
		if got := InsightTierForLevel(tc.level, cfg); got != tc.want {
			t.Fatalf("InsightTierForLevel(%d) = %d, want %d", tc.level, got, tc.want)
		}
	}
}

func TestNextStreak(t *testing.T) {
	cfg := DefaultConfig() // earn 1/period, max 4

	t.Run("met period extends streak and earns a freeze", func(t *testing.T) {
		streak, freezes := NextStreak(StreakInput{CurrentStreak: 3, Freezes: 1}, true, cfg)
		if streak != 4 || freezes != 2 {
			t.Fatalf("got (%d,%d), want (4,2)", streak, freezes)
		}
	})

	t.Run("freeze banking is capped", func(t *testing.T) {
		_, freezes := NextStreak(StreakInput{CurrentStreak: 1, Freezes: cfg.MaxFreezes}, true, cfg)
		if freezes != cfg.MaxFreezes {
			t.Fatalf("freezes = %d, want capped at %d", freezes, cfg.MaxFreezes)
		}
	})

	t.Run("missed period with a freeze → streak survives, freeze consumed", func(t *testing.T) {
		streak, freezes := NextStreak(StreakInput{CurrentStreak: 5, Freezes: 2}, false, cfg)
		if streak != 5 || freezes != 1 {
			t.Fatalf("got (%d,%d), want (5,1) — freeze auto-applied", streak, freezes)
		}
	})

	t.Run("missed period with no freezes → reset, never negative", func(t *testing.T) {
		streak, freezes := NextStreak(StreakInput{CurrentStreak: 9, Freezes: 0}, false, cfg)
		if streak != 0 || freezes != 0 {
			t.Fatalf("got (%d,%d), want (0,0)", streak, freezes)
		}
	})

	t.Run("negative prior state is floored at zero", func(t *testing.T) {
		streak, freezes := NextStreak(StreakInput{CurrentStreak: -3, Freezes: -2}, false, cfg)
		if streak < 0 || freezes < 0 {
			t.Fatalf("got (%d,%d), must be non-negative", streak, freezes)
		}
	})
}

func TestBaselineRelative(t *testing.T) {
	// span 0.2, baseline 100. delta = 20.
	if got := BaselineRelative(100, 100, true, 0.2); math.Abs(got-0.5) > 1e-9 {
		t.Fatalf("at baseline = %v, want 0.5", got)
	}
	if got := BaselineRelative(80, 100, true, 0.2); math.Abs(got-1.0) > 1e-9 {
		t.Fatalf("full improvement (lower better) = %v, want 1.0", got)
	}
	if got := BaselineRelative(120, 100, true, 0.2); got != 0 {
		t.Fatalf("full regression (lower better) = %v, want 0", got)
	}
	// unknown baseline → no credit (falls back to band elsewhere).
	if got := BaselineRelative(80, 0, true, 0.2); got != 0 {
		t.Fatalf("unknown baseline = %v, want 0", got)
	}
}

func TestScaleHP_NeverNegative(t *testing.T) {
	if got := scaleHP(10, -5); got != 0 {
		t.Fatalf("scaleHP clamps negative r to 0, got %d", got)
	}
	if got := scaleHP(10, 2.0); got != 10 {
		t.Fatalf("scaleHP clamps r>1 to max, got %d", got)
	}
}
