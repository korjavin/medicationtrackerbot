package gamification

// insights_goodday.go is the second real personal insight (design §8 tier 4,
// Plan gamification-13): the good-day association scan — which of a small,
// fixed set of previous-day behaviors most often precede an in-range morning.
// It follows insights.go's honesty-gate template (min days per arm, a noise
// floor below which "no effect" is itself the reported finding, insufficient-
// data as an explicit third state) rather than introducing a new one: this is
// a scan over four booleans, not a correlation framework (ponytail: framework
// only if a third insight ever wants different math).
//
// Computed on read from the same per-domain repos scoreday.go's loaders
// already use — no new tables, no persisted state. Gated on the feature flag
// AND the user's unlocked insight tier, one level above sleep→BP.

import (
	"context"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/gamification/scoring"
)

// goodDayInsightTier is the insight tier the good-day card unlocks at (tier 4
// — level 7 by DefaultConfig's InsightTierLevels).
const goodDayInsightTier = 4

// Candidate behavior keys (GoodDayFinding.Behavior / GoodDayInsufficient.Behavior).
const (
	GoodDayBehaviorWorkout   = "workout"
	GoodDayBehaviorBedtime   = "bedtime"
	GoodDayBehaviorSteps     = "steps"
	GoodDayBehaviorAdherence = "adherence"
)

// GoodDayFinding is one candidate behavior whose rate difference cleared the
// noise floor: the good-day rate on days after the behavior vs without it.
type GoodDayFinding struct {
	Behavior    string  `json:"behavior"`
	RateWith    float64 `json:"rate_with"`
	RateWithout float64 `json:"rate_without"`
	DeltaPP     float64 `json:"delta_pp"`
	NWith       int     `json:"n_with"`
	NWithout    int     `json:"n_without"`
}

// GoodDayInsufficient is one candidate behavior that didn't clear the honesty
// gate (fewer than Needed days logged in at least one arm).
type GoodDayInsufficient struct {
	Behavior string `json:"behavior"`
	NWith    int    `json:"n_with"`
	NWithout int    `json:"n_without"`
	Needed   int    `json:"needed"`
}

// GoodDayInsight is the good-day association-scan result: over the trailing
// WindowDays, which previous-day behaviors most often precede a good day.
// Locked/UnlocksAtLevel gate this insight independently of the rest of
// InsightsView: a user at tier 3 sees SleepBP but GoodDay still locked, since
// tier 4 unlocks at a higher level (same depth-not-data gating as tier 3).
type GoodDayInsight struct {
	Locked            bool                  `json:"locked,omitempty"`
	UnlocksAtLevel    int                   `json:"unlocks_at_level,omitempty"`
	Status            string                `json:"status,omitempty"`
	WindowDays        int                   `json:"window_days,omitempty"`
	GoodDayDefinition string                `json:"good_day_definition,omitempty"`
	Findings          []GoodDayFinding      `json:"findings,omitempty"`
	Insufficient      []GoodDayInsufficient `json:"insufficient,omitempty"`
}

// goodDayBehavior is one candidate behavior's per-day signal. dayOffset is the
// day (relative to the outcome day D) whose data this behavior reads: -1 for
// the previous calendar day (workout/steps/adherence), 0 for bedtime — a sleep
// log's Day is already the wake day, so the night "bridging D-1 into D" is
// keyed to D itself. present[dayStr] is only meaningful when known[dayStr] is
// true; a day absent from known has no signal for this behavior and is
// excluded from its with/without split, never guessed.
type goodDayBehavior struct {
	key       string
	dayOffset int
	present   map[string]bool
	known     map[string]bool
}

