package gamification

// weekly.go is the "Your week" read model (gamification-12): one aggregation
// over already-computed data, shared by the Journey card and the bot's /week
// digest (Overview — "one read model, two presentations"). It adds no ledger
// rows and no new tables; it folds the same ledger + gauge + Health Score
// reads GetSummary/GetGauges/computeHealthScore already expose, anchored a
// week apart, so a late backup import that retro-fills a lighter week simply
// changes what this read returns next time (same "pure function of the log"
// invariant as the rest of the package).

import (
	"context"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/gamification/scoring"
	gamstore "github.com/korjavin/medicationtrackerbot/internal/store/gamification"
)

// WeeklyLeverReview is one lever ring's closed-day count this week vs last —
// the same three levers summary.go's PeriodRings groups by (leverRings).
type WeeklyLeverReview struct {
	Key            string `json:"key"`
	ClosedThisWeek int    `json:"closed_this_week"`
	ClosedLastWeek int    `json:"closed_last_week"`
}

// WeeklyBestDay is the day within the reviewed week with the most lever
// rings closed (Overview — "best day"). Absent (nil) when no day closed any
// ring, so the card can omit the callout instead of naming a day with 0.
type WeeklyBestDay struct {
	DayUnix     int64 `json:"day_unix"`
	RingsClosed int   `json:"rings_closed"`
}

// WeeklyStrength is one pillar's habit-strength EMA (wellbeing.go's
// computeStrengths) read now and anchored 7 days earlier, so the card can
// phrase a delta ("Movement strength up") without re-deriving it.
type WeeklyStrength struct {
	Key        string  `json:"key"`
	Label      string  `json:"label"`
	ValueNow   float64 `json:"value_now"`
	ValuePrior float64 `json:"value_prior"`
}

// WeeklyGauges embeds this week's gauge views (gauges.go) as-is — velocity/
// acceleration/pace-status are already trend reads — plus the one extra
// number the card needs that GaugesView doesn't carry: BP's 30-day share a
// week ago, so "BP in range 82% · up from 76%" doesn't require the frontend
// to re-fetch and re-derive a second gauge snapshot.
type WeeklyGauges struct {
	Weight          WeightGaugeView    `json:"weight"`
	BP              BPGaugeView        `json:"bp"`
	BPShare30dPrior float64            `json:"bp_share_30d_prior,omitempty"`
	RestingHR       RestingHRGaugeView `json:"resting_hr"`
}

// WeeklyHealthScore is the Health Score now vs anchored 7 days earlier — the
// week-over-week "movement" the card headlines with (Overview).
type WeeklyHealthScore struct {
	Now   HealthScoreView `json:"now"`
	Prior HealthScoreView `json:"prior"`
}

// WeeklyReview is the GET /api/gamification/weekly-review read model: the
// primary reading cadence for gauges (Overview). Gate-off yields
// {Enabled:false}. A week with zero ledger HP yields Quiet:true instead of
// an error or a wall of zeros — "a quiet week", never a failure (tone
// rules, Overview).
type WeeklyReview struct {
	Enabled bool `json:"enabled"`
	Quiet   bool `json:"quiet"`

	WeekStart time.Time `json:"week_start"`
	WeekEnd   time.Time `json:"week_end"`

	DaysWithAnyHP int                 `json:"days_with_any_hp"`
	Levers        []WeeklyLeverReview `json:"levers"`
	BestDay       *WeeklyBestDay      `json:"best_day,omitempty"`
	Strengths     []WeeklyStrength    `json:"strengths"`

	Gauges      WeeklyGauges      `json:"gauges"`
	HealthScore WeeklyHealthScore `json:"health_score"`
}

