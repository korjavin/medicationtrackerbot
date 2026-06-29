package gamification

// journey.go is the Journey-screen read model (Plan 2, Task 2): the Summary plus
// the extras that screen draws — a trailing HP-per-day history, the insight tiers
// unlocked so far, and the surrounding level curve. It lives on the domain service
// (not the HTTP handler) because the history needs ledger reads and the curve needs
// the service's private scoring Config (Critical Rule #1).

import (
	"context"

	"github.com/korjavin/medicationtrackerbot/internal/domain/gamification/scoring"
)

// journeyHistoryDays is the trailing window (inclusive of today) the Journey
// HP-history series covers — a quarter, enough to read level momentum.
const journeyHistoryDays = 90

// levelCurveLookahead is how many levels past the user's current level the curve
// extends, so the UI can show the next few thresholds.
const levelCurveLookahead = 5

// DayHP is one day's total HP — a point in the Journey history series.
type DayHP struct {
	DayUnix int64 `json:"day_unix"`
	HP      int   `json:"hp"`
}

// LevelThreshold is one point on the level curve: the cumulative lifetime HP
// needed to reach Level.
type LevelThreshold struct {
	Level     int `json:"level"`
	HPToReach int `json:"hp_to_reach"`
}

// Journey is the Journey-screen read model. The embedded Summary carries the
// enable flag and per-ring breakdown (PeriodRings); the extra fields add the
// history series, unlocked insight tiers, and the level curve. Gate-off yields
// Journey{Summary: {Enabled: false}} with empty extras.
type Journey struct {
	Summary
	HPHistory     []DayHP          `json:"hp_history"`
	UnlockedTiers []int            `json:"unlocked_tiers"`
	LevelCurve    []LevelThreshold `json:"level_curve"`
}

// GetJourney returns the user's Journey read model. It reuses GetSummary (which
// applies the gate and computes level/streak/rings) and layers on the trailing
// HP history, the [1..InsightTier] unlocked tiers, and the level curve from 1 up
// to a few levels past the current one.
func (s *service) GetJourney(ctx context.Context, userID int64) (Journey, error) {
	sum, err := s.GetSummary(ctx, userID)
	if err != nil {
		return Journey{}, err
	}
	if !sum.Enabled {
		return Journey{Summary: Summary{Enabled: false}}, nil
	}

	today := utcMidnight(s.now())
	start := today.AddDate(0, 0, -(journeyHistoryDays - 1))
	ledger, err := s.gam.ListLedger(ctx, userID, start.Unix(), today.Unix())
	if err != nil {
		return Journey{}, err
	}
	byDay := make(map[int64]int, journeyHistoryDays)
	for _, e := range ledger {
		byDay[e.Day.Unix()] += e.HP
	}
	// Emit ascending by day, only days that actually earned HP (sparse series).
	history := make([]DayHP, 0, len(byDay))
	for d := start; !d.After(today); d = d.AddDate(0, 0, 1) {
		if hp, ok := byDay[d.Unix()]; ok {
			history = append(history, DayHP{DayUnix: d.Unix(), HP: hp})
		}
	}

	tiers := make([]int, 0, sum.InsightTier)
	for t := 1; t <= sum.InsightTier; t++ {
		tiers = append(tiers, t)
	}

	curveTop := sum.Level + levelCurveLookahead
	if curveTop > s.cfg.LevelMax {
		curveTop = s.cfg.LevelMax
	}
	curve := make([]LevelThreshold, 0, curveTop)
	for lv := 1; lv <= curveTop; lv++ {
		curve = append(curve, LevelThreshold{Level: lv, HPToReach: scoring.HPToReachLevel(lv, s.cfg)})
	}

	return Journey{
		Summary:       sum,
		HPHistory:     history,
		UnlockedTiers: tiers,
		LevelCurve:    curve,
	}, nil
}