// computeGoodDayInsight scans the trailing cfg.GoodDayWindowDays days: a day D
// is "good" when it has >=1 BP reading and its mean systolic sits in the
// effective cfg.BPSystolic band (days without any reading are excluded from
// the denominator, not counted as bad). Each candidate behavior is compared
// with-vs-without via the same min-per-arm + noise-floor honesty gate
// insights.go's sleep→BP scan uses, ordered by |delta| and capped at
// cfg.GoodDayTopFindings.
func (s *service) computeGoodDayInsight(ctx context.Context, userID int64, cfg scoring.Config) (GoodDayInsight, error) {
	windowDays := cfg.GoodDayWindowDays
	today := utcMidnight(s.now())
	outcomeStart := today.AddDate(0, 0, -(windowDays - 1))
	behaviorStart := outcomeStart.AddDate(0, 0, -1)

	goodByDay, hasBPByDay, err := s.goodDayOutcomes(ctx, userID, outcomeStart, today, cfg)
	if err != nil {
		return GoodDayInsight{}, err
	}
	behaviors, err := s.goodDayBehaviors(ctx, userID, behaviorStart, today, cfg)
	if err != nil {
		return GoodDayInsight{}, err
	}

	out := GoodDayInsight{
		WindowDays:        windowDays,
		GoodDayDefinition: goodDayDefinition(cfg),
	}

	minPerArm := cfg.GoodDayMinDaysPerArm
	anyEnoughData := false
	for _, b := range behaviors {
		var nWith, nWithout, goodWith, goodWithout int
		for d := outcomeStart; !d.After(today); d = d.AddDate(0, 0, 1) {
			dayStr := d.Format("2006-01-02")
			if !hasBPByDay[dayStr] {
				continue
			}
			behaviorDay := d.AddDate(0, 0, b.dayOffset).Format("2006-01-02")
			if !b.known[behaviorDay] {
				continue
			}
			if b.present[behaviorDay] {
				nWith++
				if goodByDay[dayStr] {
					goodWith++
				}
			} else {
				nWithout++
				if goodByDay[dayStr] {
					goodWithout++
				}
			}
		}
		if nWith < minPerArm || nWithout < minPerArm {
			out.Insufficient = append(out.Insufficient, GoodDayInsufficient{
				Behavior: b.key, NWith: nWith, NWithout: nWithout, Needed: minPerArm,
			})
			continue
		}
		anyEnoughData = true
		rateWith := float64(goodWith) / float64(nWith)
		rateWithout := float64(goodWithout) / float64(nWithout)
		deltaPP := (rateWith - rateWithout) * 100
		if math.Abs(deltaPP) < cfg.GoodDayNoiseFloorPP {
			continue
		}
		out.Findings = append(out.Findings, GoodDayFinding{
			Behavior: b.key, RateWith: rateWith, RateWithout: rateWithout,
			DeltaPP: deltaPP, NWith: nWith, NWithout: nWithout,
		})
	}

	sort.Slice(out.Findings, func(i, j int) bool {
		return math.Abs(out.Findings[i].DeltaPP) > math.Abs(out.Findings[j].DeltaPP)
	})
	if len(out.Findings) > cfg.GoodDayTopFindings {
		out.Findings = out.Findings[:cfg.GoodDayTopFindings]
	}

	// no_effect is only honest when *every* behavior cleared the data gate and
	// none cleared the noise floor (docs/api.md#gamification). If some behaviors
	// are still insufficient, we're not entitled to say "nothing stands out" —
	// fall to insufficient_data so the not-enough-data behaviors render instead
	// of being hidden behind an overstated "your good days look evenly spread".
	switch {
	case len(out.Findings) > 0:
		out.Status = InsightStatusEffect
	case anyEnoughData && len(out.Insufficient) == 0:
		out.Status = InsightStatusNoEffect
	default:
		out.Status = InsightStatusInsufficientData
	}
	return out, nil
}

// goodDayDefinition renders the good-day outcome band in the user's own
// numbers, so the model is never a black box.
func goodDayDefinition(cfg scoring.Config) string {
	return fmt.Sprintf("in range = systolic %.0f–%.0f", cfg.BPSystolic.Low, cfg.BPSystolic.High)
}