// GetWeeklyReview returns the weekly review read model, gated on
// gamification_enabled. It resolves the ISO week (Mon-Sun) containing `now`
// via the same weekIndex/weekBounds bucketing streak.go uses, so "this
// week"/"last week" never drifts from the streak/weekly-gauge-award
// definition of a week.
func (s *service) GetWeeklyReview(ctx context.Context, userID int64) (WeeklyReview, error) {
	enabled, err := s.gate(ctx)
	if err != nil {
		return WeeklyReview{}, err
	}
	if !enabled {
		return WeeklyReview{}, nil
	}

	cfg, err := s.effectiveConfig(ctx, userID)
	if err != nil {
		return WeeklyReview{}, err
	}
	today := utcMidnight(s.now())
	week := weekIndex(today)
	weekStart, weekEnd := weekBounds(week)
	weekStartT, weekEndT := time.Unix(weekStart, 0).UTC(), time.Unix(weekEnd, 0).UTC()
	priorStart, priorEnd := weekBounds(week - 1)

	thisWeekLedger, err := s.gam.ListLedger(ctx, userID, weekStartT.Unix(), weekEndT.Unix())
	if err != nil {
		return WeeklyReview{}, err
	}
	lastWeekLedger, err := s.gam.ListLedger(ctx, userID, priorStart, priorEnd)
	if err != nil {
		return WeeklyReview{}, err
	}
	levers, daysWithHP, bestDay := weeklyLeverBreakdown(thisWeekLedger, lastWeekLedger)

	weekAgo := today.AddDate(0, 0, -7)
	strengthsNow, err := s.computeStrengths(ctx, userID, today, cfg)
	if err != nil {
		return WeeklyReview{}, err
	}
	strengthsPrior, err := s.computeStrengths(ctx, userID, weekAgo, cfg)
	if err != nil {
		return WeeklyReview{}, err
	}
	strengths := make([]WeeklyStrength, 0, len(strengthsNow))
	for i, now := range strengthsNow {
		prior := 0.0
		if i < len(strengthsPrior) {
			prior = strengthsPrior[i].Value
		}
		strengths = append(strengths, WeeklyStrength{Key: now.Key, Label: now.Label, ValueNow: now.Value, ValuePrior: prior})
	}

	weight, err := s.computeWeightGauge(ctx, userID, today, cfg)
	if err != nil {
		return WeeklyReview{}, err
	}
	bp, err := s.computeBPGauge(ctx, userID, today, cfg)
	if err != nil {
		return WeeklyReview{}, err
	}
	bpPrior, err := s.computeBPGauge(ctx, userID, weekAgo, cfg)
	if err != nil {
		return WeeklyReview{}, err
	}
	hr, err := s.computeRestingHRGauge(ctx, userID, today, cfg)
	if err != nil {
		return WeeklyReview{}, err
	}

	scoreNow, err := s.computeHealthScore(ctx, userID, today, cfg)
	if err != nil {
		return WeeklyReview{}, err
	}
	scorePrior, err := s.computeHealthScore(ctx, userID, weekAgo, cfg)
	if err != nil {
		return WeeklyReview{}, err
	}

	bpSharePrior := 0.0
	if bpPrior.Status == GaugeStatusOK {
		bpSharePrior = bpPrior.Share30d
	}

	return WeeklyReview{
		Enabled:       true,
		Quiet:         daysWithHP == 0,
		WeekStart:     weekStartT,
		WeekEnd:       weekEndT,
		DaysWithAnyHP: daysWithHP,
		Levers:        levers,
		BestDay:       bestDay,
		Strengths:     strengths,
		Gauges: WeeklyGauges{
			Weight:          weight,
			BP:              bp,
			BPShare30dPrior: bpSharePrior,
			RestingHR:       hr,
		},
		HealthScore: WeeklyHealthScore{Now: scoreNow, Prior: scorePrior},
	}, nil
}

// weeklyLeverBreakdown folds two weeks' ledger entries into per-lever
// closed-day counts (mirroring ringScores' (ring, source_metric) matching,
// summary.go), the count of days with any HP at all, and the day with the
// most rings closed within thisWeek.
func weeklyLeverBreakdown(thisWeek, lastWeek []gamstore.LedgerEntry) (levers []WeeklyLeverReview, daysWithHP int, bestDay *WeeklyBestDay) {
	thisClosed := closedDaysByLever(thisWeek)
	lastClosed := closedDaysByLever(lastWeek)

	levers = make([]WeeklyLeverReview, 0, len(leverRings))
	for _, lv := range leverRings {
		levers = append(levers, WeeklyLeverReview{
			Key:            lv.Key,
			ClosedThisWeek: len(thisClosed[lv.Key]),
			ClosedLastWeek: len(lastClosed[lv.Key]),
		})
	}

	hpDays := map[int64]bool{}
	for _, e := range thisWeek {
		if e.HP > 0 {
			hpDays[e.Day.Unix()] = true
		}
	}
	daysWithHP = len(hpDays)

	closedByDay := map[int64]int{}
	for _, lv := range leverRings {
		for day := range thisClosed[lv.Key] {
			closedByDay[day]++
		}
	}
	var bestDayUnix int64
	bestCount := 0
	for day, count := range closedByDay {
		if count > bestCount || (count == bestCount && day < bestDayUnix) {
			bestCount, bestDayUnix = count, day
		}
	}
	if bestCount > 0 {
		bestDay = &WeeklyBestDay{DayUnix: bestDayUnix, RingsClosed: bestCount}
	}
	return levers, daysWithHP, bestDay
}

// closedDaysByLever maps each lever key to the set of day_unix keys on which
// it closed (a non-floor award) within entries — the same matching rule
// ringScores uses, applied per-day instead of summed over the whole period.
func closedDaysByLever(entries []gamstore.LedgerEntry) map[string]map[int64]bool {
	out := make(map[string]map[int64]bool, len(leverRings))
	for _, lv := range leverRings {
		out[lv.Key] = map[int64]bool{}
	}
	for _, e := range entries {
		if e.Kind == scoring.KindFloor {
			continue
		}
		for _, lv := range leverRings {
			if e.Ring != lv.Ring || (lv.SourceMetric != "" && e.SourceMetric != lv.SourceMetric) {
				continue
			}
			out[lv.Key][e.Day.Unix()] = true
			break
		}
	}
	return out
}
