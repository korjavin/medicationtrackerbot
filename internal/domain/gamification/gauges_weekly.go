package gamification

// gauges_weekly.go computes the once-per-week gauge awards (gamification-11
// §Task2): the idempotent HP replacement for the daily BP/weight/resting-HR
// outcomes scoreday.go's daily scorers no longer grant. It reuses the exact
// same compute*Gauge helpers gauges.go's GaugesView read model calls — today
// is the week's last day instead of the live now() — so a late backup import
// that changes the trend/share automatically changes the award on the next
// rescore (RescoreInstants adds every affected week's end day back into the
// rescore set for exactly this reason, see rescore_imports.go). A gauge
// reporting insufficient_data grants no award: honest silence on thin
// history, never a zero judgment.

import (
	"context"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/gamification/scoring"
)

// weeklyGaugeAwards is called from scoreDayAwards only when the day being
// scored is a week's last day (isWeekEndDay, streak.go). It is written into
// the same ledger day as that day's regular awards, so ApplyDayScore's
// delete-and-replace-the-day write makes the weekly award idempotent under
// rescore for free — no separate persistence path.
func (s *service) weeklyGaugeAwards(ctx context.Context, userID int64, weekEndDay time.Time, cfg scoring.Config) ([]scoring.Award, error) {
	var awards []scoring.Award

	weight, err := s.computeWeightGauge(ctx, userID, weekEndDay, cfg)
	if err != nil {
		return nil, err
	}
	if weight.Status == GaugeStatusOK {
		awards = append(awards, scoring.ScoreWeightWeekly(scoring.WeightWeeklyInput{
			HasData:            true,
			VelocityPctPerWeek: weight.VelocityPctPerWeek,
			GoalDirection:      weight.GoalDirection,
		}, cfg)...)
	}

	bp, err := s.computeBPGauge(ctx, userID, weekEndDay, cfg)
	if err != nil {
		return nil, err
	}
	if bp.Status == GaugeStatusOK && bp.Count30d > 0 {
		awards = append(awards, scoring.ScoreBPWeekly(scoring.BPWeeklyInput{
			HasData:          true,
			Share30d:         bp.Share30d,
			BaselineShare60d: bp.BaselineShare60d,
		}, cfg)...)
	}

	hr, err := s.computeRestingHRGauge(ctx, userID, weekEndDay, cfg)
	if err != nil {
		return nil, err
	}
	if hr.Status == GaugeStatusOK {
		awards = append(awards, scoring.ScoreRestingHRWeekly(scoring.RestingHRWeeklyInput{
			HasData:           true,
			DeltaFromBaseline: hr.DeltaFromBaseline,
		}, cfg)...)
	}

	return awards, nil
}