// goodDayOutcomes returns, per calendar day D in [start, end], whether D had
// any BP reading (hasBP) and whether it was a "good day" (mean systolic in
// cfg.BPSystolic — strict band membership, ignoring Falloff, same convention
// computeBPGauge uses for "share of readings in range"). Only meaningful when
// hasBP is true for that day.
//
// ponytail: BP/workout/adherence day-keys are UTC-midnight, steps/bedtime use
// their stored local wake/aggregate day — the same mixed basis scoreday.go's
// loaders already use. The cross-day D-1→D join thus carries a day-label skew
// bounded by the user's tz offset (and ~0 in practice, since BP readings land
// morning/evening, not near midnight); the ≥10/arm + 15pp gates absorb it.
// Unify on a local-day basis only if a real non-UTC user shows spurious
// findings — it needs re-keying the shared loadAdherenceRange loader.
func (s *service) goodDayOutcomes(ctx context.Context, userID int64, start, end time.Time, cfg scoring.Config) (good, hasBP map[string]bool, err error) {
	readings, err := s.bp.ListReadings(ctx, userID, start)
	if err != nil {
		return nil, nil, err
	}
	windowEnd := end.AddDate(0, 0, 1)
	sumByDay := map[string]float64{}
	countByDay := map[string]int{}
	for _, r := range readings {
		if r.IgnoreCalc || r.MeasuredAt.Before(start) || !r.MeasuredAt.Before(windowEnd) {
			continue
		}
		dayStr := r.MeasuredAt.UTC().Format("2006-01-02")
		sumByDay[dayStr] += float64(r.Systolic)
		countByDay[dayStr]++
	}
	good = make(map[string]bool, len(countByDay))
	hasBP = make(map[string]bool, len(countByDay))
	for dayStr, count := range countByDay {
		hasBP[dayStr] = true
		mean := sumByDay[dayStr] / float64(count)
		good[dayStr] = mean >= cfg.BPSystolic.Low && mean <= cfg.BPSystolic.High
	}
	return good, hasBP, nil
}

// goodDayBehaviors builds the four fixed candidate behaviors' per-day signals
// over [start, end].
func (s *service) goodDayBehaviors(ctx context.Context, userID int64, start, end time.Time, cfg scoring.Config) ([]goodDayBehavior, error) {
	workout, err := s.goodDayWorkoutBehavior(userID, start, end)
	if err != nil {
		return nil, err
	}
	steps, err := s.goodDayStepsBehavior(ctx, userID, start, cfg)
	if err != nil {
		return nil, err
	}
	adherence, err := s.goodDayAdherenceBehavior(ctx, userID, start, end, cfg)
	if err != nil {
		return nil, err
	}
	bedtime, err := s.goodDayBedtimeBehavior(ctx, userID, start, end, cfg)
	if err != nil {
		return nil, err
	}
	return []goodDayBehavior{workout, steps, adherence, bedtime}, nil
}

// goodDayWorkoutBehavior reports, for every calendar day in [start, end],
// whether a workout session was completed that day. "No workout" is always a
// known, valid false — unlike steps/bedtime/adherence there is no missing-
// data state for this behavior.
func (s *service) goodDayWorkoutBehavior(userID int64, start, end time.Time) (goodDayBehavior, error) {
	hist, err := s.workout.ListHistory(userID, workoutHistoryLimit)
	if err != nil {
		return goodDayBehavior{}, err
	}
	b := goodDayBehavior{key: GoodDayBehaviorWorkout, dayOffset: -1, present: map[string]bool{}, known: map[string]bool{}}
	for d := start; !d.After(end); d = d.AddDate(0, 0, 1) {
		b.known[d.Format("2006-01-02")] = true
	}
	windowEnd := end.AddDate(0, 0, 1)
	for _, ws := range hist {
		if ws.Status != "completed" {
			continue
		}
		at := sessionInstant(ws)
		if at.Before(start) || !at.Before(windowEnd) {
			continue
		}
		b.present[utcMidnight(at).Format("2006-01-02")] = true
	}
	return b, nil
}

