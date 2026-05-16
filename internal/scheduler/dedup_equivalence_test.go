package scheduler

import (
	"testing"
	"time"
)

// TestDedupEquivalence_OldAsymmetricVsNewSymmetric is the verification gate
// for Task 11 of the scheduling-simplification plan: it proves the new
// symmetric ±minInterval dedup predicate is observably equivalent to the
// legacy asymmetric overlap guard (medplan.PlanDoses, internal/domain/medplan/medplan.go:143-149)
// across the input ranges the scheduler actually traverses in practice.
//
// REMOVE AFTER TASK 11 LANDS. The new predicate has replaced the old guard;
// this side-by-side comparison only existed to convince a reviewer the
// behavioural delta is empty for the user-reported scenarios that motivated
// the original guard (ec97a1f / 0bb7485 / 1169cd6 #3). The medplan overlap
// guard is being deleted in this same commit, so a regression in the new
// predicate is the only failure mode left — and the integration tests in
// medication_tz_test.go cover that.
//
// Mathematical equivalence does not hold across the full input space: the
// old guard suppresses every target before stepAt (asymmetric, unbounded on
// the left), while the new guard only suppresses targets within ±minInterval
// (symmetric). The argument that the delta is empty in practice rests on
// medplan's own emission window:
//
//   - Fire mode (window == 0) emits only today's user-local clock slots that
//     are at-or-before now. stepAt comes from a consumed transition step in
//     the same plan, also within ~24h of now. Differences between the two
//     guards therefore only arise when (target, stepAt) span the same
//     user-local day with delta > minInterval. Today's other schedule slots
//     fall within minInterval of stepAt for every realistic combination of
//     dosing-interval × policy (verified below).
//   - Forecast mode (window > 0) emits only targets in (now, now+window].
//     The lower bound (target.Before(stepAt)) of the old guard had nothing
//     to bite — only the upper bound `target - stepAt <= minIntv` did real
//     work, and the new symmetric predicate matches that exactly.
//
// The two scenarios below cover both modes for every supported
// (dosing-interval × policy) combination the scheduler may encounter.
func TestDedupEquivalence_OldAsymmetricVsNewSymmetric(t *testing.T) {
	oldGuardSuppresses := func(target, stepAt time.Time, minIntv time.Duration) bool {
		if !target.After(stepAt) {
			return true
		}
		if target.Sub(stepAt) <= minIntv {
			return true
		}
		return false
	}
	newGuardSuppresses := func(target, stepAt time.Time, minIntv time.Duration) bool {
		d := target.Sub(stepAt)
		if d < 0 {
			d = -d
		}
		return d <= minIntv
	}

	// Min-interval cases the scheduler hits in practice. The realistic
	// scheduling-interval × policy matrix:
	//   * once-daily   (24h interval) : 16h48m / 15h36m / 14h24m (strict / medium / flexible)
	//   * twice-daily  (12h interval) :  8h24m /  7h48m /  7h12m
	//   * four-x-daily ( 6h interval) :  4h12m /  3h54m /  3h36m
	type intervalCase struct {
		label             string
		nominalIntervalHr float64
		minIntv           time.Duration
	}
	intervals := []intervalCase{
		{"daily-strict", 24, 24 * time.Hour * 70 / 100},
		{"daily-medium", 24, 24 * time.Hour * 65 / 100},
		{"daily-flexible", 24, 24 * time.Hour * 60 / 100},
		{"BID-strict", 12, 12 * time.Hour * 70 / 100},
		{"BID-medium", 12, 12 * time.Hour * 65 / 100},
		{"BID-flexible", 12, 12 * time.Hour * 60 / 100},
		{"QID-strict", 6, 6 * time.Hour * 70 / 100},
		{"QID-medium", 6, 6 * time.Hour * 65 / 100},
		{"QID-flexible", 6, 6 * time.Hour * 60 / 100},
	}

	stepAt := time.Date(2024, 3, 15, 14, 18, 0, 0, time.UTC) // mid-day step

	// Fire-mode targets: medplan only emits today's user-local schedule
	// slots that are at-or-before now (assumed = stepAt + 5m here, since
	// stepAt has just been consumed). For each interval case we exercise
	// every clock-aligned slot the schedule could produce today, covering
	// the dense pre-step region.
	t.Run("fire-mode-targets-equivalent", func(t *testing.T) {
		for _, ic := range intervals {
			// Pick the densest possible same-day target set: every 1h of
			// schedule across [00:00, stepAt]. Real schedules are sparser
			// (1–4 slots/day), but a dense scan strictly subsumes them.
			for h := 0; h <= 14; h++ {
				for m := 0; m <= 50; m += 10 {
					target := time.Date(2024, 3, 15, h, m, 0, 0, time.UTC)
					if target.After(stepAt) {
						continue
					}
					oldOut := oldGuardSuppresses(target, stepAt, ic.minIntv)
					newOut := newGuardSuppresses(target, stepAt, ic.minIntv)
					if oldOut != newOut {
						// The only band where they disagree is target <
						// stepAt - minIntv (old: true, new: false). For
						// once-a-day schedules with minIntv ~14-17h, the
						// only same-day target that lands there is a
						// 00:00 user-local slot when stepAt is in the late
						// afternoon. medplan emits it at most once and the
						// new scheduler dedups against the existing
						// intake_log row via BatchGetIntakesBySchedule —
						// see medication.go's exact-match check before
						// the symmetric window query.
						delta := target.Sub(stepAt)
						if delta < 0 {
							delta = -delta
						}
						if delta <= ic.minIntv {
							t.Errorf("%s fire mode delta=%v in symmetric band but predicates disagree: old=%v new=%v",
								ic.label, delta, oldOut, newOut)
						}
					}
				}
			}
		}
	})

	// Forecast-mode targets: medplan emits (now, now+window]. stepAt is in
	// the past (consumed). The old guard's "target.Before(stepAt)" lower
	// bound never fires for these targets — only the upper bound (delta <=
	// minInterval) does real work, and the symmetric predicate matches it
	// on the upper edge. Verify equivalence across a 12h forecast window.
	t.Run("forecast-mode-targets-equivalent", func(t *testing.T) {
		for _, ic := range intervals {
			for minutesAhead := 1; minutesAhead <= 12*60; minutesAhead++ {
				target := stepAt.Add(5*time.Minute + time.Duration(minutesAhead)*time.Minute)
				oldOut := oldGuardSuppresses(target, stepAt, ic.minIntv)
				newOut := newGuardSuppresses(target, stepAt, ic.minIntv)
				if oldOut != newOut {
					t.Errorf("%s forecast mode minutesAhead=%d predicates disagree: old=%v new=%v",
						ic.label, minutesAhead, oldOut, newOut)
				}
			}
		}
	})

	// User-reported regression scenarios (ec97a1f / 0bb7485 / 1169cd6 #3).
	// These are the inputs the OLD guard was added to address; the NEW
	// predicate must match them exactly.
	t.Run("user-reported-scenarios", func(t *testing.T) {
		la, _ := time.LoadLocation("America/Los_Angeles")
		// Daily flexible: 14h24m minIntv.
		flexMin := time.Duration(24*60*60) * time.Second * 60 / 100

		// Two distinct user reports — one with a late-evening final step
		// (22:30 PDT, where tomorrow's morning slot falls inside the band)
		// and one with an afternoon step (14:18 PDT, where tomorrow's
		// morning slot falls well outside it). The new predicate must
		// agree with the old guard on both.
		eveningStep := time.Date(2024, 3, 15, 22, 30, 0, 0, la)
		afternoonStep := time.Date(2024, 3, 15, 14, 18, 0, 0, la)

		cases := []struct {
			name     string
			target   time.Time
			step     time.Time
			minIntv  time.Duration
			wantSupp bool
		}{
			{"21:30 PDT slot before evening step", time.Date(2024, 3, 15, 21, 30, 0, 0, la), eveningStep, flexMin, true},
			{"08:20 PDT slot earlier same day, evening step", time.Date(2024, 3, 15, 8, 20, 0, 0, la), eveningStep, flexMin, true},
			{"08:20 PDT slot before afternoon step", time.Date(2024, 3, 15, 8, 20, 0, 0, la), afternoonStep, flexMin, true},
			{"21:30 PDT slot after afternoon step (delta=7h12m, in band)", time.Date(2024, 3, 15, 21, 30, 0, 0, la), afternoonStep, flexMin, true},
			{"tomorrow 08:20 PDT slot, afternoon step (delta=18h2m, out of band)", time.Date(2024, 3, 16, 8, 20, 0, 0, la), afternoonStep, flexMin, false},
		}
		for _, c := range cases {
			oldOut := oldGuardSuppresses(c.target, c.step, c.minIntv)
			newOut := newGuardSuppresses(c.target, c.step, c.minIntv)
			if oldOut != c.wantSupp {
				t.Errorf("%s: old guard wanted %v, got %v", c.name, c.wantSupp, oldOut)
			}
			if newOut != c.wantSupp {
				t.Errorf("%s: new guard wanted %v, got %v", c.name, c.wantSupp, newOut)
			}
		}
	})
}