// goodDayStepsBehavior reports, for every day with a day_stats row, whether
// that day's steps sat in cfg.StepsBand (strict Low/High, ignoring Falloff —
// the same "in band" convention goodDayOutcomes uses for BP). A day with no
// day_stats row has no step signal and is excluded.
func (s *service) goodDayStepsBehavior(ctx context.Context, userID int64, start time.Time, cfg scoring.Config) (goodDayBehavior, error) {
	stats, err := s.vitals.ListDayStats(ctx, userID, start)
	if err != nil {
		return goodDayBehavior{}, err
	}
	b := goodDayBehavior{key: GoodDayBehaviorSteps, dayOffset: -1, present: map[string]bool{}, known: map[string]bool{}}
	for _, st := range stats {
		b.known[st.Day] = true
		steps := float64(st.Steps)
		b.present[st.Day] = steps >= cfg.StepsBand.Low && steps <= cfg.StepsBand.High
	}
	return b, nil
}

// goodDayAdherenceBehavior reports, for every day with at least one expected
// dose (taken or missed — the same "expected" ScoreAdherence grades),
// whether every expected dose was taken on time (no misses, no dose later
// than cfg.AdherenceOnTimeGraceMin). A day with zero expected doses (nothing
// scheduled, or only honest skips) has no adherence signal and is excluded.
func (s *service) goodDayAdherenceBehavior(ctx context.Context, userID int64, start, end time.Time, cfg scoring.Config) (goodDayBehavior, error) {
	byDay, err := s.loadAdherenceRange(ctx, userID, start, end.AddDate(0, 0, 1))
	if err != nil {
		return goodDayBehavior{}, err
	}
	b := goodDayBehavior{key: GoodDayBehaviorAdherence, dayOffset: -1, present: map[string]bool{}, known: map[string]bool{}}
	for dayKey, ad := range byDay {
		expected := 0
		onTime := true
		for _, d := range ad.Doses {
			switch d.Status {
			case scoring.DoseTaken:
				expected++
				if float64(d.MinutesLate) > cfg.AdherenceOnTimeGraceMin {
					onTime = false
				}
			case scoring.DoseMissed:
				expected++
				onTime = false
			}
		}
		if expected == 0 {
			continue
		}
		dayStr := time.Unix(dayKey, 0).UTC().Format("2006-01-02")
		b.known[dayStr] = true
		b.present[dayStr] = onTime
	}
	return b, nil
}

// goodDayBedtimeBehavior reports, for every day with a logged night and an
// established personal baseline, whether that night's bedtime sat in
// cfg.BedtimeWindow around the trailing-baseline median (the same
// membership predicate ScoreSleep's timing-consistency award grades, reused
// here as a binary "in window" instead of graded credit). dayOffset 0: a
// sleep log's Day is the wake day, so this is naturally keyed to the outcome
// day D, not D-1.
func (s *service) goodDayBedtimeBehavior(ctx context.Context, userID int64, start, end time.Time, cfg scoring.Config) (goodDayBehavior, error) {
	fetchFrom := start.AddDate(0, 0, -(bedtimeBaselineDays + 1))
	logs, err := s.vitals.ListSleepLogs(ctx, userID, fetchFrom)
	if err != nil {
		return goodDayBehavior{}, err
	}
	onsetByDay := map[string]float64{}
	for _, sl := range logs {
		// First-seen wins, matching insights.go's sleep-day dedupe: ListSleepLogs
		// is start_time DESC, so a nap + main sleep resolves to the same session
		// loadSleep would pick.
		if _, ok := onsetByDay[sl.Day]; !ok {
			onsetByDay[sl.Day] = sleepOnsetMinutes(sl.StartTime, sl.TimezoneOffset)
		}
	}
	b := goodDayBehavior{key: GoodDayBehaviorBedtime, dayOffset: 0, present: map[string]bool{}, known: map[string]bool{}}
	for d := start; !d.After(end); d = d.AddDate(0, 0, 1) {
		dayStr := d.Format("2006-01-02")
		onset, logged := onsetByDay[dayStr]
		if !logged {
			continue
		}
		baselineStartStr := d.AddDate(0, 0, -bedtimeBaselineDays).Format("2006-01-02")
		center, ok := medianBedtimeOnset(logs, dayStr, baselineStartStr)
		if !ok {
			continue
		}
		b.known[dayStr] = true
		b.present[dayStr] = cfg.BedtimeWindow.Membership(math.Abs(onset-center)) == 1
	}
	return b, nil
}
